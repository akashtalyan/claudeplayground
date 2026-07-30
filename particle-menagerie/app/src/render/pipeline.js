// Render pipeline — implements specs/frame-graph.md, the whole chain [1]-[5]:
// scene Points -> HalfFloat scene target -> trails ping-pong accumulate ->
// final full-screen quad owning the ONLY tonemap and the ONLY sRGB encode.
// Hand-rolled passes (3 passes; no EffectComposer needed).
//
// v3.2 render-quality changes, all inside the final pass or the target sizing:
//
//  A. SUPERSAMPLING. The scene/trails/bloom targets are sized
//     drawingBuffer x internalScale with internalScale ABOVE 1 (quality.js
//     tier, 1.5x on balanced), and the final pass box-filters them back down
//     to the canvas (4 bilinear taps on a quarter-dest-pixel grid ~ a tent
//     over one destination pixel). Spec [2] already sizes the scene target as
//     "renderSize x renderScale"; what is new is that the factor may exceed 1
//     and that the canvas drawing buffer no longer moves with it — it stays at
//     css x min(dpr, 1.5), so the downsample is a filtered pass we own instead
//     of whatever the browser compositor would do with an oversized canvas.
//     The spec's renderScale lever keeps its exact meaning (default 1.0, floor
//     0.5) and multiplies the tier factor, which is what makes the Phase F
//     governor work unchanged: its setRenderScale(0.65) walks the whole thing
//     down (balanced 1.5 -> 0.975, i.e. supersampling is the first thing to go).
//
//  B. HIGHLIGHT SHOULDER. ACES still owns the tonemap, but dense additive
//     cores used to arrive far past its clamp and flattened into pure white
//     plateaus. A filmic shoulder now compresses the top of the linear HDR
//     range into a finite ceiling BEFORE ACES: an exact identity below the
//     knee (midtones are untouched, bit for bit) and asymptotic above it, so
//     a 25x range of core brightness keeps a visible gradient instead of
//     clipping. Still exactly one tonemap and one sRGB encode, both here
//     (hard rule 2) — the shoulder is a pre-tonemap curve, not a second one.
//
// Everything else is unchanged: HalfFloat linear intermediates (rule 1), no
// fade quad (rule 3), snapshot renders-then-toBlob (rule 6).

import * as THREE from 'three';
import {
	FullScreenPass,
	Trails,
	makeHalfFloatTarget,
	computeFadeK,
	clamp01k,
} from './trails.js';
import { Bloom } from './bloom.js';
import { createQuality, setRenderPixelScale } from '../quality.js';

// OutputPass-equivalent. ACESFilmicToneMapping / RRTAndODTFit / LinearTosRGB
// bodies match three r185 (ShaderChunk tonemapping_pars_fragment +
// colorspace_pars_fragment) so the tonemap itself is still exactly OutputPass's.
const OUTPUT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform vec2 uDownTap;
uniform float uKnee;
uniform float uCeil;
varying vec2 vUv;

vec3 linearToSRGB( vec3 c ) {
	return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

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
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return clamp( color, 0.0, 1.0 );
}

// Filmic highlight shoulder, in linear HDR, applied to the BRIGHTEST channel
// with the channel ratios preserved:
//
//   m' = K + (C - K) * ( 1 - exp( -( m - K ) / ( C - K ) ) )
//
//  - identity for m <= K, and C1-continuous at m = K (slope exactly 1), so
//    midtones are not merely "close", they are unchanged;
//  - asymptotes to C, so an unbounded additive pileup lands on a finite
//    near-white instead of clipping to flat paper white, and a 20x range of
//    core brightness still resolves as a gradient;
//  - scaling all three channels by m'/m keeps hue and saturation: a hot cyan
//    core reads as a hot cyan core, not a white hole. ACES downstream still
//    does its own highlight desaturation, just starting from lower values.
//
// K and C live in the ACES INPUT domain (i.e. after the exposure multiply), so
// the curve is exposure-relative and every weather preset gets the same shape.
vec3 highlightShoulder( vec3 c ) {
	float m = max( c.r, max( c.g, c.b ) );
	if ( m <= uKnee ) return c;
	float range = max( uCeil - uKnee, 1e-3 );
	float mapped = uKnee + range * ( 1.0 - exp( - ( m - uKnee ) / range ) );
	return c * ( mapped / m );
}

