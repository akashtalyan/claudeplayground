// Sediment motes (marine snow) — atmosphere, now a world-space field filling
// the whole water column. One Points object of tiny dim dots drifting slowly
// DOWNWARD with current-driven sideways wander. Reuses the existing dot
// material (shaders/dots.js) exactly like the ambient plankton does, so the
// motes are additive, fogged, DOF'd and twinkled by the same one-program
// shader — no new GLSL.
//
// v3.4 — WORLD SPACE, NOT VIEWPORT SPACE. v3.3 packed the motes into one
// screen-tall band with the band bottoms glued to the seabed. In a 1200 m
// column that band would either be glued to the viewport (motes following you
// down, which is exactly the illusion this feature must not break) or spread
// so thin that the field disappears. So the field is a PERIODIC WORLD LATTICE:
// each mote has a fixed world trajectory, and it is drawn at whichever of its
// period-WRAP images lies nearest the camera. A mote therefore holds still in
// the water while you descend past it, and only ever jumps by a full period —
// off-screen, by construction. Motes are also folded back inside the column so
// none appear above the surface film or below the seabed.
//
// Depth drives density two ways: the profile's sedFrac picks how much of the
// mote pool is drawn (a prefix of a frozen iid draw order, so any prefix is a
// uniform subsample), and sedAlpha scales their brightness. Sparse and faint
// in the sunlit zone, thick and close near the abyssal plain.
//
// Determinism: all draws from mulberry32(seed), frozen order. Clock: closed
// form in timeSec except the current integral, accumulated from timeSec
// deltas — no wall-time reads. No allocation on the frame path.

import * as THREE from 'three';
import { mulberry32 } from '../geometry/rng.js';
import { createDotMaterial } from '../shaders/dots.js';
import {
	SEABED_DEPTH_M,
	DEFAULT_DEPTH_M,
	createDepthSample,
	sampleDepth,
	clampDepth,
	metresToWorldY,
	pxAbove,
} from '../depthprofile.js';

// Must match REF_DIST in shaders/dots.js: px = aSize * REF_DIST / viewDist.
const REF_DIST = 10;
const TAU = Math.PI * 2;
// Integrator tuning: 0.3 → 0.55 — at 0.3 the motes vanished entirely under
// the abyss preset's heavy fog; still comfortably dimmer than a creature dot
// (presets run this at 0.3-0.55 intensity in the lit weathers).
// 0.55 was invisible once real fog + the sub-1.5px shader fade + dark-preset
// gains stacked; marine snow needs to actually read against near-black water.
const BASE_ALPHA = 0.9;

// Pool size. Only a depth-driven fraction is ever drawn (see sedFrac): 0.13 of
// the pool in the sunlit zone, 0.52 at the default mid-water depth — which
// lands within ~20% of v3.3's on-screen mote count — and the whole pool at the
// abyssal plain, a bit over twice as thick as mid-water.
const POOL = 900;

