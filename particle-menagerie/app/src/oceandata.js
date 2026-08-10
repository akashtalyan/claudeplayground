// Ocean data — v3.5. The real-ocean facts behind the board, and the ecology
// they correct.
//
// Everything here reads ONE baked file: src/data/ocean-data.json, merged from
// four researched source files. Vite inlines JSON into the single-file build,
// so this stays offline: the app never fetches anything at runtime, and this
// module never touches the network, the DOM, three.js or a clock. Pure data +
// pure functions — node-importable, testable, safe to import from anywhere.
//
// WHAT THE INTEGRATOR CALLS
//   statsFor(word)            -> a normalised species record, or null
//   statRows(word)            -> ONLY the rows that have data, ready to render
//   correctedBandFor(word)    -> the depth band derived from the real range
//   CORRECTED_BANDS           -> every lexicon word's corrected band
//   asDepthbandsBands(opts)   -> the same, trimmed to depthbands.js's shape
//   ZONES / zoneAt(m)         -> the four ocean zones, for the gauge
//   temperatureAt(m) / lightAt(m) + their *Label helpers
//   PROVENANCE / PROVENANCE_LINE -> what to print under the readout
//
// THE SIX HONESTY RULES, and how this module enforces them
//   1. A null is never displayed. statRows OMITS a row whose figure is null —
//      it never substitutes 0, "unknown" or a guess. Callers render whatever
//      rows they are handed and never null-check a figure.
//   2. maxLenM is NOT always a length. Every record carries `measure` and
//      `measureLabel` ('disc width' for a manta, 'carapace width' for a crab,
//      'test diameter' for an urchin, 'mantle length' for a cuttlefish,
//      'height' for kelp, 'branch length' for coral...). sizeRow() labels the
//      figure with THAT word. Never print "length" over a disc width.
//   3. group:true entries are not species. `groupLine` says so out loud
//      ("crab — the infraorder Brachyura; shown: blue crab").
//   4. Freshwater and diadromous entries say so. habitatRow() is emitted
//      automatically for anything that is not marine, so a piranha never
//      implies a marine depth.
//   5. Provenance travels with the data. PROVENANCE_LINE ("curated from public
//      sources") belongs under any readout; every record keeps its own source
//      URLs. This is a curated snapshot, not an authoritative database.
//   6. The dot-creature is not the animal. Stats are ambient context about a
//      real organism; nothing here claims the procedural rendering depicts it.
//      DISCLAIMER carries that sentence for the UI.
//
// A SEVENTH RULE, specific to the bands: band figures (minM/maxM/preferM) are
// PLACEMENT HEURISTICS derived from the sourced ranges — arithmetic, not
// citations. They must never be shown as data. Show `depthLabel` (the sourced
// range) instead; DATA.bandDerivation documents every step of the derivation.

import DATA from './data/ocean-data.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** The machine-readable provenance block (method, date, the WebFetch block,
 *  the source files, and the honesty rules the data was built under). */
export const PROVENANCE = Object.freeze({ ...DATA.provenance });

/** One quiet line for the bottom of an instrument readout. */
export const PROVENANCE_LINE = 'curated from public sources';

/** The longer form, for a tooltip or an about panel. */
export const PROVENANCE_NOTE = DATA.provenance.note;

/** Rule 6, in one sentence, for the UI to print near the stats. */
export const DISCLAIMER =
  'Figures describe the real organism. The creature on screen is a procedural '
  + 'particle sketch, not a depiction of it.';

export const SCHEMA_VERSION = DATA.schemaVersion;
export const IUCN_LABELS = Object.freeze({ ...DATA.iucn });
export const MEASURE_LABELS = Object.freeze({ ...DATA.measures });

// ---------------------------------------------------------------------------
// Word resolution
// ---------------------------------------------------------------------------
//
// Mirrors lexicon/depthbands lookup order so the same name resolves the same
// way everywhere: exact -> alias -> singular -> each word of a multi-word name,
// head noun first ("three red jellyfish" -> "jellyfish").

