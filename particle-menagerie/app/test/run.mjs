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

      // Two PNGs, same size, compared in the browser's decoder like pngStats.
      // Returns how much of the central box actually MOVED between them and
      // where the light is in each — the pair a "does it stroke, or is it a
      // pose?" question needs: a stroke changes the pixels while leaving the
      // body where it was.
      const pngPair = (bufA, bufB) =>
        page.evaluate(
          async ([a64, b64]) => {
            const dec = async (b64) => {
              const img = new Image();
              img.src = 'data:image/png;base64,' + b64;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              const g = c.getContext('2d', { willReadFrequently: true });
              g.drawImage(img, 0, 0);
              const x = img.width >> 2, y = img.height >> 2;
              const w = img.width >> 1, h = img.height >> 1;
              return { d: g.getImageData(x, y, w, h).data, w, h };
            };
            const A = await dec(a64);
            const B = await dec(b64);
            let changed = 0;
            let sumAbs = 0;
            const cen = (P) => {
              let sx = 0, sy = 0, s = 0;
              for (let i = 0, p = 0; i < P.d.length; i += 4, p++) {
                const l = (P.d[i] + P.d[i + 1] + P.d[i + 2]) / 3;
                if (l <= 25) continue;
                sx += (p % P.w) * l; sy += ((p / P.w) | 0) * l; s += l;
              }
              return s > 0 ? { x: sx / s, y: sy / s, mass: s } : { x: 0, y: 0, mass: 0 };
            };
            // `subject` = pixels either frame considers lit, i.e. the animal
            // and its glow rather than the empty water around it. changedFrac
            // (below) is a fraction of the whole central box, which makes it a
            // function of how BIG the creature is on screen as much as of what
            // changed: a 5 cm lanternfish covers ~0.7% of that box, so a bound
            // of 2% is unreachable for it at any brightness. changedFracSubject
            // asks the question the bio assertion actually means -- of the
            // animal itself, how much of it changed -- and is size-independent.
            let subject = 0;
            for (let i = 0; i < A.d.length; i += 4) {
              const la = (A.d[i] + A.d[i + 1] + A.d[i + 2]) / 3;
              const lb = (B.d[i] + B.d[i + 1] + B.d[i + 2]) / 3;
              const dd = Math.abs(la - lb);
              sumAbs += dd;
              if (dd > 12) changed++;
              if (la > 25 || lb > 25) subject++;
            }
            const px = A.d.length / 4;
            const ca = cen(A);
            const cb = cen(B);
            return {
              changedFrac: changed / px,
              changedFracSubject: subject > 0 ? changed / subject : 0,
              subjectPx: subject,
              meanAbsDiff: sumAbs / px,
              centroidShiftPx: Math.hypot(ca.x - cb.x, ca.y - cb.y),
              massRatio: cb.mass > 0 ? ca.mass / cb.mass : 0,
            };
          },
          [bufA.toString('base64'), bufB.toString('base64')],
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
        // EVERY archetype in creatures.js REGISTRY, which is what makes this
        // the per-archetype rendered-brightness floor. `tetrapod` was left out
        // when it shipped in v3.7, so the one archetype with no v3.6 history
        // was also the one archetype nothing rendered.
        const names = {
          eel: 'eel', medusa: 'jellyfish', fish: 'fish', ray: 'manta ray',
          octo: 'octopus', star: 'starfish', amorph: 'plankton',
          bloom: 'lotus', kelp: 'kelp', tetrapod: 'sea turtle',
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

      // ---- 10b. v3.7 TETRAPODS: does a turtle read as a turtle, and do the
      // flippers STROKE? The archetype shipped with no rendered coverage at
      // all — its only assertion was that the word routes to it. Two frames a
      // quarter-second apart, in the museum pose (speed 0), so a stroke is
      // separable from a translation: the dots must MOVE while the body stays
      // where it is.
      await scenario('tetrapod', async (s) => {
        await load('fixedstep=1&board=eel');
        s.subjects = [];
        for (const [tag, name] of [['turtle', 'sea turtle'], ['penguin', 'emperor penguin']]) {
          await page.evaluate((n) => window.__menagerie.test.solo(n), name);
          await step(200); // formation complete
          const c = (await page.evaluate(() => window.__menagerie.test.creatureDepths()))[0];
          if (!c) throw new Error(`tetrapod: ${name} did not spawn`);
          const a = await shot(`tetrapod-${tag}-a.png`);
          await step(15); // 0.25 s of sim — a quarter of a flipper cycle
          const b = await shot(`tetrapod-${tag}-b.png`);
          const sa = await pngStats(a, 'central');
          const sb = await pngStats(b, 'central');
          const d = await pngPair(a, b);
          const rec = {
            name, arch: c.arch ?? null, kind: c.kind, m: Math.round(c.depthM),
            maxChannel: sa.maxChannel, blownFrac: sa.blownFrac,
            changedFrac: +d.changedFrac.toFixed(4),
            centroidShiftPx: +d.centroidShiftPx.toFixed(2),
            massRatio: +d.massRatio.toFixed(3),
          };
          s.subjects.push(rec);
          // it rendered at all, and it rendered as dots rather than as a lamp
          if (sa.maxChannel < 40) throw new Error(`tetrapod-${tag}: central maxChannel ${sa.maxChannel} — nothing there`);
          if (sa.blownFrac > 0.08 || sb.blownFrac > 0.08) {
            throw new Error(`tetrapod-${tag}: ${(Math.max(sa.blownFrac, sb.blownFrac) * 100).toFixed(2)}% blown (bound 8%)`);
          }
          // THE STROKE: measurable motion between the two frames...
          if (!(d.changedFrac > 0.004)) {
            throw new Error(`tetrapod-${tag}: only ${(d.changedFrac * 100).toFixed(2)}% of the frame moved in 0.25 s — the limbs are a pose, not a stroke`);
          }
          // ...that is a limb cycle and not the whole animal sliding past
          if (!(d.centroidShiftPx < 12)) {
            throw new Error(`tetrapod-${tag}: the body moved ${d.centroidShiftPx.toFixed(1)} px in 0.25 s — that is swimming past, not stroking`);
          }
          // and the body did not gain or lose itself between the two frames
          if (!(d.massRatio > 0.72 && d.massRatio < 1.4)) {
            throw new Error(`tetrapod-${tag}: lit mass changed ${d.massRatio.toFixed(2)}x between adjacent frames`);
          }
        }
      });

      // ---- 10c. v3.7 BIOLUMINESCENCE: the light an animal MAKES ----------
      // Nothing in v3.7 ever rendered a lit creature: every `bio` reference in
      // this file was either a weather preset or a data-flag assertion, so
      // "does it read as making light, and does it blow out" had no evidence
      // either way. This shoots each pattern mode at the depth its own species
      // actually lives at, twice — once with the layer's documented global
      // dimmer at whatever the water gives it, once with that dimmer forced to
      // 0, which is bit-for-bit the v3.6 creature. The lit species must differ
      // between the two; the researched non-luminous control (barreleye, which
      // watches other animals' light and makes none) must not.
      await scenario('bio', async (s) => {
        const CASES = [
          // tag, name, expected pattern
          ['rows', 'lanternfish', 'photophore rows'],
          ['rowsdeep', 'bristlemouth', 'photophore rows'],
          ['lure', 'anglerfish', 'lure'],
          ['pulse', 'atolla jellyfish', 'pulse'],
          ['control', 'barreleye', 'dark'],
        ];
        const shoot = async (gain) => {
          await load('fixedstep=1&board=eel');
          await page.waitForFunction(() => window.__menagerie.column);
          await page.evaluate(() => window.__menagerie.ui.forceAmbient(true));
          await page.waitForTimeout(1400);
          if (gain != null) await page.evaluate((g) => window.__menagerie.test.setBioGain(g), gain);
          const out = {};
          for (const [tag, name] of CASES) {
            await page.evaluate((n) => window.__menagerie.test.solo(n), name);
            await step(220);
            const buf = await shot(`bio-${tag}${gain == null ? '' : '-off'}.png`);
            const c = (await page.evaluate(() => window.__menagerie.test.creatureDepths()))[0];
            out[tag] = { buf, stats: await pngStats(buf, 'central'), c };
          }
          return out;
        };
        const on = await shoot(null);
        const off = await shoot(0);
        s.subjects = [];
        for (const [tag, name, pattern] of CASES) {
          const A = on[tag];
          const B = off[tag];
          if (!A.c) throw new Error(`bio: ${name} did not spawn`);
          const d = await pngPair(A.buf, B.buf);
          const rec = {
            name, m: Math.round(A.c.depthM), lit: A.c.lit, pattern: A.c.bioPattern,
            maxChannel: A.stats.maxChannel, blownFrac: A.stats.blownFrac,
            meanLuma: +A.stats.meanLuma.toFixed(2),
            deltaMeanLuma: +(A.stats.meanLuma - B.stats.meanLuma).toFixed(3),
            changedFrac: +d.changedFrac.toFixed(4),
            changedFracSubject: +d.changedFracSubject.toFixed(4),
            subjectPx: d.subjectPx,
          };
          s.subjects.push(rec);
          if (A.c.bioPattern !== pattern) throw new Error(`bio: ${name} renders pattern '${A.c.bioPattern}', expected '${pattern}'`);
          // it is DARK down there, which is the whole premise of the layer
          if (tag !== 'rows' && !(A.c.depthM > 300)) {
            throw new Error(`bio: ${name} placed at ${A.c.depthM.toFixed(0)} m — this shot has to be in the dark`);
          }
          if (A.stats.maxChannel < 40) throw new Error(`bio-${tag}: central maxChannel ${A.stats.maxChannel} — nothing rendered`);
          // "intense against black" is a budget, not a licence: the same
          // additive bound the rest of the app lives under.
          if (A.stats.blownFrac > 0.08) throw new Error(`bio-${tag}: ${(A.stats.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
          if (B.stats.blownFrac > 0.08) throw new Error(`bio-${tag}-off: ${(B.stats.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
          if (A.c.lit) {
            // The layer must be DOING something — this is exactly the check the
            // first v3.7 draft would have failed (it measured under 1.5%).
            //
            // v3.8 measures it against the ANIMAL rather than against the box.
            // The old bound was 2% of the central box, which silently required
            // the creature to be big on screen: once fish.js gave the
            // lanternfish a real 5 cm size (scale 0.35) it covered ~0.7% of
            // that box, so no amount of light could have passed — the test was
            // reading creature size, not luminosity. 20% of the animal's own
            // lit footprint is a strictly harder question for a dark draft to
            // pass (it changed almost nothing ANYWHERE, so it fails either
            // form) and is independent of how large the subject is.
            if (!(d.changedFracSubject > 0.2)) {
              throw new Error(`bio-${tag}: turning the layer off changes only ${(d.changedFracSubject * 100).toFixed(2)}% of ${name}'s own lit footprint (${d.subjectPx} px) — it is indistinguishable from a non-luminous animal`);
            }
          } else {
            // the control anchors the measurement: no light, no difference
            if (d.changedFracSubject > 0.02) {
              throw new Error(`bio-control: ${name} makes no light but ${(d.changedFracSubject * 100).toFixed(2)}% of its footprint changed when the light layer was switched off`);
            }
          }
        }
        const litOnes = s.subjects.filter((x) => x.lit);
        if (litOnes.length < 4) throw new Error(`bio: only ${litOnes.length} of the four lit patterns rendered lit`);
      });

      // ---- 11. Phase D controls: chrome + every plate knob + presets +
      // summon path + ambient + hover label + URL round-trip ---------------
      await scenario('controls', async (s) => {
        // inspector=off: v3.6 raises the specimen modal on selection, which
        // would sit over the plate this scenario drives. The modal carries its
        // own copy of these controls and is covered by its own checks.
        await load(`fixedstep=1&inspector=off&board=${encodeURIComponent('jellyfish,manta')}`);
        await page.waitForFunction(
          () => window.__menagerie.ui && typeof window.__menagerie.ui.forceAmbient === 'function',
        );
        await step(260); // ~4.3s sim: formations complete

        // -- select creature c1 (jellyfish) -> gauge plate surfaces
        // (stepping burns wall-clock; under software GL the 260 steps can
        // exceed the 33s idle threshold and sink the chrome — wake it first)
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(false));
        await page.waitForTimeout(750);
        await page.evaluate(() => window.__menagerie.controls.select('c1'));
        await page.waitForTimeout(650); // 400ms rise + anchor settle (wall clock)
        await step(20);
        await shot('plate-open.png');

        // -- v3.2: drive every INTENT axis by clicking a notch; assert both
        // the named word AND the underlying params actually changed. A row
        // whose word moves but whose params don't is the new dead knob.
        s.intents = {};
        const axes = await page.evaluate(() => window.__menagerie.controls.intentAxes());
        if (!axes.length) throw new Error('no intent axes exposed');
        const readAxis = (axis) =>
          page.evaluate(
            (a) => {
              const c = window.__menagerie.controls;
              const params = {};
              for (const k of a.keys) params[k] = c.getParam('c1', k);
              return { word: c.getIntent('c1', a.id), params };
            },
            { id: axis.id, keys: axis.keys },
          );
        for (const axis of axes) {
          const before = await readAxis(axis);
          // pick a notch that is NOT the current one (last, else first)
          const n = axis.options.length;
          const curIdx = axis.options.indexOf(before.word);
          const target = curIdx === n - 1 ? 0 : n - 1;
          await page.locator(`#plate .plate-row[data-axis="${axis.id}"] .plate-notch[data-i="${target}"]`).click();
          await page.waitForTimeout(500); // needle spring settles (wall clock)
          const after = await readAxis(axis);
          const paramsChanged = axis.keys.some(
            (k) => String(after.params[k]) !== String(before.params[k]),
          );
          s.intents[axis.id] = { before: before.word, after: after.word, paramsChanged };
          if (after.word === before.word) throw new Error(`dead intent: ${axis.id} word never changed (${before.word})`);
          if (!paramsChanged) throw new Error(`dead intent: ${axis.id} changed its word (${before.word} -> ${after.word}) but no engine param moved`);
        }

        await page.locator('#plate .plate-swatch').nth(3).click(); // hue 185 (cyan)
        const hue = await page.evaluate(() => window.__menagerie.controls.getParam('c1', 'color'));
        s.color = hue;
        if (hue !== 185) throw new Error(`dead knob: color swatch (got ${hue})`);
        await step(20); // recolor lands in the frame
        await shot('plate-intents.png'); // v3.2: all intent rows set, color applied

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
        // inside the viewport (c1 is now giant and rides the right edge).
        //
        // v3.4: creatures no longer scatter over the screen's height — they sit
        // at their species' depth, so on a two-species board whichever one is
        // framed is near the middle of the porthole and a giant one can shove
        // its schoolmate anywhere. The vessel is the answer: pick the smallest
        // body that is horizontally in frame, then TRIM THE DEPTH so it sits in
        // the lower-middle where the label has room. That is framing with the
        // instrument the release added, not a relaxed bound — the assertions
        // below are unchanged and still demand a fully on-viewport label.
        const hoverId = await page.evaluate(() => {
          const m = window.__menagerie;
          const anchors = [];
          for (const c of m.test.creatureList()) {
            const an = m.controls.screenAnchor(c.id);
            if (!an || !(an.x > 80 && an.x < innerWidth - 120)) continue;
            anchors.push({ id: c.id, r: an.radiusPx, x: an.x, y: an.y });
          }
          // v3.7: prefer an ISOLATED body. On a two-species board the vessel
          // now frames one species' depth, so both members of a pair can land
          // on top of each other and the pointer sits inside two hit circles at
          // once. The assertions below are about the LABEL (it surfaced, it
          // named something, it fits on the viewport); which of two coincident
          // bodies won the hit test is not the thing under test, so the target
          // is chosen to make that question not arise. NOTE: an earlier version
          // of this comment blamed labels.js's 150 ms stability debounce for a
          // flicker. That mechanism is not real — effWant is acquired
          // immediately from null and hitTest only re-runs on pointermove,
          // which the harness does exactly once — and the claim is retracted
          // here rather than left standing. No bound moved: the assertions are
          // byte-identical to v3.6's.
          let best = null;
          for (const a of anchors) {
            let near = Infinity;
            for (const o of anchors) {
              if (o.id === a.id) continue;
              near = Math.min(near, Math.hypot(a.x - o.x, a.y - o.y) - a.r - o.r);
            }
            const score = { id: a.id, r: a.r, y: a.y, near };
            if (!best || near > best.near + 20 || (Math.abs(near - best.near) <= 20 && a.r < best.r)) {
              best = score;
            }
          }
          if (!best) return null;
          const wantY = innerHeight * 0.6; // lower-middle: room for the label above
          if (best.y - best.r <= 60 || best.y > innerHeight - 120) {
            // CSS px the body must move DOWN the frame -> metres the vessel
            // must RISE (world y = -depth, so a shallower camera drops it)
            const dy = wantY - best.y;
            const info = m.test.depthInfo();
            m.test.setDepth(info.depth - dy * 0.2, true);
          }
          return best.id;
        });
        if (!hoverId) throw new Error('no hoverable creature horizontally in view');
        await step(12); // the trimmed depth lands in a rendered frame
        const a = await page.evaluate((id) => {
          const an = window.__menagerie.controls.screenAnchor(id);
          if (an && an.x > 80 && an.x < innerWidth - 120 && an.y - an.radiusPx > 60 && an.y < innerHeight - 120) return an;
          return null;
        }, hoverId);
        if (!a) throw new Error('no hoverable creature fully in view');
        await page.mouse.move(a.x, a.y);
        await page.waitForTimeout(1400); // label fade-in (wall clock rAF)
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
        // v3.2: the intents chosen above must survive the round-trip, both as
        // engine params and as the words the plate re-derives from them.
        const back = await page.evaluate(
          (ids) => {
            const c = window.__menagerie.controls;
            const out = {};
            for (const id of ids) out[id] = c.getIntent('c1', id);
            return out;
          },
          Object.keys(s.intents),
        );
        s.roundTrip = { intents: back, expected: Object.fromEntries(Object.entries(s.intents).map(([k, v]) => [k, v.after])) };
        for (const [id, word] of Object.entries(s.roundTrip.expected)) {
          if (back[id] !== word) throw new Error(`round-trip intent ${id}: ${word} -> ${back[id]}`);
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
        if (!(s.sedimentLitDelta > 40)) {
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

      // ---- 13. v3.2 gather: a click summons the menagerie WITHIN EARSHOT ---
      // Asserts (a) every swimmer/drifter inside the beacon's reach closes on
      // it, (b) a sleeping creature is exempt, (c) they spread around the point
      // rather than stacking, (d) after the beacon expires they resume roaming.
      //
      // v3.4: the world is 1200 m tall, so "the WHOLE menagerie" stopped being
      // a coherent ask — an octopus at 565 m cannot visit a beacon at 150 m
      // inside the beacon's ~12 s life, and asking it to would mean species
      // bands are decorative. The beacon now carries ~2 screens of water
      // (test.gatherReachPx). The convergence bound is UNCHANGED (every mover
      // in reach must close to <75% of its starting distance) and the scenario
      // gains a stricter one: a creature out of reach must still be out of
      // reach at the end, i.e. it never left its own water to answer.
      await scenario('gather', async (s) => {
        // v3.7: the beacon reaches through the WATER, and the water is now 36 km
        // wide as well as 1200 m deep — seven unrelated species live seven
        // different places on the transect and no one summons could honestly
        // reach them all. So the crowd is a SCHOOL, which is one group in one
        // patch of ocean by construction, and the anglerfish (500-1190 m, out
        // over the slope) is still the creature living far outside earshot no
        // matter where the vessel is looking. Every assertion below is
        // unchanged; only the board it is asked of is.
        await load('fixedstep=1&board=school%20of%20fish,jellyfish,kelp,anglerfish');
        await step(340); // formations complete, swimmers roam apart
        const setup = await page.evaluate(() => {
          const m = window.__menagerie;
          const reach = m.test.gatherReachPx();
          // the beacon goes where a CLICK would put it: beside the porthole, at
          // the depth the vessel is looking at — and, from v3.7, at the vessel's
          // own place on the transect. A click 260 px right of centre is 260 px
          // right of the VESSEL; world x = 260 is a fixed point 18 km offshore.
          const pt = { x: m.column.camX() + 260, y: m.column.camY() - 40, z: -60 };
          const list = m.test.creatureList();
          // mirrors main.js's own reach test, both axes
          const inReach = (c) => Math.abs(c.y - pt.y) <= reach && Math.abs(c.x - pt.x) <= reach * 1.8;
          // put one swimmer that IS in reach to sleep — it must not answer
          const sleeper = list.find((c) => c.klass === 'swimmer' && inReach(c));
          if (sleeper) m.controls.setParam(sleeper.id, 'behavior', 'sleep');
          m.gather.setPoint(pt.x, pt.y, pt.z);
          return { list: m.test.creatureList(), sleeperId: sleeper ? sleeper.id : null, pt, reach };
        });
        const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
        const d0 = new Map(setup.list.map((c) => [c.id, dist(c, setup.pt)]));
        const inReach0 = new Set(
          setup.list
            .filter(
              (c) =>
                Math.abs(c.y - setup.pt.y) <= setup.reach
                && Math.abs(c.x - setup.pt.x) <= setup.reach * 1.8,
            )
            .map((c) => c.id),
        );
        const sleeperStart = setup.list.find((c) => c.id === setup.sleeperId);
        await step(40);
        await shot('gather-converge.png');
        await step(200); // ~4 s sim-time of converging
        const mid = await page.evaluate(() => window.__menagerie.test.creatureList());
        await shot('gather-converge.png');

        const all = mid.filter((c) => c.klass !== 'rooted' && c.id !== setup.sleeperId);
        const movers = all.filter((c) => inReach0.has(c.id));
        const deaf = all.filter((c) => !inReach0.has(c.id));
        const closed = movers.filter((c) => dist(c, setup.pt) < d0.get(c.id) * 0.75);
        s.reachPx = Math.round(setup.reach);
        s.movers = movers.length;
        s.closed = closed.length;
        s.outOfReach = deaf.length;
        s.distances = movers.map((c) => ({ id: c.id, from: Math.round(d0.get(c.id)), to: Math.round(dist(c, setup.pt)) }));
        if (movers.length < 3) throw new Error(`gather: expected several swimmers in reach, saw ${movers.length}`);
        if (closed.length < movers.length) {
          throw new Error(`gather: only ${closed.length}/${movers.length} creatures closed on the beacon: ${JSON.stringify(s.distances)}`);
        }
        // the column is real: a creature living outside earshot stays there
        if (!deaf.length) throw new Error('gather: board no longer has an out-of-reach creature to test against');
        for (const c of deaf) {
          // v3.7: out of reach is a distance in the WATER, so the test is the
          // same disjunction the app applies — either axis alone is enough to
          // put a creature out of earshot, and it has to stay out.
          const dy = Math.abs(c.y - setup.pt.y);
          const dx = Math.abs(c.x - setup.pt.x);
          if (dy <= setup.reach * 0.75 && dx <= setup.reach * 1.8 * 0.75) {
            throw new Error(`gather: an out-of-reach creature (${c.id}) came ${Math.round(dy)}px / ${Math.round(dx)}px of the beacon — bands are not holding`);
          }
        }
        // sleeper exemption
        if (sleeperStart) {
          const now = mid.find((c) => c.id === setup.sleeperId);
          const drift = now ? dist(now, sleeperStart) : 0;
          s.sleeperDrift = Math.round(drift);
          const sleeperClosed = now && dist(now, setup.pt) < d0.get(setup.sleeperId) * 0.75;
          if (sleeperClosed) throw new Error('gather: a sleeping creature answered the summons (it must not wake)');
        }
        // spread: they must mill AROUND the point, not stack on one pixel
        const spread = Math.max(...movers.map((c) => dist(c, setup.pt)));
        s.spreadPx = Math.round(spread);
        if (!(spread > 12)) throw new Error(`gather: creatures stacked on the point (max radius ${spread.toFixed(0)}px)`);
        // resume: past the beacon's life they go back to their own business
        await step(700); // ~12 s sim-time — beacon expires, crowd disperses
        const after = await page.evaluate(() => ({
          list: window.__menagerie.test.creatureList(),
          active: window.__menagerie.gather.active(),
        }));
        s.beaconActiveAfter = after.active;
        const dispersed = after.list
          .filter((c) => c.klass !== 'rooted' && inReach0.has(c.id))
          .some((c) => dist(c, setup.pt) > 40);
        if (after.active) throw new Error('gather: beacon never expired');
        if (!dispersed) throw new Error('gather: creatures never resumed roaming after the beacon expired');
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
        // v3.5: the background is a WATER COLUMN, so its brightness depends on
        // the vessel's depth. The baseline and the decayed frame must therefore
        // be captured at the SAME depth or the comparison measures the water,
        // not the trails — which is exactly what a 199-vs-234 "leak" turned out
        // to be. Pin both to one depth.
        const SOAK_DEPTH_M = 240;
        // v3.7 extends that same reasoning to the second axis. The two loads
        // carry different boards, so they frame different stretches of the
        // TRANSECT, and 240 m over the inner shelf is a metre off the seabed
        // while 240 m over the abyssal plain is open water — the "leak" would
        // be the seabed sheet, measured once and not the other time. Pin both
        // to one PLACE as well as one depth: the far offshore end, where the
        // floor is 1200 m down and 240 m is mid-water with nothing in frame.
        const SOAK_SHORE_M = 34000;
        const extinguish = () =>
          page.evaluate(([depthM, shoreM]) => {
            const m = window.__menagerie;
            m.test.releaseAll();
            m.controls.setPreset('ink', { snap: true });
            m.atmosphere.setIntensity(0);
            m.test.setPlankton(0);
            m.test.setTrails(0.99);
            // shore FIRST: the navigable depth range is the water under the
            // vessel, so commanding the depth against the wrong stretch of
            // transect would clamp it against a floor it is about to leave.
            if (m.test.setShore) m.test.setShore(shoreM, true);
            if (m.test.setDepth) m.test.setDepth(depthM, true);
          }, [SOAK_DEPTH_M, SOAK_SHORE_M]);
        await load('fixedstep=1&board=eel');
        await extinguish();
        await step(300);
        const baseBuf = await shot('soakE-baseline.png');
        await load(`fixedstep=1&board=${encodeURIComponent('jellyfish,kelp,eel,fish')}`);
        await page.evaluate(([depthM, shoreM]) => {
          window.__menagerie.controls.setPreset('bioluminescent bay', { snap: true });
          if (window.__menagerie.test.setShore) window.__menagerie.test.setShore(shoreM, true);
          if (window.__menagerie.test.setDepth) window.__menagerie.test.setDepth(depthM, true);
        }, [SOAK_DEPTH_M, SOAK_SHORE_M]);
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

      // ---- 16. Phase F resize torture: 960x540 -> 1440x900 -> 700x400 -----
      // Each stage must leave the frame correct: backing buffer matches the
      // CSS aspect (no stretch), creatures still render (camera/targets/fog
      // scale all re-derived), and the board survives the sequence.
      await scenario('resize', async (s) => {
        await load(`fixedstep=1&board=${encodeURIComponent('jellyfish,kelp,eel')}`);
        await step(300); // formations + moonlit trails settle at 960x540
        s.stages = {};
        for (const [w, h] of [[1440, 900], [700, 400]]) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(150); // resize event -> onResize lands
          await step(150); // trails re-fill the fresh (flushed) targets
          const buf = await shot(`resize-${w}x${h}.png`);
          const st = await pngStats(buf, 'full');
          const geom = await page.evaluate(() => {
            const c = document.getElementById('scene');
            return { bw: c.width, bh: c.height, cw: innerWidth, ch: innerHeight };
          });
          s.stages[`${w}x${h}`] = { maxChannel: st.maxChannel, litCount: st.litCount, ...geom };
          if (st.width !== w || st.height !== h) {
            throw new Error(`resize ${w}x${h}: screenshot is ${st.width}x${st.height}`);
          }
          const aspectErr = Math.abs(geom.bw / geom.bh - geom.cw / geom.ch);
          if (aspectErr > 0.02) {
            throw new Error(`resize ${w}x${h}: stretched aspect — backing ${geom.bw}x${geom.bh} vs css ${geom.cw}x${geom.ch}`);
          }
          if (st.maxChannel < 40) {
            throw new Error(`resize ${w}x${h}: maxChannel ${st.maxChannel} — creatures missing after resize`);
          }
        }
        await page.setViewportSize({ width: 960, height: 540 }); // leave as found
      });

      // ---- 17. v3.4 the water column -------------------------------------
      // The world is now a 1200 m vertical shaft of ocean that the camera
      // travels through. This scenario proves the four things that makes true:
      //   (a) the four zones LOOK different — a surface frame, a mid-water
      //       frame, a deep frame and a seabed frame are separated by mean-luma
      //       and lit-pixel deltas, not by a label;
      //   (b) species live at their own depth — flora is planted on the seabed
      //       relief, a surface species is in the sunlit zone — and they STAY
      //       there while the vessel travels past them;
      //   (c) the vessel EASES to a commanded depth (it is a submarine, not a
      //       cut) and stops short of both the waterline and the floor;
      //   (d) determinism survives: the same hash at the same depth renders the
      //       same frame, byte for byte.
      // Step counts are deliberately lean — this is software GL.
      await scenario('column', async (s) => {
        // A board that spans the whole column: air-breather / twilight drifter
        // / abyssal predator / flora rooted on the LIT SHELF.
        // v3.5: kelp used to be this board's deep anchor, back when every
        // rooted plant was planted on the 1200 m plain. It is photosynthetic,
        // so it now lives in the shallows and an anglerfish carries the deep
        // end instead — which is the whole point of the ecology fix.
        const board = 'dolphin,jellyfish,kelp,anglerfish';
        await load(`fixedstep=1&board=${encodeURIComponent(board)}`);
        await page.waitForFunction(() => window.__menagerie.column);
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(true)); // chrome-free canvas
        await page.waitForTimeout(1600);
        await step(240); // formations complete

        // v3.7 PRECONDITION, not a relaxation. The world gained a horizontal
        // axis, and the navigable DEPTH range is now the water actually under
        // the vessel: over the inner shelf it is 26 m deep, so "the column" is
        // only a 1200 m journey where the ocean is 1200 m deep. Park at the far
        // offshore end — which is exactly where v3.6's whole world sat, world
        // x = 0 — and every assertion below is the v3.6 assertion unchanged.
        await page.evaluate(() => {
          const t = window.__menagerie.test;
          t.setShore(t.shoreInfo().max, true);
        });
        await step(2);

        // -- (b) the world model + where the board actually lives ------------
        const info0 = await page.evaluate(() => window.__menagerie.test.depthInfo());
        s.range = { min: +info0.min.toFixed(1), max: +info0.max.toFixed(1), seabed: info0.seabed };
        if (info0.seabed !== 1200) throw new Error(`column: seabed is ${info0.seabed} m, expected 1200`);
        if (!(info0.min > 0 && info0.max < info0.seabed && info0.max - info0.min > 800)) {
          throw new Error(`column: navigable range ${info0.min}..${info0.max} is not a journey inside the water`);
        }
        // the vessel surfaces framed on the board rather than at a fixed depth
        s.bootDepth = +info0.depth.toFixed(1);

        const depths0 = await page.evaluate(() => window.__menagerie.test.creatureDepths());
        s.creatures = depths0.map((c) => ({ name: c.name, kind: c.kind, m: Math.round(c.depthM) }));
        const kelp = depths0.find((c) => c.name === 'kelp');
        const dolphin = depths0.find((c) => c.name === 'dolphin');
        const jelly = depths0.find((c) => c.name === 'jellyfish');
        const deep = depths0.find((c) => c.name === 'anglerfish');
        if (!kelp || !dolphin || !jelly || !deep) throw new Error(`column: board did not resolve: ${JSON.stringify(s.creatures)}`);
        // rooted flora is PLANTED — its holdfast sits ON or slightly IN the
        // substrate under its own (x, z). v3.5 note: this used to allow up to
        // 140px of LIFT, which is precisely the bug that made every plant hover
        // half a body-length above the floor with open water beneath it. The
        // window is now a small embed: flush, or a few px into the silt, which
        // is where a real holdfast is. Positive lift is a regression.
        if (kelp.kind !== 'rooted') throw new Error(`column: kelp is '${kelp.kind}', expected rooted`);
        const lift = kelp.y - kelp.floorY;
        s.kelp = { depthM: Math.round(kelp.depthM), liftPx: Math.round(lift) };
        if (!(lift >= -24 && lift <= 2)) {
          throw new Error(`column: kelp sits ${lift.toFixed(0)}px off its own substrate (want flush or slightly embedded; positive = hovering)`);
        }
        // v3.5: kelp is PHOTOSYNTHETIC. Its researched range is 0-40 m and it
        // anchors on rock in the lit shallows — this assertion used to demand
        // it be below 1100 m, i.e. on the abyssal plain in permanent darkness,
        // which was the ecology inversion the ocean data exposed. A kelp forest
        // in the abyss is the failure now, not the expectation.
        if (!(kelp.depthM < 60)) {
          throw new Error(`column: kelp is at ${kelp.depthM.toFixed(0)} m — it is photosynthetic and belongs on the lit shelf`);
        }
        // a surface species is in the sunlit zone, an order of magnitude above it
        s.dolphinM = Math.round(dolphin.depthM);
        if (!(dolphin.depthM < 120)) throw new Error(`column: dolphin is at ${dolphin.depthM.toFixed(0)} m — it has to reach air`);
        // The board must genuinely span the column. The deep end is the
        // anglerfish (500-1190 m), not a plant: a species' depth is drawn
        // within its band from its seed, so pinning the span to a mid-water
        // drifter like the jellyfish (40-520 m) would flake by seed.
        s.deepM = Math.round(deep.depthM);
        if (!(deep.depthM > 400)) {
          throw new Error(`column: anglerfish is at ${deep.depthM.toFixed(0)} m — the deep end of the board is missing`);
        }
        if (!(deep.depthM > dolphin.depthM + 300)) {
          throw new Error(`column: the board does not span depth (dolphin ${dolphin.depthM.toFixed(0)} m, anglerfish ${deep.depthM.toFixed(0)} m)`);
        }

        // -- (a) the four zones look different -------------------------------
        const stops = [
          ['surface', info0.min],
          ['mid', 420],
          ['deep', 900],
          ['seabed', info0.max],
        ];
        s.zones = {};
        for (const [tag, m] of stops) {
          await page.evaluate((mm) => window.__menagerie.test.setDepth(mm, true), m);
          await step(80); // trails re-fill after the jump flushes them
          const buf = await shot(`column-${tag}.png`);
          const st = await pngStats(buf, 'full');
          s.zones[tag] = {
            depthM: Math.round(await page.evaluate(() => window.__menagerie.test.depthInfo().depth)),
            zone: await page.evaluate(() => window.__menagerie.test.depthInfo().zone),
            meanLuma: +st.meanLuma.toFixed(2),
            litCount: st.litCount,
            blownFrac: st.blownFrac,
          };
          if (st.blownFrac > 0.08) throw new Error(`column-${tag}: ${(st.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
        }
        const Z = s.zones;
        // sunlit water is unmistakably brighter than the twilight below it...
        if (!(Z.surface.meanLuma > Z.mid.meanLuma + 8)) {
          throw new Error(`column: surface (${Z.surface.meanLuma}) is not visibly brighter than mid-water (${Z.mid.meanLuma})`);
        }
        if (!(Z.surface.litCount > Z.mid.litCount * 4)) {
          throw new Error(`column: surface lit ${Z.surface.litCount} vs mid ${Z.mid.litCount} — the light is not dying with depth`);
        }
        // ...the deep is darker still than mid-water...
        if (!(Z.mid.meanLuma >= Z.deep.meanLuma)) {
          throw new Error(`column: the deep (${Z.deep.meanLuma}) is not at or below mid-water (${Z.mid.meanLuma})`);
        }
        // ...and the seabed is a FLOOR: sediment haze + the dotted plain put
        // measurably more light back into the frame than the black above it
        if (!(Z.seabed.meanLuma > Z.deep.meanLuma + 2 && Z.seabed.litCount > Z.deep.litCount * 3)) {
          throw new Error(`column: the seabed (${Z.seabed.meanLuma} luma, ${Z.seabed.litCount} lit) does not read as a floor over the abyss (${Z.deep.meanLuma}, ${Z.deep.litCount})`);
        }
        if (Z.surface.zone !== 'sunlit' || Z.seabed.zone !== 'abyssal') {
          throw new Error(`column: zone names disagree with the depths (${Z.surface.zone} / ${Z.seabed.zone})`);
        }

        // -- (b cont.) creatures STAYED while the vessel travelled -----------
        const depths1 = await page.evaluate(() => window.__menagerie.test.creatureDepths());
        s.after = depths1.map((c) => ({ name: c.name, m: Math.round(c.depthM) }));
        for (const now of depths1) {
          if (now.homeM == null) continue;
          // The camera has just travelled ~1100 m. A creature may wander inside
          // its own band (a jellyfish's is tens of metres wide) but must still
          // be at HOME — if any of them tracked the porthole this blows up.
          const off = Math.abs(now.depthM - now.homeM);
          if (off > 120) {
            throw new Error(`column: ${now.name} is ${off.toFixed(0)} m from its home depth after the camera travelled 1100 m — it is following the porthole`);
          }
        }
        // ...and the column's vertical order is intact. v3.5 reorders this:
        // the old chain ended at kelp because kelp was the deepest thing on the
        // board, planted on the abyssal plain. With real ranges the stack runs
        // air-breather -> lit-shelf flora -> twilight drifter -> abyssal
        // predator. Kelp vs jellyfish is a genuine ordering (kelp's band tops
        // out at 30-40 m on the shelf; a jellyfish starts at 40 m), not an
        // accident of seeds.
        const after = (n) => depths1.find((c) => c.name === n).depthM;
        if (!(after('dolphin') < after('kelp')
              && after('kelp') < after('jellyfish')
              && after('jellyfish') < after('anglerfish'))) {
          throw new Error(`column: the species stack is out of order: ${JSON.stringify(s.after)}`);
        }

        // -- (c) the vessel eases, and stops short of both ends --------------
        await page.evaluate(() => window.__menagerie.test.setDepth(window.__menagerie.test.depthInfo().min, true));
        await step(2);
        const easing = await page.evaluate(async () => {
          const t = window.__menagerie.test;
          const from = t.depthInfo().depth;
          const to = t.depthInfo().max;
          t.setDepth(to); // NOT instant — the column owns the travel
          window.__menagerie.clock.stepMany(1, 1 / 60);
          const afterOne = t.depthInfo().depth;
          window.__menagerie.clock.stepMany(30, 1 / 60); // half a second
          const afterHalfSec = t.depthInfo().depth;
          return { from, to, afterOne, afterHalfSec, rate: t.depthInfo().rate };
        });
        const span = easing.to - easing.from;
        s.easing = {
          from: +easing.from.toFixed(1),
          to: +easing.to.toFixed(1),
          movedInOneFrame: +(easing.afterOne - easing.from).toFixed(2),
          movedInHalfSecond: +(easing.afterHalfSec - easing.from).toFixed(1),
        };
        if (!(easing.afterOne - easing.from > 0)) throw new Error('column: setDepth did not start the vessel moving');
        if (easing.afterOne - easing.from > span * 0.05) {
          throw new Error(`column: setDepth teleported — ${(easing.afterOne - easing.from).toFixed(1)} m of a ${span.toFixed(0)} m command in one frame`);
        }
        if (!(easing.afterHalfSec > easing.afterOne)) throw new Error('column: the vessel stalled mid-travel');
        await step(600); // 10 s sim: the full-column run completes and settles
        const arrived = await page.evaluate(() => window.__menagerie.test.depthInfo());
        s.arrivedM = +arrived.depth.toFixed(1);
        if (Math.abs(arrived.depth - arrived.max) > 1) {
          throw new Error(`column: the vessel never arrived (${arrived.depth.toFixed(1)} m of a ${arrived.max.toFixed(1)} m command)`);
        }
        const clamps = await page.evaluate(() => {
          const t = window.__menagerie.test;
          const r = t.depthInfo();
          t.setDepth(-9999, true);
          const lo = t.depthInfo().depth;
          t.setDepth(99999, true);
          const hi = t.depthInfo().depth;
          return { lo, hi, min: r.min, max: r.max };
        });
        s.clamps = { lo: +clamps.lo.toFixed(1), hi: +clamps.hi.toFixed(1) };
        if (Math.abs(clamps.lo - clamps.min) > 0.01 || Math.abs(clamps.hi - clamps.max) > 0.01) {
          throw new Error(`column: depth did not clamp to [${clamps.min}, ${clamps.max}] — got ${clamps.lo} / ${clamps.hi}`);
        }

        // -- (d) determinism: same hash + same depth = the same frame --------
        await page.evaluate(() => window.__menagerie.test.setDepth(430, true));
        const ser = await page.evaluate(() => window.__menagerie.controls.serialize());
        s.serialized = ser;
        if (!/(^|;)d=430(;|$)/.test(ser)) throw new Error(`column: depth did not serialize into the hash: ${ser}`);
        // `nonce` is ignored by the app and exists only to force a real
        // document load: navigating twice to a byte-identical URL is a
        // same-document hash navigation, which would leave the first session's
        // sim time running and compare two different moments.
        const shoot = async (name, nonce) => {
          await page.goto(`${server.origin}/?fixedstep=1&nonce=${nonce}#${encodeURIComponent(ser)}`, { waitUntil: 'load', timeout: 90000 });
          await page.waitForFunction(
            () => window.__menagerie && window.__menagerie.clock && typeof window.__menagerie.clock.stepMany === 'function',
            null, { timeout: 90000 },
          );
          await page.evaluate(() => window.__menagerie.ui.forceAmbient(true));
          await page.waitForTimeout(1600);
          await step(150);
          return shot(name);
        };
        const detA = await shoot('column-determinism-a.png', 'a');
        const detB = await shoot('column-determinism-b.png', 'b');
        s.deterministic = detA.equals(detB);
        s.restoredDepth = await page.evaluate(() => window.__menagerie.test.depthInfo().target);
        if (Math.abs(s.restoredDepth - 430) > 0.01) {
          throw new Error(`column: hash restored the board at ${s.restoredDepth} m, not 430 m`);
        }
        if (!s.deterministic) {
          throw new Error('column: the same hash at the same depth rendered two different frames');
        }
      });

      // ---- 15. transect: the v3.7 HORIZONTAL axis ------------------------
      // The world stopped being a column and became a cross-shelf section, so
      // this is the column scenario's twin: the same five questions asked
      // sideways. Step counts are budgeted the same way — 5 stops of 50 frames
      // instead of 4 of 80, so the whole scenario is cheaper than `column`.
      await scenario('transect', async (s) => {
        // one species per stretch of the transect, chosen so that the ecology
        // itself is the assertion: a barnacle cannot be anywhere but the
        // intertidal, a tube worm cannot be anywhere but the abyssal plain.
        const board = 'barnacle,kelp,starfish,lanternfish,giant tube worm';
        await load(`fixedstep=1&board=${encodeURIComponent(board)}`);
        await page.waitForFunction(() => window.__menagerie.column);
        await page.evaluate(() => window.__menagerie.ui.forceAmbient(true));
        await page.waitForTimeout(1600);
        await step(180); // formations complete

        // -- (a) the model: one seabed whose depth depends on where you are ---
        const t0 = await page.evaluate(() => window.__menagerie.test.shoreInfo());
        s.range = { min: +t0.min.toFixed(1), max: t0.max, break: t0.break, plain: t0.plain };
        if (t0.max < 30000) throw new Error(`transect: the transect is only ${t0.max} m long`);
        if (t0.breakDepth !== 200) throw new Error(`transect: the shelf break is at ${t0.breakDepth} m, expected 200`);
        if (!(t0.min > 0 && t0.min < 2000)) {
          throw new Error(`transect: the inshore stop is ${t0.min} m offshore — the shore is not reachable`);
        }
        // the profile must be MONOTONE and must actually cross the break
        const prof = await page.evaluate(() => {
          const c = window.__menagerie.column;
          const out = [];
          for (let m = 0; m <= 36000; m += 500) out.push(c.profileDepthAt(m));
          return out;
        });
        s.profileSamples = prof.length;
        for (let i = 1; i < prof.length; i++) {
          if (prof[i] < prof[i - 1] - 1e-6) {
            throw new Error(`transect: the seabed profile rises seaward at ${i * 500} m (${prof[i - 1]} -> ${prof[i]})`);
          }
        }
        if (!(prof[0] < 1 && prof[prof.length - 1] > 1100)) {
          throw new Error(`transect: the profile runs ${prof[0]} m -> ${prof[prof.length - 1]} m; it must run shore to abyss`);
        }

        // -- (b) every creature at its true position, in BOTH axes -----------
        const cs = await page.evaluate(() => window.__menagerie.test.creatureDepths());
        s.creatures = cs.map((c) => ({
          name: c.name, kind: c.kind, m: Math.round(c.depthM),
          km: +(c.transectM / 1000).toFixed(2), zone: c.shoreZone, seabedM: Math.round(c.seabedAtM),
        }));
        const by = (n) => cs.find((c) => c.name === n);
        const barnacle = by('barnacle');
        const kelp = by('kelp');
        const star = by('starfish');
        const lantern = by('lanternfish');
        const worm = by('tubeworm');
        if (!barnacle || !kelp || !star || !lantern || !worm) {
          throw new Error(`transect: board did not resolve: ${JSON.stringify(s.creatures)}`);
        }
        // an INTERTIDAL species is near the shore and in shallow water. Both
        // halves matter: shallow alone was already true in v3.6, and it was
        // true by planting it on a 1200 m plain and calling it shallow.
        if (!(barnacle.transectM < 2500)) {
          throw new Error(`transect: the barnacle is ${(barnacle.transectM / 1000).toFixed(1)} km offshore — it lives between the tides`);
        }
        if (!(barnacle.depthM < 25)) {
          throw new Error(`transect: the barnacle is at ${barnacle.depthM.toFixed(0)} m — the intertidal is metres deep`);
        }
        // an OCEANIC species is off the shelf, over water far deeper than it
        if (!(lantern.transectM > t0.break)) {
          throw new Error(`transect: the lanternfish is ${(lantern.transectM / 1000).toFixed(1)} km offshore, inshore of the ${(t0.break / 1000).toFixed(0)} km shelf break — it is an open-ocean fish`);
        }
        if (!(lantern.seabedAtM > lantern.depthM * 2)) {
          throw new Error(`transect: the lanternfish at ${lantern.depthM.toFixed(0)} m has only ${lantern.seabedAtM.toFixed(0)} m of water under it — it is not in the open ocean`);
        }
        // an ABYSSAL species is deep AND far out — the two are one fact here
        if (!(worm.transectM > t0.plain && worm.depthM > 1100)) {
          throw new Error(`transect: the tube worm is at ${worm.depthM.toFixed(0)} m, ${(worm.transectM / 1000).toFixed(1)} km out — it lives on the abyssal plain past ${(t0.plain / 1000).toFixed(0)} km`);
        }
        // and the board SPANS the transect, which is the whole feature
        s.spreadKm = +((worm.transectM - barnacle.transectM) / 1000).toFixed(1);
        if (!(worm.transectM - barnacle.transectM > 25000)) {
          throw new Error(`transect: the board spans only ${s.spreadKm} km — it is not a crossing`);
        }
        // -- ...and everything ON the bottom is ON the bottom, THERE ---------
        // The strong form: a floor dweller's own depth must equal the depth of
        // the seabed at its OWN transect position. v3.6 could only ask "is it
        // near the one seabed"; this asks "is it standing on the ground under
        // it", which is the question the second axis makes askable.
        s.floorFits = [];
        for (const c of cs) {
          if (c.kind !== 'rooted' && c.kind !== 'benthic') continue;
          const offMeanM = c.depthM - c.seabedAtM; // + = below the mean profile
          const offGroundPx = c.y - c.floorY; // + = hovering above its own ground
          s.floorFits.push({ name: c.name, offMeanM: +offMeanM.toFixed(1), offGroundPx: +offGroundPx.toFixed(1) });
          // relief is +/- 15 m of dune on top of the mean, so the mean test is
          // generous; the GROUND test is the tight one.
          if (Math.abs(offMeanM) > 18) {
            throw new Error(`transect: ${c.name} is ${offMeanM.toFixed(1)} m off the seabed at its own position (${(c.transectM / 1000).toFixed(1)} km, seabed ${c.seabedAtM.toFixed(0)} m)`);
          }
          // rooted = flush or a few px into the silt (the v3.6 kelp window);
          // benthic = flush to a hover of a metre or two plus its own bob.
          const lo = c.kind === 'rooted' ? -26 : -8;
          const hi = c.kind === 'rooted' ? 2 : 26;
          if (!(offGroundPx >= lo && offGroundPx <= hi)) {
            throw new Error(`transect: ${c.name} (${c.kind}) sits ${offGroundPx.toFixed(0)} px off the ground under it, outside [${lo}, ${hi}]`);
          }
        }
        if (s.floorFits.length < 4) {
          throw new Error(`transect: only ${s.floorFits.length} floor dwellers on a board of four — placement lost one`);
        }

        // -- (c) five stops: the scene AND the seabed change under you -------
        const stops = [
          ['shore', t0.min],
          ['shelf', 6000],
          ['break', t0.break],
          ['slope', 23000],
          ['abyss', 34000],
        ];
        s.stops = {};
        let prevLuma = null;
        for (const [tag, m] of stops) {
          await page.evaluate((mm) => window.__menagerie.test.setShore(mm, true), m);
          await step(3);
          // hover just off the local seabed, so each stop shows its own ground
          await page.evaluate(() => {
            const t = window.__menagerie.test;
            t.setDepth(t.shoreInfo().depthMax, true);
          });
          await step(50); // trails re-fill after the jump flushes them
          const buf = await shot(`transect-${tag}.png`);
          const st = await pngStats(buf, 'full');
          const bot = await pngStats(buf, 'bottom');
          const mid = await pngStats(buf, 'central');
          const si = await page.evaluate(() => window.__menagerie.test.shoreInfo());
          s.stops[tag] = {
            shoreM: Math.round(si.shore),
            zone: si.zone,
            seabedM: +si.floorM.toFixed(1),
            depthM: Math.round(si.depthMax),
            meanLuma: +st.meanLuma.toFixed(2),
            bottomLuma: +bot.meanLuma.toFixed(2),
            centralLuma: +mid.meanLuma.toFixed(2),
            litCount: st.litCount,
            blownFrac: st.blownFrac,
          };
          if (st.blownFrac > 0.08) throw new Error(`transect-${tag}: ${(st.blownFrac * 100).toFixed(2)}% blown (bound 8%)`);
          // THERE IS GROUND UNDER YOU, and it is drawn. The vessel is hovering
          // just off the local seabed at every stop, so the bottom of the frame
          // is the seabed and the middle is water. Asserted only at the three
          // DARK stops: inshore the water is lit from above and the brightest
          // band is the surface, which would make this test say the opposite
          // for the right reason. v3.7 shipped with the break and the slope
          // rendering as empty black — the haze was computed, written to the
          // uniform, drawn, and then subtracted away by the trails pass — so
          // 13 km of the crossing had no ground in it at all.
          if (tag === 'break' || tag === 'slope' || tag === 'abyss') {
            if (!(bot.meanLuma > 4)) {
              throw new Error(`transect-${tag}: the bottom of the frame reads ${bot.meanLuma.toFixed(2)}/255 — the vessel is ${(si.floorM - si.depthMax).toFixed(0)} m off the seabed and there is no seabed drawn`);
            }
            if (!(bot.meanLuma > mid.meanLuma * 1.5)) {
              throw new Error(`transect-${tag}: bottom ${bot.meanLuma.toFixed(2)} vs mid-water ${mid.meanLuma.toFixed(2)} — no ground edge; the frame is the same water top to bottom`);
            }
          }
          if (prevLuma != null && Math.abs(st.meanLuma - prevLuma) < 0.4) {
            throw new Error(`transect-${tag}: mean luma ${st.meanLuma.toFixed(2)} is the previous stop's — travelling the transect did not change the scene`);
          }
          prevLuma = st.meanLuma;
        }
        const S = s.stops;
        // the seabed is DEEPER at every stop seaward — that is the profile
        const order = ['shore', 'shelf', 'break', 'slope', 'abyss'];
        for (let i = 1; i < order.length; i++) {
          const a = S[order[i - 1]];
          const b = S[order[i]];
          if (!(b.seabedM > a.seabedM * 1.4)) {
            throw new Error(`transect: the seabed goes ${a.seabedM} m at ${order[i - 1]} -> ${b.seabedM} m at ${order[i]} — the shelf is not dropping away`);
          }
        }
        // ...and the light dies with it, because the shore end IS the shallow
        // end: the inner shelf is unmistakably brighter than the slope
        if (!(S.shore.meanLuma > S.slope.meanLuma + 8)) {
          throw new Error(`transect: the shore (${S.shore.meanLuma}) is not visibly brighter than the slope (${S.slope.meanLuma})`);
        }
        if (!(S.shore.litCount > S.slope.litCount * 4)) {
          throw new Error(`transect: shore lit ${S.shore.litCount} vs slope ${S.slope.litCount} — travelling out is not travelling into the dark`);
        }
        if (S.shore.zone !== 'shore' || S.abyss.zone !== 'abyss') {
          throw new Error(`transect: zone names disagree with the positions (${S.shore.zone} / ${S.abyss.zone})`);
        }

        // -- (d) the vessel EASES sideways, and stops short of both ends -----
        await page.evaluate(() => window.__menagerie.test.setShore(window.__menagerie.test.shoreInfo().min, true));
        await step(2);
        const easing = await page.evaluate(() => {
          const t = window.__menagerie.test;
          const from = t.shoreInfo().shore;
          const to = t.shoreInfo().max;
          t.setShore(to); // NOT instant — the column owns the travel
          window.__menagerie.clock.stepMany(1, 1 / 60);
          const afterOne = t.shoreInfo().shore;
          window.__menagerie.clock.stepMany(30, 1 / 60); // half a second
          const afterHalfSec = t.shoreInfo().shore;
          return { from, to, afterOne, afterHalfSec };
        });
        const span = easing.to - easing.from;
        s.easing = {
          from: Math.round(easing.from),
          to: Math.round(easing.to),
          movedInOneFrame: +(easing.afterOne - easing.from).toFixed(1),
          movedInHalfSecond: Math.round(easing.afterHalfSec - easing.from),
        };
        if (!(easing.afterOne - easing.from > 0)) throw new Error('transect: setShore did not start the vessel moving');
        if (easing.afterOne - easing.from > span * 0.05) {
          throw new Error(`transect: setShore teleported — ${(easing.afterOne - easing.from).toFixed(0)} m of a ${span.toFixed(0)} m command in one frame`);
        }
        if (!(easing.afterHalfSec > easing.afterOne)) throw new Error('transect: the vessel stalled mid-crossing');
        // 8 s sim. The flank cap puts the 36 km crossing at ~6 s and the spring
        // settles inside 1.8 s of that, so this is arrival plus margin, not a
        // budget guess.
        await step(480);
        const arrived = await page.evaluate(() => window.__menagerie.test.shoreInfo());
        s.arrivedM = Math.round(arrived.shore);
        if (Math.abs(arrived.shore - arrived.max) > 2) {
          throw new Error(`transect: the vessel never arrived (${arrived.shore.toFixed(0)} m of a ${arrived.max.toFixed(0)} m crossing)`);
        }
        const clamps = await page.evaluate(() => {
          const t = window.__menagerie.test;
          const r = t.shoreInfo();
          t.setShore(-9999, true);
          const lo = t.shoreInfo().shore;
          t.setShore(999999, true);
          const hi = t.shoreInfo().shore;
          return { lo, hi, min: r.min, max: r.max };
        });
        s.clamps = { lo: +clamps.lo.toFixed(1), hi: +clamps.hi.toFixed(1) };
        if (Math.abs(clamps.lo - clamps.min) > 0.01 || Math.abs(clamps.hi - clamps.max) > 0.01) {
          throw new Error(`transect: shore did not clamp to [${clamps.min.toFixed(0)}, ${clamps.max}] — got ${clamps.lo.toFixed(0)} / ${clamps.hi.toFixed(0)}`);
        }

        // -- (e) determinism across BOTH axes --------------------------------
        await page.evaluate(() => {
          const t = window.__menagerie.test;
          // the sunlit inner shelf: a stop with real content in frame, and one
          // whose navigable depth band (9-39 m here) contains 30 m with room
          // either side, so the round trip is testing the hash and not a clamp.
          t.setShore(9000, true);
          t.setDepth(30, true);
        });
        const ser = await page.evaluate(() => window.__menagerie.controls.serialize());
        s.serialized = ser;
        if (!/(^|;)s=9000(;|$)/.test(ser)) throw new Error(`transect: the transect position did not serialize into the hash: ${ser}`);
        if (!/(^|;)d=30(;|$)/.test(ser)) throw new Error(`transect: the depth did not serialize alongside it: ${ser}`);
        const shoot = async (name, nonce) => {
          await page.goto(`${server.origin}/?fixedstep=1&nonce=${nonce}#${encodeURIComponent(ser)}`, { waitUntil: 'load', timeout: 90000 });
          await page.waitForFunction(
            () => window.__menagerie && window.__menagerie.clock && typeof window.__menagerie.clock.stepMany === 'function',
            null, { timeout: 90000 },
          );
          await page.evaluate(() => window.__menagerie.ui.forceAmbient(true));
          await page.waitForTimeout(1600);
          await step(120);
          return shot(name);
        };
        const detA = await shoot('transect-determinism-a.png', 'a');
        const detB = await shoot('transect-determinism-b.png', 'b');
        s.deterministic = detA.equals(detB);
        const restored = await page.evaluate(() => ({
          shore: window.__menagerie.test.shoreInfo().target,
          depth: window.__menagerie.test.depthInfo().target,
        }));
        s.restored = { shore: +restored.shore.toFixed(1), depth: +restored.depth.toFixed(1) };
        if (Math.abs(restored.shore - 9000) > 0.01) {
          throw new Error(`transect: the hash restored the vessel at ${restored.shore.toFixed(0)} m offshore, not 9000 m`);
        }
        if (Math.abs(restored.depth - 30) > 0.01) {
          throw new Error(`transect: the hash restored the vessel at ${restored.depth.toFixed(1)} m, not 30 m`);
        }
        if (!s.deterministic) {
          throw new Error('transect: the same hash at the same place on the transect rendered two different frames');
        }
        // the creatures came back to the same place in BOTH axes too
        const again = await page.evaluate(() => window.__menagerie.test.creatureDepths());
        s.replayed = again.length;
        for (const c of again) {
          const was = cs.find((o) => o.name === c.name);
          if (!was) throw new Error(`transect: '${c.name}' did not come back from the hash`);
          if (Math.abs(c.homeS - was.homeS) > 0.01) {
            throw new Error(`transect: ${c.name} restored ${(c.homeS - was.homeS).toFixed(0)} m along the transect from where it was — placement is not deterministic in x`);
          }
          if (Math.abs((c.homeM ?? 0) - (was.homeM ?? 0)) > 0.01) {
            throw new Error(`transect: ${c.name} restored ${(c.homeM - was.homeM).toFixed(1)} m from its depth — placement is not deterministic in y`);
          }
        }
      });

    } finally {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } else {
    for (const name of ['duo', 'swaySweep', 'ray', 'pileup', 'soak', 'sweep', 'solo', 'controls', 'atmosphere', 'gather', 'capture', 'soakE', 'resize', 'column', 'transect']) {
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

  // ---- 9b. data + ecology, in node (no browser) -------------------------
  // src/oceandata.js, src/depthbands.js and src/lexicon.js are three-free and
  // node-importable by contract, so the whole data layer is testable without
  // paying for a build. This is the scenario that guards the SIX HONESTY RULES
  // and, from v3.7, the second axis's data.
  currentScenario = 'data';
  {
    const s = { pass: true };
    report.scenarios.data = s;
    try {
      const od = await import('../src/oceandata.js');
      const db = await import('../src/depthbands.js');
      const lx = await import('../src/lexicon.js');
      const RAW = od.RAW;
      const keys = od.speciesKeys();
      s.species = keys.length;
      s.zoned = od.zonedKeys().length;
      s.bands = Object.keys(RAW.bands).length;
      s.aliases = Object.keys(RAW.aliases).length;
      if (!(keys.length >= 150)) throw new Error(`data: ${keys.length} species records, expected the 84 v3.5 ones plus the v3.7 research`);
      if (!(s.zoned >= 70)) throw new Error(`data: only ${s.zoned} records carry a shoreZone`);

      // RULE 1 — a null is never displayed, and never invented. Every figure
      // that reaches a row must be non-null, and a record that lost a sourced
      // figure to the merge is a data bug.
      const ZONES = new Set(['intertidal', 'nearshore', 'shelf', 'shelfbreak', 'slope', 'oceanic', 'abyssal']);
      let nulledRow = 0;
      for (const k of keys) {
        for (const r of od.statRows(k, { precision: true })) {
          // A leaked null renders as the exact string 'null' / 'undefined' /
          // 'NaN'. A substring match would flag the `precision` prose, which
          // says "Depth nulled - no published range" on purpose — that sentence
          // IS rule 1 being honest, and it must not be mistaken for a breach.
          const v = r.value == null ? null : String(r.value).trim();
          if (v == null || v === '' || v === 'null' || v === 'undefined' || v === 'NaN') nulledRow++;
        }
        const rec = RAW.species[k];
        if (rec.shoreZone) {
          if (!Array.isArray(rec.shoreZone) || !rec.shoreZone.length) throw new Error(`data: ${k} has an empty shoreZone`);
          for (const z of rec.shoreZone) {
            if (!ZONES.has(z)) throw new Error(`data: ${k} has shoreZone '${z}', which is not one of the seven`);
          }
        }
        // the three-state fields must never be coerced to a plain boolean
        const n = od.statsFor(k);
        if (rec.benthic === undefined && n.benthic !== null) throw new Error(`data: ${k} invented a benthic flag`);
        if (rec.bioluminescent === undefined && n.bioluminescent !== null) throw new Error(`data: ${k} invented a bioluminescence flag`);
      }
      s.nulledRows = nulledRow;
      if (nulledRow) throw new Error(`data: ${nulledRow} rendered rows carry a null figure — rule 1`);

      // a researched FALSE is an answer. The barreleye is the case that proves
      // it: it watches other animals' light and makes none of its own.
      if (od.isBioluminescent('barreleye') !== false) throw new Error('data: barreleye must be a researched false, not a gap');
      if (od.isBioluminescent('lanternfish') !== true) throw new Error('data: lanternfish must be bioluminescent');
      if (od.isBioluminescent('whale') !== null) throw new Error('data: whale was never researched for light; it must read null, not false');
      // DIEL: the sourced day/night split survives the merge intact
      const lf = od.statsFor('lanternfish');
      s.diel = { day: lf.dayLabel, night: lf.nightLabel };
      if (!(lf.dayDepthMaxM > lf.nightDepthMaxM)) throw new Error('data: the lanternfish must be deeper by day than by night');
      if (!od.dielFor('lanternfish')) throw new Error('data: the lanternfish lost its migration sentence');

      // the merge must not have overwritten a v3.5 sourced figure
      if (od.statsFor('sardine').depthMaxM == null) throw new Error('data: sardine lost its sourced depth in the merge');
      if (od.statsFor('seasnake').shoreZone == null) throw new Error('data: seasnake did not gain its shore zones in the merge');

      // ---- the second axis: every zoned species lands where it lives ------
      s.placed = [];
      const expect = [
        // name, max metres offshore, min metres offshore, max depth, min depth
        ['barnacle', 2500, 0, 25, 0],
        ['mussel', 3000, 0, 40, 0],
        ['kelp', 8000, 0, 60, 0],
        ['parrotfish', 17000, 0, 60, 0],
        ['lanternfish', 36000, 15500, 1200, 0],
        ['tubeworm', 36000, 27500, 1200, 1000],
        ['tripod fish', 36000, 19000, 1200, 700],
      ];
      for (const [name, maxKmM, minKmM, maxD, minD] of expect) {
        const r = lx.resolveName(name);
        s.placed.push({ name, km: +(r.transectM / 1000).toFixed(2), m: +r.depthM.toFixed(1), kind: r.band.kind, arch: r.arch });
        if (r.transectM > maxKmM || r.transectM < minKmM) {
          throw new Error(`data: ${name} placed ${(r.transectM / 1000).toFixed(1)} km offshore, outside [${minKmM / 1000}, ${maxKmM / 1000}] km`);
        }
        if (r.depthM > maxD || r.depthM < minD) {
          throw new Error(`data: ${name} placed at ${r.depthM.toFixed(0)} m, outside [${minD}, ${maxD}] m`);
        }
      }
      // a floor dweller's depth IS the seabed at its own transect position
      for (const name of ['barnacle', 'mussel', 'kelp', 'tubeworm', 'starfish', 'crab', 'sponge']) {
        const r = lx.resolveName(name);
        if (r.band.kind !== 'rooted' && r.band.kind !== 'benthic') continue;
        const floor = db.floorDepthAt(r.transectM);
        if (Math.abs(floor - r.depthM) > 4) {
          throw new Error(`data: ${name} is at ${r.depthM.toFixed(1)} m but the seabed at its own position (${(r.transectM / 1000).toFixed(1)} km) is ${floor.toFixed(1)} m`);
        }
      }
      // ...and a swimmer always has water under it
      for (const name of ['lanternfish', 'anglerfish', 'dolphin', 'tuna', 'turtle', 'sea otter', 'atolla jellyfish']) {
        const r = lx.resolveName(name);
        const floor = db.floorDepthAt(r.transectM);
        if (floor < r.depthM) {
          throw new Error(`data: ${name} is at ${r.depthM.toFixed(0)} m over ${floor.toFixed(0)} m of water — it is inside the seabed`);
        }
      }

      // ---- the lexicon still answers every old word, and the new ones -----
      const arches = new Set(lx.ARCH_NAMES);
      if (!arches.has('tetrapod')) throw new Error('data: the tetrapod archetype is missing from the lexicon');
      if (lx.resolveName('turtle').arch !== 'tetrapod') throw new Error('data: turtle must be a marine tetrapod, not a ray');
      const legacy = ['eel', 'jellyfish', 'manta', 'koi', 'octopus', 'starfish', 'blob', 'lotus', 'kelp', 'shark', 'anemone', 'squid', 'coral', 'red jellyfish', 'school of fish'];
      for (const w of legacy) {
        const r = lx.resolveName(w);
        if (!r.arch || !r.band || !r.band.kind) throw new Error(`data: the legacy word '${w}' stopped resolving`);
      }
      // every new species word resolves to a real archetype and a real band
      let unresolved = 0;
      for (const k of od.zonedKeys()) {
        const r = lx.resolveName(k);
        if (!r.band || r.band === db.DEFAULT_BAND) unresolved++;
      }
      s.unresolvedZoned = unresolved;
      if (unresolved) throw new Error(`data: ${unresolved} researched species fall through to the default band`);
      // multi-word names collapse to the same creature as the single word
      for (const [a, b] of [['sea turtle', 'seaturtle'], ['giant tube worm', 'tubeworm'], ['sea otter', 'seaotter']]) {
        const ra = lx.resolveName(a);
        const rb = lx.resolveName(b);
        if (ra.seed !== rb.seed || ra.arch !== rb.arch) throw new Error(`data: '${a}' and '${b}' are two different creatures`);
      }
      console.log(`data: ${s.species} species (${s.zoned} cross-shelf), ${s.bands} bands, ${s.aliases} aliases — all rows non-null`);
    } catch (e) {
      s.pass = false;
      s.error = String((e && e.stack) || e);
      console.error('data FAILED: ' + s.error.split('\n')[0]);
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
