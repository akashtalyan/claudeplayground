// Lexicon + name parsing — ported from v2 (particle-menagerie.html) and
// upgraded to the v3 taxonomy of record (CLAUDE.md): eel, medusa, fish, ray,
// octo, star, amorph, bloom, kelp. Pure module — no three.js, no DOM —
// importable and testable in plain node.
//
// resolveName(raw) → {
//   name,     // cleaned display name ("red jellyfish")
//   arch,     // archetype key into the creature registry
//   seed,     // uint32 from hashName(name) — the creature's identity
//   scale, tempo, speed,   // modifier multipliers (giant/baby/fast/slow...)
//   ghost,    // boolean — translucent
//   hue,      // 0..360 or null (monochrome default)
//   count,    // 1..6 — "school of fish" → 5, "three eels" → 3
//   morph,    // named-species morph preset (FISH_MORPHS / KELP_MORPHS /
//             // BLOOM_MORPHS entry) or null — passed as opts.morph to the
//             // maker; plain "fish"/"kelp"/"flower" stays null so generic
//             // creatures keep seed-varied bodies
//
//   -- v3.4, the vertical water column (src/depthbands.js) --
//   bandKey,  // the depth band this name resolved to ('jellyfish', 'kelp',
//             // 'fish'...) — the species entry when there is one, else the
//             // archetype's
//   band,     // the frozen band record: { kind, minM, maxM, preferM, hold,
//             // wanderM, ... } in METRES BELOW THE SURFACE. A summoned
//             // creature therefore knows where it lives before it is placed.
//   depthM,   // metres below the surface for instance 0 — a deterministic
//             // draw from `seed` inside `band`. Batches of >1 pass their
//             // instance index to pickDepth(band, seed, i) so a school
//             // spreads through its band instead of stacking.
// }

import { hashName } from './geometry/rng.js';
import { bandFor, bandKeyFor, pickDepth, pickTransect } from './depthbands.js';
import { FISH_MORPHS } from './geometry/fish.js';
import { EEL_MORPHS, eelMorphFor } from './geometry/eel.js';
import { OCTO_MORPHS, octoMorphFor } from './geometry/octo.js';
import { MEDUSA_MORPHS, medusaMorphFor } from './geometry/medusa.js';
import { STAR_MORPHS, starMorphFor } from './geometry/star.js';
import { AMORPH_MORPHS, amorphMorphFor } from './geometry/amorph.js';
import { KELP_MORPHS } from './geometry/kelp.js';
import { BLOOM_MORPHS } from './geometry/bloom.js';
import { TETRAPOD_MORPHS, tetrapodMorphFor } from './geometry/tetrapod.js';

