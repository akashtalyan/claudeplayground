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
      const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1, acceptDownloads: true });
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
            } else if (reg === 'top') {
              h = (h / 3) | 0; // upper third (caustic shafts live here)
            } else if (reg === 'bottom') {
              const t = (h / 3) | 0; y = h - t; h = t; // lower third (sediment)
            }
            const d = g.getImageData(x, y, w, h).data;
            let blown = 0;
            let maxChannel = 0;
            let lumaSum = 0;
            let lit = 0;
            for (let i = 0; i < d.length; i += 4) {
              const r = d[i], gg = d[i + 1], b = d[i + 2];
              if (r >= 250 && gg >= 250 && b >= 250) blown++;
              const m = r > gg ? (r > b ? r : b) : (gg > b ? gg : b);
              if (m > maxChannel) maxChannel = m;
              lumaSum += (r + gg + b) / 3;
              if (m > 25) lit++; // pixels clearly above the night-water floor
            }
            const pixels = d.length / 4;
            return { width: img.width, height: img.height, regionPixels: pixels, blownFrac: blown / pixels, maxChannel, meanLuma: lumaSum / pixels, litCount: lit };
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

      // ---- 8. soak: trails must decay back to the empty-water baseline ----
      // (The scene has a night-ocean background, so "black" is really the
      // background itself: assert the decayed frame matches a creature-free
      // baseline of the same scene, not absolute zero.)
      await scenario('soak', async (s) => {
        await load('fixedstep=1&scene=eel');
        await page.evaluate(() => {
          window.__menagerie.test.setTrails(0.99);
          window.__menagerie.test.releaseAll();
        });
        await step(600); // settle trails onto pure background
        const baseBuf = await shot('soak-baseline.png');
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
        const baseStats = await pngStats(baseBuf, 'central');
        s.maxCentralChannelAfterDecay = stats.maxChannel;
        s.baselineMaxChannel = baseStats.maxChannel;
        s.bound = 6;
        s.pass = stats.maxChannel - baseStats.maxChannel <= 6;
        if (!s.pass) console.error(`soak: central channel ${stats.maxChannel}/255 vs baseline ${baseStats.maxChannel}/255 after decay (bound +6) — trails did not decay to background`);
      });

      // ---- 9. Phase C sweep: 12-creature board, all 9 archetypes ---------
      await scenario('sweep', async (s) => {
        const board = [
          'eel', 'jellyfish', 'manta', 'koi', 'octopus', 'starfish',
          'blob', 'lotus', 'kelp', 'shark', 'anemone', 'squid',
        ].join(',');
        await load(`fixedstep=1&board=${encodeURIComponent(board)}`);
        await step(400); // warm ~6.7s sim-time: all formations complete
        let i = 0;
        for (const yaw of [0, 0.45]) {
          for (const az of [0.8, 2.4]) {
            i++;
            await page.evaluate(
              ([y, a]) => {
                window.__menagerie.test.setCameraYaw(y);
                window.__menagerie.test.setLightAzimuth(a);
              },
              [yaw, az],
            );
            await step(40); // trails re-accumulate under new view/light
            const buf = await shot(`sweep-a${i}.png`);
            const st = await pngStats(buf, 'full');
            s[`a${i}`] = { blownFrac: st.blownFrac, maxChannel: st.maxChannel };
            // a 12-creature board must glow without washing out
            if (st.blownFrac > 0.08) {
              s.pass = false;
              console.error(`sweep-a${i}: ${(st.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
            }
            if (st.maxChannel < 40) {
              s.pass = false;
              console.error(`sweep-a${i}: maxChannel ${st.maxChannel} — board too dark`);
            }
          }
        }
        await page.evaluate(() => {
          window.__menagerie.test.setCameraYaw(0);
          window.__menagerie.test.setLightAzimuth(0.8);
        });
      });

      // ---- 10. per-archetype solo shots ----------------------------------
      await scenario('solo', async (s) => {
        const names = {
          eel: 'eel', medusa: 'jellyfish', fish: 'fish', ray: 'manta ray',
          octo: 'octopus', star: 'starfish', amorph: 'plankton',
          bloom: 'lotus', kelp: 'kelp',
        };
        await load('fixedstep=1&board=eel');
        s.shots = [];
        for (const [arch, name] of Object.entries(names)) {
          await page.evaluate((n) => window.__menagerie.test.solo(n), name);
          await step(200);
          const buf = await shot(`solo-${arch}.png`);
          const st = await pngStats(buf, 'central');
          s.shots.push({ arch, maxChannel: st.maxChannel });
          if (st.maxChannel < 40) {
            s.pass = false;
            console.error(`solo-${arch}: central maxChannel ${st.maxChannel} — creature missing or too dark`);
          }
        }
      });

      // ---- 11. Phase D controls: chrome + every plate knob + presets +
      // summon path + ambient + hover label + URL round-trip ---------------
      await scenario('controls', async (s) => {
        await load(`fixedstep=1&board=${encodeURIComponent('jellyfish,manta')}`);
        await page.waitForFunction(
          () => window.__menagerie.ui && typeof window.__menagerie.ui.forceAmbient === 'function',
        );
        await step(260); // ~4.3s sim: formations complete

        // -- select creature c1 (jellyfish) -> gauge plate surfaces
        await page.evaluate(() => window.__menagerie.controls.select('c1'));
        await page.waitForTimeout(650); // 400ms rise + anchor settle (wall clock)
        await step(20);
        await shot('plate-open.png');

        // -- drive a slider row with a REAL pointer drag; assert live param
        s.knobs = {};
        const drive = async (key) => {
          const before = await page.evaluate((k) => window.__menagerie.controls.getParam('c1', k), key);
          const box = await page.locator(`#plate .plate-row[data-key="${key}"] .plate-track`).boundingBox();
          const y = box.y + box.height / 2;
          await page.mouse.move(box.x + box.width * 0.2, y);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * 0.85, y, { steps: 4 });
          await page.mouse.up();
          await page.waitForTimeout(500); // needle spring settles on wall clock
          const after = await page.evaluate((k) => window.__menagerie.controls.getParam('c1', k), key);
          s.knobs[key] = { before, after };
          if (!(Math.abs(after - before) > 1e-3)) throw new Error(`dead knob: ${key} (${before} -> ${after})`);
        };
        for (const k of ['glow', 'tempo', 'sway', 'size']) await drive(k);

        // -- 'more ›' drawer: 4 advanced sliders + behavior rotary + swatch
        await page.locator('#plate .plate-actions [data-act="more"]').click();
        await page.waitForTimeout(600); // plate re-centers on its anchor (height grew)
        for (const k of ['twinkle', 'iridescence', 'density', 'depth']) await drive(k);

        const behBefore = await page.evaluate(() => window.__menagerie.controls.getParam('c1', 'behavior'));
        await page.locator('#plate .plate-behavior .plate-rot-arrow').nth(1).click(); // ›
        await page.waitForTimeout(400); // rotary detent settle
        const behAfter = await page.evaluate(() => window.__menagerie.controls.getParam('c1', 'behavior'));
        s.behavior = { before: behBefore, after: behAfter };
        if (behAfter === behBefore) throw new Error('dead knob: behavior rotary');

        await page.locator('#plate .plate-swatch').nth(3).click(); // hue 185 (cyan)
        const hue = await page.evaluate(() => window.__menagerie.controls.getParam('c1', 'color'));
        s.color = hue;
        if (hue !== 185) throw new Error(`dead knob: color swatch (got ${hue})`);
        await step(20); // recolor lands in the frame
        await shot('plate-more.png');

        // -- esc sinks the plate, clears selection
        await page.keyboard.press('Escape');
        await page.waitForTimeout(450);
        const sel = await page.evaluate(() => window.__menagerie.controls.getSelected());
        if (sel !== null) throw new Error('esc did not clear selection');

        // -- all 5 weather presets: engine crossfade + scene-param deltas
        s.presets = {};
        const names = await page.evaluate(() => window.__menagerie.controls.presetNames());
        let prev = null;
        for (const name of names) {
          await page.evaluate((n) => window.__menagerie.controls.setPreset(n), name);
          await step(150); // 2.5s sim: 2s crossfade completes + trails settle
          const sv = await page.evaluate(() => window.__menagerie.controls.sceneValues());
          s.presets[name] = { gain: sv.gain, fogDensity: sv.fogDensity, trailsK: sv.trailsK };
          if (prev && !(Math.abs(sv.gain - prev.gain) > 1e-3 && Math.abs(sv.fogDensity - prev.fogDensity) > 1e-6)) {
            throw new Error(`preset '${name}' produced no scene-param delta`);
          }
          prev = sv;
          // stepping burns wall-clock; make sure idle-ambient hasn't sunk the
          // chrome before the shot (the harness is minutes of "idle" to it)
          await page.evaluate(() => window.__menagerie.ui.forceAmbient(false));
          await page.waitForTimeout(750);
          await shot(`preset-${name.replace(/\s+/g, '-')}.png`);
        }
        await page.evaluate(() => window.__menagerie.controls.setPreset('moonlit', { snap: true }));
        await step(60); // trails re-settle under moonlit

        // -- summon via the REAL input path (type + Enter)
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(false)); // wake after stepping
        await page.waitForTimeout(750);
        const popBefore = await page.evaluate(() => window.__menagerie.test.aliveCount());
        await page.locator('#summon-input').click();
        await page.keyboard.type('jellyfish');
        await page.keyboard.press('Enter');
        const popAfter = await page.evaluate(() => window.__menagerie.test.aliveCount());
        s.population = { before: popBefore, after: popAfter };
        if (popAfter !== popBefore + 1) throw new Error(`summon: population ${popBefore} -> ${popAfter}, expected +1`);
        const cleared = await page.evaluate(() => document.getElementById('summon-input').value);
        if (cleared !== '') throw new Error('summon: field did not clear');
        await step(130); // ~2.2s sim: the new jellyfish forms
        await page.mouse.move(30, 30); // park the pointer off every creature
        await page.waitForTimeout(350); // hover label (if any) fades back out
        await shot('state-a.png'); // at-rest chrome: summon row + small rotary

        // -- ambient: all chrome sinks; screenshot must be chrome-free
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(true));
        await page.waitForTimeout(1600); // 1.2s sink + fade tails
        const summonOpacity = await page.evaluate(
          () => +getComputedStyle(document.getElementById('summon')).opacity,
        );
        s.ambientSummonOpacity = summonOpacity;
        if (summonOpacity > 0.01) throw new Error(`ambient: summon row still visible (opacity ${summonOpacity})`);
        await shot('ambient.png');
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(false));
        await page.waitForTimeout(900); // staggered return completes

        // -- hover label: pick a creature whose body (and label spot) is well
        // inside the viewport (c1 is now giant and rides the right edge)
        const a = await page.evaluate(() => {
          for (const id of ['c2', 'c3', 'c1']) {
            const an = window.__menagerie.controls.screenAnchor(id);
            if (an && an.x > 80 && an.x < innerWidth - 120 && an.y - an.radiusPx > 60 && an.y < innerHeight - 120) return an;
          }
          return null;
        });
        if (!a) throw new Error('no hoverable creature fully in view');
        await page.mouse.move(a.x, a.y);
        await page.waitForTimeout(800); // label fade-in (wall clock rAF)
        const label = await page.evaluate(() => {
          const el = document.querySelector('.scene-label');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { opacity: +getComputedStyle(el).opacity, text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
        });
        s.label = label;
        if (!label || !(label.opacity > 0.2) || !label.text) {
          throw new Error(`hover label did not surface (${JSON.stringify(label)})`);
        }
        if (label.y < 0 || label.y + label.h > 540 || label.x < 0 || label.x + label.w > 960) {
          throw new Error(`hover label off-viewport (${JSON.stringify(label)})`);
        }
        await shot('label.png');

        // -- URL round-trip: serialize -> reload -> serialize must match
        const ser = await page.evaluate(() => window.__menagerie.controls.serialize());
        s.serialized = ser;
        await page.goto(`${server.origin}/?fixedstep=1#${encodeURIComponent(ser)}`, {
          waitUntil: 'load', timeout: 90000,
        });
        await page.waitForFunction(
          () => window.__menagerie && window.__menagerie.clock && typeof window.__menagerie.clock.stepMany === 'function',
          null, { timeout: 90000 },
        );
        await step(60);
        const ser2 = await page.evaluate(() => window.__menagerie.controls.serialize());
        if (ser2 !== ser) throw new Error(`URL round-trip drifted:\n  before ${ser}\n  after  ${ser2}`);
        const glowBack = await page.evaluate(() => window.__menagerie.controls.getParam('c1', 'glow'));
        s.roundTrip = { glow: { set: s.knobs.glow.after, restored: glowBack } };
        if (!(Math.abs(glowBack - s.knobs.glow.after) < 0.02)) {
          throw new Error(`round-trip glow ${s.knobs.glow.after} -> ${glowBack}`);
        }
      });

      // ---- 12. Phase E atmosphere: shafts + sediment, per preset ----------
      // Pretty shots with the full board first, then a creature-free
      // measurement phase (moving creatures/plankton would corrupt the
      // on/off pixel diffs).
      await scenario('atmosphere', async (s) => {
        await load(`fixedstep=1&board=${encodeURIComponent('kelp,jellyfish,eel')}`);
        await page.waitForFunction(
          () => window.__menagerie.ui && typeof window.__menagerie.ui.forceAmbient === 'function',
        );
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(true)); // chrome-free canvas
        await page.waitForTimeout(1700);
        await step(300); // formations + moonlit trails settle
        await shot('atm-moonlit.png');
        const snapPreset = (n) =>
          page.evaluate((p) => window.__menagerie.controls.setPreset(p, { snap: true }), n);
        await snapPreset('shallows');
        await step(200);
        await shot('atm-shallows.png');
        await snapPreset('abyss');
        await step(260); // abyss trails are long (k 0.06) — let them settle
        await shot('atm-abyss.png');

        // -- measurement phase: empty water, plankton off. setPreset re-applies
        // the preset's planktonAlpha, so plankton is re-zeroed after every snap.
        await page.evaluate(() => window.__menagerie.test.releaseAll());
        const measPreset = async (n) => {
          await snapPreset(n);
          await page.evaluate(() => window.__menagerie.test.setPlankton(0));
        };
        // caustics present in shallows: upper-third light on vs off
        await measPreset('shallows');
        await step(150);
        const shalOn = await pngStats(await shot('atm-meas-shallows-on.png'), 'top');
        await page.evaluate(() => window.__menagerie.atmosphere.caustics.setIntensity(0));
        await step(120); // trails flush the shaft light
        const shalOff = await pngStats(await shot('atm-meas-shallows-off.png'), 'top');
        s.causticsTopDelta = shalOn.meanLuma - shalOff.meanLuma;
        if (!(s.causticsTopDelta > 0.5)) {
          throw new Error(`caustics not visible in shallows: top meanLuma ${shalOn.meanLuma.toFixed(2)} -> ${shalOff.meanLuma.toFixed(2)}`);
        }
        // sediment present in abyss: lower-third lit pixels on vs off
        await measPreset('abyss');
        await step(260);
        const abysOn = await pngStats(await shot('atm-meas-abyss-on.png'), 'bottom');
        await page.evaluate(() => window.__menagerie.atmosphere.sediment.setIntensity(0));
        await step(240);
        const abysOff = await pngStats(await shot('atm-meas-abyss-off.png'), 'bottom');
        s.sedimentLitDelta = abysOn.litCount - abysOff.litCount;
        if (!(s.sedimentLitDelta > 50)) {
          throw new Error(`sediment not visible in abyss: bottom lit ${abysOn.litCount} -> ${abysOff.litCount}`);
        }
        // ink: atmosphere must be absent — extinguishing it changes nothing
        await measPreset('ink');
        await step(120);
        const inkVals = await page.evaluate(() => window.__menagerie.controls.sceneValues());
        s.ink = { caustics: inkVals.caustics, sediment: inkVals.sediment };
        if (inkVals.caustics > 0.01) throw new Error(`ink still has caustics: ${inkVals.caustics}`);
        const inkOnTop = await pngStats(await shot('atm-meas-ink.png'), 'top');
        const inkOnBot = await pngStats(await shot('atm-meas-ink2.png'), 'bottom');
        await page.evaluate(() => window.__menagerie.atmosphere.setIntensity(0));
        await step(120);
        const inkOffBuf = await shot('atm-meas-ink-off.png');
        const inkOffTop = await pngStats(inkOffBuf, 'top');
        const inkOffBot = await pngStats(inkOffBuf, 'bottom');
        s.inkTopDelta = inkOnTop.meanLuma - inkOffTop.meanLuma;
        s.inkBotLitDelta = inkOnBot.litCount - inkOffBot.litCount;
        if (Math.abs(s.inkTopDelta) > 0.3 || Math.abs(s.inkBotLitDelta) > 40) {
          throw new Error(`ink is not atmosphere-free: topDelta ${s.inkTopDelta.toFixed(2)}, bottomLitDelta ${s.inkBotLitDelta}`);
        }
      });

      // ---- 13. Phase E feeding: a dropped mote pulls the swimmer in -------
      await scenario('feeding', async (s) => {
        await load('fixedstep=1&board=fish');
        await step(280); // formation completes, fish roams
        const drop = await page.evaluate(() => {
          const m = window.__menagerie;
          const a = m.controls.screenAnchor('c1');
          const x = Math.min(Math.max(a.x + 90, 80), innerWidth - 80);
          const y = Math.min(Math.max(a.y - 60, 80), innerHeight - 140);
          m.feeding.drop(x, y);
          return { p: m.test.creaturePos('c1'), mote: m.feeding.getMote() };
        });
        const d0 = Math.hypot(drop.p.x - drop.mote.x, drop.p.y - drop.mote.y, drop.p.z - drop.mote.z);
        s.distStart = d0;
        let eaten = false;
        let dMin = d0;
        for (let i = 0; i < 12; i++) {
          await step(30); // 0.5 s sim-time per check
          if (i === 1) await shot('feeding.png'); // mid-race
          const r = await page.evaluate(() => {
            const m = window.__menagerie;
            return { p: m.test.creaturePos('c1'), mote: m.feeding.getMote() };
          });
          if (!r.mote || r.mote.phase !== 'sink') {
            eaten = true; // consumed (burst) — the strongest convergence proof
            break;
          }
          dMin = Math.min(dMin, Math.hypot(r.p.x - r.mote.x, r.p.y - r.mote.y, r.p.z - r.mote.z));
        }
        s.eaten = eaten;
        s.distMin = dMin;
        if (!eaten && !(dMin < d0 * 0.55)) {
          throw new Error(`swimmer did not converge on the mote: ${d0.toFixed(0)} -> min ${dMin.toFixed(0)} world px`);
        }
      });

      // ---- 14. Phase E capture: PNG blob + 2 s WebM recording -------------
      await scenario('capture', async (s) => {
        await load('fixedstep=1&board=eel');
        await step(150);
        const downloads = [];
        page.on('download', (d) => downloads.push(d));
        const pngBytes = await page.evaluate(() =>
          window.__menagerie.capture.snapshotPNG().then((b) => b.size),
        );
        s.pngBytes = pngBytes;
        if (!(pngBytes > 5000)) throw new Error(`snapshotPNG blob too small: ${pngBytes} bytes`);
        const started = await page.evaluate(() => window.__menagerie.capture.toggleRecording());
        if (!started) throw new Error('toggleRecording did not start');
        // ~2 s wall-clock of recording; frames come from the fixed-step clock
        for (let i = 0; i < 7; i++) {
          await step(20);
          await page.waitForTimeout(300);
        }
        if (!(await page.evaluate(() => window.__menagerie.capture.isRecording()))) {
          throw new Error('recording stopped early');
        }
        await page.evaluate(() => window.__menagerie.capture.toggleRecording());
        const t0 = Date.now();
        let webm = null;
        while (!webm && Date.now() - t0 < 20000) {
          webm = downloads.find((d) => d.suggestedFilename().endsWith('.webm'));
          if (!webm) await page.waitForTimeout(250);
        }
        if (!webm) throw new Error('no .webm download arrived after stop');
        const webmStat = await fs.stat(await webm.path());
        s.webmBytes = webmStat.size;
        if (!(webmStat.size > 1000)) throw new Error(`webm too small: ${webmStat.size} bytes`);
      });

      // ---- 15. Phase E extended soak: 2000 steps at bio-bay (bloom 0.75 +
      // full atmosphere), then extinguish — trails must still reach the
      // creature-free baseline within the Phase B bound (+6). Bloom reads the
      // trail output and never feeds back, and this proves it. --------------
      await scenario('soakE', async (s) => {
        const extinguish = () =>
          page.evaluate(() => {
            const m = window.__menagerie;
            m.test.releaseAll();
            m.controls.setPreset('ink', { snap: true });
            m.atmosphere.setIntensity(0);
            m.test.setPlankton(0);
            m.test.setTrails(0.99);
          });
        await load('fixedstep=1&board=eel');
        await extinguish();
        await step(300);
        const baseBuf = await shot('soakE-baseline.png');
        await load(`fixedstep=1&board=${encodeURIComponent('jellyfish,kelp,eel,fish')}`);
        await page.evaluate(() =>
          window.__menagerie.controls.setPreset('bioluminescent bay', { snap: true }),
        );
        await step(2000); // ~33 s sim-time under bloom + atmosphere
        const fullBuf = await shot('soakE-full.png');
        const full = await pngStats(fullBuf, 'full');
        s.fullBlownFrac = full.blownFrac;
        if (full.blownFrac > 0.08) {
          throw new Error(`bio-bay soak blowout: ${(full.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
        }
        await extinguish();
        await step(300);
        const stc = await pngStats(await shot('soakE-decayed.png'), 'central');
        const bsc = await pngStats(baseBuf, 'central');
        s.maxCentralChannelAfterDecay = stc.maxChannel;
        s.baselineMaxChannel = bsc.maxChannel;
        s.bound = 6;
        if (stc.maxChannel - bsc.maxChannel > 6) {
          throw new Error(`soakE: central channel ${stc.maxChannel}/255 vs baseline ${bsc.maxChannel}/255 after decay (bound +6)`);
        }
      });

    } finally {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } else {
    for (const name of ['duo', 'swaySweep', 'ray', 'pileup', 'soak', 'sweep', 'solo', 'controls', 'atmosphere', 'feeding', 'capture', 'soakE']) {
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
