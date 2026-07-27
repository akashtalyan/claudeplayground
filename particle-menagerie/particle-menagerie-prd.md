# PRD — Particle Menagerie

**A living canvas where named animals become dotted-particle creatures drifting in the dark.**

| | |
|---|---|
| Author | Akash Talyan |
| Date | July 27, 2026 |
| Status | Draft v1 |
| Reference aesthetic | [Dotted Particle Creature Drifting in the Dark](https://movin.design/video/dotted-particle-creature-drifting-in-the-dark/) (@yuruyurau) |

---

## 1. Overview

Particle Menagerie is a browser-based generative art board. The user types the name of an animal or character; a creature made of thousands of white dots coils into existence and joins a shared dark canvas, drifting alongside every creature named before it. The result is a personal, ever-growing aquarium of math-born creatures in the yuruyurau aesthetic: monochrome particles, organic motion, continuous re-formation.

The core promise: **any name you type becomes a living thing in under a second, and it never stops moving.**

## 2. Problem / Opportunity

Generative particle art of this style is mesmerizing but inaccessible — it lives in one-off Processing sketches by a handful of artists. There is no playful tool where a non-coder can *summon* a creature by naming it and collect the results. The gap between "I saw this beautiful thing" and "I can make one of my own" is the product.

## 3. Goals

1. Typing any animal/character name produces a recognizable-in-silhouette particle creature within ~1 second, with no network dependency for generation.
2. All creatures coexist and drift on one shared canvas at 60fps with at least 8–10 creatures live.
3. The same name always regenerates the same creature (deterministic), while a "reroll" affordance produces variations.
4. The board feels like a place, not a form: dark, ambient, minimal chrome.

### Non-goals (v1)

- No AI/LLM calls in the generation path (procedural only).
- No accounts, persistence across devices, or multiplayer.
- No color — monochrome white-on-black is the identity, not a limitation.
- No video export (v1 is live canvas only; export is v2).

## 4. Target user

Primary: people who enjoy generative art and creative toys — designers, creative coders, and anyone who saw the reference video and thought "I want one." Secondary: Akash, brainstorming and demoing the concept.

## 5. User experience

### 5.1 Core loop

1. User lands on a near-black canvas. A faint prompt reads *"name a creature"*.
2. User types e.g. `jellyfish` and hits Enter.
3. A cloud of dots swirls in from noise, coils, and condenses into a jellyfish-like particle form over ~1.5s (the *formation moment* — this is the magic beat and must feel earned).
4. The creature begins its idle behavior: drifting slowly through the space, breathing, undulating, occasionally re-forming.
5. User names another. Creatures accumulate. The canvas becomes a menagerie.

### 5.2 Interactions

- **Type-to-summon**: single always-focused input, Enter to create.
- **Hover/tap a creature**: its name fades in beside it in small type.
- **Click a creature**: focus mode — others dim, this one enlarges slightly.
- **Reroll**: regenerate the focused creature with a new variation seed.
- **Release**: remove the focused creature (it disperses back into dots).
- **Ambient mode**: after ~30s idle, UI chrome fades out entirely.

### 5.3 The board as a place

Creatures avoid overlapping via gentle repulsion, drift with individual rhythms, and very occasionally "notice" each other (brief orientation toward a neighbor). Session state is saved to the URL (list of names + seeds) so a board is shareable as a link.

## 6. Creature generation (the heart of the product)

Generation is a deterministic pipeline: **name → archetype → parameters → particle sketch**.

### 6.1 Archetype resolution

A built-in lexicon (~150–200 entries) maps names to one of ~8 body archetypes:

| Archetype | Structure | Example names |
|---|---|---|
| Serpent | 1 long ribbed spine | snake, eel, dragon, worm |
| Medusa | bell + trailing tentacles | jellyfish, squid, ghost |
| Finned | fusiform body + fin planes | fish, shark, whale, dolphin |
| Winged | body + 2 flapping membranes | bird, butterfly, moth, bat, phoenix |
| Quadruped | spine + 4 limb chains + head | cat, wolf, horse, fox |
| Radial | symmetric arms from a core | starfish, octopus, spider, sun |
| Amorph | pulsing blob field | amoeba, slime, cloud, blob |
| Biped | upright spine + limbs | human, robot, yeti |

Unknown names are not errors: the name is hashed to pick an archetype and seed, so *every* input yields a creature. (A stretch goal upgrades unknown-name resolution with a small on-device word-embedding table so "leviathan" lands near "whale" instead of landing randomly.)

### 6.2 Parameterization

The name's hash seeds ~15 parameters within archetype-defined ranges: scale, segment count, rib density, tentacle/limb count and length, undulation frequency and amplitude, drift speed, breathing rate, dot size and count, re-formation interval, asymmetry. Modifier words parse naturally: `giant jellyfish` scales up, `baby wolf` scales down and quickens, `ghost cat` lowers dot opacity and adds drift.

### 6.3 Rendering model

Each creature is a parametric skeleton (spline spine + appendage chains) animated by layered sine/noise fields, with dots emitted along ribs/rings perpendicular to the skeleton — the ribbed, coiling look of the reference. Dots have slight jitter and per-dot phase so the surface shimmers. Formation and dispersal animate dots between a noise cloud and their skeleton targets.

## 7. Technical requirements

- Single self-contained HTML file; rendering via WebGL point sprites (Canvas2D fallback), targeting 60fps with ~40–60k total dots on a mid-range laptop.
- Deterministic seeded RNG (name → seed) so links reproduce boards exactly.
- Dot budget manager: per-creature dot counts scale down as the board fills.
- Responsive full-viewport canvas; devicePixelRatio-aware.

## 8. Success criteria

- **The squint test**: at a glance, ≥7 of 10 common animal names produce a form a viewer can guess or accept ("yeah, that reads as a bird").
- **The lingering test**: users leave it running — median session length > 3 minutes.
- 60fps with 10 creatures; formation completes < 2s after Enter.
- Zero-result inputs: none. Every string yields a creature.

## 9. Milestones

| Phase | Scope | Estimate |
|---|---|---|
| M1 — Proof of look | One archetype (Medusa), formation animation, drift. Validates the aesthetic. | Prototype session |
| M2 — Menagerie | All 8 archetypes, lexicon, shared-canvas behaviors, hover/click/reroll/release. | 1–2 sessions |
| M3 — Place-ness | URL persistence, ambient mode, inter-creature awareness, dot budget manager. | 1 session |
| M4 (v2) — Beyond | GIF/WebM export, sound-reactive mode, optional AI naming-to-parameters upgrade, gallery view. | Later |

## 10. Risks & open questions

- **Recognizability vs. abstraction** — the reference creature is evocative, not literal. Risk: users expect a "cat that looks like a cat." Mitigation: lean into silhouette + motion signature (cats stalk, jellyfish pulse); motion carries more identity than shape at this dot density.
- **Performance ceiling** — many creatures × many dots. Mitigation: WebGL points, dot budget manager, cap of ~12 live creatures with graceful "oldest disperses" behavior.
- **Unknown-name quality** — hash fallback can feel arbitrary. Open question: ship v1 with hash fallback, or invest early in embedding-based nearest-archetype?
- **Open question** — should creatures ever interact more strongly (schooling, predator/prey choreography), or does that break the calm?
