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
4. **Click a creature.** The brass gauge plate surfaces — and every row is a
   *word*, not a number: **motion** (still / calm / lively / frantic),
   **light** (ghostly / dim / glowing / radiant), **size**, **depth**, and
   **doing**. The needle points at the word you pick.
5. **Set `doing` to "following you"** and move your mouse. Set another creature
   to "sleeping" and watch it dim and settle to the seabed. "schooling" makes
   same-species creatures shoal together.
6. **Spin the weather rotary** (bottom of the screen at rest): moonlit → abyss →
   bioluminescent bay → ink → shallows. Each is a full scene change — fog,
   light, trails, sediment, caustics — crossfading over ~2s like weather, not a
   config load. `bioluminescent bay` is the showstopper.
7. **Click empty water.** An amber beacon lights and the *whole menagerie*
   turns and comes — each creature on its own curve, at its own speed, milling
   around the point rather than piling onto it. Rooted plants lean toward it.
   Sleepers don't wake. Click elsewhere to call them somewhere new; after ~10s
   the beacon fades and everyone drifts back to their own business.
8. **Press `p`** for a PNG snapshot, **`v`** to start/stop a WebM recording —
   both save straight to downloads (ignored while you're typing a name).
9. **Walk away for ~30 seconds.** All the chrome sinks out of frame and it
   becomes a pure ambient screensaver. Any real input brings it back, summon
   row first.
10. **Copy the URL and send it to someone.** The whole board lives in the hash —
    creatures, tweaks, weather — and reforms exactly on their machine.

Bonus — **plant a garden first**, then summon swimmers over it. The flora has
species too: `seagrass` (a stand of thin blades), `seaweed` (wide curly
ribbons), `sea fan` (flat and spreading), `coral` (stubby clusters), `anemone`
(a swaying tentacle crown), `lotus` (wide flat petals), `rose`, `tulip`, `kelp`.
Unknown words work too — anything becomes *some* sea creature.

Known nit: the anemone's crown reads as a bright blob at small on-screen sizes
(many short petals converging on one point). Every other species is clean.

## Honest note on performance

Numbers from headless/SwiftShader runs were never the perf evidence — only real
GPU frame times count, so please feel it on your own hardware: add `?hud=1` for
the live frame-time HUD and watch the p50 while the board fills up.
If a heavy scene stutters, the adaptive governor should step quality down
(and back up) before you consciously notice — if you *do* notice, that's
exactly the feedback I want.

Enjoy the water. — Claude