const SPECIES = DATA.species;
const ALIASES = DATA.aliases;

function normWord(raw) {
  return String(raw == null ? '' : raw).toLowerCase().trim().replace(/\s+/g, ' ');
}

function directKey(w) {
  if (!w) return null;
  if (SPECIES[w]) return w;
  const a = ALIASES[w];
  if (a && SPECIES[a]) return a;
  if (w.endsWith('s')) {
    const s = w.slice(0, -1);
    if (SPECIES[s]) return s;
    const as = ALIASES[s];
    if (as && SPECIES[as]) return as;
  }
  return null;
}

/**
 * The species key a name resolves to, or null.
 * @param {string} nameOrWord  "manta", "three red jellyfish", "Kelp"
 */
export function speciesKeyFor(nameOrWord) {
  const name = normWord(nameOrWord);
  if (!name) return null;
  const direct = directKey(name);
  if (direct) return direct;
  const words = name.split(' ');
  for (let i = words.length - 1; i >= 0; i--) {
    const k = directKey(words[i]);
    if (k) return k;
  }
  return null;
}

function bandKey(nameOrWord) {
  const name = normWord(nameOrWord);
  if (!name) return null;
  if (BANDS[name]) return name;
  if (name.endsWith('s') && BANDS[name.slice(0, -1)]) return name.slice(0, -1);
  const words = name.split(' ');
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (BANDS[w]) return w;
    if (w.endsWith('s') && BANDS[w.slice(0, -1)]) return w.slice(0, -1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting — the only place a number becomes a string
// ---------------------------------------------------------------------------

function trim(n, dp) {
  const s = n.toFixed(dp);
  return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, '');
}

/**
 * A size in metres as the shortest honest unit: 30 m, 2.73 m, 11 cm, 5 µm.
 * Returns null for null — a missing figure has no string form.
 */
export function formatSize(m) {
  if (m == null || !Number.isFinite(m)) return null;
  if (m >= 100) return `${Math.round(m)} m`;
  if (m >= 10) return `${trim(m, 1)} m`;
  if (m >= 1) return `${trim(m, 2)} m`;
  const cm = m * 100;
  if (cm >= 10) return `${trim(cm, 1)} cm`;
  if (cm >= 1) return `${trim(cm, 1)} cm`;
  const mm = m * 1000;
  if (mm >= 1) return `${trim(mm, 1)} mm`;
  return `${trim(m * 1e6, 1)} µm`;
}

/** A depth in metres: 0, 7.6, 1250. Null-safe. */
export function formatDepth(m) {
  if (m == null || !Number.isFinite(m)) return null;
  if (m === 0) return '0';
  if (m < 10) return trim(m, 1);
  return String(Math.round(m));
}

/** "0–300 m", "surface (0 m)", or null when either end is missing. */
export function formatDepthRange(minM, maxM) {
  if (minM == null || maxM == null) return null;
  if (minM === 0 && maxM === 0) return 'surface (0 m)';
  return `${formatDepth(minM)}–${formatDepth(maxM)} m`;
}

// ---------------------------------------------------------------------------
// Species records
// ---------------------------------------------------------------------------

const recordCache = new Map();

function buildRecord(word, key) {
  const s = SPECIES[key];
  const habitat = s.habitat || 'marine';
  const measureLabel = s.measureLabel || MEASURE_LABELS[s.measure] || 'size';
  const rec = {
    // identity
    word,                       // the word that was asked for
    key,                        // the species key it resolved to
    via: key === word ? null : key, // set when the word borrowed another entry
    scientific: s.scientific || null,
    commonName: s.commonName || null,

    // rule 3 — a group is not a species. groupTaxon is the sourced sentence
    // verbatim ("\"Crab\" is the infraorder Brachyura plus other decapods
    // (~7,000 species)."); groupShown names the one organism the figures
    // actually describe. Neither is rewritten at render time.
    group: !!s.group,
    groupNote: s.groupNote || null,
    groupTaxon: s.groupTaxon || null,
    // groupReferent ONLY. It is the one field that names the one organism the
    // figures describe, and its ABSENCE is the signal that they are group-wide
    // — so it cannot be defaulted. v3.7 fix round 2: it used to fall back to
    // commonName and then to `scientific`, and for 31 records `scientific` IS
    // the referent's binomial (Placopecten magellanicus, Mnemiopsis leidyi),
    // so groupShown came out equal to scientific, statRows' `named` test went
    // false, and the row printed "figures are for the group" directly above a
    // note saying the figures are one named species'. commonName was no better
    // — it is usually the lexicon word again ("sea turtle"), a circular row.
    // Every record that HAS a referent now carries it in the data.
    groupShown: s.group ? (s.groupReferent || null) : null,
    groupLine: s.group
      ? `${word} — ${(s.groupTaxon || '').replace(/^"[^"]*"\s+/, '').replace(/\.$/, '')}${s.groupReferent ? `; shown: ${s.groupReferent}` : ''}`
      : null,

    // rule 4 — habitat is stated whenever it is not marine
    habitat,
    habitatLabel: DATA.habitats[habitat] || habitat,
    marine: habitat === 'marine',

    // depth, as sourced (rule 1: nulls stay null)
    depthMinM: s.depthMinM,
    depthMaxM: s.depthMaxM,
    depthLabel: formatDepthRange(s.depthMinM, s.depthMaxM),
    usualMinM: s.usualMinM,
    usualMaxM: s.usualMaxM,
    usualLabel: s.usualMinM == null ? null : formatDepthRange(s.usualMinM, s.usualMaxM),
    usualNote: s.usualNote,

    // rule 2 — the measure is part of the figure
    maxLenM: s.maxLenM,
    measure: s.measure,
    measureLabel,
    measureNote: s.measureNote,
    sizeLabel: s.maxLenM == null ? null : measureLabel,
    sizeValue: formatSize(s.maxLenM),

    iucn: s.iucn,
    iucnLabel: s.iucn ? IUCN_LABELS[s.iucn] || null : null,

    fact: s.fact || null,
    precision: s.precision || null,
    sources: Object.freeze((s.sources || []).slice()),
    dataset: s.dataset,
    band: correctedBandFor(word) || correctedBandFor(key) || null,

    // ---- v3.7: WHERE, not just how deep -----------------------------------
    // Rule 1 still holds: a field the research left out is absent here, not
    // filled. `shoreZone` is undefined for the 81 records the cross-shelf pass
    // never covered and an array for the 72 it did — statRows omits the row either
    // way, and nothing downstream may substitute a guess.
    shoreZone: s.shoreZone ? Object.freeze(s.shoreZone.slice()) : null,
    shoreZoneLabel: s.shoreZone && s.shoreZone.length
      ? s.shoreZone.map((z) => SHORE_ZONE_LABELS[z] || z).join(', ')
      : null,
    // benthic is a THREE-state field: true, false, or "not researched". The
    // difference matters — an unresearched species is not "not benthic".
    benthic: s.benthic === undefined ? null : !!s.benthic,
    locationNote: s.locationNote || null,
    // ...and so is bioluminescent. `false` here is a researched false: a
    // barreleye watches other animals' light and makes none of its own.
    bioluminescent: s.bioluminescent === undefined ? null : !!s.bioluminescent,
    bioNote: s.bioNote || null,
    bioColour: s.bioColour || null,
    // vertical migration, when the sources describe one
    diel: s.diel || null,
    dayDepthMinM: s.dayDepthMinM == null ? null : s.dayDepthMinM,
    dayDepthMaxM: s.dayDepthMaxM == null ? null : s.dayDepthMaxM,
    nightDepthMinM: s.nightDepthMinM == null ? null : s.nightDepthMinM,
    nightDepthMaxM: s.nightDepthMaxM == null ? null : s.nightDepthMaxM,
    dayLabel: s.dayDepthMinM == null ? null : formatDepthRange(s.dayDepthMinM, s.dayDepthMaxM),
    nightLabel: s.nightDepthMinM == null ? null : formatDepthRange(s.nightDepthMinM, s.nightDepthMaxM),
  };
  return Object.freeze(rec);
}

/** The cross-shelf vocabulary, in the words a readout should print. */
export const SHORE_ZONE_LABELS = Object.freeze({
  intertidal: 'intertidal',
  nearshore: 'nearshore',
  shelf: 'continental shelf',
  shelfbreak: 'shelf break',
  slope: 'continental slope',
  oceanic: 'open ocean',
  abyssal: 'abyssal plain',
});

/** The researched shore zones for a name, or null. */
export function shoreZonesFor(nameOrWord) {
  const rec = statsFor(nameOrWord);
  return rec ? rec.shoreZone : null;
}

/** True / false / null — see the three-state note in buildRecord. */
export function isBenthic(nameOrWord) {
  const rec = statsFor(nameOrWord);
  return rec ? rec.benthic : null;
}

/** True / false / null. A researched `false` is an answer, not a gap. */
export function isBioluminescent(nameOrWord) {
  const rec = statsFor(nameOrWord);
  return rec ? rec.bioluminescent : null;
}

/** The diel-migration sentence for a name, or null when none was researched. */
export function dielFor(nameOrWord) {
  const rec = statsFor(nameOrWord);
  return rec && rec.diel ? rec.diel : null;
}

/** Every species key whose record carries a researched shore zone. */
export function zonedKeys() {
  return Object.keys(SPECIES).filter((k) => SPECIES[k].shoreZone);
}

/**
 * The normalised record for a lexicon word (or a whole typed name), or null
 * when nothing was researched for it. Frozen and memoised — calling it every
 * frame allocates nothing after the first hit, though it is meant for the
 * selection path, not the frame path.
 *
 * Every figure may be null. Do not read them one by one — use statRows().
 */
export function statsFor(nameOrWord) {
  const w = normWord(nameOrWord);
  if (!w) return null;
  if (recordCache.has(w)) return recordCache.get(w);
  const key = speciesKeyFor(w);
  const rec = key ? buildRecord(directWord(w, key), key) : null;
  recordCache.set(w, rec);
  return rec;
}

// the display word: the lexicon word itself when it is one, else the head noun
function directWord(name, key) {
  if (SPECIES[name] || ALIASES[name]) return name;
  const words = name.split(' ');
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (SPECIES[w] || ALIASES[w] || (w.endsWith('s') && (SPECIES[w.slice(0, -1)] || ALIASES[w.slice(0, -1)]))) {
      return w.endsWith('s') && !SPECIES[w] && !ALIASES[w] ? w.slice(0, -1) : w;
    }
  }
  return key;
}

