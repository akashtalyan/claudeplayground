// AO blobs — Phase E atmosphere. A soft dark radial-gradient disc under each
// rooted creature (kelp, bloom): the ONE deliberate depth-semantic element in
// an otherwise order-free additive scene. Per the compositing contract
// (risk-spike-report L1): caustics (-20) → AO blobs (-10, NON-additive
// darkening) → all additive points (0). Enforced via renderOrder; everything
// in the chain has depthTest/depthWrite off, so renderOrder is the whole
// ordering story. The blobs darken the light already in the frame (caustic
// shafts, background haze) and can never darken creature dots — by design.
//
// Implementation: ONE pooled mesh (MAX quads, one draw call), view-plane
// billboarded in the vertex shader and squashed vertically so each disc reads
// as a contact-shadow pool on the seabed. Scale follows the flora's footprint
// (creature.rad); opacity eases with the creature's formation ramp and eases
// out when it disperses. Normal (SrcAlpha/OneMinusSrcAlpha) blending, black
// rgb — pure darkening, no tonemap, no sRGB (frame-graph hard rule 2).
//
// Who is "rooted" is the integrator's call: opts.getRooted() returns the live
// list each frame — either Creature objects from main.js (points/rad/material
// /state are read off them) or plain {x, y, z, r, formation, alive} records.
// Clock: eased with timeSec deltas from update() — no wall-time reads.

import * as THREE from 'three';

const MAX = 16; // board cap is 14 — one pool, never grown
const SQUASH = 0.32; // vertical squash: disc → seabed pool
const BASE_OPACITY = 0.45;
const EASE_RATE = 3.0; // 1/s opacity easing (dispersal fade-out)

const VERT = /* glsl */ `
attribute vec2 aCorner;  // [-1,1] quad corner
attribute vec4 aBlob;    // center xyz, half-width (0 = slot unused)
attribute float aOp;     // eased opacity 0..1

uniform float uSquash;

varying vec2 vUv;
varying float vOp;

void main() {
	vUv = aCorner;
	vOp = aOp;
	// view-plane billboard: offset in view space after the model-view transform
	vec4 mv = modelViewMatrix * vec4( aBlob.xyz, 1.0 );
	mv.xy += aCorner * vec2( aBlob.w, aBlob.w * uSquash );
	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying float vOp;

void main() {
	float d2 = dot( vUv, vUv );
	// soft gaussian core, windowed to exactly zero at the quad edge so the
	// square never shows against the caustic shafts behind it
	float g = exp( -d2 * 3.0 ) * max( 1.0 - d2, 0.0 );
	// black rgb + normal blending = pure multiplicative-style darkening
	gl_FragColor = vec4( 0.0, 0.0, 0.0, g * vOp );
}
`;

export function create( scene, globalUniforms, opts = {} ) {

	const getRooted = opts.getRooted ?? ( () => [] );
	const footprint = opts.footprint ?? 0.55; // disc half-width = rad × this

	const n = MAX * 6; // non-indexed, 2 triangles per blob
	const CORNERS = [ [ -1, -1 ], [ 1, -1 ], [ 1, 1 ], [ -1, -1 ], [ 1, 1 ], [ -1, 1 ] ];
	const corner = new Float32Array( n * 2 );
	const blob = new Float32Array( n * 4 );
	const op = new Float32Array( n );
	const posDummy = new Float32Array( n * 3 ); // three requires a 'position'
	for ( let i = 0; i < MAX; i++ ) {
		for ( let c = 0; c < 6; c++ ) {
			corner[ ( i * 6 + c ) * 2 ] = CORNERS[ c ][ 0 ];
			corner[ ( i * 6 + c ) * 2 + 1 ] = CORNERS[ c ][ 1 ];
		}
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( posDummy, 3 ) );
	geometry.setAttribute( 'aCorner', new THREE.BufferAttribute( corner, 2 ) );
	const blobAttr = new THREE.BufferAttribute( blob, 4 ).setUsage( THREE.DynamicDrawUsage );
	const opAttr = new THREE.BufferAttribute( op, 1 ).setUsage( THREE.DynamicDrawUsage );
	geometry.setAttribute( 'aBlob', blobAttr );
	geometry.setAttribute( 'aOp', opAttr );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );
	geometry.setDrawRange( 0, 0 );

	const material = new THREE.ShaderMaterial( {
		uniforms: { uSquash: { value: SQUASH } },
		vertexShader: VERT,
		fragmentShader: FRAG,
		blending: THREE.NormalBlending, // the deliberate NON-additive element
		transparent: true,
		depthWrite: false,
		depthTest: false,
		toneMapped: false,
	} );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;
	mesh.renderOrder = -10; // after caustics (-20), before additive points (0)
	scene.add( mesh );

	let intensity = opts.intensity ?? 1;
	let lastT = 0;
	// per-creature eased opacity, keyed by the rooted entry's identity so a
	// blob fades in with formation and out through dispersal
	let eased = new Map();

	// duck-typed reads: Creature objects from main.js or plain records
	function readEntry( e, out ) {
		const p = e.points ? e.points.position : e;
		out.x = p.x ?? 0;
		out.y = p.y ?? 0;
		out.z = p.z ?? 0;
		out.r = e.rad ?? e.r ?? 100;
		out.formation = e.material
			? e.material.uniforms.uFormation.value
			: ( e.formation ?? 1 );
		out.alive = e.state ? e.state === 'alive' : ( e.alive ?? true );
		return out;
	}
	const scratch = {};

	function update( timeSec /* , current — unused: shadows don't drift */ ) {
		const dt = Math.max( timeSec - lastT, 0 );
		lastT = timeSec;
		const c = 1 - Math.exp( -EASE_RATE * dt );
		const rooted = getRooted() || [];
		const next = new Map();
		let slot = 0;
		for ( let i = 0; i < rooted.length && slot < MAX; i++ ) {
			const s = readEntry( rooted[ i ], scratch );
			// target opacity: formation ramps it in, dispersal eases it to 0
			const target = s.alive ? BASE_OPACITY * intensity * s.formation : 0;
			const prev = eased.get( rooted[ i ] ) ?? 0;
			const o = prev + ( target - prev ) * c;
			next.set( rooted[ i ], o );
			if ( o < 0.003 ) continue; // invisible — free the slot
			const halfW = s.r * footprint;
			for ( let v = 0; v < 6; v++ ) {
				const k = slot * 6 + v;
				blob[ k * 4 ] = s.x;
				// sit the pool slightly below the root anchor
				blob[ k * 4 + 1 ] = s.y - halfW * SQUASH * 0.35;
				blob[ k * 4 + 2 ] = s.z;
				blob[ k * 4 + 3 ] = halfW;
				op[ k ] = o;
			}
			slot++;
		}
		eased = next; // entries gone from getRooted() are dropped with their state
		geometry.setDrawRange( 0, slot * 6 );
		if ( slot > 0 ) {
			blobAttr.needsUpdate = true;
			opAttr.needsUpdate = true;
		}
	}

	function setIntensity( v ) {
		intensity = Math.min( Math.max( v, 0 ), 1 );
	}

	function dispose() {
		scene.remove( mesh );
		geometry.dispose();
		material.dispose();
		eased.clear();
	}

	return { update, setIntensity, dispose, getIntensity: () => intensity };
}

export const createAoBlobs = create;
