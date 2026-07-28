# Frame Graph Spec — v3 rendering contract

**Status: normative.** Build agents implement exactly this; deviations are build failures. Rationale lives in `risk-spike-report.md` (H1, M1, M2) — this doc is the *what*, not the *why*.

## The chain (one frame)

```
[1] creature Points (additive, toneMapped=false, depthWrite/Test off)
        │  rendered into ↓
[2] SCENE target: THREE.WebGLRenderTarget, HalfFloatType, LinearSRGBColorSpace,
    no depth needed for points; sized = renderSize × renderScale
        │
[3] TRAILS accumulate pass (ping-pong pair A/B, both HalfFloatType linear):
        next = clamp( prev × fadeK + scene × (1 − fadeK) , 0.0, 64.0 )
    – fadeK is frame-rate independent: fadeK = pow(1 − k, dt × 60), k ∈ [0, 0.995], NEVER 1.0
    – energy is normalized by construction above (lerp form): steady-state brightness
      is slider-invariant; a stationary emitter converges to its own brightness, not input/(1−fade)
    – subtractive epsilon in the same pass: next = max(next − 1.5/255, 0) when next < 8/255,
      so trails provably reach black even in fp16
        │
[4] (Phase E only) UnrealBloomPass reading the trails output
        │
[5] OutputPass — owns the ONLY tonemap (ACESFilmic) and the ONLY sRGB encode.
    renderer.toneMapping is set for OutputPass's benefit; it does NOT affect the
    custom ShaderMaterial (toneMapped=false) — never rely on it upstream.
```

## Hard rules

1. **All accumulation targets are `HalfFloatType` linear.** `UnsignedByteType` anywhere in the chain is a build failure. (Half-float blending is core WebGL2; do not require `EXT_float_blend`.)
2. **Exactly one tonemap and one sRGB encode, both in the final pass.** Any hand-rolled encode elsewhere (double-encode washout) is a build failure.
3. **No fade quad to screen.** Trails exist only as the ping-pong accumulation above.
4. **Camera×trails coupling:** fadeK is additionally multiplied toward 0 by per-frame camera delta: `fadeK *= 1 − clamp(camDeltaPx / 40, 0, 1)` — camera motion flushes screen-space history instead of streaking it.
5. **renderScale and DPR cap ship in Phase B**, not Phase F: `backingSize = cssSize × min(devicePixelRatio, 1.5) × renderScale`, renderScale default 1.0, floor 0.5.
6. **`preserveDrawingBuffer: false`.** Snapshots render-then-`toBlob` inside the same rAF.
7. **One shader program** for all creatures; per-creature variation via uniforms only (no per-creature `#define` variants). `renderer.compile()` prewarm at startup.
8. **Point size policy:** `gl_PointSize = clamp(base × dpr × atten(z), 1.0, min(appCapPx × dpr, ALIASED_POINT_SIZE_RANGE[1]))`; query the range at startup; fade alpha → 0 below 1.5 device px (never let the 1px clamp brighten distant dots); clamp view-space −z ≥ nearGuard (0.1×near) before division.
9. **Fog is exponential** (`exp(−density·viewDepth)`), applied in the dot shader pre-accumulation (it's part of the emitted light, and must be in the trail history).
10. **DOF conserves energy:** defocus size factor k ⇒ alpha × 1/k², k capped at 4.
11. **Fixed-step test clock:** the engine reads time from an injectable clock (`engine.clock`); tests drive sim-time deterministically. `Date.now()`/`performance.now()` are read in exactly one place.

## Uniform / attribute contract (spike scope)

- Attributes: interleaved `position`(dyn) + `normal`(dyn, eased with same coefficient as position, renormalized in-shader; directional term × formationProgress) ; `aSize`, `aTw`, `aRing` static.
- Uniforms per creature: `uColor`, `uAlpha`, `uTime`, `uFormation`; global: `uLightDir`, `uLightColor`, `uRim`, `uFogDensity`, `uFocusZ`, `uAperture`, `uDprSize`.