/** True when there is anything researched to show for this name. */
export function hasStats(nameOrWord) {
  return statsFor(nameOrWord) != null;
}

// ---------------------------------------------------------------------------
// Rows — the render-ready form
// ---------------------------------------------------------------------------
//
// THE POINT OF THIS FUNCTION: a row exists only if its figure exists. The UI
// maps over what it is given and never asks "is this null?" — which is exactly
// how rule 1 is kept. Row shape:
//
//   { key, label, value, note }
//     key    stable id ('depth', 'size', 'iucn', 'habitat', 'group', 'fact')
//     label  the left column, already correct for the measure
//     value  the right column, already formatted with its unit
//     note   an optional second line (the qualification, e.g. "disc width",
//            "usually 0–100 m", "standard length") — may be null

const rowsCache = new Map();

const DEFAULT_ROW_OPTS = { habitat: 'auto', fact: true, precision: false, order: null };

/**
 * The rows that have data, in reading order, for `nameOrWord`.
 * Returns [] (never null) when nothing was researched.
 *
 * @param {string} nameOrWord
 * @param {object} [opts]
 *   habitat   'auto' (default — a row only when NOT marine), 'always', 'never'
 *   fact      include the one-line fact row (default true)
 *   precision include the long precision/caveat row (default false)
 *   order     an array of row keys to select and order them
 */