// ---- archetype lexicon (~150 entries) ------------------------------------
export const LEX = {
  medusa: [
    'jellyfish', 'jelly', 'jellies', 'medusa', 'medusae', 'manowar',
    'ghost', 'phantom', 'wraith', 'spirit', 'seaangel', 'comb',
    // v3.7 the gelatinous, including the ones that make their own light
    'atolla', 'atollajellyfish', 'alarmjelly', 'crystaljelly', 'aequorea',
    'siphonophore', 'praya', 'combjelly', 'ctenophore',
  ],
  fish: [
    'fish', 'shark', 'whale', 'dolphin', 'orca', 'tuna', 'salmon', 'koi',
    'goldfish', 'narwhal', 'marlin', 'swordfish', 'anglerfish', 'angler',
    'piranha', 'barracuda', 'clownfish', 'minnow', 'guppy', 'betta', 'cod',
    'sardine', 'herring', 'mackerel', 'bass', 'trout', 'snapper', 'grouper',
    'pufferfish', 'puffer', 'carp', 'catfish', 'angelfish', 'lionfish',
    'sunfish', 'tetra', 'wrasse', 'perch', 'pike', 'sturgeon',
    // cetaceans (fish archetype, but hand-authored cetacean morphs in
    // FISH_MORPHS: horizontal fluke + up-down undulation)
    'humpback', 'beluga', 'porpoise',
    // v3.7 reef + coastal (species-F)
    'parrotfish', 'triggerfish', 'bluetang', 'tang', 'surgeonfish',
    'butterflyfish', 'damselfish', 'goby', 'blenny',
    // v3.7 pelagic (species-F)
    'remora', 'suckerfish', 'sailfish', 'mahimahi', 'mahi', 'dorado',
    'dolphinfish', 'anchovy', 'opah', 'moonfish', 'wahoo', 'cobia',
    // v3.7 the abundance champions + the deep-sea lamps (species-F/G)
    'lanternfish', 'myctophid', 'bristlemouth', 'cyclothone',
    'viperfish', 'hatchetfish', 'flashlightfish', 'cookiecutter',
    'cookiecuttershark', 'barreleye', 'macropinna', 'tripodfish',
    'lanternshark', 'etmopterus',
  ],
  eel: [
    'eel', 'moray', 'seasnake', 'serpent', 'snake', 'dragon', 'seadragon',
    'oarfish', 'lamprey', 'ribbonfish', 'pipefish', 'seahorse', 'worm',
    'leviathan', 'wyrm', 'noodle',
    // v3.7 long soft bodies: the dragonfish is a ribbon with a red lamp, the
    // gulper is mostly jaw and tail, a sea cucumber is a tube that crawls, an
    // arrow worm is a transparent dart
    'dragonfish', 'blackdragonfish', 'gulpereel', 'gulper', 'pelicaneel',
    'seacucumber', 'cucumber', 'holothurian', 'arrowworm', 'chaetognath',
  ],
  ray: [
    'ray', 'manta', 'stingray', 'skate', 'flounder', 'halibut',
    'sole', 'mobula',
  ],
  // v3.7 — the marine tetrapods. 'turtle' MOVED HERE from `ray`: a turtle is
  // not a flat sheet with a whip tail, it is a barrel with four paddling
  // limbs, and geometry/tetrapod.js is the archetype that says so.
  tetrapod: [
    'turtle', 'seaturtle', 'greenturtle', 'loggerhead', 'hawksbill',
    'hawksbillturtle', 'leatherback', 'leatherbackturtle', 'terrapin',
    'seal', 'harbourseal', 'harborseal', 'pinniped', 'sealion', 'walrus',
    'penguin', 'emperorpenguin', 'littlepenguin', 'fairypenguin',
    'otter', 'seaotter', 'dugong', 'manatee', 'seacow',
    'marineiguana', 'iguana', 'polarbear',
  ],
  octo: [
    'octopus', 'octo', 'kraken', 'squid', 'cuttlefish', 'nautilus',
    'argonaut', 'vampyroteuthis',
    // v3.7 (species-G)
    'vampiresquid', 'fireflysquid', 'watasenia', 'glasssquid', 'cranchiid',
  ],
  star: [
    'starfish', 'star', 'seastar', 'urchin', 'crab', 'brittlestar',
    'sanddollar', 'basketstar', 'sunstar',
    // v3.7 armoured, many-legged floor walkers (species-E)
    'lobster', 'hermitcrab', 'horseshoecrab',
  ],
  amorph: [
    'plankton', 'krill', 'blob', 'amoeba', 'slime', 'ooze', 'spore', 'mist',
    'cloud', 'algae', 'goo', 'shrimp', 'salp', 'nebula',
    // v3.7 soft, shelled and formless benthos (species-E) — placement pins
    // them to the seabed; the archetype only says what shape they are
    'prawn', 'nudibranch', 'seaslug', 'clam', 'quahog', 'oyster', 'mussel',
    'scallop', 'barnacle', 'cockle', 'abalone', 'limpet', 'chiton',
    'seasquirt', 'tunicate',
    // v3.7 the small drifting multitudes + the glowing motes (species-F/G)
    'copepod', 'amphipod', 'foraminifera', 'foram',
    'seasparkle', 'noctiluca', 'dinoflagellate', 'dinoflagellatebloom',
    'redtide', 'pyrosome', 'seapickle',
  ],
  bloom: [
    'flower', 'rose', 'tulip', 'lotus', 'daisy', 'lily', 'orchid',
    'sunflower', 'poppy', 'hibiscus', 'blossom', 'sakura', 'peony', 'dahlia',
    'anemone', 'carnation', 'lavender', 'iris', 'jasmine',
    'marigold', 'chrysanthemum', 'camellia', 'magnolia', 'daffodil',
  ],
  kelp: [
    'kelp', 'seaweed', 'seagrass', 'grass', 'reed', 'vine', 'fern', 'willow',
    'wakame', 'eelgrass', 'sargassum',
    // coral moved bloom→kelp (Phase F): the stubby strand-cluster morph
    // reads as coral; 'fan'/'seafan' cover "sea fan" (planar morph)
    'coral', 'seafan', 'fan',
    // v3.7 the SESSILE — not plants, but built the same way: a holdfast and a
    // body that stands up in the current. A tube worm IS a tube on a stalk.
    'sponge', 'barrelsponge', 'seapen', 'tubeworm', 'gianttubeworm', 'riftia',
  ],
};