export function create( scene, globalUniforms, opts = {} ) {

	const seed = ( opts.seed ?? 0x5ed1a3e7 ) >>> 0;
	const N = opts.count ?? POOL;
	const width = opts.width ?? 960;
	const height = opts.height ?? 540;
	const [ zMin, zMax ] = opts.zRange ?? [ -340, 40 ]; // main.js water volume
	// camDist only calibrates on-screen dot size (1:1 CSS-px plane at z=0);
	// default replicates main.js: camDist = (cssH/2)/tan(FOV/2), FOV 55.
	// All extents are lets: resize() rescales them (and the lattice period)
	// deterministically — the mote field is never rebuilt.
	let camDist = opts.camDist ?? height / 2 / Math.tan( ( 55 * Math.PI ) / 360 );

	let hw = width / 2 + 120;
	// Lattice period. It must exceed the world-y extent visible at the FAR end
	// of the water volume (motes at zMin are further away, so more of the
	// column fits on screen there) or a wrap seam could cross the frame.
	let wrapH = height * 1.5 + 200;

	// ---- frozen draw order: per-mote block, append only ----
	const rng = mulberry32( seed );
	const bx = new Float32Array( N );    // base x
	const by = new Float32Array( N );    // base y within one lattice period
	const fall = new Float32Array( N );  // px/s downward
	const wob = new Float32Array( N );   // sideways wobble amplitude px
	const wrate = new Float32Array( N ); // wobble rate
	const ph = new Float32Array( N );    // wobble phase
	const curF = new Float32Array( N );  // per-mote response to the current
	const bz = new Float32Array( N );    // fixed depth
	for ( let i = 0; i < N; i++ ) {
		bx[ i ] = ( rng() * 2 - 1 ) * hw;
		by[ i ] = rng() * wrapH;
		fall[ i ] = 2.5 + 6 * rng();
		wob[ i ] = 6 + 14 * rng();
		wrate[ i ] = 0.05 + 0.09 * rng();
		ph[ i ] = rng() * TAU;
		curF[ i ] = 0.4 + 0.8 * rng();
		// near-camera bias (integrator tuning — pure remap of the same draw):
		// snow drifting close to the lens survives heavy weather fog, and the
		// exponential falloff was erasing the uniform-depth motes wholesale.
		bz[ i ] = zMin + Math.pow( rng(), 0.7 ) * ( zMax - zMin );
	}
	// ---- end frozen draw order (attribute draws below also frozen) ----

	const pos = new Float32Array( N * 3 );
	const nor = new Float32Array( N * 3 );
	const aSize = new Float32Array( N );
	const aTw = new Float32Array( N );
	const aRing = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		// random unit normal: motes are omnidirectional specks; the wrap-Lambert
		// ambient floor keeps them visible from any light azimuth
		let nx = rng() * 2 - 1;
		let ny = rng() * 2 - 1;
		let nz = rng() * 2 - 1;
		const il = 1 / Math.max( Math.hypot( nx, ny, nz ), 1e-4 );
		nor[ i * 3 ] = nx * il;
		nor[ i * 3 + 1 ] = ny * il;
		nor[ i * 3 + 2 ] = nz * il;
		// tiny: 1.2-2.4 CSS px at this mote's depth (integrator tuning: was
		// 0.8-1.7, but the sub-1.5-device-px fade in the dot shader was erasing
		// most of the layer — marine snow should be faint, not absent)
		const vd = ( camDist - bz[ i ] ) / REF_DIST;
		aSize[ i ] = ( 1.6 + 1.4 * rng() ) * vd;
		aTw[ i ] = rng();
		aRing[ i ] = rng();
	}

	const geometry = new THREE.BufferGeometry();
	const posAttr = new THREE.BufferAttribute( pos, 3 ).setUsage( THREE.DynamicDrawUsage );
	const sizeAttr = new THREE.BufferAttribute( aSize, 1 );
	geometry.setAttribute( 'position', posAttr );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( nor, 3 ) );
	geometry.setAttribute( 'aSize', sizeAttr );
	geometry.setAttribute( 'aTw', new THREE.BufferAttribute( aTw, 1 ) );
	geometry.setAttribute( 'aRing', new THREE.BufferAttribute( aRing, 1 ) );

	const material = createDotMaterial( globalUniforms );
	// warm-neutral silt against the cool water, still nearly monochrome
	material.uniforms.uColor.value.setRGB( 0.72, 0.78, 0.82 );
	material.uniforms.uFormation.value = 1;
	material.uniforms.uTwk.value.set( 1.3, 0.55 ); // slow, deep shimmer

	const points = new THREE.Points( geometry, material );
	points.frustumCulled = false;
	// renderOrder 0: with the other additive emitters, AFTER the AO blobs (-10)
	scene.add( points );

	const wrapC = ( v, half ) => {
		const span = half * 2;
		let m = ( v + half ) % span;
		if ( m < 0 ) m += span;
		return m - half;
	};

	let intensity = opts.intensity ?? 1;
	let depthM = clampDepth( opts.depthM ?? DEFAULT_DEPTH_M );
	// World y the camera sits at. It stays 0 until setDepth() is called, so a
	// board whose camera has not been lifted into the column still finds the
	// mote field around it exactly as in v3.3.
	let viewY = 0;
	let surfaceY = viewY + pxAbove( depthM, 0 );
	let seabedY = viewY + pxAbove( depthM, SEABED_DEPTH_M );
	const sample = createDepthSample();
	let lastT = 0;
	let curInt = 0; // ∫ current dt — shared drift distance, scaled per mote

	function applyDepth() {
		sampleDepth( depthM, sample );
		surfaceY = viewY + pxAbove( sample.depthM, 0 );
		seabedY = viewY + pxAbove( sample.depthM, SEABED_DEPTH_M );
		material.uniforms.uAlpha.value = BASE_ALPHA * intensity * sample.sedAlpha;
		// Render-fraction density: a prefix of a frozen iid draw order, so any
		// count is a uniform subsample of the same field (no re-seeding, no
		// popping of individual motes as the fraction moves).
		geometry.setDrawRange( 0, Math.max( 1, Math.round( N * sample.sedFrac ) ) );
	}
	applyDepth();

	// depthM is optional: main.js may drive depth through update()'s third
	// argument or through setDepth() — both land in the same place.
	function update( timeSec, current = 0, m ) {
		if ( m !== undefined && m !== depthM ) setDepth( m );
		const dt = Math.max( timeSec - lastT, 0 );
		lastT = timeSec;
		curInt += current * dt;
		const half = wrapH * 0.5;
		const top = surfaceY - 6;   // nothing floats above the surface film
		const bottom = seabedY + 2; // nothing sinks through the floor
		for ( let i = 0; i < N; i++ ) {
			// A fixed world trajectory: this mote is falling through the column
			// whether or not anyone is watching from this depth.
			const yWorld = by[ i ] - fall[ i ] * timeSec;
			// …drawn at the lattice image nearest the camera, then folded back
			// inside the column. Both operations move a mote by whole periods
			// only, which is off-screen by construction.
			let y = viewY + wrapC( yWorld - viewY, half );
			if ( y > top ) y -= wrapH;
			else if ( y < bottom ) y += wrapH;
			const x = wrapC(
				bx[ i ] + curInt * curF[ i ] + wob[ i ] * Math.sin( wrate[ i ] * timeSec + ph[ i ] ),
				hw
			);
			pos[ i * 3 ] = x;
			pos[ i * 3 + 1 ] = y;
			pos[ i * 3 + 2 ] = bz[ i ];
		}
		posAttr.needsUpdate = true;
		material.uniforms.uTime.value = timeSec;
	}
	update( 0 );

	function setDepth( m ) {
		depthM = clampDepth( m );
		viewY = metresToWorldY( depthM ); // the camera's own world y (column.js)
		applyDepth();
	}

	// Resize: rescale extents + lattice data in place (deterministic — a pure
	// function of the new CSS size; NO rng draws, no rebuild, mote count
	// untouched). bx/by scale with the water volume so the field keeps covering
	// the viewport; aSize rescales by the view-distance ratio so each mote keeps
	// its authored CSS-px size under the new camDist.
	function resize( w, h ) {
		const newHw = Math.max( 1, w ) / 2 + 120;
		const newWrap = Math.max( 1, h ) * 1.5 + 200;
		const newCamDist = Math.max( 1, h ) / 2 / Math.tan( ( 55 * Math.PI ) / 360 );
		const sx = newHw / hw;
		const sy = newWrap / wrapH;
		for ( let i = 0; i < N; i++ ) {
			bx[ i ] *= sx;
			by[ i ] *= sy;
			aSize[ i ] *= ( newCamDist - bz[ i ] ) / Math.max( camDist - bz[ i ], 1e-3 );
		}
		sizeAttr.needsUpdate = true;
		hw = newHw;
		wrapH = newWrap;
		camDist = newCamDist;
		update( lastT, 0 ); // reproject positions into the new extents now
	}

	function setIntensity( v ) {
		intensity = Math.min( Math.max( v, 0 ), 1 );
		applyDepth();
	}

	function dispose() {
		scene.remove( points );
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
		// v3.7 — the object itself, so the integrator can carry this layer along
		// the vessel's new HORIZONTAL axis (main.js followCamX). Read-only by
		// convention: nothing in here reads .position, so setting it is a pure
		// world offset applied by the model matrix.
		points,
	};
}

export const createSediment = create;