export function statRows(nameOrWord, opts) {
  const o = opts ? { ...DEFAULT_ROW_OPTS, ...opts } : DEFAULT_ROW_OPTS;
  const rec = statsFor(nameOrWord);
  if (!rec) return EMPTY_ROWS;
  const cacheable = !opts;
  if (cacheable && rowsCache.has(rec.key + '|' + rec.word)) return rowsCache.get(rec.key + '|' + rec.word);

  const rows = [];
  const push = (key, label, value, note) => {
    if (value == null || value === '') return;
    rows.push(Object.freeze({ key, label, value, note: note || null }));
  };

  // identity. Rule 3 starts HERE, not at the group row: a group record's
  // `scientific` is a family, genus, order or phylum name (Scaridae,
  // Copepoda, Ctenophora), and printing it under the label "species" — in the
  // italic binomial styling the UI keys off the row key 'species' — states
  // something the research never said. Group records get their own row key and
  // their own label, so a phylum stops reading as a binomial.
  const idKey = rec.group ? 'taxon' : 'species';
  push(idKey, idKey, rec.scientific, rec.commonName && !rec.group ? rec.commonName : null);
  // ...and the group row names the ONE organism the figures describe, when
  // there is one. When the sources gave figures for the whole group there is
  // no referent to name, and repeating the taxon back at itself ("taxon
  // Scaridae / group shown: Scaridae") is a circular row that says nothing.
  if (rec.group) {
    // The test is the PRESENCE of a referent, not whether it happens to differ
    // from `scientific`. On a group record `scientific` is often the referent's
    // own binomial (scallop -> Placopecten magellanicus), so comparing the two
    // said "figures are for the group" about figures that are one species' —
    // the exact opposite of the groupTaxon note printed underneath it.
    push('group', 'group', rec.groupShown ? `shown: ${rec.groupShown}` : 'figures are for the group', rec.groupTaxon);
  }
  // rule 4 — non-marine is always stated
  if (o.habitat === 'always' || (o.habitat === 'auto' && !rec.marine)) {
    push('habitat', 'habitat', rec.habitatLabel, null);
  }
  // rule 1 — omitted entirely when either end of the range is null
  push('depth', 'depth', rec.depthLabel, rec.usualNote || null);
  // v3.7 — WHERE across the shelf, and whether it lives on the bottom. Both
  // omitted whole for the 84 records the cross-shelf research did not cover.
  push('shore', 'found', rec.shoreZoneLabel, rec.locationNote);
  if (rec.benthic === true) push('benthic', 'habit', 'lives on the bottom', null);
  // a researched day/night split is the honest form of "it migrates"
  if (rec.dayLabel && rec.nightLabel) {
    push('diel', 'by day', rec.dayLabel, rec.diel);
    push('dielNight', 'by night', rec.nightLabel, null);
  } else if (rec.diel) {
    push('diel', 'migration', 'rises at night', rec.diel);
  }
  if (rec.bioluminescent === true) push('bio', 'light', rec.bioColour || 'bioluminescent', rec.bioNote);
  else if (rec.bioluminescent === false && rec.bioNote) push('bio', 'light', 'makes none', rec.bioNote);
  // rule 2 — the label IS the measure
  push('size', rec.sizeLabel, rec.sizeValue, rec.measureNote);
  push('iucn', 'red list', rec.iucnLabel, rec.iucn);
  if (o.fact) push('note', 'note', rec.fact, null);
  if (o.precision) push('precision', 'caveat', rec.precision, null);

  let out = rows;
  if (o.order) {
    const by = new Map(rows.map((r) => [r.key, r]));
    out = o.order.map((k) => by.get(k)).filter(Boolean);
  }
  const frozen = Object.freeze(out);
  if (cacheable) rowsCache.set(rec.key + '|' + rec.word, frozen);
  return frozen;
}

