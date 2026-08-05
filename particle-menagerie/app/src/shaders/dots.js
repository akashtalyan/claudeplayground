// Dot material — the ONE shader program for every creature (frame-graph rule 7).
// Per-creature variation is uniforms only; global uniforms are shared object
// references so mutating one value updates every creature's material at once.
// Output is linear HDR: no tonemap, no sRGB here — the pipeline owns both
// (frame-graph rule 2).

import * as THREE from 'three';
import { renderPixelScale } from '../quality.js';

// App-level sprite cap in CSS px; combined at runtime with uDpr and the
// GL-queried ALIASED_POINT_SIZE_RANGE max (frame-graph rule 8).
const APP_CAP_PX = 32.0;

const VERT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uFormation;
uniform float uIrid;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uRim;
uniform float uFogDensity;
uniform float uFogScale;
uniform float uFogRef;
uniform vec3 uFogTint;
uniform vec3 uWaterColor;
uniform float uDepthTint;
uniform float uGain;
uniform float uFocusZ;
uniform float uAperture;
uniform float uDpr;
uniform float uMaxPointPx;
uniform float uSmall;
// ---- bioluminescence (v3.7) — see the BIO block in main() ------------------
// uBio       x strength (0 = the whole layer is off), y pattern mode,
//            z rate in Hz, w pattern parameter (see each mode)
// uBioAim    xyz the body-fixed surface the photophores sit on (local space,
//            unit; (0,-1,0) = the belly), w the angular width of that band
// uBioLure   xyz the body-fixed direction the lure sits in (local, unit),
//            w the aRing fraction that is "the lure's station" — positive
//            measures from the head/root end, negative from the tail/tip end
// uBioColor / uBioLureColor  linear emissive radiance, the lure's already
//            scaled by its own gain (a red dragonfish lure is not a red body)
uniform vec4 uBio;
uniform vec4 uBioAim;
uniform vec4 uBioLure;
uniform vec3 uBioColor;
uniform vec3 uBioLureColor;
uniform float uBioGain;

attribute float aSize;
attribute float aTw;
attribute float aRing;

varying vec3 vColor;
varying float vAlphaExtra;
varying float vTw;
varying float vMerge;
// x: sprite pad actually granted (>= 1, see BLEED_PAD); y: how far the wide
// bioluminescent lobe is engaged for this dot (0 = v3.1 profile exactly).
varying vec2 vGlow;

const float APP_CAP_PX = ${APP_CAP_PX.toFixed( 1 )};
// Distance (view units) at which a dot renders at exactly aSize CSS px.
const float REF_DIST = 10.0;
// Small-creature merge correction (Phase F). Dot px size is normalized per
// archetype at spawn while dot spacing scales with the creature, so the
// projected dot-size : dot-spacing ratio relative to the archetype's tuned
// default reduces exactly to uSmall / worldScale (uSmall = refScale x
// spawnViewDist / camDist, set per creature; 0 disables — plankton, sediment,
// the feeding mote). Below MERGE_FREE x default the look is untouched;
// beyond it dots overlap, so per-dot alpha divides by merge^2 (the overlap
// count grows as merge^2) — energy conservation: total brightness must not
// grow as dots merge, or small creatures bloom into solid white comets.
const float MERGE_FREE = 1.35;
const float MERGE_MAX = 3.2;
// Wrap-around Lambert softness: light bleeds past the terminator so a
// dotted shell reads as a soft organic form, not a hard-lit ball.
const float WRAP = 0.5;
const float TAU = 6.2831853;
const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
// Aerial perspective (v3.2): how far the emitted hue rotates toward the water
// colour at infinite depth, and the depth constant of that rotation, in units
// of the SAME extinction term the fog uses. AER_MAX keeps the farthest dot
// recognisably its own colour — this is water, not a blue filter.
const float AER_K = 1.0;
const float AER_MAX = 0.62;
// Wide-lobe glow (v3.2). A second, much fainter gaussian needs room outside
// the existing halo to be visible at all, so BRIGHT dots (and only bright
// dots) get a padded sprite; the core and the original halo are divided back
// out in the fragment stage, so their pixel footprint is unchanged. Dim,
// distant, defocused, merged-small and plankton/sediment dots stay at pad 1.0
// and render exactly as in v3.1 — the fill-rate cost (Risk 5) is paid only
// where the glow is actually visible.
const float BLEED_PAD = 1.45;
const float BRIGHT_LO = 0.6;
const float BRIGHT_HI = 1.6;

