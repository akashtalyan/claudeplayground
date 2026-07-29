// Atmosphere — Phase E scene atmosphere bundle: caustic light shafts,
// sediment motes, AO blobs under rooted flora. One create() wires all three
// with a shared update/setIntensity/dispose surface so presets can drive the
// whole layer (or each sub-system via the exposed handles).
//
// Compositing contract (risk-spike-report L1), enforced by renderOrder inside
// each module: caustics (-20, additive light) → ao (-10, the ONE non-additive
// darkening element) → additive points (0: creatures, plankton, sediment).
//
// opts (all optional):
//   seed        base RNG seed (each module derives its own stream)
//   width/height CSS-px viewport (resize(w,h) keeps caustics fitted)
//   camDist     camera distance for sediment dot sizing (else derived)
//   zRange      [zMin, zMax] water volume for sediment depth
//   getRooted   () => rooted creatures (Creature objects or {x,y,z,r,...})
//   intensity   initial 0..1 for every layer
//   caustics/sediment/ao   per-module opt overrides or `false` to skip one

import { create as createCaustics } from './caustics.js';
import { create as createSediment } from './sediment.js';
import { create as createAoBlobs } from './ao.js';

export { createCaustics, createSediment, createAoBlobs };

export function create( scene, globalUniforms, opts = {} ) {

	const base = {
		seed: opts.seed,
		width: opts.width,
		height: opts.height,
		camDist: opts.camDist,
		zRange: opts.zRange,
		getRooted: opts.getRooted,
		intensity: opts.intensity,
	};

	const caustics = opts.caustics === false
		? null
		: createCaustics( scene, globalUniforms, { ...base, ...opts.caustics } );
	const sediment = opts.sediment === false
		? null
		: createSediment( scene, globalUniforms, { ...base, ...opts.sediment } );
	const ao = opts.ao === false
		? null
		: createAoBlobs( scene, globalUniforms, { ...base, ...opts.ao } );

	const parts = [ caustics, sediment, ao ].filter( Boolean );

	return {
		caustics,
		sediment,
		ao,
		update( timeSec, current = 0 ) {
			for ( const p of parts ) p.update( timeSec, current );
		},
		setIntensity( v ) {
			for ( const p of parts ) p.setIntensity( v );
		},
		resize( w, h ) {
			if ( caustics ) caustics.resize( w, h );
		},
		dispose() {
			for ( const p of parts ) p.dispose();
		},
	};
}

export const createAtmosphere = create;
