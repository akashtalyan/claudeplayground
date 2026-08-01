// Caustic light shafts — atmosphere, now anchored to the water column.
// Reference: moonlight through water, never god-ray kitsch. 3-6 elongated
// triangles-as-quads with a purely procedural soft gradient (no textures, no
// image assets), slow sway and brightness flicker driven by uTime, tilted each
// frame to follow the global light direction (shared uLightDir uniform).
//
// v3.4: the shafts start at the SURFACE PLANE, not at the top of the frame.
// Their geometry is static in world space and their vertical extent is
// authored in METRES (depthprofile.js), so descending physically moves you
// down them: near the surface you are inside the bright root of the shaft,
// by the twilight zone they are a faint ceiling far above, and below ~-400 m
// the depth profile has extinguished them entirely (the mesh stops drawing).
// Absorption along the shaft is an exponential in true depth, so a shaft dims
// downward for the same reason the water does.
//
// Frame-graph position: these are EMITTED light, rendered in the scene pass
// pre-trails (frame-graph [1]-[2]) so shafts land in the trail history like
// every other emitter. Linear HDR out, no tonemap, no sRGB here (hard rule 2).
// Compositing contract (risk-spike-report L1): caustics render FIRST
// (renderOrder -20), before the AO blobs (-10), before all additive points (0)
// — enforced via renderOrder since every material in the chain has
// depthTest/depthWrite off.
//
// Cost: one draw call, 6 verts per shaft, one small shader. No per-pixel
// raymarching (breakdown §2.5 — fake it with gradient quads). setDepth() is a
// handful of uniform writes: the buffers never change with depth.
// Determinism: all placement drawn from mulberry32(seed) in a frozen order.
// Clock: time arrives via update(timeSec) — no wall-time reads.

import * as THREE from 'three';
import { mulberry32 } from '../geometry/rng.js';
import {
	METRES_PER_PX,
	PX_PER_METRE,
	SURFACE_M,
	DEFAULT_DEPTH_M,
	createDepthSample,
	sampleDepth,
	clampDepthM,
	offsetPxTo,
	yOfDepth,
} from '../depthprofile.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uCurrent;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uIntensity;
uniform float uFogDensity;
uniform float uFogScale;
uniform float uFogRef;
uniform vec3 uFogTint;
uniform float uGain;
uniform float uSurfaceY;   // world y of the surface plane (shaft origin)
uniform float uMPerPx;     // world px -> metres
uniform float uExtinctM;   // e-folding depth of the shaft, metres
uniform vec3 uDepthTint;   // water's own colour bias at the camera's depth

attribute vec3 aAnchor;   // shaft mouth, RELATIVE to the surface plane (world px)
attribute vec2 aAxis;     // x: u across [-1,1], y: v along [0,1] (0 = surface)
attribute vec3 aDim;      // length px, half-width at the mouth px, widen at tip
attribute vec2 aRand;     // phase, 0..1 seed

varying vec2 vUv;         // (u, v)
varying vec3 vColor;
varying float vSeed;

