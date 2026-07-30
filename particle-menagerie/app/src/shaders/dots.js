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

	// Point size policy (rule 8): clamp(base*dpr*atten(z), 1, min(cap*dpr, GLmax)).
	// uDpr is the raster ratio of the target being drawn into, so it carries the
	// v3.2 supersample factor (quality.js) — sprites keep their CSS-px size
	// through the downsample. gl_PointSize itself is assigned below, once the
	// dot's brightness is known (see the wide-lobe pad).
	float px = aSize * uDpr * ( REF_DIST / viewDist ) * k;
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
	vec3 viewDir = normalize( -mv.xyz );
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
	float engage = smoothstep( BRIGHT_LO, BRIGHT_HI, bright ) * ( 1.0 - clamp( vMerge, 0.0, 1.0 ) );
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