const EMPTY_ROWS = Object.freeze([]);

// ---------------------------------------------------------------------------
// The corrected depth bands
// ---------------------------------------------------------------------------
//
// THE ECOLOGY FIX. v3.4 authored bands by feel and put every rooted plant and
// every floor animal on the 1200 m abyssal seabed. Kelp (6–30 m), coral
// (5–25 m), seagrass (0–10 m) and anemone (0–7 m) are shallow, LIGHT-DEPENDENT
// organisms — they cannot live at 1200 m, where no sunlight arrives at all.
// Starfish, urchins, crabs and brittle stars are shelf animals; flounder and
// sole are shelf flatfish; the Portuguese man o' war is a pure surface floater
// (depth exactly 0) and sargassum is holopelagic — it never attaches to the
// seafloor, so it is no longer 'rooted' at all.
//
// Each band is derived from that species' sourced range by the arithmetic in
// DATA.bandDerivation — the sourced "usually" band when one is quoted, else the
// shallow third of the sourced range (published maxima are records, not homes),
// with the mode at the shallow-weighted centre. Bands stay RANGES, so a school
// still spreads through one. Words with no data keep their v3.4 band exactly,
// except flora and benthos, which take the shallow ecological fallback.
//
// Band record = the depthbands.js shape (kind, minM, maxM, preferM, tight,
// hold, wanderM, wanderHz, hoverM, hoverVarM, note) plus provenance:
//   source      'data' | 'authored' (v3.4, no data) | 'fallback' | 'archetype'
//   basis       which derivation step produced it
//   dataKey     the species entry it came from, or null
//   extentMinM/extentMaxM  the FULL sourced range, clamped to the column
//   substrateDepthM  benthic/rooted only: the depth the floor it needs sits at
//   substrate   'rock' | 'sand' | 'reef' | null
//   needsLight  rooted only: true — it photosynthesises and cannot go deep
//   previous    the v3.4 band this replaces, for diffing

