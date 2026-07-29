// Caustic light shafts — Phase E atmosphere. Reference: moonlight through
// water, never god-ray kitsch. 3-6 elongated additive triangles-as-quads with
// a purely procedural soft gradient (no textures, no image assets), slow sway
// and brightness flicker driven by uTime, tilted each frame to follow the
// global light direction (shared uLightDir uniform reference).
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
// raymarching (breakdown §2.5 — fake it with gradient quads).
// Determinism: all placement drawn from mulberry32(seed) in a frozen order.
// Clock: time arrives via update(timeSec) — no wall-time reads.

import * as THREE from 'three';
import { mulberry32 } from '../geometry/rng.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uCurrent;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uIntensity;
uniform float uFogDensity;
uniform float uFogScale;
uniform vec3 uFogTint;
uniform float uGain;

attribute vec3 aAnchor;   // shaft top center (world px; y sits above the frame)
attribute vec2 aAxis;     // x: u across [-1,1], y: v along [0,1] (0 = top)
attribute vec3 aDim;      // length px, half-width at top px, widen factor at tip
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
	vec3 world = aAnchor + vec3( planar, 0.0 );

	// Slow brightness flicker — surface ripple focusing, kept gentle (0.55-1).
	float flicker = 0.775 + 0.225 * sin( uTime * 0.17 + phase )
	                              * sin( uTime * 0.275 + phase * 3.1 );

	vec4 mv = modelViewMatrix * vec4( world, 1.0 );
	float viewDist = max( -mv.z, 0.0 );
	// Exponential fog pre-accumulation, same model as the dot shader
	// (frame-graph rule 9); uGain is the weather's pre-accumulation exposure.
	vec3 fog = exp( -uFogDensity * uFogScale * viewDist * uFogTint );

	vUv = vec2( u, v );
	vSeed = aRand.y;
	vColor = uLightColor * fog * uGain * ( uIntensity * flicker );

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

	// Fade along the shaft: full where it enters the frame, dissolving toward
	// the tip as the water absorbs it.
	float along = ( 1.0 - v ) * ( 1.0 - v );

	// Scrolling internal bands (the cheap stand-in for a caustic mask —
	// breakdown §2.5): a faint 1D modulation drifting slowly down-shaft.
	float bands = 0.88 + 0.12 * sin( u * ( 2.0 + vSeed * 3.0 ) + v * 9.0 - uTime * 0.14 );

	// Additive SrcAlpha/One: scalar shape rides in alpha, color in rgb —
	// linear HDR out, exactly like the dot shader.
	gl_FragColor = vec4( vColor, across * along * bands );
}
`;

// Base emitted intensity at setIntensity(1). Deliberately faint: with the
// app's ~3.4 exposure this reads as a suggestion of light, not a beam.
// (Integrator tuning 0.05 → 0.07: at 0.05 the moonlit preset's 0.6 intensity
// × gain 1.0 fell below one sRGB step — shafts existed only in shallows.)
const BASE_ALPHA = 0.07;

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
			lenFrac: 0.8 + 0.5 * rng(),                  // × viewport height
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
		// Shafts live in a mid-depth band behind most creatures. All dimensions
		// are authored in CSS px and scaled by (camDist − z)/camDist to world px
		// at the shaft's own depth (the app's 1:1 plane is z=0), so the anchor
		// sits above the visible frame at EVERY depth — otherwise a far shaft's
		// hard top edge (v=0, full brightness) cuts across the upper frame.
		// camDist derives from the CURRENT height exactly like main.js
		// (camDist = cssH/2/tan(FOV/2), FOV 55), so resize stays correct.
		const camDist = height / 2 / Math.tan( ( 55 * Math.PI ) / 360 );
		for ( let i = 0; i < K; i++ ) {
			const s = shafts[ i ];
			const z = -300 + s.zFrac * 190; // -300 .. -110
			const vd = ( camDist - z ) / camDist; // CSS px -> world px at depth z
			const ax = s.xFrac * ( width + 260 ) * vd;
			const ay = ( height / 2 + 40 ) * vd;
			const len = ( s.lenFrac * height + 120 ) * vd;
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
			// shared references — mutating the globals updates this material too
			uLightDir: globalUniforms.uLightDir,
			uLightColor: globalUniforms.uLightColor,
			uFogDensity: globalUniforms.uFogDensity,
			uFogScale: globalUniforms.uFogScale,
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

	let intensity = opts.intensity ?? 1;

	function update( timeSec, current = 0 ) {
		material.uniforms.uTime.value = timeSec;
		material.uniforms.uCurrent.value = current;
	}

	function setIntensity( v ) {
		intensity = Math.min( Math.max( v, 0 ), 1 );
		material.uniforms.uIntensity.value = BASE_ALPHA * intensity;
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

	return { update, setIntensity, resize, dispose, getIntensity: () => intensity };
}

export const createCaustics = create;