void main() {
	// Downsample of the supersampled trails target: 4 bilinear taps on a
	// quarter-destination-pixel grid, equally weighted (a tent over roughly one
	// destination pixel). uDownTap is zero whenever the target is at or below
	// display resolution, where a single bilinear fetch is already correct.
	vec3 color;
	if ( uDownTap.x > 0.0 ) {
		color = texture2D( tInput, vUv + vec2( uDownTap.x, uDownTap.y ) ).rgb;
		color += texture2D( tInput, vUv + vec2( - uDownTap.x, uDownTap.y ) ).rgb;
		color += texture2D( tInput, vUv + vec2( uDownTap.x, - uDownTap.y ) ).rgb;
		color += texture2D( tInput, vUv + vec2( - uDownTap.x, - uDownTap.y ) ).rgb;
		color *= 0.25;
	} else {
		color = texture2D( tInput, vUv ).rgb;
	}
	// Bloom (frame-graph [4]) is added in LINEAR light, upstream of the single
	// tonemap below — never encoded separately.
	color += texture2D( tBloom, vUv ).rgb * uBloomStrength;
	color *= uExposure / 0.6;
	color = highlightShoulder( color );
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

// Defaults for the shoulder (ACES-input domain — see highlightShoulder):
//   knee 1.25 -> ACES ~0.68 -> sRGB ~214/255: everything up to a bright but
//   still-shaded body is bit-identical to v3.1.
//   ceiling 6.0 -> ACES ~0.945 -> sRGB ~249/255: the brightest possible pixel
//   is 6/255 short of paper white, which is invisible on its own and is what
//   buys the gradient across dense cores.
const SHOULDER_KNEE = 1.25;
const SHOULDER_CEIL = 6.0;

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

	const dbgExt = gl.getExtension( 'WEBGL_debug_renderer_info' );
	const rendererString = dbgExt
		? gl.getParameter( dbgExt.UNMASKED_RENDERER_WEBGL )
		: gl.getParameter( gl.RENDERER );

	// The spec's renderScale lever: default 1.0, floor 0.5, driven by the Phase F
	// governor through setRenderScale(). It MULTIPLIES the quality tier's
	// supersample factor, so 1.0 means "whatever the tier asked for" and 0.65
	// means "35% off that" — the governor keeps working with no changes.
	let renderScale = Math.max( 0.5, opts.renderScale ?? 1.0 );
	const quality = createQuality( {
		rendererString,
		onChange: () => applySize(),
	} );
	let trailsK = clamp01k( opts.trailsK ?? 0.5 );
	let cssW = 1;
	let cssH = 1;
	// Live sizing telemetry (also the UI/screenshot surface via __menagerie).
	const sizing = {
		internalScale: 1, // tier supersample x renderScale lever, floored at 0.5
		superScale: 1, // tier supersample after software/pixel-budget guards
		renderScale, // the spec lever alone
		displayW: 1,
		displayH: 1,
		targetW: 1,
		targetH: 1,
		downsampling: false,
	};

	const sceneRT = makeHalfFloatTarget( 1, 1 );
	const trails = new Trails( 1, 1 );

	// Bloom (frame-graph [4]): half-res bright+blur between trails and the
	// final pass. strength 0 skips its passes entirely; tBloom then reads this
	// 1x1 black so the composite is a mathematical no-op.
	const bloom = new Bloom();
	const bloomParams = {
		strength: opts.bloom?.strength ?? 0.35,
		// threshold 0.55 -> 0.65 (Phase F): keep bloom off the mid-bright body
		// of small merged creatures — their skirt came from bloom as much as
		// from the halo. Large-creature hot cores sit well above either value.
		threshold: opts.bloom?.threshold ?? 0.65,
		radius: opts.bloom?.radius ?? 0.4,
	};
	const blackTexture = new THREE.DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );
	blackTexture.needsUpdate = true;

	const outputMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tInput: { value: null },
			tBloom: { value: blackTexture },
			uBloomStrength: { value: 0 },
			uExposure: { value: opts.exposure ?? 1.0 },
			uDownTap: { value: new THREE.Vector2( 0, 0 ) },
			uKnee: { value: opts.shoulder?.knee ?? SHOULDER_KNEE },
			uCeil: { value: opts.shoulder?.ceiling ?? SHOULDER_CEIL },
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
		// The CANVAS stays at display resolution: css x min(dpr, 1.5). Its
		// backing buffer is the destination of the downsample, not its source.
		renderer.setPixelRatio( dpr );
		renderer.setSize( cssW, cssH );
		renderer.getDrawingBufferSize( drawingBufferSize );
		const dispW = Math.max( 1, drawingBufferSize.x );
		const dispH = Math.max( 1, drawingBufferSize.y );

		// Internal (accumulation) resolution: display x tier supersample x the
		// spec's renderScale lever, with the spec's 0.5 floor on the product.
		const superScale = quality.resolve( dispW * dispH );
		const internalScale = Math.max( 0.5, superScale * renderScale );
		const targetW = Math.max( 1, Math.round( dispW * internalScale ) );
		const targetH = Math.max( 1, Math.round( dispH * internalScale ) );

		sceneRT.setSize( targetW, targetH );
		trails.setSize( targetW, targetH );
		bloom.setSize( targetW, targetH ); // half-res inside, i.e. half of THIS

		// Sprite sizes are in raster px of the target being drawn into, so the
		// dot shader's uDpr has to carry the extra factor (see quality.js).
		setRenderPixelScale( internalScale );

		// Downsample taps: quarter of a DESTINATION pixel, expressed in source
		// UV. Zero when the target is not larger than the canvas (a single
		// bilinear fetch is then exactly right, including the governor's
		// sub-1.0 scales where this pass upsamples instead).
		const tap = internalScale > 1.0 ? 0.25 * internalScale : 0;
		outputMaterial.uniforms.uDownTap.value.set( tap / targetW, tap / targetH );

		sizing.internalScale = internalScale;
		sizing.superScale = superScale;
		sizing.renderScale = renderScale;
		sizing.displayW = dispW;
		sizing.displayH = dispH;
		sizing.targetW = targetW;
		sizing.targetH = targetH;
		sizing.downsampling = tap > 0;

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
	bloom.prewarm( renderer );

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
		const u = outputMaterial.uniforms;
		if ( bloomParams.strength > 0 ) {
			bloom.render( renderer, trails.output, bloomParams );
			u.tBloom.value = bloom.output;
			u.uBloomStrength.value = bloomParams.strength;
		} else {
			// pass entirely skipped: zero bloom cost
			u.tBloom.value = blackTexture;
			u.uBloomStrength.value = 0;
		}
		composite();
		renderer.setRenderTarget( null );
	}

	function setTrails( k ) {
		trailsK = clamp01k( k );
	}

	function setBloom( { strength, threshold, radius } = {} ) {
		if ( strength !== undefined ) bloomParams.strength = Math.max( 0, strength );
		if ( threshold !== undefined ) bloomParams.threshold = Math.max( 0, threshold );
		if ( radius !== undefined ) bloomParams.radius = Math.min( Math.max( radius, 0 ), 1 );
	}

	function getBloom() {
		return { ...bloomParams };
	}

	// The Phase F governor's lever 1 (and, folded in by main.js, its DPR-cap
	// lever 2). 1.0 = the quality tier as chosen; below 1.0 walks the internal
	// resolution down from there, spec floor 0.5 on the product.
	function setRenderScale( s ) {
		renderScale = Math.max( 0.5, s );
		applySize();
	}

	function setQualityTier( name ) {
		return quality.setTier( name ); // onChange -> applySize()
	}

	function qualityInfo() {
		return {
			tier: quality.tier,
			tiers: quality.names,
			software: quality.software,
			explicit: quality.explicit,
			...sizing,
		};
	}

	// Tonemap shoulder, exposed for tuning/UI. knee/ceiling are in the ACES
	// input domain; ceiling <= knee would flatten the top, so keep them apart.
	function setShoulder( { knee, ceiling } = {} ) {
		const u = outputMaterial.uniforms;
		if ( knee !== undefined ) u.uKnee.value = Math.max( 0, knee );
		if ( ceiling !== undefined ) u.uCeil.value = Math.max( u.uKnee.value + 0.05, ceiling );
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

	// Screenshot/dev/UI surface. main.js spreads any pre-existing __menagerie
	// keys into its own test surface, so registering here is safe and keeps the
	// quality tier reachable without the pipeline handle.
	if ( typeof window !== 'undefined' ) {
		window.__menagerie = window.__menagerie || {};
		window.__menagerie.quality = {
			tiers: quality.names,
			get: () => quality.tier,
			set: ( name ) => setQualityTier( name ),
			info: qualityInfo,
		};
	}

	return {
		render,
		setTrails,
		setBloom,
		getBloom,
		resize,
		setRenderScale,
		setQualityTier,
		qualityInfo,
		setShoulder,
		snapshot,
		// targetType is the THREE type constant of every intermediate target
		// (=== THREE.HalfFloatType); rendererString unmasks SwiftShader in tests.
		info: { targetType: sceneRT.texture.type, rendererString },
	};
}