const BANDS = DATA.bands;

/** Every lexicon word's corrected band, keyed by word. Frozen. */
export const CORRECTED_BANDS = Object.freeze(BANDS);

/** Per-archetype fallback bands for names outside the lexicon. Frozen. */
export const ARCHETYPE_BANDS = Object.freeze(DATA.archetypeBands);

/** How the bands were derived, in machine-readable form. */
export const BAND_DERIVATION = Object.freeze(DATA.bandDerivation);

/**
 * The corrected band for a lexicon word or a typed name, or null if the word
 * is outside the lexicon (fall back to ARCHETYPE_BANDS[arch] then).
 */
export function correctedBandFor(nameOrWord) {
  const k = bandKey(nameOrWord);
  return k ? BANDS[k] : null;
}

/** Corrected band for a name, falling back to the archetype's. Never null. */
export function bandForNameOrArch(name, arch) {
  return correctedBandFor(name) || ARCHETYPE_BANDS[arch] || ARCHETYPE_BANDS.fish;
}

const BAND_FIELDS = ['key', 'kind', 'minM', 'maxM', 'preferM', 'tight', 'hold', 'wanderM', 'wanderHz', 'hoverM', 'hoverVarM', 'note'];

/**
 * The corrected bands trimmed to exactly the fields depthbands.js reads, ready
 * to merge into SPECIES_BANDS.
 *
 * @param {object} [opts]
 *   floorMode  'ecology' (default) — kinds are left as the ecology says they
 *              are. 'benthic' and 'rooted' bands then carry a REAL depth
 *              (substrateDepthM) instead of the single 1200 m seabed, so
 *              depthbands.js must learn a per-band floor before it can place
 *              them; until it does, its floorDepthM() would still drop them to
 *              the abyssal plain.
 *              'anchored' — benthic and rooted bands are emitted as PELAGIC
 *              bands centred on their real depth (kelp 6–30 m, crab 0–35 m),
 *              which an UNMODIFIED depthbands.js places correctly today. The
 *              trade: they hold their true depth with nothing under them,
 *              because this column has exactly one floor and it is at 1200 m.
 *              Rooted bands get hold 3 / wander 0, so a plant still does not
 *              drift; benthic bands keep their small hover wander.
 * @returns {object} word -> band record (plain objects, safe to spread)
 */