export const ARCH_NAMES = Object.keys(LEX);
// unknown names become free-swimming/drifting sea creatures, never flora.
// NOT extended in v3.7: this list is the hash -> archetype map for unknown
// names, so appending to it would re-roll every made-up creature on every
// saved board. `tetrapod` is reachable by name only, which is right — an
// invented word should not become a walrus.
export const SWIMMERS = ['medusa', 'fish', 'eel', 'ray', 'octo', 'star', 'amorph'];

// v3.7 — multi-word species names, collapsed to the single lexicon word before
// parsing. "sea turtle" and "seaturtle" are the same animal and the user should
// not have to know which spelling the table uses. Longest phrase first, so
// "giant tube worm" is not eaten by "tube worm".
const PHRASES = [
  ['giant tube worm', 'tubeworm'], ['tube worm', 'tubeworm'],
  ['emperor penguin', 'emperorpenguin'], ['little penguin', 'littlepenguin'],
  ['fairy penguin', 'littlepenguin'],
  ['leatherback turtle', 'leatherback'], ['hawksbill turtle', 'hawksbill'],
  ['green turtle', 'greenturtle'], ['sea turtle', 'seaturtle'],
  ['sea otter', 'seaotter'], ['sea lion', 'sealion'], ['sea cow', 'seacow'],
  ['harbour seal', 'harbourseal'], ['harbor seal', 'harborseal'],
  ['marine iguana', 'marineiguana'], ['polar bear', 'polarbear'],
  ['hermit crab', 'hermitcrab'], ['horseshoe crab', 'horseshoecrab'],
  ['sea cucumber', 'seacucumber'], ['sea pen', 'seapen'],
  ['sea squirt', 'seasquirt'], ['sea slug', 'seaslug'],
  ['barrel sponge', 'barrelsponge'],
  ['blue tang', 'bluetang'], ['mahi mahi', 'mahimahi'], ['mahi-mahi', 'mahimahi'],
  ['arrow worm', 'arrowworm'],
  ['vampire squid', 'vampiresquid'], ['firefly squid', 'fireflysquid'],
  ['glass squid', 'glasssquid'], ['black dragonfish', 'blackdragonfish'],
  ['atolla jellyfish', 'atollajellyfish'], ['flashlight fish', 'flashlightfish'],
  ['cookiecutter shark', 'cookiecuttershark'], ['crystal jelly', 'crystaljelly'],
  ['sea sparkle', 'seasparkle'], ['dinoflagellate bloom', 'dinoflagellatebloom'],
  ['red tide', 'redtide'], ['comb jelly', 'combjelly'],
  ['gulper eel', 'gulpereel'], ['pelican eel', 'pelicaneel'],
  ['tripod fish', 'tripodfish'], ['sea pickle', 'seapickle'],
];