// ---------------------------------------------------------------------------
// Bioluminescence (v3.7) — light the animal MAKES, not light it is lit BY
// ---------------------------------------------------------------------------
//
// Everything above this line is reflected light: it multiplies uLightColor, it
// bends around a light direction, and by the time it reaches the midnight zone
// the depth profile has extinguished it. Bioluminescence is the other kind,
// and three properties define it. All three are load-bearing below:
//
//   1. NO LIGHT DIRECTION. The emission never touches lambert, rim, uLightDir
//      or uLightColor. A photophore facing away from the sun is exactly as
//      bright as one facing it, because the sun has nothing to do with it.
//
//   2. NOT ATTENUATED BY THE WATER ABOVE THE ANIMAL, ATTENUATED BY THE WATER
//      IN FRONT OF IT. Its photons start AT the dot, so the whole column
//      between the sun and the creature — which lives in uLightColor and in
//      the depth profile that drives it — must not touch it. The column
//      between the creature and the camera must: that is the exp(-ext) term
//      below, and the emission is added to 'lit' immediately BEFORE it, so it
//      is fogged exactly once, like every other photon leaving this dot.
//
//   3. BODY-FIXED. Every pattern is a function of the LOCAL normal, the LOCAL
//      position and aRing (the head->tail / root->tip fraction, ring-quantized
//      by the geometry spec). A row of photophores therefore stays on the
//      flank it was drawn on however the animal turns, and a lure stays at the
//      head while the head swings — the pattern is anatomy, not a screen
//      effect.
//
// uBio.x == 0 skips the block entirely: a creature with no bioluminescence
// renders bit-for-bit as it did in v3.6, and so does every ?scene= spike.
//
// Pattern modes (the canonical list lives in src/biolum.js — these five
// numbers are the contract between that module and this shader):
const float BIO_ROWS = 1.0;      // photophore rows: counter-illumination
const float BIO_LURE = 2.0;      // one hot point off the head: angler, dragonfish
const float BIO_PULSE = 3.0;     // whole-body pulse / Atolla's spinning alarm
const float BIO_GLOW = 4.0;      // diffuse glow: dinoflagellates, crystal jelly
const float BIO_ROWS_LURE = 5.0; // both — the dragonfish case
// Ceiling on emitted radiance per channel, pre-fog, pre-gain. The additive
// pileup bound (8% of pixels fully white) is a budget, not a suggestion: a
// lure is a handful of dots so it is allowed to be hot, but nothing here may
// run away. Bioluminescence has to read as INTENSE AGAINST BLACK — which is
// saturated colour plus the wide bleed lobe — not as a white blob.
const float BIO_MAX = 3.0;
// A lure is a lantern, not a brighter scale dot: the sprite itself grows,
// BEFORE the wide-lobe pad, so its core and halo grow with it and it reads as
// one point of light hanging off the animal. Energy therefore grows as the
// square of this — which is why it is small, and why it reaches only the few
// dots at the lure's own station.
const float BIO_LURE_PX = 1.75;

// A latitude band on the body: how close this dot's local normal is to 'aim'.
// aim (0,-1,0) is the belly (counter-illumination's home), (0,0,±1) a flank,
// (0,1,0) the dorsal surface. Gaussian in the angular error, so the row has no
// hard edge to crawl or alias.
float bioBand( vec3 nl, vec3 aim, float width ) {
	float x = ( 1.0 - dot( nl, aim ) ) / max( width, 1e-3 );
	return exp( -x * x );
}

// Discrete photophores along the body. aRing is ring-quantized (geometry spec
// section 7), so a periodic function of it lights WHOLE STATIONS: a row of
// separate lamps with dark gaps between them, which is what a photophore row
// looks like, rather than a painted stripe.
float bioLamps( float ring, float pitch ) {
	float s = 0.5 + 0.5 * cos( TAU * ring * pitch );
	s *= s;
	return s * s * s; // ^6 — tight lamps, dark gaps
}