export function asDepthbandsBands(opts) {
  const mode = (opts && opts.floorMode) || 'ecology';
  const out = {};
  for (const w of Object.keys(BANDS)) {
    const b = BANDS[w];
    const rec = {};
    for (const f of BAND_FIELDS) rec[f] = b[f];
    if (mode === 'anchored' && (b.kind === 'benthic' || b.kind === 'rooted')) {
      rec.kind = 'pelagic';
      rec.hoverM = 0;
      rec.hoverVarM = 0;
      if (b.kind === 'rooted') {
        rec.wanderM = 0;
        rec.wanderHz = 0;
        rec.hold = 3;
        rec.tight = 0.6;
      } else {
        rec.wanderM = Math.max(1.5, (b.maxM - b.minM) * 0.06);
        rec.wanderHz = 0.02;
      }
    }
    out[w] = rec;
  }
  return out;
}

/**
 * Every band as a flat table, for a report or a test:
 * [{ word, kind, minM, maxM, preferM, source, basis, previous }]
 */
export function bandTable() {
  return Object.keys(BANDS).map((w) => {
    const b = BANDS[w];
    return {
      word: w,
      arch: b.arch,
      kind: b.kind,
      minM: b.minM,
      maxM: b.maxM,
      preferM: b.preferM,
      source: b.source,
      basis: b.basis,
      previous: b.previous,
    };
  });
}

/** Only the bands whose placement v3.4 got wrong (kind changed, or the mode
 *  moved by more than 25%). The ecology diff, for the integrator. */
export function changedBands() {
  return bandTable().filter((r) => {
    const p = r.previous;
    if (!p) return false;
    return p.kind !== r.kind || Math.abs(p.preferM - r.preferM) > Math.max(4, 0.25 * p.preferM);
  });
}

// ---------------------------------------------------------------------------
// The water column itself — zones, temperature, light (for the depth gauge)
// ---------------------------------------------------------------------------

/** The four ocean zones, each with name, nickname, depth range, facts,
 *  sources and a precision note. Ordered shallow to deep. */
export const ZONES = Object.freeze(DATA.zones);

/** Sources for the zone/temperature/light set as a whole. */
export const ZONE_SOURCES = Object.freeze(DATA.zoneSources);

/** The zone containing `depthM`, or the deepest one below its range. */
export function zoneAt(depthM) {
  const m = Number.isFinite(depthM) ? depthM : 0;
  for (let i = 0; i < ZONES.length; i++) {
    const z = ZONES[i];
    if (m >= z.depthMinM && m < z.depthMaxM) return z;
  }
  return m < ZONES[0].depthMinM ? ZONES[0] : ZONES[ZONES.length - 1];
}

/** Temperature anchors by depth. tempC and rangeC are BOTH nullable and are
 *  null on purpose where no source gives a global figure — see each note. */
export const TEMPERATURE = Object.freeze(DATA.temperature);

/** The deepest temperature anchor at or above `depthM`, or null above the
 *  shallowest one. May carry tempC null, rangeC null, or both. */
export function temperatureAt(depthM) {
  const m = Number.isFinite(depthM) ? depthM : 0;
  let hit = null;
  for (let i = 0; i < TEMPERATURE.length; i++) {
    if (TEMPERATURE[i].depthM <= m) hit = TEMPERATURE[i];
  }
  return hit;
}

/** "17 °C", "2–4 °C", or NULL when the anchor has neither a point nor a range.
 *  A null return means print nothing — not "unknown", not a guess. */
export function temperatureLabel(anchor) {
  if (!anchor) return null;
  if (anchor.tempC != null) return `${trim(anchor.tempC, 1)} °C`;
  if (anchor.rangeC && anchor.rangeC.length === 2) {
    return `${trim(anchor.rangeC[0], 1)}–${trim(anchor.rangeC[1], 1)} °C`;
  }
  return null;
}

