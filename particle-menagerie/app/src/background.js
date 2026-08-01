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
  DEFAULT_DEPTH_M,
  EXTINCTION,
  SURFACE_LIGHT,
  SURFACE_GLOW,
  FLOOR_COLOUR,
  SCATTER_COLOUR,
  SCATTER_K,
  BIO_COLOUR,
  scatterGlow,
  bioGlow,
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
uniform float uFloorTop;  // uv.y the seabed haze reaches up to (<0 = not yet)
uniform vec3 uGlow;       // surface lobe colour x depth-faded strength
uniform float uShimmer;   // surface wave shimmer, 0..1
uniform vec3 uFloor;      // abyssal sediment colour x presence
uniform vec3 uScatter;    // scattered-daylight colour x weight, AT uDepthPos
uniform float uScatterK;  // its falloff per metre (the within-frame gradient)
uniform vec3 uBio;        // bioluminescent field colour x weight
uniform float uBioPhase;  // slow drift so the deep is alive while you hover
uniform float uIntensity;
uniform float uTime;

void main() {

	// Depth of THIS row of the frame, metres below the surface. Rows ABOVE the
	// surface plane get dm = 0 and are measured separately by am.
	float sm = uDepthPos + ( 0.5 - vUv.y ) * uSpanM;
	float dm = max( sm, 0.0 );
	float am = max( -sm, 0.0 ); // metres this row sits ABOVE the waterline

	// Beer–Lambert: red dies first, green next, blue carries the column.
	// One exponential does both the dimming and the hue walk.
	//
	// Past the waterline the depth clamp alone would hold the colour at exactly
	// uAmbient for every row above it — a flat slab with a razor-cut lower edge,
	// which is what a surfaced frame used to show instead of a water surface.
	// The water body is what ENDS at the plane, so it is faded out across it
	// rather than clamped: a few metres of soft break-up, after which only the
	// glow lobe and its shimmer are left up there. Below the plane am is 0 and
	// this is exactly exp(0) = 1, so nothing else in the column is touched.
	vec3 col = uAmbient * exp( -uK * dm ) * exp( -am * 0.12 );

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

	// --- the last of the daylight ------------------------------------------
	// The direct beam above is gone by ~300 m. Multiply-scattered skylight is
	// not: it has a far longer effective path and outlives the beam by
	// hundreds of metres. Same exponential form, its own (much smaller) rate,
	// evaluated relative to the camera's row — so it is brighter ABOVE you and
	// dimmer below, which is the last "up is that way" the water has to give.
	// depthprofile.js gates the whole term to zero above 180 m, so the sunlit
	// zone and every fixed-depth spike scene are untouched.
	col += uScatter * exp( -( dm - uDepthPos ) * uScatterK );

	// --- the living dark ---------------------------------------------------
	// Below the twilight the only light left is made by what lives here. Cold
	// cloud-scale veils, ANCHORED IN METRES rather than in the frame: they
	// scroll past as the vessel travels, which is most of what makes a descent
	// read as travel rather than as a fade. uBio grows with depth (the profile's
	// bio weight), so this is the exact complement of the scattered daylight
	// above — patchy, non-directional, strongest over the plain.
	float bp = dm * 0.0209; // ~300 m per cycle: cloud scale, not texture scale
	float bx = vUv.x * 6.2832;
	float veil = sin( bp + sin( bx * 0.61 + uBioPhase * 0.13 ) * 1.7 )
		+ 0.7 * sin( bp * 1.63 - bx * 0.37 - uBioPhase * 0.09 )
		+ 0.45 * sin( bp * 3.4 + bx * 1.13 + uBioPhase * 0.05 );
	veil = clamp( veil * 0.36 + 0.5, 0.0, 1.0 );
	col += uBio * ( 0.18 + 0.82 * veil * veil );

	// --- the floor, below you --------------------------------------------
	// Suspended silt hanging over the abyssal plain: a soft-edged wash rising
	// from the bottom of the frame, thickest right at the edge. It is keyed to
	// PROXIMITY rather than to the seabed's z=0 position, because a horizontal
	// plane below the camera projects between the horizon and the near edge —
	// so as you settle onto the plain the haze climbs toward the horizon,
	// which is where column.js's dotted seabed sheet draws its ridge line.
	// INTEGRATION TUNING: this was a 0.2-wide smoothstep, i.e. a hard-edged
	// plateau — the bottom ~36% of the frame came out as one flat warm slab that
	// read as a lit desert rather than as silt suspended over an abyssal plain.
	// It is now a long ramp from the haze top down to the bottom edge, reaching
	// full strength only in the last few percent of the frame, so the floor
	// arrives as a glow you descend INTO. The dotted seabed sheet (column.js)
	// carries the actual surface; this is only the air over it.
	float fm = smoothstep( uFloorTop, uFloorTop - 0.44, vUv.y );
	fm *= fm;
	col += uFloor * ( fm + 0.14 * fm * smoothstep( 0.26, 0.0, vUv.y ) );

	// NOTE: v3.3 multiplied the whole plate by a slow ±5% "breathing" so the
	// water never read as a still image. It is gone in v3.4 and must not come
	// back: the column's water body is now bright enough in the low-trails
	// weathers to sit near the harness's lit-pixel threshold, and a global
	// temporal gain there flips thousands of pixels between any two frames —
	// it broke the "ink is atmosphere-free" measurement by ±1/255 across the
	// frame. The water gets its life from the surface shimmer, the shafts and
	// the marine snow, all of which move on their own; the BODY of the water
	// is deliberately static.
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
      uDepthPos: { value: DEFAULT_DEPTH_M },
      uSpanM: { value: 1 },
      uSurfaceUv: { value: 2 },
      uFloorTop: { value: -1 },
      uGlow: { value: new THREE.Vector3() },
      uShimmer: { value: 0 },
      uFloor: { value: new THREE.Vector3() },
      uScatter: { value: new THREE.Vector3() },
      uScatterK: { value: SCATTER_K },
      uBio: { value: new THREE.Vector3() },
      uBioPhase: { value: 0 },
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
    u.uDepthPos.value = sample.depthM;
    // uv.y of the surface plane where it crosses z = 0, in units of the
    // current frame height: `depth` metres above the camera. It slides up out
    // of frame as the vessel descends and the glow leaves with it.
    u.uSurfaceUv.value = 0.5 + sample.depthM / spanM;
    // The seabed haze is placed by proximity, not by the plane's z=0 position
    // (see the shader): off-frame while the plain is far, climbing to just
    // under the horizon once the vessel is hovering over it.
    u.uFloorTop.value = -0.05 + 0.51 * sample.floor;
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
    // The last of the daylight is still daylight — it takes the weather's hue
    // and gain like the surface lobe does. Bioluminescence does not: the
    // animals make it, not the sky, so the weather cannot tint or dim it.
    const s = scatterGlow(sample.depthM);
    u.uScatter.value.set(
      SCATTER_COLOUR[0] * s * wr,
      SCATTER_COLOUR[1] * s * wg,
      SCATTER_COLOUR[2] * s * wb,
    );
    const bw = bioGlow(sample);
    u.uBio.value.set(BIO_COLOUR[0] * bw, BIO_COLOUR[1] * bw, BIO_COLOUR[2] * bw);
  }
  apply();

  return {
    update(timeSec) {
      u.uTime.value = timeSec;
      // The bio veils drift on the same injectable clock. It is a PHASE inside
      // the field, never a gain over the plate: the frame mean does not move,
      // so this cannot do what the global "breathing" did (see the note in the
      // shader). Above 180 m uBio is the zero vector and this is dead code.
      u.uBioPhase.value = timeSec;
    },
    // The camera's depth in metres below the surface (column.js's positive
    // convention — pass column.depth() straight through). Cheap enough to call
    // every frame: a keyframe lerp and a handful of uniform writes.
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
      // accepts [r,g,b] (the preset's own shape), a THREE.Vector3 or a
      // THREE.Color, so the integrator can hand over whichever it has
      const r = lightColor[0] ?? lightColor.x ?? lightColor.r ?? 1;
      const g = lightColor[1] ?? lightColor.y ?? lightColor.g ?? 1;
      const b = lightColor[2] ?? lightColor.z ?? lightColor.b ?? 1;
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
