// Render pipeline — implements specs/frame-graph.md, the whole chain [1]-[5]:
// scene Points -> HalfFloat scene target -> trails ping-pong accumulate ->
// final full-screen quad owning the ONLY tonemap (ACESFilmic) and the ONLY
// sRGB encode. Hand-rolled passes (3 passes; no EffectComposer needed).

import * as THREE from 'three';
import {
	FullScreenPass,
	Trails,
	makeHalfFloatTarget,
	computeFadeK,
	clamp01k,
} from './trails.js';

// OutputPass-equivalent. ACESFilmicToneMapping / RRTAndODTFit / LinearTosRGB
// bodies match three r185 (ShaderChunk tonemapping_pars_fragment +
// colorspace_pars_fragment) so the result is identical to OutputPass.
const OUTPUT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform float uExposure;
varying vec2 vUv;

vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}

vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),
		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3( 1.60475, - 0.10208, - 0.00327 ),
		vec3( - 0.53108, 1.10813, - 0.07276 ),
		vec3( - 0.07367, - 0.00605, 1.07602 )
	);
	color *= uExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return clamp( color, 0.0, 1.0 );
}

vec3 linearToSRGB( vec3 c ) {
	return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

void main() {
	vec3 color = texture2D( tInput, vUv ).rgb;
	color = ACESFilmicToneMapping( color );
	gl_FragColor = vec4( linearToSRGB( color ), 1.0 );
}
`;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export function createPipeline( renderer, scene, camera, opts = {} ) {

	// The final quad above owns the single tonemap + single sRGB encode (hard
	// rule 2). Keep the renderer itself out of the conversion business so no
	// built-in path can double-encode upstream.
	renderer.toneMapping = THREE.NoToneMapping;
	renderer.toneMappingExposure = 1.0;
	renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
	renderer.autoClear = true;

	const gl = renderer.getContext();
	if ( gl.getContextAttributes().preserveDrawingBuffer ) {
		// Hard rule 6 — snapshots must use render-then-toBlob, not preservation.
		console.warn( 'pipeline: renderer was created with preserveDrawingBuffer: true; frame-graph rule 6 requires false.' );
	}

	let renderScale = Math.max( 0.5, opts.renderScale ?? 1.0 );
	let trailsK = clamp01k( opts.trailsK ?? 0.5 );
	let cssW = 1;
	let cssH = 1;

	const sceneRT = makeHalfFloatTarget( 1, 1 );
	const trails = new Trails( 1, 1 );

	const outputMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tInput: { value: null },
			uExposure: { value: opts.exposure ?? 1.0 },
		},
		vertexShader: FS_VERT,
		fragmentShader: OUTPUT_FRAG,
		depthTest: false,
		depthWrite: false,
		toneMapped: false,
	} );
	const outputPass = new FullScreenPass( outputMaterial );

	const clearColor = new THREE.Color( 0x000000 );
	const drawingBufferSize = new THREE.Vector2();

	function applySize() {
		const dpr = Math.min( ( typeof window !== 'undefined' && window.devicePixelRatio ) || 1, 1.5 );
		// backing = css x min(dpr, 1.5) x renderScale (hard rule 5)
		renderer.setPixelRatio( dpr * renderScale );
		renderer.setSize( cssW, cssH );
		renderer.getDrawingBufferSize( drawingBufferSize );
		sceneRT.setSize( drawingBufferSize.x, drawingBufferSize.y );
		trails.setSize( drawingBufferSize.x, drawingBufferSize.y );
		if ( camera.isPerspectiveCamera ) {
			camera.aspect = cssW / Math.max( 1, cssH );
			camera.updateProjectionMatrix();
		}
	}

	function resize( newCssW, newCssH ) {
		cssW = Math.max( 1, newCssW );
		cssH = Math.max( 1, newCssH );
		applySize();
	}

	const initialSize = renderer.getSize( new THREE.Vector2() );
	resize( initialSize.x || 1, initialSize.y || 1 );

	// Program prewarm (frame-graph rule 7).
	renderer.compile( scene, camera );
	renderer.compile( trails.pass.scene, trails.pass.camera );
	renderer.compile( outputPass.scene, outputPass.camera );

	function composite() {
		outputMaterial.uniforms.tInput.value = trails.output;
		outputPass.render( renderer, null );
	}

	function render( dtSec, camDeltaPx = 0 ) {
		const fadeK = computeFadeK( trailsK, dtSec, camDeltaPx );
		renderer.setClearColor( clearColor, 1 );
		renderer.setRenderTarget( sceneRT );
		renderer.clear();
		renderer.render( scene, camera );
		trails.accumulate( renderer, sceneRT.texture, fadeK );
		composite();
		renderer.setRenderTarget( null );
	}

	function setTrails( k ) {
		trailsK = clamp01k( k );
	}

	function setRenderScale( s ) {
		renderScale = Math.max( 0.5, s );
		applySize();
	}

	// Hard rule 6: re-draw the final frame into the (non-preserved) drawing
	// buffer, then toBlob in the same tick.
	function snapshot() {
		composite();
		renderer.setRenderTarget( null );
		return new Promise( ( resolve, reject ) => {
			renderer.domElement.toBlob(
				( blob ) => ( blob ? resolve( blob ) : reject( new Error( 'pipeline.snapshot: toBlob returned null' ) ) ),
				'image/png'
			);
		} );
	}

	const dbgExt = gl.getExtension( 'WEBGL_debug_renderer_info' );
	const rendererString = dbgExt
		? gl.getParameter( dbgExt.UNMASKED_RENDERER_WEBGL )
		: gl.getParameter( gl.RENDERER );

	return {
		render,
		setTrails,
		resize,
		setRenderScale,
		snapshot,
		// targetType is the THREE type constant of every intermediate target
		// (=== THREE.HalfFloatType); rendererString unmasks SwiftShader in tests.
		info: { targetType: sceneRT.texture.type, rendererString },
	};
}
