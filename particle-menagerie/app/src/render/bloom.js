// Bloom — frame-graph.md chain position [4]. Reads the trails HDR output and
// produces a HALF-resolution blurred bright-pass texture; the final pass adds
// it to the trails color BEFORE its (single) tonemap + sRGB encode.
//
// Invariants honored here:
// - No tonemap and no color-space encode anywhere in this file (hard rule 2).
// - All targets HalfFloatType linear via makeHalfFloatTarget (hard rule 1).
// - Half resolution is mandatory (fill-rate: this is the expensive pass).
//
// Hand-rolled (soft-knee bright pass + 2 iterations of separable gaussian)
// rather than UnrealBloomPass: the pipeline is an explicit-target chain with
// no EffectComposer, and UnrealBloomPass composites additively onto its own
// readBuffer with internal materials that assume composer conventions. Three
// tiny passes at half res compose cleanly and cost less.

import * as THREE from 'three';
import { FullScreenPass, makeHalfFloatTarget } from './trails.js';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Soft-knee bright pass (Unreal/Kawase-style knee): smooth ramp around the
// threshold so glow fades in instead of popping. Pure linear HDR in/out.
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform float uThreshold;
varying vec2 vUv;
void main() {
	vec3 c = texture2D( tInput, vUv ).rgb;
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	float knee = uThreshold * 0.5 + 1e-4;
	float soft = clamp( l - uThreshold + knee, 0.0, 2.0 * knee );
	soft = soft * soft / ( 4.0 * knee );
	float contrib = max( soft, l - uThreshold ) / max( l, 1e-4 );
	gl_FragColor = vec4( c * max( contrib, 0.0 ), 1.0 );
}
`;

// 9-tap gaussian via 5 linear-filtered fetches (weights 0.2270, 0.3162,
// 0.0703). uStep carries direction, texel size, and radius scale.
const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
	vec3 acc = texture2D( tInput, vUv ).rgb * 0.227027;
	vec2 o1 = uStep * 1.384615;
	vec2 o2 = uStep * 3.230769;
	acc += ( texture2D( tInput, vUv + o1 ).rgb + texture2D( tInput, vUv - o1 ).rgb ) * 0.3162162;
	acc += ( texture2D( tInput, vUv + o2 ).rgb + texture2D( tInput, vUv - o2 ).rgb ) * 0.0702703;
	gl_FragColor = vec4( acc, 1.0 );
}
`;

// Widening factors for the two H+V gaussian iterations; the second pass reads
// already-blurred data, compounding into a smooth wide falloff (glow spill,
// not haze) without a mip chain.
const ITERATIONS = [ 1.0, 1.75 ];

export class Bloom {

	constructor() {
		this.rtA = makeHalfFloatTarget( 1, 1 );
		this.rtB = makeHalfFloatTarget( 1, 1 );
		this.texel = new THREE.Vector2( 1, 1 );

		this.brightMaterial = new THREE.ShaderMaterial( {
			uniforms: {
				tInput: { value: null },
				uThreshold: { value: 0.55 },
			},
			vertexShader: FS_VERT,
			fragmentShader: BRIGHT_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		} );
		this.blurMaterial = new THREE.ShaderMaterial( {
			uniforms: {
				tInput: { value: null },
				uStep: { value: new THREE.Vector2() },
			},
			vertexShader: FS_VERT,
			fragmentShader: BLUR_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		} );
		this.brightPass = new FullScreenPass( this.brightMaterial );
		this.blurPass = new FullScreenPass( this.blurMaterial );
	}

	// Takes the FULL drawing-buffer size; targets live at half res.
	setSize( fullW, fullH ) {
		const w = Math.max( 1, Math.round( fullW / 2 ) );
		const h = Math.max( 1, Math.round( fullH / 2 ) );
		this.rtA.setSize( w, h );
		this.rtB.setSize( w, h );
		this.texel.set( 1 / w, 1 / h );
	}

	prewarm( renderer ) {
		renderer.compile( this.brightPass.scene, this.brightPass.camera );
		renderer.compile( this.blurPass.scene, this.blurPass.camera );
	}

	// bright(input) -> rtA, then per iteration: blurH rtA->rtB, blurV rtB->rtA.
	// Result stays in rtA (this.output). Strength is NOT applied here — the
	// final pass owns it, so this stays pure linear light.
	render( renderer, inputTexture, { threshold, radius } ) {
		this.brightMaterial.uniforms.tInput.value = inputTexture;
		this.brightMaterial.uniforms.uThreshold.value = Math.max( 0, threshold );
		this.brightPass.render( renderer, this.rtA );

		// radius 0..1 -> 0.5..2.0 half-res texels of base step (kept <= the
		// kernel's clean linear-sampling range; no undersampling sparkle)
		const base = 0.5 + 1.5 * Math.min( Math.max( radius, 0 ), 1 );
		const u = this.blurMaterial.uniforms;
		for ( const it of ITERATIONS ) {
			const s = base * it;
			u.tInput.value = this.rtA.texture;
			u.uStep.value.set( this.texel.x * s, 0 );
			this.blurPass.render( renderer, this.rtB );
			u.tInput.value = this.rtB.texture;
			u.uStep.value.set( 0, this.texel.y * s );
			this.blurPass.render( renderer, this.rtA );
		}
	}

	get output() {
		return this.rtA.texture;
	}

}
