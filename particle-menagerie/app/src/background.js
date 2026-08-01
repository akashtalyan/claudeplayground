// Night-ocean background: the scene's base layer. A cold moonlit glow bleeds
// down from the surface and fades into abyssal near-black, per the Bathyscaphe
// mock's scene backdrop (#0a1522 top glow into #04060a). Rendered as emitted
// light in LINEAR space before all additive points (normal blending, the base
// the water is made of), so it accumulates/tonemaps consistently with the rest
// of the frame graph.
import * as THREE from 'three';

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
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform float uIntensity;
uniform float uTime;

void main() {
	// Vertical falloff: surface glow at the top, deep water below.
	float h = vUv.y;
	vec3 col = mix( uDeep, uMid, smoothstep( 0.0, 0.55, h ) );
	// Moon-glow lobe centred above the frame.
	float d = distance( vec2( vUv.x, vUv.y * 0.82 ), vec2( 0.5, 1.06 ) );
	col += uTop * smoothstep( 0.85, 0.0, d );
	// Barely-there slow breathing so the water never reads as a still image.
	col *= 1.0 + 0.05 * sin( uTime * 0.11 );
	gl_FragColor = vec4( col * uIntensity, 1.0 );
}
`;

// Linear-light conversions of the design hexes (sRGB #0a1522 glow, #04060a
// mid-water, ~#020305 depths), pre-tuned for the single final ACES+sRGB pass.
const TOP = new THREE.Color(0.0032, 0.0078, 0.0165);
const MID = new THREE.Color(0.0012, 0.0021, 0.0038);
const DEEP = new THREE.Color(0.0004, 0.0007, 0.0014);

export function createBackground(scene) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTop: { value: TOP.clone() },
      uMid: { value: MID.clone() },
      uDeep: { value: DEEP.clone() },
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
  return {
    update(timeSec) { material.uniforms.uTime.value = timeSec; },
    setIntensity(v) { material.uniforms.uIntensity.value = v; },
    dispose() { scene.remove(mesh); mesh.geometry.dispose(); material.dispose(); },
  };
}
