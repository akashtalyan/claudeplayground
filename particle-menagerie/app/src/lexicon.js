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
// }

import { hashName } from './geometry/rng.js';
import { FISH_MORPHS } from './geometry/fish.js';
import { KELP_MORPHS } from './geometry/kelp.js';
import { BLOOM_MORPHS } from './geometry/bloom.js';

// ---- archetype lexicon (~150 entries) ------------------------------------
export const LEX = {
  medusa: [
    'jellyfish', 'jelly', 'jellies', 'medusa', 'medusae', 'manowar',
    'ghost', 'phantom', 'wraith', 'spirit', 'seaangel', 'comb',
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
  ],
  eel: [
    'eel', 'moray', 'seasnake', 'serpent', 'snake', 'dragon', 'seadragon',
    'oarfish', 'lamprey', 'ribbonfish', 'pipefish', 'seahorse', 'worm',
    'leviathan', 'wyrm', 'noodle',
  ],
  ray: [
    'ray', 'manta', 'stingray', 'skate', 'turtle', 'flounder', 'halibut',
    'sole', 'mobula',
  ],
  octo: [
    'octopus', 'octo', 'kraken', 'squid', 'cuttlefish', 'nautilus',
    'argonaut', 'vampyroteuthis',
  ],
  star: [
    'starfish', 'star', 'seastar', 'urchin', 'crab', 'brittlestar',
    'sanddollar', 'basketstar', 'sunstar',
  ],
  amorph: [
    'plankton', 'krill', 'blob', 'amoeba', 'slime', 'ooze', 'spore', 'mist',
    'cloud', 'algae', 'goo', 'shrimp', 'salp', 'nebula',
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
  ],
};

export const ARCH_NAMES = Object.keys(LEX);
// unknown names become free-swimming/drifting sea creatures, never flora
export const SWIMMERS = ['medusa', 'fish', 'eel', 'ray', 'octo', 'star', 'amorph'];

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
  const name = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
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
      BLOOM_MORPHS[w] || BLOOM_MORPHS[ws];
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
  return {
    name: clean, arch, seed, scale, tempo, speed, ghost,
    hue: hueSet ? hue : null, count, morph,
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