// ---- modifiers -----------------------------------------------------------
export const MODS = {
  giant: { scale: 1.6 },
  huge: { scale: 1.7 },
  big: { scale: 1.4 },
  mega: { scale: 1.8 },
  colossal: { scale: 1.9 },
  great: { scale: 1.5 },
  baby: { scale: 0.55, tempo: 1.35 },
  tiny: { scale: 0.5, tempo: 1.4 },
  small: { scale: 0.7, tempo: 1.2 },
  mini: { scale: 0.55, tempo: 1.35 },
  little: { scale: 0.65, tempo: 1.25 },
  ghost: { ghost: 1 },
  ghostly: { ghost: 1 },
  phantom: { ghost: 1 },
  spectral: { ghost: 1 },
  fast: { tempo: 1.6, speed: 1.6 },
  quick: { tempo: 1.5, speed: 1.5 },
  slow: { tempo: 0.6, speed: 0.6 },
  sleepy: { tempo: 0.5, speed: 0.5 },
  lazy: { tempo: 0.6, speed: 0.5 },
};

// ---- colors in names (hue degrees; null = keep monochrome default) -------
export const COLORS = {
  red: 5,
  crimson: 0,
  scarlet: 8,
  orange: 25,
  amber: 38,
  gold: 45,
  golden: 45,
  yellow: 55,
  green: 130,
  emerald: 145,
  teal: 165,
  cyan: 190,
  aqua: 185,
  turquoise: 175,
  blue: 215,
  azure: 205,
  indigo: 245,
  purple: 270,
  violet: 275,
  magenta: 310,
  pink: 330,
  white: null,
  silver: null,
  pearl: null,
};

// ---- counts / schools ----------------------------------------------------
export const NUMS = {
  two: 2, three: 3, four: 4, five: 5, six: 6,
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6,
  pair: 2, couple: 2, few: 3, trio: 3, bunch: 4,
  school: 5, shoal: 5, flock: 5, swarm: 6, pod: 4,
};

