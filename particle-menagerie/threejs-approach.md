# Technical Approach — Particle Menagerie on three.js

**Goal:** the fidelity of the reference video (ribbed 3D forms coiling in the dark, glowing dots, real depth) while keeping everything that makes this a board: type-to-summon, live controls, cursor interaction.

---

## 1. Why three.js changes the picture

The v2 prototype draws ~15,000 squares per frame on a 2D canvas with the CPU. Every dot is flat, hard-edged, and lives on a plane. Three.js moves rendering to the GPU as **point sprites**, which unlocks four things Canvas2D cannot do at quality:

1. **Glow.** Each dot becomes a soft radial sprite composited with *additive blending* — overlapping dots brighten into bloom, which is the bioluminescent look of the reference. On Canvas2D this effect costs more than the whole frame budget; on the GPU it is free.
2. **True 3D.** A perspective camera projects real 3D creature skeletons. The ribbed rings of the reference creature only read correctly when rings actually tilt through depth — near dots larger and brighter, far dots smaller and dimmer.
3. **Density.** The GPU renders 100k+ points at 60fps. We can triple dot density per creature and raise the creature cap without dropping frames.
4. **Atmosphere.** Depth fog, camera parallax, and long exposure trails come almost free, and they are what turn "shapes on black" into "a place."

## 2. Division of labor

The design keeps a clean split:

**CPU (JavaScript, per frame)** — the *soul*: the name→archetype→parameters pipeline (unchanged from v2), each archetype's 3D skeleton math producing a target position per dot, and per-dot easing toward targets (`pos += (target − pos) × ease`), which is what makes formation, morphing, and size changes feel liquid.

**GPU (GLSL shaders)** — the *body*: perspective projection and point sizing by distance, the glow sprite (bright core + colored halo), per-dot twinkle driven by a time uniform, and depth fog.

At ~1,500 dots per creature × 16 creatures, the CPU does ~24k target evaluations per frame — a few sin/cos each. Measured headroom in v2 was already fine at similar counts; the expensive half (drawing) is what moves to the GPU.

## 3. Scene architecture

- One `THREE.Scene`, near-black clear color, `PerspectiveCamera` placed so that the z=0 plane maps 1:1 to screen pixels (world units = pixels; no coordinate translation bugs).
- **Each creature = one `THREE.Points` object** with a `BufferGeometry` holding three attributes: `position` (updated every frame, `DynamicDrawUsage`), `aSize` (static per-dot size variance), `aTw` (static twinkle phase). One draw call per creature.
- **One `ShaderMaterial` per creature** with uniforms: `uColor` (the color control), `uAlpha` (glow control × formation fade), `uTime`. Changing a control writes a uniform — no geometry rebuild.
- **Trails** via a full-screen fade quad: `autoClear` off, each frame a translucent dark quad renders first (renderOrder −10), then all points additively on top. The trails slider maps to the quad's opacity — from crisp dots to long comet exposure.
- **Ambient plankton** = one more Points object, 400 dots, drifting with the current.

## 4. The dot shader (the glow)

Fragment shader, the heart of the look:

```glsl
float d    = length(gl_PointCoord - vec2(0.5)) * 2.0;   // 0 center → 1 edge
float core = exp(-d * d * 7.0);                          // hot white center
float halo = exp(-d * d * 2.0) * 0.32;                   // soft colored aura
float tw   = 0.6 + 0.4 * sin(uTime * 2.3 + aTw * 6.28);  // per-dot shimmer
float fog  = clamp(1.35 - vDepth * 0.00085, 0.15, 1.0);  // dim with distance
vec3 col   = vec3(1.0) * core * 0.85 + uColor * (core * 0.6 + halo);
gl_FragColor = vec4(col * uAlpha * tw * fog, 1.0);       // additive blend
```

Vertex shader sizes each point by `aSize × (620 / −mvPosition.z)` — perspective attenuation, so depth reads instantly. `depthWrite/depthTest` off + `AdditiveBlending`: overlap always brightens, never occludes, and draw order stops mattering.

## 5. 3D skeletons (what actually gets more beautiful)

Archetype math upgrades from 2D curves to 3D frames. The eel — the reference showpiece — illustrates the pattern:

- The spine is a 3D curve: `S(s,t) = ( (s−½)L,  A·sin(g₁),  A·cos(g₂) )` where `g₁,g₂` are two incommensurate traveling waves — the body genuinely *coils* and the coil evolves rather than repeating.
- At each of ~50 spine stations, compute the tangent numerically, build a local frame (normal + binormal via cross products), and place a **ring of ~22 dots in the plane perpendicular to the spine**. Rings are quantized — that is what produces crisp dotted ribs instead of noise. A slow per-ring twist offset makes the ribs spiral.
- The same pattern gives every archetype volume: the jellyfish bell becomes a true surface of revolution that the camera can look *around*; ray wings extend into depth and sweep through it when turning; octopus arms fan in a full 3D circle; flowers become cones of petals that rotate and reveal themselves.
- Non-swimming creatures get a slow idle rotation (`spin ≈ 0.2 rad/s`) so their three-dimensionality is always on display — this is the single cheapest "wow" in the rebuild.

## 6. Interaction mapping (all v2 controls survive)

- **Type-to-summon, lexicon, modifiers, colors-in-names, counts/schools** — unchanged, pure JS.
- **Click-to-select** — project each creature's center to screen space per frame; hit-test in 2D (cheap, no raycaster needed for ~16 creatures).
- **Ripple** — unproject the mouse to the z=0 world plane; dots within radius get a decaying 3D push. Same feel as v2, now with depth.
- **Lure** — steer creature headings toward the mouse's world point.
- **Camera parallax** — the camera eases a few degrees toward the mouse position and the whole scene shifts with parallax by depth. Not a control; just makes the water feel inhabited.
- **Panel controls** — tempo/sway/size change CPU-side parameters (dots morph via easing, as in v2); color/glow write shader uniforms directly.

## 7. Performance budget

| Item | Cost | Budget |
|---|---|---|
| Dot targets (CPU) | ~24k × ~10 trig ops | ~1–2 ms/frame |
| Attribute upload | 24k × 3 floats, dynamic buffer | < 0.5 ms |
| Draw calls | 1 per creature + fade quad + plankton ≈ 18 | trivial |
| GPU fill (additive sprites) | the real cost; bounded by sprite size cap | fine at 1080p; cap sprite px size |

Target: 60fps with 16 creatures on integrated graphics. Fallback knob: global dot-density multiplier (0.5×) if `requestAnimationFrame` deltas degrade — auto-detected, not user-facing.

## 8. Dependency & delivery

- Single self-contained HTML file, three.js r128 from **cdnjs** (the one CDN allowed in claude.ai previews; global `THREE`, no build step). No other dependencies; shaders are inline strings.
- Everything else (lexicon, resolve, panel UI, URL-hash persistence) carries over from v2 nearly verbatim.
- Risk: if the file is opened fully offline, the CDN import fails — acceptable for a prototype; a later step can inline three.js or ship via a bundler.

## 9. Build order

1. Engine skeleton: scene, camera, fade-quad trails, shader material, one hardcoded eel — validate the *look* first (this is the go/no-go moment for fidelity).
2. Port all archetypes to 3D frames; wire lexicon + spawn.
3. Port controls (panel → uniforms/params), ripple/lure, parallax, schooling.
4. Headless test: screenshots + FPS + control exercise, tune glow/fog/density.
5. Deliver; then iterate on whichever creature you judge weakest.