// The lure's station: the head end (frac > 0) or the tip end (frac < 0) of the
// aRing parameter. Anatomy again — every archetype's aRing runs head/root 0 to
// tail/tip 1, so this is the same "front of the animal" everywhere.
// (Both branches keep edge0 < edge1: GLSL leaves smoothstep with reversed
// edges undefined, so the head case is written as 1 - the rising ramp.)
float bioStation( float ring, float frac ) {
	return frac >= 0.0
		? 1.0 - smoothstep( 0.0, max( frac, 1e-3 ), ring )
		: smoothstep( 1.0 + min( frac, -1e-3 ), 1.0, ring );
}

void main() {

	vec4 mv = modelViewMatrix * vec4( position, 1.0 );

	// Near-plane guard before the 1/z division (rule 8): clamp -z >= 0.1*near.
	// near is recovered from the standard perspective projection matrix so no
	// extra uniform is needed.
	float near = projectionMatrix[3][2] / ( projectionMatrix[2][2] - 1.0 );
	float viewDist = max( -mv.z, 0.1 * near );

	// DOF (rule 10): defocus factor k, capped at 4; energy conserved below by
	// alpha x 1/k^2. uFocusZ is the focus distance as positive view-space depth.
	float k = min( 1.0 + abs( viewDist - uFocusZ ) * uAperture, 4.0 );

	// Hoisted from below (same expression, same operand — the value is
	// unchanged): the bioluminescence block needs it for the counter-
	// illumination lobe, and it is computed before the point size for that.
	vec3 viewDir = normalize( -mv.xyz );

	// ---- bioluminescence: which dots emit, and how much (see the block above)
	// bioBody is in units of uBioColor, bioLure in units of uBioLureColor, and
	// both are exactly 0.0 — with no work done — when the layer is off.
	float bioBody = 0.0;
	float bioLure = 0.0;
	float bioPx = 1.0; // sprite growth for a lure dot; exactly 1.0 otherwise
	if ( uBio.x > 0.0 ) {

		// LOCAL normal: body-fixed, so the pattern is painted on the animal and
		// not on the screen. Eased and therefore non-unit (geometry spec), so
		// renormalize with the same degenerate guard the view normal uses.
		vec3 nl = normal / max( length( normal ), 1e-5 );
		float mode = uBio.y;
		float ph = uTime * uBio.z; // cycles, not radians — TAU applied at use
		// Mode dispatch, written once so the two combined modes cannot drift
		// apart from the single ones. These are uniform branches: every dot of
		// a draw call takes the same path, so the cost is one mode, not five.
		bool doRows = ( mode > BIO_ROWS - 0.5 && mode < BIO_ROWS + 0.5 ) || mode > BIO_ROWS_LURE - 0.5;
		bool doPulse = mode > BIO_PULSE - 0.5 && mode < BIO_PULSE + 0.5;
		bool doGlow = mode > BIO_GLOW - 0.5 && mode < BIO_GLOW + 0.5;
		bool doLure = ( mode > BIO_LURE - 0.5 && mode < BIO_LURE + 0.5 ) || mode > BIO_ROWS_LURE - 0.5;

		if ( doRows ) {
			// ROWS — counter-illumination, the commonest use of light in the
			// ocean: a row of ventral lamps whose output cancels the animal's
			// silhouette against the dim light from above. It is therefore
			// AIMED: brightest to an eye directly below it. The floor keeps it
			// legible from the side (which is where this camera lives) instead
			// of switching the adaptation off whenever you are not its prey.
			vec3 aimV = normalize( normalMatrix * uBioAim.xyz );
			float lobe = 0.6 + 0.4 * clamp( dot( aimV, viewDir ), 0.0, 1.0 );
			bioBody = bioBand( nl, uBioAim.xyz, uBioAim.w )
				* bioLamps( aRing, uBio.w )
				* ( 0.78 + 0.22 * sin( TAU * ph + aRing * 9.0 ) )
				* lobe;
		} else if ( doPulse ) {
			// PULSE — a wave of light running the length of the body or down
			// the bell, and at uBio.w -> 1 the atolla jellyfish's burglar
			// alarm: a narrow sector spinning around the bell to call in
			// something big enough to eat whatever is holding it. The spin is
			// about the LOCAL Y axis, which is the bell axis of every
			// archetype that has a bell.
			float wave = 0.5 + 0.5 * cos( TAU * ( ph - aRing * 0.9 ) );
			wave *= wave * wave;
			// atan(0,0) is undefined in GLSL and a dot can sit exactly on the
			// bell axis, so the degenerate case is answered explicitly rather
			// than left to leak a NaN into the emitted colour.
			vec2 pxz = position.xz;
			float az = dot( pxz, pxz ) > 1e-12 ? atan( pxz.y, pxz.x ) : 0.0;
			float spin = 0.5 + 0.5 * cos( az - TAU * ph );
			spin *= spin;
			spin *= spin;
			spin *= spin; // ^8 — a narrow rotating sector
			bioBody = mix( wave, spin, clamp( uBio.w, 0.0, 1.0 ) );
		} else if ( doGlow ) {
			// GLOW — a diffuse whole-body field: dinoflagellates in the water
			// the animal disturbs, a crystal jelly's ring. uBio.w is how much
			// of it is per-cell sparkle (aTw is the dot's own static phase)
			// rather than one even sheet of light.
			float sparkle = 0.5 + 0.5 * sin( TAU * ph + aTw );
			bioBody = mix( 1.0, sparkle, clamp( uBio.w, 0.0, 1.0 ) )
				* ( 0.82 + 0.18 * sin( TAU * ph * 0.6 + aRing * 3.0 ) );
		}

		if ( doLure ) {
			// LURE — the esca of an anglerfish, the barbel of a dragonfish: the
			// few dots at the head's own station whose surface faces the lure's
			// direction, driven hot and grown (BIO_LURE_PX) so they read as one
			// lamp standing off the head rather than as a bright patch of skin.
			// It twitches, because a still lure catches nothing.
			bioLure = bioStation( aRing, uBioLure.w )
				* bioBand( nl, uBioLure.xyz, 0.62 )
				* ( 0.62 + 0.38 * sin( TAU * ph ) );
		}

		// A pattern drawn on a cloud of unformed dots is not a pattern — same
		// reasoning as the directional terms below, which also ride uFormation.
		float form = mix( 0.2, 1.0, uFormation );
		bioBody *= form;
		bioLure *= form;
		bioPx = mix( 1.0, BIO_LURE_PX, clamp( bioLure, 0.0, 1.0 ) );
	}

	// Point size policy (rule 8): clamp(base*dpr*atten(z), 1, min(cap*dpr, GLmax)).
	// uDpr is the raster ratio of the target being drawn into, so it carries the
	// v3.2 supersample factor (quality.js) — sprites keep their CSS-px size
	// through the downsample. gl_PointSize itself is assigned below, once the
	// dot's brightness is known (see the wide-lobe pad).
	// bioPx is exactly 1.0 for every dot that is not a lure, and multiplying by
	// 1.0 is exact, so the size of every other dot in the app is untouched.
	float px = aSize * uDpr * ( REF_DIST / viewDist ) * k * bioPx;
	float maxPx = min( APP_CAP_PX * uDpr, uMaxPointPx );

	// Sub-1.5-raster-px fade uses the UNCLAMPED, UNPADDED size so the 1px floor
	// never brightens distant dots (rule 8), times the DOF 1/k^2 (rule 10).
	vAlphaExtra = smoothstep( 0.0, 1.5, px ) / ( k * k );

	// Small-creature merge correction (see MERGE_FREE above). worldScale is
	// the model matrix's uniform scale (view is rigid), so the size slider and
	// eased size morphs track automatically. merge == 1.0 exactly for every
	// creature at or above MERGE_FREE x its tuned default — large creatures
	// are provably untouched.
	float ws = length( modelViewMatrix[ 0 ].xyz );
	float merge = uSmall > 0.0
		? clamp( uSmall / ( ws * MERGE_FREE ), 1.0, MERGE_MAX )
		: 1.0;
	vAlphaExtra /= merge * merge;
	vMerge = merge - 1.0;

	// Normals arrive eased (same coefficient as position, geometry spec) and
	// therefore non-unit: renormalize in-shader, with a degenerate-length guard.
	vec3 n = normalMatrix * normal;
	n /= max( length( n ), 1e-5 );

	// uLightDir is a world-space direction; bring it into view space here.
	vec3 L = normalize( ( viewMatrix * vec4( uLightDir, 0.0 ) ).xyz );
	float lambert = clamp( ( dot( n, L ) + WRAP ) / ( 1.0 + WRAP ), 0.0, 1.0 );

	// Rim on silhouette normals; abs() because dots are two-sided emitters.
	// (viewDir is computed above, before the point size — see the bio block.)
	float rim = pow( 1.0 - abs( dot( n, viewDir ) ), 3.0 ) * uRim;

	// Twinkle phase: per-dot aTw plus a slow per-ring offset (rib shimmer).
	// (computed before the color terms so iridescence can reuse it)
	vTw = aTw * TAU + aRing * 0.7;

	// Directional terms scale with uFormation: a still-forming swarm has
	// meaningless normals and shows only the ambient floor.
	// Ambient floor 0.35 -> 0.45 (Phase C tuning): face-on sheet interiors
	// (ray wing, bloom petals) get little rim and were reading faint.
	vec3 lit = uColor * ( 0.45 + uLightColor * ( lambert + rim ) * uFormation );

	// Iridescence (Phase D): per-dot hue rotation with view angle — Rodrigues
	// rotation of the color about the gray axis. uIrid 0 is an exact identity.
	float ndv = abs( dot( n, viewDir ) );
	float hueA = uIrid * ( 2.4 * ( 1.0 - ndv ) - 1.0 + 0.6 * sin( vTw + uTime * 0.6 ) );
	const vec3 GREY = vec3( 0.57735027 );
	float ca = cos( hueA );
	float sa = sin( hueA );
	lit = lit * ca + cross( GREY, lit ) * sa + GREY * dot( GREY, lit ) * ( 1.0 - ca );

	// ---- the animal's OWN light -------------------------------------------
	// Added here and nowhere else, and the position in the chain IS the
	// physics (see the BIO block above): AFTER every directional and reflected
	// term, so no sun and no water above the animal can touch it, and BEFORE
	// the aerial-perspective rotation and the fog below, so the water between
	// the animal and the camera attenuates it exactly once — like every other
	// photon leaving this dot. It is not multiplied by the creature's own
	// uColor: a red jellyfish still glows blue-green, because the pigment and
	// the photophore are different organs.
	if ( uBio.x > 0.0 ) {
		float amp = uBio.x * uBioGain;
		lit += min( uBioColor * ( amp * bioBody ) + uBioLureColor * ( amp * bioLure ), vec3( BIO_MAX ) );
	}

	// Exponential fog is part of the emitted light, applied pre-accumulation so
	// it lands in the trail history (frame-graph rule 9 / spec section 9).
	// Fog measures depth INTO the scene relative to the creature plane
	// (uFogRef = camera distance to z=0): the plane itself is unfogged — the
	// regime every preset was tuned in — and distance swallows light behind it.
	// Relative depth is also viewport-invariant (uFogScale stays as a spare
	// normalizer, 1.0 in production).
	// uFogTint absorbs per channel (watery weather); uGain is the weather
	// presets' pre-accumulation exposure. Both default to identity.
	float fogDepth = max( viewDist - uFogRef, 0.0 );
	float ext = uFogDensity * uFogScale * fogDepth;

	// Aerial perspective (v3.2): distance doesn't only dim light, it cools it —
	// the water's own hue takes over as the column of water grows. Driven by the
	// SAME uFogRef-relative extinction as the fog below, so it is exactly zero
	// at the creature plane and exactly zero whenever fog is off, and it scales
	// with each weather preset's fog automatically.
	// Luma-preserving by construction: the mix target is the water hue
	// renormalised to this dot's own luminance, so this is a pure chroma
	// rotation. Dimming stays the fog's job, emitted energy is untouched, and
	// the tonemap/blowout budget therefore cannot move.
	float aer = min( uDepthTint * ( 1.0 - exp( -ext * AER_K ) ), AER_MAX );
	vec3 water = uWaterColor / max( dot( uWaterColor, LUMA ), 1e-4 );
	lit = mix( lit, water * dot( lit, LUMA ), aer );

	vColor = lit * exp( -ext * uFogTint ) * uGain;

	// Wide-lobe pad (v3.2, see BLEED_PAD): engage on the dot's actual emitted
	// peak — colour x alpha x the sub-pixel/DOF factor — so only genuinely
	// bright dots grow, and never the merged dots of a small creature (vMerge),
	// whose skirt Phase F deliberately tightened.
	float bright = max( vColor.r, max( vColor.g, vColor.b ) ) * uAlpha * vAlphaExtra;
	// A bioluminescent dot takes the wide lobe on its own account, whatever the
	// fog has left of its brightness: the water immediately around a photophore
	// scatters its light into a soft skirt, and that skirt — not raw amplitude
	// — is what makes a lamp read as a lamp instead of a hot pixel. Exactly 0
	// when the layer is off, and max(x, 0.0) is x, so nothing else moves.
	// Driven by the EMITTED amplitude, not by the raw pattern: a faint diffuse
	// glow does not get to buy the padded sprite that a photophore earns, so
	// the fill-rate cost (Risk 5) stays proportional to the light on screen.
	float bioEng = smoothstep( 0.12, 0.55, ( bioBody + bioLure ) * uBio.x * uBioGain );
	float engage = max( smoothstep( BRIGHT_LO, BRIGHT_HI, bright ), bioEng ) * ( 1.0 - clamp( vMerge, 0.0, 1.0 ) );
	float got = clamp( px * mix( 1.0, BLEED_PAD, engage ), 1.0, maxPx );
	gl_PointSize = got;
	// If the app/GL cap bit, the pad we actually got is smaller than asked for:
	// fall back toward the exact v3.1 profile instead of stretching the core
	// over a sprite that never grew. Unpadded dots (engage == 0, which includes
	// everything the 1.0-px floor lifted) are pinned to 1.0 so their profile is
	// bit-identical to v3.1.
	float grant = engage > 0.0 ? clamp( got / max( px, 1e-4 ), 1.0, BLEED_PAD ) : 1.0;
	vGlow.x = grant;
	vGlow.y = engage * clamp( ( grant - 1.0 ) / ( BLEED_PAD - 1.0 ), 0.0, 1.0 );

	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform float uAlpha;
uniform float uTime;
uniform vec2 uTwk;

varying vec3 vColor;
varying float vAlphaExtra;
varying float vTw;
varying float vMerge;
varying vec2 vGlow;

void main() {

	vec2 p = gl_PointCoord * 2.0 - 1.0;
	float d2 = dot( p, p );
	// Undo the wide-lobe sprite pad for the core and the original halo: d2c is
	// this fragment's squared distance in units of the UNPADDED sprite, so both
	// terms keep their exact v3.1 pixel footprint and peak (vGlow.x == 1 for
	// every dot that was not padded).
	float d2c = d2 * vGlow.x * vGlow.x;

	// Hot core + soft halo, both gaussian; the halo is windowed to zero at the
	// inscribed circle so the square sprite corner never shows under additive.
	// Halo raised 0.30/-4.0 -> 0.55/-3.2 (Phase C tuning): more bioluminescent
	// bleed around each dot; overall energy rebalanced via pipeline exposure.
	// Phase F: merged dots (vMerge > 0, small creatures) tighten the halo —
	// the wide skirt is what floods the gaps between overlapping dots and
	// defeats the dotted-rib identity; vMerge is 0 for everything at or above
	// its archetype's tuned default size, so large creatures keep the skirt.
	float core = exp( -d2c * 12.0 );
	// v3.2: on dots where the second lobe engages, the mid halo hands part of
	// its amplitude over to it (0.55 -> 0.42) — the peak stays at exactly
	// core+halo+bleed = 1.55 as in v3.1 and the total energy is within ~2%, so
	// this redistributes glow outward instead of adding brightness. Dots with
	// vGlow.y == 0 keep 0.55 and no second lobe: byte-identical to v3.1.
	float halo = mix( 0.55, 0.42, vGlow.y ) * exp( -d2c * ( 3.2 + 2.4 * vMerge ) ) * clamp( 1.0 - d2c, 0.0, 1.0 );
	// The second, much wider and much fainter lobe: bioluminescent bleed. It
	// lives in the padded part of the sprite (falloff 1.15 spans the whole
	// inscribed disc) and is windowed with (1-d2)^2 so it reaches zero with zero
	// slope — no ring, no sprite-corner tell under additive blending.
	float win = clamp( 1.0 - d2, 0.0, 1.0 );
	float bleed = 0.13 * vGlow.y * exp( -d2 * 1.15 ) * win * win;

	// Twinkle rate/depth from uTwk (Phase D); the default (2.1, 0.4) reduces to
	// exactly the Phase C constant 0.80 + 0.20 * sin( uTime * 2.1 + vTw ).
	float twinkle = 1.0 - uTwk.y + uTwk.y * ( 0.5 + 0.5 * sin( uTime * uTwk.x + vTw ) );

	// Linear HDR out. Blending is SrcAlpha/One (additive), so the whole scalar
	// intensity rides in alpha and multiplies vColor exactly once.
	gl_FragColor = vec4( vColor, ( core + halo + bleed ) * twinkle * uAlpha * vAlphaExtra );
}
`;

// Shared global uniform objects. Created once at startup; every creature
// material holds these same references. ALIASED_POINT_SIZE_RANGE is queried
// here, at startup (frame-graph rule 8).
//
// uDpr is the RASTER ratio of the target the dots are drawn into: the app
// assigns the renderer's pixel ratio to it (on boot and on every resize, as it
// always did) and the getter folds in the pipeline's current internal render
// scale — v3.2 supersamples the scene/trails targets above the canvas
// resolution (quality.js), and gl_PointSize is in target pixels, so without
// this every sprite would come out 1/scale too small after the downsample.
// Reading it costs one multiply and allocates nothing.
export function createGlobalUniforms( renderer ) {

	const gl = renderer.getContext();
	const pointSizeRange = gl.getParameter( gl.ALIASED_POINT_SIZE_RANGE );

	const uDpr = {
		_base: renderer.getPixelRatio(),
		get value() {
			return this._base * renderPixelScale();
		},
		set value( v ) {
			this._base = v;
		},
	};

	const uniforms = {
		uLightDir: { value: new THREE.Vector3( 0.35, 0.75, 0.55 ).normalize() },
		uLightColor: { value: new THREE.Color( 1.0, 1.0, 1.0 ) },
		uRim: { value: 1.0 },
		uFogDensity: { value: 0.045 },
		// Normalizes fog to the 540px-CSS-height tuning viewport: viewDist scales
		// with camDist (which scales with viewport height), so without this the
		// same preset over-fogs on taller screens.
		uFogScale: { value: 1.0 },
		// Camera distance to the z=0 creature plane (set on resize) — fog zero-point.
		uFogRef: { value: 518.0 },
		uFogTint: { value: new THREE.Vector3( 1, 1, 1 ) },
		// Aerial perspective (v3.2): the hue distant light is absorbed INTO —
		// the scene's own deep-water blue (background.js #0a1522 -> #04060a
		// column, normalised). Only the hue matters: the shader renormalises it
		// to the dot's own luminance, so changing it never changes brightness.
		uWaterColor: { value: new THREE.Vector3( 0.28, 0.52, 1.0 ) },
		// Strength of that rotation at infinite depth, before AER_MAX clamps it.
		uDepthTint: { value: 0.55 },
		uGain: { value: 1.0 },
		// Master on the bioluminescence layer (src/biolum.js). GLOBAL on
		// purpose: the depth profile and the weather presets both have an
		// opinion about how much of the animals' own light you should be
		// seeing ('bioluminescent bay' wants more of it; the sunlit shelf
		// wants less, because at 20 m nothing can compete with the sun), and
		// they should be able to say so with one number instead of touching
		// every creature. 1.0 is the identity; 0.0 turns the layer off
		// everywhere, which is also how to A/B it.
		uBioGain: { value: 1.0 },
		uFocusZ: { value: 12.0 },
		uAperture: { value: 0.05 },
		uDpr,
		uMaxPointPx: { value: pointSizeRange[ 1 ] },
	};

	// Aerial-perspective hook. The chrome layer may want depth tint as a named
	// intent, and it is the only way to A/B the term at runtime (0 is an exact
	// identity, so on/off is a clean measurement). Registered the same way
	// ui/ambient.js registers its own key; main.js spreads pre-existing
	// __menagerie keys into its test surface, so nothing is clobbered.
	if ( typeof window !== 'undefined' ) {
		window.__menagerie = window.__menagerie || {};
		window.__menagerie.dots = {
			setDepthTint: ( v ) => {
				uniforms.uDepthTint.value = Math.max( 0, v );
			},
			getDepthTint: () => uniforms.uDepthTint.value,
			setWaterColor: ( r, g, b ) => uniforms.uWaterColor.value.set( r, g, b ),
			// v3.7 bioluminescence master (see uBioGain). 0 is an exact
			// identity with v3.6 for every creature, so on/off is a clean
			// measurement of the whole layer.
			setBioGain: ( v ) => {
				uniforms.uBioGain.value = Math.max( 0, v );
			},
			getBioGain: () => uniforms.uBioGain.value,
		};
	}

	return uniforms;
}

export function createDotMaterial( globalUniforms ) {

	return new THREE.ShaderMaterial( {
		uniforms: {
			// per-creature
			uColor: { value: new THREE.Color( 0.55, 0.85, 1.0 ) },
			uAlpha: { value: 1.0 },
			uTime: { value: 0.0 },
			uFormation: { value: 1.0 },
			uTwk: { value: new THREE.Vector2( 2.1, 0.4 ) },
			uIrid: { value: 0.0 },
			// merge-correction reference (see VERT): refScale x spawnViewDist /
			// camDist, set by the creature integrator; 0 = correction off (the
			// default — plankton, sediment, and the feeding mote stay untouched)
			uSmall: { value: 0.0 },
			// bioluminescence (v3.7) — per-creature, and OFF by default:
			// uBio.x == 0 means the shader never enters the block, so any
			// creature the integrator does not light is bit-identical to
			// v3.6. src/biolum.js owns every value that goes in here; call
			// applyBio( material, bioForSpec( spec ) ) once at spawn.
			// Defaults below are inert but sane: belly rows, a lure off the
			// head, and the ~480 nm blue-green that most marine light is.
			uBio: { value: new THREE.Vector4( 0.0, 1.0, 0.12, 18.0 ) },
			uBioAim: { value: new THREE.Vector4( 0.0, -1.0, 0.0, 0.55 ) },
			uBioLure: { value: new THREE.Vector4( -0.55, 0.83, 0.0, 0.06 ) },
			uBioColor: { value: new THREE.Color( 0.0, 0.36, 1.0 ) },
			uBioLureColor: { value: new THREE.Color( 0.0, 0.36, 1.0 ) },
			// global — same object references across all materials, on purpose
			uLightDir: globalUniforms.uLightDir,
			uLightColor: globalUniforms.uLightColor,
			uRim: globalUniforms.uRim,
			uFogDensity: globalUniforms.uFogDensity,
			uFogScale: globalUniforms.uFogScale,
			uFogRef: globalUniforms.uFogRef,
			uFogTint: globalUniforms.uFogTint,
			uWaterColor: globalUniforms.uWaterColor,
			uDepthTint: globalUniforms.uDepthTint,
			uGain: globalUniforms.uGain,
			uBioGain: globalUniforms.uBioGain,
			uFocusZ: globalUniforms.uFocusZ,
			uAperture: globalUniforms.uAperture,
			uDpr: globalUniforms.uDpr,
			uMaxPointPx: globalUniforms.uMaxPointPx,
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		blending: THREE.AdditiveBlending,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		toneMapped: false,
	} );
}
