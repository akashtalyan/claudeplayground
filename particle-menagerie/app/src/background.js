// The water column's background: the scene's base layer, now depth-aware.
//
// v3.3 drew one fixed gradient — a moon glow pinned to the top of the frame
// and near-black below. v3.4 replaces it with the column itself: a Beer–
// Lambert water colour evaluated per screen row, a surface ceiling that sits
// at the SURFACE PLANE (so it is genuinely above you, recedes as you descend
// and is gone by the twilight zone), and an abyssal floor haze that rises into
// frame only when the seabed is actually below you.
//
// The optics are in depthprofile.js: sea water eats red first, then green,
// blue last, so the column runs silver -> blue-green -> deep blue -> blue-
// black with depth without a single hand-authored colour ramp.
//
// Frame graph: unchanged. Emitted light in LINEAR space, normal blending,
// renderOrder -30 (beneath the AO discs, the caustics and every additive
// point), depthTest/Write off, toneMapped false — no second tonemap, no sRGB
// encode here (hard rule 2). The single final OutputPass still owns both.
//
// Screen-row -> depth mapping uses the z = 0 plane's 1:1 CSS-px scale, the
// same plane every other world quantity in the app is authored against.
//
// Clock: time arrives via update(timeSec). No wall-time reads, no allocation
// on any frame path.
import * as THREE from 'three';
import {
  METRES_PER_PX,
  SEABED_M,
  DEFAULT_DEPTH_M,
  EXTINCTION,
  SURFACE_LIGHT,
  SURFACE_GLOW,
  FLOOR_COLOUR,
  createDepthSample,
  sampleDepth,
} from './depthprofile.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.99999, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform vec3 uAmbient;    // downwelling light at the surface (linear)
uniform vec3 uK;          // per-channel extinction, 1/metre
uniform float uDepthPos;  // camera depth, POSITIVE metres below the surface
uniform float uSpanM;     // metres spanned by one viewport height
uniform float uSurfaceUv; // uv.y of the surface plane (>1 once it is overhead)
uniform float uSeabedUv;  // uv.y of the seabed plane (<0 while it is far below)
uniform vec3 uGlow;       // surface lobe colour x depth-faded strength
uniform float uShimmer;   // surface wave shimmer, 0..1
uniform vec3 uFloor;      // abyssal sediment colour x presence
uniform float uIntensity;
uniform float uTime;