/** Light remaining anchors by depth. percentOfSurface is nullable below
 *  100 m — no source gives a number there, so none is invented. */
export const LIGHT = Object.freeze(DATA.lightRemaining);

/** The deepest light anchor at or above `depthM`, or null above 10 m. */
export function lightAt(depthM) {
  const m = Number.isFinite(depthM) ? depthM : 0;
  let hit = null;
  for (let i = 0; i < LIGHT.length; i++) {
    if (LIGHT[i].depthM <= m) hit = LIGHT[i];
  }
  return hit;
}

/** "16% of surface light", or NULL where the percentage is nulled. Fall back
 *  to the anchor's own `note`, which is sourced prose, not a number. */
export function lightLabel(anchor) {
  if (!anchor || anchor.percentOfSurface == null) return null;
  return `${trim(anchor.percentOfSurface, 1)}% of surface light`;
}

const columnCache = new Map();

/**
 * Everything the depth gauge might print for one depth, with nulls already
 * removed — same contract as statRows.
 *
 * The gauge may call this every frame while the user drags the column, so the
 * result is memoised on the (zone, temperature anchor, light anchor) triple —
 * the only things that can change what it says. After each band is visited
 * once this allocates nothing, and `depthM` on the returned record is the
 * anchor triple's, not the caller's: read the depth from your own state.
 * @returns {{zone, rows: Array}}
 */
export function columnRowsAt(depthM) {
  const m = Number.isFinite(depthM) ? depthM : 0;
  const z = zoneAt(m);
  const t = temperatureAt(m);
  const l = lightAt(m);
  const ck = `${z ? z.key : '-'}|${t ? t.depthM : '-'}|${l ? l.depthM : '-'}`;
  const hit = columnCache.get(ck);
  if (hit) return hit;
  const rows = [];
  const push = (key, label, value, note) => {
    if (value == null || value === '') return;
    rows.push(Object.freeze({ key, label, value, note: note || null }));
  };
  push('zone', 'zone', z ? z.nickname : null, z ? z.name : null);
  push('temp', 'temperature', temperatureLabel(t), t ? t.label : null);
  push('light', 'light', lightLabel(l), l ? l.note : null);
  if (z && z.facts && z.facts.length) push('fact', 'note', z.facts[0], null);
  const out = Object.freeze({ zone: z, rows: Object.freeze(rows) });
  columnCache.set(ck, out);
  return out;
}

// ---------------------------------------------------------------------------
// Coverage — which lexicon words the research reaches
// ---------------------------------------------------------------------------

/** { withData, viaAlias, noData } — lexicon words, as arrays. */
export const COVERAGE = Object.freeze(DATA.coverage);

/** { words, withData, viaAlias, noData, covered, pct } */
export function coverage() {
  const c = DATA.coverage;
  const words = c.withData.length + c.viaAlias.length + c.noData.length;
  const covered = c.withData.length + c.viaAlias.length;
  return {
    words,
    withData: c.withData.length,
    viaAlias: c.viaAlias.length,
    noData: c.noData.length,
    covered,
    pct: Math.round((covered / words) * 1000) / 10,
  };
}

/** Every researched species key. */
export function speciesKeys() {
  return Object.keys(SPECIES);
}

/** The raw merged dataset, for tests and tooling. Do not mutate. */
export const RAW = DATA;

export default {
  statsFor,
  statRows,
  hasStats,
  speciesKeyFor,
  correctedBandFor,
  bandForNameOrArch,
  asDepthbandsBands,
  bandTable,
  changedBands,
  zoneAt,
  temperatureAt,
  temperatureLabel,
  lightAt,
  lightLabel,
  columnRowsAt,
  coverage,
  formatSize,
  formatDepth,
  formatDepthRange,
  CORRECTED_BANDS,
  ARCHETYPE_BANDS,
  BAND_DERIVATION,
  ZONES,
  TEMPERATURE,
  LIGHT,
  PROVENANCE,
  PROVENANCE_LINE,
  DISCLAIMER,
  COVERAGE,
};
