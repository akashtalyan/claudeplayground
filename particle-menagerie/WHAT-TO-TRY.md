# Particle Menagerie v3 — what to try

Hi Akash — v3 is done and it's a genuinely lovely thing. Here's the tour.

## Run it

- **Zero setup:** open `app/dist/index.html` in any WebGL browser. It's the whole
  aquarium in one offline file.
- **Dev mode:** `cd app && npm install && npm run dev`, then open the vite URL.

## Ten things, in rough order of wow

1. **Type `shark`** in the summon line and press Enter. Watch it form out of
   dots — dorsal sail, forked tail, the works. Then try `marlin` (that bill!)
   and `angelfish` (tall, disc-bodied, nothing like the shark).
2. **Type `ghost jellyfish`** — modifiers stack: a translucent medusa. Also fun:
   `giant blue whale`, `tiny fast goldfish`, `red octopus`.
3. **Type `school of tuna`** — five of them, seed-varied, swimming together.
4. **Click a creature.** The brass gauge plate surfaces: glow, tempo, sway, size
   needles you can drag live. A fresh click always starts minimal.
5. **Press `more ›`** on the plate for the deep cut: twinkle, iridescence, dot
   density, color swatches — and the **behavior rotary**, a five-notch dial
   (drift / patrol / follow / school / sleep). Set something to `follow` and
   move your mouse. Set another to `sleep` and watch it dim and settle.
6. **Spin the weather rotary** (bottom of the screen at rest): moonlit → abyss →
   bioluminescent bay → ink → shallows. Each is a full scene change — fog,
   light, trails, sediment, caustics — crossfading over ~2s like weather, not a
   config load. `bioluminescent bay` is the showstopper.
7. **Click empty water** to drop a glowing amber mote. Nearby swimmers break
   formation and race to it; someone gets a little burst of dots on
   consumption. Sleepers don't wake. Click again to move the bait.
8. **Press `p`** for a PNG snapshot, **`v`** to start/stop a WebM recording —
   both save straight to downloads (ignored while you're typing a name).
9. **Walk away for ~30 seconds.** All the chrome sinks out of frame and it
   becomes a pure ambient screensaver. Any real input brings it back, summon
   row first.
10. **Copy the URL and send it to someone.** The whole board lives in the hash —
    creatures, tweaks, weather — and reforms exactly on their machine.

Bonus: plant a garden first (`kelp`, `coral`, `lotus`, `anemone`), then summon
swimmers over it. Unknown words work too — anything becomes *some* sea creature.

## Honest note on performance

Numbers from headless/SwiftShader runs were never the perf evidence — only real
GPU frame times count, so please feel it on your own hardware: add `?hud=1` for
the live frame-time HUD and watch the p50 while the board fills up.
If a heavy scene stutters, the adaptive governor should step quality down
(and back up) before you consciously notice — if you *do* notice, that's
exactly the feedback I want.

Enjoy the water. — Claude
