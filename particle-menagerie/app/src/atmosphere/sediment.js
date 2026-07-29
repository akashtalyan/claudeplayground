// Sediment motes — Phase E atmosphere. One Points object, ~250 tiny dim dots
// drifting slowly DOWNWARD (marine snow) with current-driven sideways wander,
// denser near the seabed. Reuses the existing dot material (shaders/dots.js)
// exactly like the ambient plankton does, so the motes are additive, fogged,
// DOF'd and twinkled by the same one-program shader — no new GLSL.
//
// Density gradient without drift decay: each mote falls inside its OWN
// vertical band; band tops are biased low (pow curve) while every band bottom
// is the seabed, so the summed density rises toward the bottom and STAYS that
// way as motes wrap — no re-uniforming over time.
//
// Determinism: all draws from mulberry32(seed), frozen order. Clock: closed
// form in timeSec except the current integral, accumulated from timeSec
// deltas — no wall-time reads. Cost: 250 dots of CPU trig per frame.

import * as THREE from 'three';
import { mulberry32 } from '../geometry/rng.js';
import { createDotMaterial } from '../shaders/dots.js';

// Must match REF_DIST in shaders/dots.js: px = aSize * REF_DIST / viewDist.
const REF_DIST = 10;
const TAU = Math.PI * 2;
// Integrator tuning: 0.3 → 0.55 — at 0.3 the motes vanished entirely under
// the abyss preset's heavy fog; still comfortably dimmer than a creature dot
// (presets run this at 0.3-0.55 intensity in the lit weathers).
const BASE_ALPHA = 0.55;

export function create( scene, globalUniforms, opts = {} ) {

	const seed = ( opts.seed ?? 0x5ed1a3e7 ) >>> 0;
	const N = opts.count ?? 250;
	const width = opts.width ?? 960;
	const height = opts.height ?? 540;
	const [ zMin, zMax ] = opts.zRange ?? [ -340, 40 ]; // main.js water volume
	// camDist only calibrates on-screen dot size (1:1 CSS-px plane at z=0);
	// default replicates main.js: camDist = (cssH/2)/tan(FOV/2), FOV 55.
	const camDist = opts.camDist ?? height / 2 / Math.tan( ( 55 * Math.PI ) / 360 );

	const hw = width / 2 + 120;
	const hh = height / 2 + 60;
	const spanY = hh * 2;

	// ---- frozen draw order: per-mote block, append only ----
	const rng = mulberry32( seed );
	const bx = new Float32Array( N );      // base x
	const bandTop = new Float32Array( N ); // band height above the seabed
	const u0 = new Float32Array( N );      // start fraction within the band
	const fall = new Float32Array( N );    // px/s downward
	const wob = new Float32Array( N );     // sideways wobble amplitude px
	const wrate = new Float32Array( N );   // wobble rate
	const ph = new Float32Array( N );      // wobble phase
	const curF = new Float32Array( N );    // per-mote response to the current
	const bz = new Float32Array( N );      // fixed depth
	for ( let i = 0; i < N; i++ ) {
		bx[ i ] = ( rng() * 2 - 1 ) * hw;
		// pow(., 1.8) biases band tops LOW → most motes live near the seabed,
		// a few climb the full water column.
		bandTop[ i ] = spanY * ( 0.12 + 0.88 * Math.pow( rng(), 1.8 ) );
		u0[ i ] = rng();
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
		aSize[ i ] = ( 1.2 + 1.2 * rng() ) * vd;
		aTw[ i ] = rng();
		aRing[ i ] = rng();
	}

	const geometry = new THREE.BufferGeometry();
	const posAttr = new THREE.BufferAttribute( pos, 3 ).setUsage( THREE.DynamicDrawUsage );
	geometry.setAttribute( 'position', posAttr );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( nor, 3 ) );
	geometry.setAttribute( 'aSize', new THREE.BufferAttribute( aSize, 1 ) );
	geometry.setAttribute( 'aTw', new THREE.BufferAttribute( aTw, 1 ) );
	geometry.setAttribute( 'aRing', new THREE.BufferAttribute( aRing, 1 ) );

	const material = createDotMaterial( globalUniforms );
	// warm-neutral silt against the cool water, still nearly monochrome
	material.uniforms.uColor.value.setRGB( 0.72, 0.78, 0.82 );
	material.uniforms.uAlpha.value = BASE_ALPHA * ( opts.intensity ?? 1 );
	material.uniforms.uFormation.value = 1;
	material.uniforms.uTwk.value.set( 1.3, 0.55 ); // slow, deep shimmer

	const points = new THREE.Points( geometry, material );
	points.frustumCulled = false;
	// renderOrder 0: with the other additive emitters, AFTER the AO blobs (-10)
	scene.add( points );

	const wrap01 = ( v ) => v - Math.floor( v );
	const wrapC = ( v, half ) => {
		const span = half * 2;
		let m = ( v + half ) % span;
		if ( m < 0 ) m += span;
		return m - half;
	};

	let intensity = opts.intensity ?? 1;
	let lastT = 0;
	let curInt = 0; // ∫ current dt — shared drift distance, scaled per mote

	function update( timeSec, current = 0 ) {
		const dt = Math.max( timeSec - lastT, 0 );
		lastT = timeSec;
		curInt += current * dt;
		for ( let i = 0; i < N; i++ ) {
			// fall inside the mote's own band: bottom = seabed, top biased low
			const y = -hh + bandTop[ i ] * wrap01( u0[ i ] - ( fall[ i ] * timeSec ) / bandTop[ i ] );
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

	function setIntensity( v ) {
		intensity = Math.min( Math.max( v, 0 ), 1 );
		material.uniforms.uAlpha.value = BASE_ALPHA * intensity;
	}

	function dispose() {
		scene.remove( points );
		geometry.dispose();
		material.dispose();
	}

	return { update, setIntensity, dispose, getIntensity: () => intensity };
}

export const createSediment = create;