void main() {

	float u = aAxis.x;
	float v = aAxis.y;
	float phase = aRand.x;

	// Shaft axis = direction the light TRAVELS (down), projected to the screen
	// plane; guarded so a near-horizontal light can never flip shafts upward.
	vec2 axis = vec2( -uLightDir.x, min( -uLightDir.y, -0.35 ) );
	axis = normalize( axis );
	vec2 side = vec2( -axis.y, axis.x );

	// Slow sway, pinned at the surface (top), free at the tip; the weather's
	// current adds amplitude. Two incommensurate rates so it never loops.
	float sway = ( 0.7 * sin( uTime * 0.11 + phase )
	             + 0.3 * sin( uTime * 0.083 + phase * 2.7 ) )
	           * ( 10.0 + uCurrent * 2.2 ) * v * v;

	float halfW = mix( aDim.y, aDim.y * aDim.z, v ); // light spreads with depth
	vec2 planar = axis * ( v * aDim.x ) + side * ( u * halfW ) + vec2( sway, 0.0 );

	// Everything vertical is authored relative to the surface plane, then
	// lifted onto it — one uniform moves the whole shaft field when the
	// camera changes depth, with no buffer traffic.
	vec2 rel = aAnchor.xy + planar;
	vec3 world = vec3( rel.x, uSurfaceY + rel.y, aAnchor.z );

	// True depth of THIS vertex below the surface, and the water's absorption
	// of the shaft over that path. This is why shafts fade downward — not an
	// authored gradient.
	float belowM = max( -rel.y, 0.0 ) * uMPerPx;
	float absorb = exp( -belowM / uExtinctM );

	// Slow brightness flicker — surface ripple focusing, kept gentle (0.55-1).
	float flicker = 0.775 + 0.225 * sin( uTime * 0.17 + phase )
	                              * sin( uTime * 0.275 + phase * 3.1 );

	vec4 mv = modelViewMatrix * vec4( world, 1.0 );
	float viewDist = max( -mv.z, 0.0 );
	// Exponential fog pre-accumulation, same model as the dot shader
	// (frame-graph rule 9); uGain is the weather's pre-accumulation exposure.
	// Integrator fix: applied as LUMINANCE, and the light color is pulled 65%
	// toward gray. A shaft is a large STEADY dim gradient — per-channel-tinted,
	// its channels straddle the trails pass's sub-8/255 subtractive-epsilon
	// zone unevenly and the steady state bands into saturated red/olive
	// (fp16-decay guard crushing blue first). Near-neutral color keeps the
	// channels crossing that zone together, so the fade stays neutral;
	// scattered shaft light reading desaturated is also physically right.
	vec3 fog = exp( -uFogDensity * uFogScale * max( viewDist - uFogRef, 0.0 ) * uFogTint );
	const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
	float fogL = dot( fog, LUMA );
	vec3 lc = mix( vec3( dot( uLightColor, LUMA ) ), uLightColor, 0.35 );
	// Cool blue-silver bias: the near-neutral shaft color drifts olive once the
	// trails epsilon guard crushes blue — pre-bias the emitted light cold so
	// the accumulated steady state lands on the scene's moonlight palette.
	lc *= vec3( 0.78, 0.92, 1.22 );
	// …and a GENTLE walk toward the water's own colour at this depth (uDepthTint
	// is luminance-normalized and heavily compressed on the JS side, so the
	// channels still cross the epsilon zone together).
	lc *= uDepthTint;

	vUv = vec2( u, v );
	vSeed = aRand.y;
	vColor = lc * fogL * uGain * ( uIntensity * flicker * absorb );

	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vSeed;

void main() {

	float u = vUv.x;
	float v = vUv.y;

	// Soft gaussian across the width, windowed to zero at the quad edge.
	float across = exp( -u * u * 2.6 ) * max( 1.0 - u * u, 0.0 );

	// Fade along the shaft: a short ease off the surface film (so the mouth is
	// bright but not a hard rectangle edge) and a soft dissolve at the tip.
	// The real downward falloff is the depth absorption in the vertex shader —
	// this only shapes the ends.
	float along = smoothstep( 0.0, 0.05, v ) * max( 1.0 - v * v, 0.0 );

	// Scrolling internal bands (the cheap stand-in for a caustic mask —
	// breakdown §2.5): a faint 1D modulation drifting slowly down-shaft.
	float bands = 0.88 + 0.12 * sin( u * ( 2.0 + vSeed * 3.0 ) + v * 9.0 - uTime * 0.14 );

	// Zero-mean temporal dither (integrator fix): a steady dim gradient parks
	// pixels on the trails pass's sub-8/255 epsilon threshold and the steady
	// state posterizes into a hard iso-contour. ±20% alpha ripple walks each
	// pixel across the threshold so the accumulated average stays smooth —
	// and the residual grain reads as surface-ripple shimmer in the shaft.
	float dither = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) )
	                           + uTime * 9.0 ) * 43758.5453 );

	// Additive SrcAlpha/One: scalar shape rides in alpha, color in rgb —
	// linear HDR out, exactly like the dot shader.
	gl_FragColor = vec4( vColor, across * along * bands * ( 0.8 + 0.4 * dither ) );
}
`;

// Base emitted intensity at setIntensity(1). Deliberately faint: with the
// app's ~3.4 exposure this reads as a suggestion of light, not a beam.
// (Integrator tuning 0.05 → 0.07: at 0.05 the moonlit preset's 0.6 intensity
// × gain 1.0 fell below one sRGB step — shafts existed only in shallows.)
const BASE_ALPHA = 0.09;

// How fast a shaft is eaten by the water, in metres. 150 m e-folding puts a
// shaft at ~7% by 400 m, where the depth profile's own multiplier reaches
// zero — the two agree instead of fighting.
const SHAFT_EXTINCT_M = 150;

// Shaft length along its (tilted) axis, in metres: 384-624 m of travel, i.e.
// roughly 330-540 m of vertical drop at the default light tilt.
const SHAFT_LEN_M = 480;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export function create( scene, globalUniforms, opts = {} ) {

	const seed = ( opts.seed ?? 0x0ca571c5 ) >>> 0;
	let width = opts.width ?? 960;
	let height = opts.height ?? 540;

	// ---- frozen draw order: count, then a fixed block per shaft ----
	const rng = mulberry32( seed );
	const K = 3 + ( ( rng() * 4 ) | 0 ); // 3-6 shafts
	const shafts = [];
	for ( let i = 0; i < K; i++ ) {
		shafts.push( {
			xFrac: ( i + 0.15 + 0.7 * rng() ) / K - 0.5, // stratified across width
			zFrac: rng(),                                //  0 near .. 1 far
			lenFrac: 0.8 + 0.5 * rng(),                  // × SHAFT_LEN_M metres
			wFrac: 0.035 + 0.05 * rng(),                 // top half-width × width
			widen: 1.5 + 0.9 * rng(),                    // spread toward the tip
			phase: rng() * Math.PI * 2,
			seed01: rng(),
			bright: 0.55 + 0.55 * rng(),                 // per-shaft variance
		} );
	}
	// ---- end frozen draw order ----

	// Non-indexed: 2 triangles = 6 verts per shaft.
	const VPS = 6;
	const CORNERS = [ [ -1, 0 ], [ 1, 0 ], [ 1, 1 ], [ -1, 0 ], [ 1, 1 ], [ -1, 1 ] ];
	const n = K * VPS;
	const aAnchor = new Float32Array( n * 3 );
	const aAxis = new Float32Array( n * 2 );
	const aDim = new Float32Array( n * 3 );
	const aRand = new Float32Array( n * 2 );

	function fillAttributes() {
		// Horizontal placement is authored in CSS px and scaled by
		// (camDist − z)/camDist to world px at the shaft's own depth (the app's
		// 1:1 plane is z=0), so a shaft covers the same screen width at every z.
		// camDist derives from the CURRENT height exactly like main.js
		// (camDist = cssH/2/tan(FOV/2), FOV 55), so resize stays correct.
		//
		// VERTICAL placement is NOT scaled: it is authored in metres and
		// converted once, because a metre of sea water is a metre at any z. The
		// anchor y is a small negative offset so the shaft mouths do not all
		// share one perfectly straight line across the surface.
		const camDist = height / 2 / Math.tan( ( 55 * Math.PI ) / 360 );
		for ( let i = 0; i < K; i++ ) {
			const s = shafts[ i ];
			const z = -300 + s.zFrac * 190; // -300 .. -110
			const vd = ( camDist - z ) / camDist; // CSS px -> world px at depth z
			const ax = s.xFrac * ( width + 260 ) * vd;
			const ay = -s.zFrac * 40; // 0..-40 px below the surface film
			const len = s.lenFrac * SHAFT_LEN_M * PX_PER_METRE;
			const hw = s.wFrac * ( width + 200 ) * vd;
			for ( let c = 0; c < VPS; c++ ) {
				const k = i * VPS + c;
				aAnchor[ k * 3 ] = ax;
				aAnchor[ k * 3 + 1 ] = ay;
				aAnchor[ k * 3 + 2 ] = z;
				aAxis[ k * 2 ] = CORNERS[ c ][ 0 ];
				aAxis[ k * 2 + 1 ] = CORNERS[ c ][ 1 ];
				aDim[ k * 3 ] = len;
				aDim[ k * 3 + 1 ] = hw;
				aDim[ k * 3 + 2 ] = s.widen;
				aRand[ k * 2 ] = s.phase;
				aRand[ k * 2 + 1 ] = s.seed01 * s.bright;
			}
		}
	}
	fillAttributes();

	const geometry = new THREE.BufferGeometry();
	const anchorAttr = new THREE.BufferAttribute( aAnchor, 3 );
	const dimAttr = new THREE.BufferAttribute( aDim, 3 );
	geometry.setAttribute( 'position', anchorAttr ); // three requires 'position'
	geometry.setAttribute( 'aAnchor', anchorAttr );
	geometry.setAttribute( 'aAxis', new THREE.BufferAttribute( aAxis, 2 ) );
	geometry.setAttribute( 'aDim', dimAttr );
	geometry.setAttribute( 'aRand', new THREE.BufferAttribute( aRand, 2 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

	const material = new THREE.ShaderMaterial( {
		uniforms: {
			uTime: { value: 0 },
			uCurrent: { value: 0 },
			uIntensity: { value: BASE_ALPHA * ( opts.intensity ?? 1 ) },
			uSurfaceY: { value: -DEFAULT_DEPTH_M * PX_PER_METRE },
			uMPerPx: { value: METRES_PER_PX },
			uExtinctM: { value: SHAFT_EXTINCT_M },
			uDepthTint: { value: new THREE.Vector3( 1, 1, 1 ) },
			// shared references — mutating the globals updates this material too
			uLightDir: globalUniforms.uLightDir,
			uLightColor: globalUniforms.uLightColor,
			uFogDensity: globalUniforms.uFogDensity,
			uFogScale: globalUniforms.uFogScale,
			uFogRef: globalUniforms.uFogRef,
			uFogTint: globalUniforms.uFogTint,
			uGain: globalUniforms.uGain,
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		blending: THREE.AdditiveBlending,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		toneMapped: false,
		// Integrator fix: the quad winding depends on the light azimuth (axis is
		// derived from uLightDir per-frame), so one-sided culling silently drops
		// every shaft for half the light directions. Shafts are pure emitted
		// light — render both faces.
		side: THREE.DoubleSide,
	} );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;
	mesh.renderOrder = -20; // compositing contract: before AO, before points
	scene.add( mesh );

	let intensity = opts.intensity ?? 1;   // the weather preset's 0..1
	let depthM = opts.depthM ?? DEFAULT_DEPTH_M;
	// World y the camera sits at. It stays 0 until setDepth() is called, so a
	// board whose camera has not been lifted into the column still sees the
	// shafts descending from overhead exactly as in v3.3.
	let viewY = 0;
	const sample = createDepthSample();
	const tintV = material.uniforms.uDepthTint.value;

	function applyDepth() {
		sampleDepth( depthM, sample );
		material.uniforms.uSurfaceY.value = viewY + offsetPxTo( sample.depthM, SURFACE_M );
		material.uniforms.uIntensity.value = BASE_ALPHA * intensity * sample.caustics;
		// Water colour at this depth as a bounded hue bias: normalize to unit
		// luminance, then compress hard (pow 0.18) and blend 35% toward neutral.
		// Raw normalized transmittance is a 400:1 blue skew and would push the
		// shaft into the saturated-banding failure mode the trails epsilon
		// causes; this keeps the three channels within ~±25% of each other.
		const t = sample.transmit;
		const l = Math.max( LUMA_R * t[ 0 ] + LUMA_G * t[ 1 ] + LUMA_B * t[ 2 ], 1e-6 );
		tintV.set(
			1 + ( Math.pow( Math.max( t[ 0 ] / l, 1e-6 ), 0.18 ) - 1 ) * 0.35,
			1 + ( Math.pow( Math.max( t[ 1 ] / l, 1e-6 ), 0.18 ) - 1 ) * 0.35,
			1 + ( Math.pow( Math.max( t[ 2 ] / l, 1e-6 ), 0.18 ) - 1 ) * 0.35,
		);
		// Below the shafts' reach there is nothing to draw — skip the draw call
		// rather than submit 36 verts of zero.
		mesh.visible = intensity * sample.caustics > 1e-4;
	}
	applyDepth();

	// depthM is optional: main.js may drive depth through update()'s third
	// argument or through setDepth() — both land in the same place.
	function update( timeSec, current = 0, m ) {
		material.uniforms.uTime.value = timeSec;
		material.uniforms.uCurrent.value = current;
		if ( m !== undefined && m !== depthM ) setDepth( m );
	}

	function setDepth( m ) {
		depthM = clampDepthM( m );
		viewY = yOfDepth( depthM ); // the camera's own world y in the column
		applyDepth();
	}

	function setIntensity( v ) {
		intensity = Math.min( Math.max( v, 0 ), 1 );
		applyDepth();
	}

	function resize( w, h ) {
		width = Math.max( 1, w );
		height = Math.max( 1, h );
		fillAttributes();
		anchorAttr.needsUpdate = true;
		dimAttr.needsUpdate = true;
	}

	function dispose() {
		scene.remove( mesh );
		geometry.dispose();
		material.dispose();
	}

	return {
		update,
		setIntensity,
		setDepth,
		resize,
		dispose,
		getIntensity: () => intensity,
		getDepth: () => depthM,
	};
}

export const createCaustics = create;
