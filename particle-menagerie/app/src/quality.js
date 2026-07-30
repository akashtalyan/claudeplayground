// Render quality tiers — v3.2 (render-quality module).
//
// Owns two things and nothing else:
//
//   1. THE SUPERSAMPLE POLICY. v3.1 rendered the scene/trails targets at
//      exactly the drawing-buffer size (renderScale 1.0) with antialias:false,
//      so every dot edge and every thin rib was point-sampled — dots crawled
//      and ribs sparkled. v3.2 renders those targets ABOVE display resolution
//      and lets the final pass box-filter them back down (see render/pipeline.js
//      OUTPUT_FRAG). That is pure fill-rate cost — risk register Risk 5 — so it
//      is a user-facing tier, not a constant:
//
//        high      1.75x   (3.06x the fragments; strong GPUs / small windows)
//        balanced  1.5x    (2.25x the fragments) <- DEFAULT on first load
//        low       1.0x    (v3.1 target sizing exactly: one texel per device
//                           pixel, single-tap final read, no downsample)
//
//      Resolution order: ?quality=<tier> (explicit; also defeats the software
//      guard below) > localStorage > 'balanced'.
//
//      Two guards keep the default honest:
//        - SOFTWARE GUARD: on SwiftShader/llvmpipe (CI, no-GPU boxes) an
//          implicit tier is pinned to 1.0. 2.25x fill on a software rasterizer
//          buys aliasing nobody will look at and costs wall-clock everywhere.
//          An explicit ?quality= wins, so screenshot runs can still force it.
//        - PIXEL BUDGET: the supersampled target is capped by tier
//          maxTargetPx, so a big retina window doesn't quietly allocate a
//          quarter-gigabyte fp16 ping-pong (scene + 2 trails + bloom, 8 bytes
//          a pixel) or ask an iGPU for bandwidth it does not have. The factor
//          is walked back toward 1.0, never below it — going below 1.0 is the
//          governor's job (frame time), not the tier's (headroom).
//
//   2. THE SHARED RENDER PIXEL SCALE. The dot shader sizes sprites in
//      RASTER pixels of whatever target it is drawing into (frame-graph rule
//      8), so once the scene target is bigger than the canvas, uDpr must carry
//      the extra factor or every dot would come out 1/scale too small after
//      the downsample. The pipeline publishes the factor here on every resize;
//      shaders/dots.js folds it into uDpr's getter. It lives in this module
//      (not in either of those two) so neither has to import the other, and
//      app code keeps setting uDpr from renderer.getPixelRatio() exactly as it
//      always did.
//
// No allocation and no work in per-frame paths: everything here runs on boot,
// on resize, and on an explicit tier/governor change.

export const TIERS = {
	high: { superScale: 1.75, maxTargetPx: 8e6 },
	balanced: { superScale: 1.5, maxTargetPx: 6e6 },
	low: { superScale: 1.0, maxTargetPx: 6e6 },
};

export const TIER_NAMES = [ 'high', 'balanced', 'low' ];
export const DEFAULT_TIER = 'balanced';
const STORE_KEY = 'pm.quality.tier';
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

// ---- shared render pixel scale (see header note 2) -------------------------
// One renderer per page; the pipeline is its only writer.
let pixelScale = 1;

export function renderPixelScale() {
	return pixelScale;
}

export function setRenderPixelScale( s ) {
	pixelScale = s > 0 ? s : 1;
}

// ---- tier resolution ------------------------------------------------------

function normalizeTier( name ) {
	if ( typeof name !== 'string' ) return null;
	const n = name.trim().toLowerCase();
	if ( n === 'off' || n === 'none' ) return 'low'; // ?quality=off = no supersampling
	return Object.prototype.hasOwnProperty.call( TIERS, n ) ? n : null;
}

function paramTier() {
	if ( typeof window === 'undefined' || ! window.location ) return null;
	try {
		return normalizeTier( new URLSearchParams( window.location.search ).get( 'quality' ) );
	} catch {
		return null;
	}
}

function storedTier() {
	try {
		return normalizeTier( window.localStorage.getItem( STORE_KEY ) );
	} catch {
		return null; // private mode / storage disabled — default is fine
	}
}

function storeTier( name ) {
	try {
		window.localStorage.setItem( STORE_KEY, name );
	} catch {
		/* non-fatal: the tier just won't persist */
	}
}

// opts.rendererString: the unmasked GL renderer (software guard input).
// opts.onChange: called after a tier switch so the owner can re-apply sizes.
export function createQuality( opts = {} ) {

	const explicitName = paramTier();
	let tier = explicitName || storedTier() || DEFAULT_TIER;
	let explicit = !! explicitName;
	const software = SOFTWARE_RE.test( String( opts.rendererString || '' ) );

	// Requested supersample for the current tier, after the software guard.
	function requested() {
		const t = TIERS[ tier ] || TIERS[ DEFAULT_TIER ];
		if ( software && ! explicit ) return 1.0;
		return t.superScale;
	}

	// Supersample after the pixel budget, given the DISPLAY buffer size in
	// device px. Walks toward 1.0 only — never below (governor's lever, not
	// the tier's).
	function resolve( displayPx ) {
		const want = requested();
		if ( want <= 1 || ! ( displayPx > 0 ) ) return Math.max( 1, want );
		const budget = ( TIERS[ tier ] || TIERS[ DEFAULT_TIER ] ).maxTargetPx;
		const maxScale = Math.sqrt( budget / displayPx );
		return Math.max( 1, Math.min( want, maxScale ) );
	}

	function setTier( name ) {
		const n = normalizeTier( name );
		if ( ! n || n === tier ) return tier;
		tier = n;
		explicit = true; // a deliberate choice outranks the software guard
		storeTier( n );
		if ( typeof opts.onChange === 'function' ) opts.onChange( n );
		return tier;
	}

	return {
		names: TIER_NAMES.slice(),
		get tier() {
			return tier;
		},
		get software() {
			return software;
		},
		get explicit() {
			return explicit;
		},
		requested,
		resolve,
		setTier,
	};
}
