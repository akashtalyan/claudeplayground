// Trails accumulation — frame-graph.md step [3] plus the shared full-screen pass
// runner and HalfFloat target factory used by the whole chain.

import * as THREE from 'three';

// Full-screen triangle (covers the viewport with a single primitive; UVs beyond
// [0,1] are clipped away).
const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export class FullScreenPass {
	constructor( material ) {
		this.material = material;
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute(
			new Float32Array( [ - 1, - 1, 0, 3, - 1, 0, - 1, 3, 0 ] ), 3 ) );
		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.frustumCulled = false;
		this.scene = new THREE.Scene();
		this.scene.add( this.mesh );
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	}

	render( renderer, target ) {
		renderer.setRenderTarget( target );
		renderer.render( this.scene, this.camera );
	}
}

// Every intermediate target in the chain: HalfFloatType linear (frame-graph
// hard rule 1 — UnsignedByteType anywhere in the chain is a build failure).
export function makeHalfFloatTarget( w, h ) {
	return new THREE.WebGLRenderTarget( w, h, {
		type: THREE.HalfFloatType,
		colorSpace: THREE.LinearSRGBColorSpace,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		depthBuffer: false,
		stencilBuffer: false,
		generateMipmaps: false,
	} );
}

export const TRAILS_K_MAX = 0.995;

export function clamp01k( k ) {
	return Math.min( Math.max( k, 0 ), TRAILS_K_MAX );
}

// fadeK on the CPU, once per frame (frame-graph [3] + hard rule 4):
// frame-rate independent via pow(1-k, dt*60); capped below 1.0 in all cases
// (NEVER 1.0 — covers k=0 and dt=0); camera motion flushes screen-space
// history instead of streaking it.
export function computeFadeK( k, dtSec, camDeltaPx = 0 ) {
	let fadeK = Math.pow( 1 - clamp01k( k ), dtSec * 60 );
	if ( fadeK > TRAILS_K_MAX ) fadeK = TRAILS_K_MAX;
	fadeK *= 1 - Math.min( Math.max( camDeltaPx / 40, 0 ), 1 );
	return fadeK;
}

const TRAILS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tPrev;
uniform sampler2D tScene;
uniform float uFadeK;
varying vec2 vUv;
void main() {
	vec3 prev = texture2D( tPrev, vUv ).rgb;
	vec3 scn = texture2D( tScene, vUv ).rgb;
	vec3 next = clamp( prev * uFadeK + scn * ( 1.0 - uFadeK ), 0.0, 64.0 );
	// Subtractive epsilon below 8/255 so trails provably reach black in fp16.
	next = mix( next, max( next - 1.5 / 255.0, vec3( 0.0 ) ), step( next, vec3( 8.0 / 255.0 ) ) );
	gl_FragColor = vec4( next, 1.0 );
}
`;

export class Trails {
	constructor( w = 1, h = 1 ) {
		this.read = makeHalfFloatTarget( w, h );
		this.write = makeHalfFloatTarget( w, h );
		this.material = new THREE.ShaderMaterial( {
			uniforms: {
				tPrev: { value: null },
				tScene: { value: null },
				uFadeK: { value: 0 },
			},
			vertexShader: FS_VERT,
			fragmentShader: TRAILS_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		} );
		this.pass = new FullScreenPass( this.material );
	}

	// One accumulate step into the write target, then swap. Returns the latest
	// accumulated texture (this.output).
	accumulate( renderer, sceneTexture, fadeK ) {
		const u = this.material.uniforms;
		u.tPrev.value = this.read.texture;
		u.tScene.value = sceneTexture;
		u.uFadeK.value = fadeK;
		this.pass.render( renderer, this.write );
		const t = this.read;
		this.read = this.write;
		this.write = t;
		return this.read.texture;
	}

	get output() {
		return this.read.texture;
	}

	setSize( w, h ) {
		// setSize clears both targets: a resize flushes trail history.
		this.read.setSize( w, h );
		this.write.setSize( w, h );
	}
}