void main() {

	// Depth of THIS row of the frame, metres below the surface.
	float dm = max( uDepthPos + ( 0.5 - vUv.y ) * uSpanM, 0.0 );

	// Beer–Lambert: red dies first, green next, blue carries the column.
	// One exponential does both the dimming and the hue walk.
	vec3 col = uAmbient * exp( -uK * dm );

	// --- the surface, above you ------------------------------------------
	// A broad soft lobe centred ON the surface plane, not on the frame top:
	// as the camera descends uSurfaceUv climbs past 1 and the lobe leaves
	// frame by itself. uGlow is separately faded to zero by the depth
	// profile, so the abyss cannot inherit a stray glow through a wide lobe.
	float sd = vUv.y - uSurfaceUv;
	vec2 q = vec2( ( vUv.x - 0.5 ) * 0.62, sd );
	col += uGlow * exp( -dot( q, q ) * 3.0 );

	// Wave shimmer hugging the surface film — two incommensurate ripples so
	// the ceiling never visibly loops.
	float band = exp( -abs( sd ) * 7.0 );
	float ripple = 0.55 + 0.45
		* sin( vUv.x * 34.0 + uTime * 0.8 + sin( vUv.x * 9.0 - uTime * 0.47 ) * 1.9 )
		* ( 0.6 + 0.4 * sin( vUv.x * 17.0 - uTime * 0.61 ) );
	col += uGlow * uShimmer * band * ripple * 0.5;

	// --- the floor, below you --------------------------------------------
	// Sediment haze filling everything under the seabed plane, plus a short
	// exponential bloom of suspended silt rising off it.
	float fd = uSeabedUv - vUv.y;              // > 0 below the seabed plane
	col += uFloor * ( smoothstep( -0.02, 0.22, fd ) * 0.85
	                + 0.15 * exp( -max( -fd, 0.0 ) * 6.0 ) );

	// Barely-there slow breathing so the water never reads as a still image.
	col *= 1.0 + 0.05 * sin( uTime * 0.11 );

	gl_FragColor = vec4( col * uIntensity, 1.0 );
}
`;

// Preset light colour, normalized to unit luminance, is applied as HUE ONLY —
// the weather says what colour the water is, the depth says how much of it
// survives. Blending at 60% keeps a strongly tinted preset (bioluminescent
// bay) from turning the whole column cyan.
const TINT_MIX = 0.6;
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export function createBackground(scene, opts = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uAmbient: { value: new THREE.Vector3(SURFACE_LIGHT[0], SURFACE_LIGHT[1], SURFACE_LIGHT[2]) },
      uK: { value: new THREE.Vector3(EXTINCTION[0], EXTINCTION[1], EXTINCTION[2]) },
      uDepthPos: { value: -DEFAULT_DEPTH_M },
      uSpanM: { value: 1 },
      uSurfaceUv: { value: 2 },
      uSeabedUv: { value: -2 },
      uGlow: { value: new THREE.Vector3() },
      uShimmer: { value: 0 },
      uFloor: { value: new THREE.Vector3() },
      uIntensity: { value: 1.0 },
      uTime: { value: 0 },
    },
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -30; // beneath everything, including AO discs
  scene.add(mesh);

  const u = material.uniforms;
  const sample = createDepthSample();
  let depthM = opts.depthM ?? DEFAULT_DEPTH_M;
  let heightPx =
    opts.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0) ?? 0;
  if (!(heightPx > 0)) heightPx = 540;
  // weather modulation (optional; identity until the integrator wires it)
  let wr = 1;
  let wg = 1;
  let wb = 1;

  function apply() {
    sampleDepth(depthM, sample);
    const spanM = heightPx * METRES_PER_PX;
    u.uSpanM.value = spanM;
    u.uDepthPos.value = -sample.depthM;
    // uv.y of the two planes, in units of the current frame height
    u.uSurfaceUv.value = 0.5 + -sample.depthM / spanM;
    u.uSeabedUv.value = 0.5 + (SEABED_M - sample.depthM) / spanM;
    u.uAmbient.value.set(
      SURFACE_LIGHT[0] * wr,
      SURFACE_LIGHT[1] * wg,
      SURFACE_LIGHT[2] * wb,
    );
    const g = sample.glow;
    u.uGlow.value.set(
      SURFACE_GLOW[0] * g * wr,
      SURFACE_GLOW[1] * g * wg,
      SURFACE_GLOW[2] * g * wb,
    );
    u.uShimmer.value = sample.shimmer;
    const f = sample.floor;
    u.uFloor.value.set(FLOOR_COLOUR[0] * f, FLOOR_COLOUR[1] * f, FLOOR_COLOUR[2] * f);
  }
  apply();

  return {
    update(timeSec) {
      u.uTime.value = timeSec;
    },
    // The camera's depth in metres (negative below the surface). Cheap enough
    // to call every frame: a keyframe lerp and a handful of uniform writes.
    setDepth(m) {
      if (m === depthM) return;
      depthM = m;
      apply();
    },
    getDepth: () => depthM,
    // Viewport height in CSS px drives the row -> depth mapping. main.js's
    // resize handler must call this or the column's scale goes stale.
    resize(w, h) {
      const hh = Math.max(1, h);
      if (hh === heightPx) return;
      heightPx = hh;
      apply();
    },
    // OPTIONAL weather modulation: the preset's light colour as hue only
    // (luminance-normalized, blended at TINT_MIX) times a compressed gain, so
    // depth still decides how much light there is. Identity if never called.
    setWeather(lightColor, gain = 1) {
      const r = lightColor[0] ?? lightColor.x ?? 1;
      const g = lightColor[1] ?? lightColor.y ?? 1;
      const b = lightColor[2] ?? lightColor.z ?? 1;
      const l = Math.max(LUMA_R * r + LUMA_G * g + LUMA_B * b, 1e-4);
      const k = Math.pow(Math.max(gain, 0.05), 0.6); // compressed exposure
      wr = (1 + (r / l - 1) * TINT_MIX) * k;
      wg = (1 + (g / l - 1) * TINT_MIX) * k;
      wb = (1 + (b / l - 1) * TINT_MIX) * k;
      apply();
    },
    setIntensity(v) {
      u.uIntensity.value = v;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