// ---- parsing -------------------------------------------------------------
export function resolveName(raw) {
  let name = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
  // v3.7: fold "sea turtle" -> "seaturtle" BEFORE anything else looks at the
  // words. The collapsed word is what is hashed, so "sea turtle" and
  // "seaturtle" are one creature with one seed, not two.
  for (let i = 0; i < PHRASES.length; i++) {
    if (name.indexOf(PHRASES[i][0]) >= 0) {
      name = name.split(PHRASES[i][0]).join(PHRASES[i][1]);
      break;
    }
  }
  const words = name.split(' ').filter(Boolean);
  let scale = 1;
  let tempo = 1;
  let speed = 1;
  let ghost = false;
  let arch = null;
  let hue = null;
  let hueSet = false;
  let count = 1;
  let morph = null;
  const kept = [];
  for (const w of words) {
    if (w === 'of' || w === 'a' || w === 'the') continue;
    if (NUMS[w]) {
      count = Math.max(count, NUMS[w]);
      continue;
    }
    const m = MODS[w];
    if (m) {
      if (m.scale) scale *= m.scale;
      if (m.tempo) tempo *= m.tempo;
      if (m.speed) speed *= m.speed;
      if (m.ghost) ghost = true;
    }
    // a color word colors the creature — unless it IS the creature ("rose")
    if (w in COLORS && !LEX.bloom.includes(w)) {
      hue = COLORS[w];
      hueSet = true;
    }
    kept.push(w);
    const ws = w.replace(/s$/, '');
    for (const a of ARCH_NAMES) {
      if (LEX[a].includes(w) || LEX[a].includes(ws)) arch = a;
    }
    // named species → characteristic morph preset (eel-likes are in LEX.eel
    // and never reach here as fish, so they keep the eel archetype); plant
    // species (seagrass, anemone, coral...) resolve the same way
    const sp =
      FISH_MORPHS[w] || FISH_MORPHS[ws] ||
      KELP_MORPHS[w] || KELP_MORPHS[ws] ||
      BLOOM_MORPHS[w] || BLOOM_MORPHS[ws] ||
      // v3.8: the archetypes that gained a preset table. Same contract as
      // FISH_MORPHS — a preset overrides VALUES only, never an RNG draw.
      EEL_MORPHS[w] || EEL_MORPHS[ws] || eelMorphFor(w) || eelMorphFor(ws) ||
      OCTO_MORPHS[w] || OCTO_MORPHS[ws] || octoMorphFor(w) || octoMorphFor(ws) ||
      MEDUSA_MORPHS[w] || MEDUSA_MORPHS[ws] || medusaMorphFor(w) || medusaMorphFor(ws) ||
      STAR_MORPHS[w] || STAR_MORPHS[ws] || starMorphFor(w) || starMorphFor(ws) ||
      AMORPH_MORPHS[w] || AMORPH_MORPHS[ws] || amorphMorphFor(w) || amorphMorphFor(ws) ||
      // v3.7: tetrapodMorphFor also resolves the aliases ("hawksbill" ->
      // the turtle morph, "pinniped" -> seal), which is why it is called
      // rather than TETRAPOD_MORPHS being indexed directly.
      TETRAPOD_MORPHS[w] || TETRAPOD_MORPHS[ws] ||
      tetrapodMorphFor(w) || tetrapodMorphFor(ws);
    if (sp && !morph) {
      morph = sp;
      if (sp.scale) scale *= sp.scale; // shark larger, minnow/seagrass smaller...
      if (sp.tempo) tempo *= sp.tempo; // a whale beats slowly, a porpoise fast
      if (sp.speed) speed *= sp.speed;
    }
  }
  const clean = kept.join(' ') || name;
  const seed = hashName(clean);
  if (!arch) arch = SWIMMERS[seed % SWIMMERS.length];
  // v3.4: the creature's home in the water column. The species band wins over
  // the archetype's when the name names a species ("red jellyfish" -> the
  // jellyfish band, not the generic medusa band); unknown names fall through
  // to the archetype they were assigned above, so everything has a home.
  // depthM is drawn from `seed` in depthbands' own salted stream — the
  // geometry RNG and its frozen draw order (geometry-spec §8) are untouched,
  // so the same URL hash still yields the same board, now including depths.
  const bandKey = bandKeyFor(clean) || arch;
  const band = bandFor(bandKey);
  // v3.7 — the second axis, resolved the same way and from the same salted
  // stream. A floor dweller's transect is drawn FIRST and its depth follows
  // from the seabed there (a mussel is at 2 m because it is 300 m offshore);
  // a swimmer's depth is drawn first, exactly as in v3.6 and from the same
  // RNG round, so every v3.6 depth is reproduced unchanged.
  const onFloor = band.kind === 'rooted' || band.kind === 'benthic';
  const swimDepthM = pickDepth(band, seed, 0);
  const transectM = pickTransect(band, seed, 0, onFloor ? null : swimDepthM);
  return {
    name: clean, arch, seed, scale, tempo, speed, ghost,
    hue: hueSet ? hue : null, count, morph,
    bandKey, band,
    depthM: onFloor ? pickDepth(band, seed, 0, transectM) : swimDepthM,
    transectM,
  };
}

// Board csv ("eel, red jellyfish,school of fish") → array of resolved specs.
export function parseBoard(csv) {
  return String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(resolveName);
}

// hue (0..360) → [r,g,b] 0..1 at the v2 look (78% sat, 66% light).
// null hue → the monochrome-by-default cool-cyan cast.
export const DEFAULT_COLOR = [0.62, 0.84, 1.0];
export function colorFromHue(hue) {
  if (hue == null) return DEFAULT_COLOR.slice();
  return hslToRgb(hue / 360, 0.78, 0.66);
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
