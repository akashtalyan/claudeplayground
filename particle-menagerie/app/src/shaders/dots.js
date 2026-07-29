// Dot material — the ONE shader program for every creature (frame-graph rule 7).
// Per-creature variation is uniforms only; global uniforms are shared object
// references so mutating one value updates every creature's material at once.
// Output is linear HDR: no tonemap, no sRGB here — the pipeline owns both
// (frame-graph rule 2).

import * as THREE from 'three';

// App-level sprite cap in CSS px; combined at runtime with uDpr and the
// GL-queried ALIASED_POINT_SIZE_RANGE max (frame-graph rule 8).
const APP_CAP_PX = 32.0;

const VERT = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uFormation;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uRim;
uniform float uFogDensity;
uniform float uFocusZ;
uniform float uAperture;
uniform float uDpr;
uniform float uMaxPointPx;

attribute float aSize;
attribute float aTw;
attribute float aRing;

varying vec3 vColor;
varying float vAlphaExtra;
varying float vTw;

const float APP_CAP_PX = ${APP_CAP_PX.toFixed( 1 )};
// Distance (view units) at which a dot renders at exactly aSize CSS px.
const float REF_DIST = 10.0;
// Wrap-around Lambert softness: light bleeds past the terminator so a
// dotted shell reads as a soft organic form, not a hard-lit ball.
const float WRAP = 0.5;
const float TAU = 6.2831853;

void main() {

	vec4 mv = modelViewMatrix * vec4( position, 1.0 );

	// Near-plane guard before the 1/z division (rule 8): clamp -z >= 0.1*near.
	// near is recovered from the standard perspective projection matrix so no
	// extra uniform is needed.
	float near = projectionMatrix[3][2] / ( projectionMatrix[2][2] - 1.0 );
	float viewDist = max( -mv.z, 0.1 * near );

	// DOF (rule 10): defocus factor k, capped at 4; energy conserved below by
	// alpha x 1/k^2. uFocusZ is the focus distance as positive view-space depth.
	float k = min( 1.0 + abs( viewDist - uFocusZ ) * uAperture, 4.0 );

	// Point size policy (rule 8): clamp(base*dpr*atten(z), 1, min(cap*dpr, GLmax)).
	float px = aSize * uDpr * ( REF_DIST / viewDist ) * k;
	gl_PointSize = clamp( px, 1.0, min( APP_CAP_PX * uDpr, uMaxPointPx ) );

	// Sub-1.5-device-px fade uses the UNCLAMPED size so the 1px floor never
	// brightens distant dots (rule 8), times the DOF 1/k^2 (rule 10).
	vAlphaExtra = smoothstep( 0.0, 1.5, px ) / ( k * k );

	// Normals arrive eased (same coefficient as position, geometry spec) and
	// therefore non-unit: renormalize in-shader, with a degenerate-length guard.
	vec3 n = normalMatrix * normal;
	n /= max( length( n ), 1e-5 );

	// uLightDir is a world-space direction; bring it into view space here.
	vec3 L = normalize( ( viewMatrix * vec4( uLightDir, 0.0 ) ).xyz );
	float lambert = clamp( ( dot( n, L ) + WRAP ) / ( 1.0 + WRAP ), 0.0, 1.0 );

	// Rim on silhouette normals; abs() because dots are two-sided emitters.
	vec3 viewDir = normalize( -mv.xyz );
	float rim = pow( 1.0 - abs( dot( n, viewDir ) ), 3.0 ) * uRim;

	// Directional terms scale with uFormation: a still-forming swarm has
	// meaningless normals and shows only the ambient floor.
	// Ambient floor 0.35 -> 0.45 (Phase C tuning): face-on sheet interiors
	// (ray wing, bloom petals) get little rim and were reading faint.
	vec3 lit = uColor * ( 0.45 + uLightColor * ( lambert + rim ) * uFormation );

	// Exponential fog is part of the emitted light, applied pre-accumulation so
	// it lands in the trail history (frame-graph rule 9 / spec section 9).
	vColor = lit * exp( -uFogDensity * viewDist );

	// Twinkle phase: per-dot aTw plus a slow per-ring offset (rib shimmer).
	vTw = aTw * TAU + aRing * 0.7;

	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform float uAlpha;
uniform float uTime;

varying vec3 vColor;
varying float vAlphaExtra;
varying float vTw;

void main() {

	vec2 p = gl_PointCoord * 2.0 - 1.0;
	float d2 = dot( p, p );

	// Hot core + soft halo, both gaussian; the halo is windowed to zero at the
	// inscribed circle so the square sprite corner never shows under additive.
	// Halo raised 0.30/-4.0 -> 0.55/-3.2 (Phase C tuning): more bioluminescent
	// bleed around each dot; overall energy rebalanced via pipeline exposure.
	float core = exp( -d2 * 12.0 );
	float halo = 0.55 * exp( -d2 * 3.2 ) * clamp( 1.0 - d2, 0.0, 1.0 );

	float twinkle = 0.80 + 0.20 * sin( uTime * 2.1 + vTw );

	// Linear HDR out. Blending is SrcAlpha/One (additive), so the whole scalar
	// intensity rides in alpha and multiplies vColor exactly once.
	gl_FragColor = vec4( vColor, ( core + halo ) * twinkle * uAlpha * vAlphaExtra );
}
`;

// Shared global uniform objects. Created once at startup; every creature
// material holds these same references. ALIASED_POINT_SIZE_RANGE is queried
// here, at startup (frame-graph rule 8). uDpr reads the renderer's effective
// pixel ratio (dpr x renderScale, set by the pipeline) — the app should
// refresh uDpr.value on resize/renderScale changes.
export function createGlobalUniforms( renderer ) {

	const gl = renderer.getContext();
	const pointSizeRange = gl.getParameter( gl.ALIASED_POINT_SIZE_RANGE );

	return {
		uLightDir: { value: new THREE.Vector3( 0.35, 0.75, 0.55 ).normalize() },
		uLightColor: { value: new THREE.Color( 1.0, 1.0, 1.0 ) },
		uRim: { value: 1.0 },
		uFogDensity: { value: 0.045 },
		uFocusZ: { value: 12.0 },
		uAperture: { value: 0.05 },
		uDpr: { value: renderer.getPixelRatio() },
		uMaxPointPx: { value: pointSizeRange[ 1 ] },
	};
}

export function createDotMaterial( globalUniforms ) {

	return new THREE.ShaderMaterial( {
		uniforms: {
			// per-creature
			uColor: { value: new THREE.Color( 0.55, 0.85, 1.0 ) },
			uAlpha: { value: 1.0 },
			uTime: { value: 0.0 },
			uFormation: { value: 1.0 },
			// global — same object references across all materials, on purpose
			uLightDir: globalUniforms.uLightDir,
			uLightColor: globalUniforms.uLightColor,
			uRim: globalUniforms.uRim,
			uFogDensity: globalUniforms.uFogDensity,
			uFocusZ: globalUniforms.uFocusZ,
			uAperture: globalUniforms.uAperture,
			uDpr: globalUniforms.uDpr,
			uMaxPointPx: globalUniforms.uMaxPointPx,
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		blending: THREE.AdditiveBlending,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		toneMapped: false,
	} );
}
