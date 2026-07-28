// Phase B test harness. Build → serve dist → headless chromium scenarios →
// node CPU bench → artifacts/ + report.json. Exit 0 only if all hard
// assertions pass. Step counts are budgeted for software rendering — do not
// increase them.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveStatic } from './serve.mjs';
import { runBench } from './bench.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(APP, 'test', 'artifacts');
const DIST = path.join(APP, 'dist');
const DT = 1 / 60;
const STEP_CHUNK = 100; // keep each page.evaluate short-lived under software GL

const report = {
  generatedAt: new Date().toISOString(),
  gpu: 'unknown',
  rendererString: null,
  pass: false,
  build: null,
  scenarios: {},
  pageErrors: [],
  consoleErrors: [],
  artifacts: [],
};

let currentScenario = 'startup';

function runCmd(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: out + '\n' + String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function launchChromium() {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  };
  try {
    return await chromium.launch(opts);
  } catch (e) {
    console.warn('default chromium launch failed, falling back to /opt/pw-browsers/chromium:', String(e).split('\n')[0]);
    return chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' });
  }
}

async function main() {
  await fs.rm(ART, { recursive: true, force: true });
  await fs.mkdir(ART, { recursive: true });

  // ---- 1. build + serve ------------------------------------------------
  console.log('building (vite build)...');
  const viteBin = path.join(APP, 'node_modules', '.bin', 'vite');
  let build = await runCmd(viteBin, ['build'], APP);
  if (build.code === -1) build = await runCmd('npx', ['vite', 'build'], APP);
  report.build = { pass: build.code === 0, exitCode: build.code, tail: build.out.slice(-2000) };
  if (build.code !== 0) {
    console.error('BUILD FAILED:\n' + build.out);
  } else {
    console.log('build ok');
  }

  if (report.build.pass) {
    const server = await serveStatic(DIST);
    console.log(`serving dist/ at ${server.origin}`);

    const browser = await launchChromium();
    try {
      const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      // 2. any pageerror / console.error anywhere in the run = hard fail
      page.on('pageerror', (e) => report.pageErrors.push({ scenario: currentScenario, message: String(e) }));
      page.on('console', (m) => {
        if (m.type() === 'error') report.consoleErrors.push({ scenario: currentScenario, text: m.text() });
      });

      const load = async (params) => {
        await page.goto(`${server.origin}/?${params}`, { waitUntil: 'load', timeout: 90000 });
        await page.waitForFunction(
          () => window.__menagerie && window.__menagerie.clock && typeof window.__menagerie.clock.stepMany === 'function',
          null,
          { timeout: 90000 },
        );
      };

      const step = async (n, dt = DT) => {
        while (n > 0) {
          const c = Math.min(n, STEP_CHUNK);
          await page.evaluate(([count, d]) => window.__menagerie.clock.stepMany(count, d), [c, dt]);
          n -= c;
        }
      };

      const shot = async (name) => {
        const buf = await page.screenshot({ path: path.join(ART, name) });
        report.artifacts.push(name);
        return buf;
      };

      // Decode a PNG buffer with the browser's own decoder (2D canvas) and
      // return pixel stats — canvas readback of the WebGL buffer is off-limits
      // (preserveDrawingBuffer:false), so measurement goes through screenshots.
      const pngStats = (buf, region) =>
        page.evaluate(
          async ([b64, reg]) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            let x = 0, y = 0, w = img.width, h = img.height;
            if (reg === 'central') {
              x = w >> 2; y = h >> 2; w >>= 1; h >>= 1; // central 50% box
            }
            const d = g.getImageData(x, y, w, h).data;
            let blown = 0;
            let maxChannel = 0;
            for (let i = 0; i < d.length; i += 4) {
              const r = d[i], gg = d[i + 1], b = d[i + 2];
              if (r >= 250 && gg >= 250 && b >= 250) blown++;
              const m = r > gg ? (r > b ? r : b) : (gg > b ? gg : b);
              if (m > maxChannel) maxChannel = m;
            }
            const pixels = d.length / 4;
            return { width: img.width, height: img.height, regionPixels: pixels, blownFrac: blown / pixels, maxChannel };
          },
          [buf.toString('base64'), region ?? 'full'],
        );

      const scenario = async (name, fn) => {
        currentScenario = name;
        const s = { pass: true, artifacts: [] };
        report.scenarios[name] = s;
        const before = report.artifacts.length;
        try {
          await fn(s);
        } catch (e) {
          s.pass = false;
          s.error = String((e && e.stack) || e);
          console.error(`scenario ${name} FAILED: ${s.error.split('\n')[0]}`);
        }
        s.artifacts = report.artifacts.slice(before);
        currentScenario = 'between-scenarios';
      };

      // ---- 3+4. duo (renderer check happens on its first load) -----------
      await scenario('duo', async (s) => {
        await load('fixedstep=1&scene=duo');
        report.rendererString = await page.evaluate(() => window.__menagerie.rendererString);
        report.gpu = /swiftshader|llvmpipe|software/i.test(report.rendererString || '') ? 'software' : 'hardware';
        if (report.gpu === 'software') {
          const bar = '!'.repeat(76);
          console.warn(`\n${bar}\n!! SOFTWARE RENDERER DETECTED: ${report.rendererString}\n!! ALL FPS-LIKE NUMBERS IN THIS RUN ARE NON-EVIDENCE — CORRECTNESS ONLY.\n${bar}\n`);
        }
        await step(300); // warm 5s sim-time
        s.lastFrameCpuMs = await page.evaluate(() => window.__menagerie.stats.lastFrameCpuMs);
        await shot('duo.png');
        for (let i = 0; i < 8; i++) {
          if (i > 0) await step(30); // 0.5s sim-time apart
          await shot(`sheet-${i}.png`);
        }
      });

      // ---- 5. eel sway sweep ---------------------------------------------
      await scenario('swaySweep', async (s) => {
        s.sways = [];
        for (const [sway, tag] of [[0.6, '06'], [1.2, '12'], [2.4, '24']]) {
          await load(`fixedstep=1&scene=eel&sway=${sway}`);
          await step(200);
          await shot(`sway-${tag}.png`);
          s.sways.push(sway);
        }
      });

      // ---- 6. ray (second light azimuth via test hook if available) ------
      await scenario('ray', async (s) => {
        await load('fixedstep=1&scene=ray');
        await step(300);
        await shot('ray.png');
        const hook = await page.evaluate(() => {
          const t = window.__menagerie.test;
          for (const n of ['setLightAzimuth', 'setLight', 'setLightDir']) {
            if (typeof t[n] === 'function') return n;
          }
          return null;
        });
        s.lightHook = hook;
        if (hook) {
          await page.evaluate((h) => window.__menagerie.test[h](2.4), hook);
          await step(30); // let trails re-accumulate under the new light
          await shot('ray-lit2.png');
        }
      });

      // ---- 7. pileup: additive blowout bound -----------------------------
      await scenario('pileup', async (s) => {
        await load('fixedstep=1&scene=pileup&trails=0.9');
        await step(300);
        const buf = await shot('pileup.png');
        const stats = await pngStats(buf, 'full');
        s.blownFrac = stats.blownFrac;
        s.bound = 0.08;
        s.pass = stats.blownFrac <= 0.08;
        if (!s.pass) console.error(`pileup blowout: ${(stats.blownFrac * 100).toFixed(2)}% pixels fully white (bound 8%)`);
      });

      // ---- 8. soak: trails must reach black ------------------------------
      await scenario('soak', async (s) => {
        await load('fixedstep=1&scene=eel');
        await page.evaluate(() => {
          window.__menagerie.test.setSway(0);
          window.__menagerie.test.setTrails(0.99);
        });
        await step(1500); // 25s sim-time accumulation
        await shot('soak-full.png');
        await page.evaluate(() => window.__menagerie.test.releaseAll());
        await step(600); // 10s sim-time decay
        const buf = await shot('soak-decayed.png');
        const stats = await pngStats(buf, 'central');
        s.maxCentralChannelAfterDecay = stats.maxChannel;
        s.bound = 6;
        s.pass = stats.maxChannel <= 6;
        if (!s.pass) console.error(`soak: central pixel channel ${stats.maxChannel}/255 after decay (bound 6) — trails did not reach black`);
      });

    } finally {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } else {
    for (const name of ['duo', 'swaySweep', 'ray', 'pileup', 'soak']) {
      report.scenarios[name] = { pass: false, error: 'skipped: build failed' };
    }
  }

  // ---- 9. CPU bench in node (no browser) -------------------------------
  currentScenario = 'cpuBench';
  {
    const s = { pass: true };
    report.scenarios.cpuBench = s;
    try {
      const r = await runBench({ frames: 200 });
      Object.assign(s, r);
      s.bound = 1.5;
      s.pass = r.medianMs <= 1.5;
      console.log(`cpu bench: median ${r.medianMs.toFixed(3)} ms combined for ${r.dots} dots (bound 1.5 ms)`);
      if (!s.pass) console.error('cpu bench FAILED: median exceeds 1.5 ms');
    } catch (e) {
      s.pass = false;
      s.error = String((e && e.stack) || e);
      console.error('cpu bench FAILED: ' + s.error.split('\n')[0]);
    }
  }

  // ---- 10. report + exit code ------------------------------------------
  const scenarioFail = Object.values(report.scenarios).some((s) => !s.pass);
  report.pass =
    report.build.pass && !scenarioFail && report.pageErrors.length === 0 && report.consoleErrors.length === 0;

  await fs.writeFile(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n===== report =====');
  console.log(`gpu: ${report.gpu} (${report.rendererString})`);
  for (const [name, s] of Object.entries(report.scenarios)) {
    console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${name}${s.error ? '  — ' + s.error.split('\n')[0] : ''}`);
  }
  if (report.pageErrors.length) console.error(`  FAIL  ${report.pageErrors.length} page error(s):`, report.pageErrors);
  if (report.consoleErrors.length) console.error(`  FAIL  ${report.consoleErrors.length} console error(s):`, report.consoleErrors);
  console.log(`artifacts: ${ART}`);
  console.log(`overall: ${report.pass ? 'PASS' : 'FAIL'}`);

  process.exit(report.pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error('harness crashed:', e);
  report.pass = false;
  report.harnessError = String((e && e.stack) || e);
  try {
    await fs.mkdir(ART, { recursive: true });
    await fs.writeFile(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
  } catch {}
  process.exit(1);
});
