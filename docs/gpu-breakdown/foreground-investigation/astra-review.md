# Independent foreground shortcut review

Read-only production review, 2026-10-15. No browser tests or production edits performed by this reviewer.

## Conclusion

Keep the shortcut rejected as an image-preserving optimization for now. Its geometric premise is sound within the modeled shell and tested camera domain, but that premise is not a proof about the existing sampled reconstruction. A physically correct clear ray and a byte-identical reconstruction are distinct contracts. The available measurements establish a small local composite saving and an output change; they do not establish the cause or acceptability of that change.

## Verified source facts

- `cloudModel.ts:34–55` finds the spherical shell interval; `clouds.ts:58–65` clips it by opaque-scene distance and returns exact `(0,0,0,1)` for an empty segment. The candidate uses the shell's radial-clearance lower bound with an 8 m cushion (`candidate-fragment.glsl:340–345`). Re-running `candidate-contract-test.mjs` passed. These are geometric/synthetic checks, not hardware output checks.
- Programmatic source comparison confirms the archived candidate, after removing its predicate and early-return branch, equals current production fragment source modulo whitespace. This rules out an accidentally stale cloud model in the archive at review time.
- Low-resolution depth is the nearest of a 3x3 full-resolution footprint (`clouds.ts:164–192`). Metadata records that limit, not only representative cloud distance.
- Color targets are half float with linear filtering; metadata attachments explicitly use nearest filtering (`clouds.ts:353–359`). The final composite samples both at nominal texel centers (`cloudPass.ts:75–78`). Finite-precision center sampling therefore permits color/metadata disagreement in principle, although no observed pixel has yet been causally attributed to this mechanism.
- A truly clear current texel cannot directly acquire temporal cloud history: resolve returns before history blending when current representative depth is nonpositive or opacity below .01 (`clouds.ts:215–219`). Thus generic claims that temporal history simply bleeds onto all clear foreground are inconsistent with this guard. Sampling of current color is itself linear, however, and occurs before that guard; history can also affect neighboring valid cloud texels.
- Metadata is copied from the current sample while resolved color can blend history (`clouds.ts:217–218,234–264`). This is a deliberately approximate radiance/metadata pairing, not a rigorous radiance support bound.
- `vcMarch` computes derivatives at `clouds.ts:57`; fallback invokes it inside a per-pixel divergent reconstruction branch (`cloudPass.ts:93–108`). The early return changes participating lanes. This is a plausible source for sparse outside-mask changes; it is not a demonstrated explanation and does not explain widespread changes in rays that should return before density evaluation.
- Normal ShaderMaterial receives sampler precision prefixes from installed Three (`node_modules/three/src/renderers/webgl/WebGLProgram.js:308–326,676`); CloudPass must not be called lowp merely because its uniform declarations omit precision. RawShaderMaterial skips those prefixes (same file, branch near 440), so upstream raw resolve/march deserve separate precision examination.

## Measurement assessment

The image harness renders control, candidate, candidate repeat and eligibility mask synchronously against shared uniforms and textures (`foregroundPerformanceReview.ts:43–57`). Candidate self-repeat zero differences is useful evidence of stable input. Add control self-repeat as a symmetric check if the harness is extended. It does not currently save input texels or intermediate radiance/transmittance at bad pixels, so summary difference counts cannot diagnose the shader.

The refined GPU harness consumes upstream dependencies before timing a repeat draw and reads completion after timing (`foregroundPerformanceReview.ts:61–71`). This is a reasonable *warm repeated composite* microbenchmark, not the actual integrated frame cost: it changes cache residency, tile/pass behavior and CPU/GPU overlap. Adjacent pairs are across separate frames, so frozen simulation does not make inputs literally identical if temporal resolve/frame jitter continue. Alternating ordering reduces drift bias. The separate pacing experiment is the appropriate whole-frame evidence; its small effect should remain qualified.

The final HDR output alpha is inherited scene alpha (`cloudPass.ts:109–110`), so identical output alpha does **not** show that reconstructed cloud transmittance is identical. Half-bit pattern separation is only a useful ULP proxy for same-sign finite values; the reported numerical absolute differences are the clearer metric. Reinhard preview agreement does not establish agreement after the actual bloom/grade/ACES pipeline.

## Best next diagnostic and bounded decision

First capture reconstructed cloud `radiance.rgb` and `transmittance` before scene multiplication, plus whether fallback ran, at the worst changed pixels and representative changed interior pixels. Also capture the original scene sample, four cloud texels and four metadata texels. This immediately separates a real nonidentity reconstruction from arithmetic/compiler changes to an identity reconstruction.

Then choose the corresponding single intervention:

1. If center reads disagree with integer texel values, replace only the final composite's four nominal-center color and metadata reads with `texelFetch` in a diagnostic variant. This is the semantically exact primitive for already computed integer pixel indices. A negative test does not exclude leakage already introduced by resolve's `texture(uCurrent,uv)`.
2. If stored resolved foreground texels are nonclear, inspect raw current versus resolved texels; test exact current-color reads in resolve and explicit highp raw sampler declarations separately. Do not bundle these changes with the shortcut.
3. If reconstruction is exactly `(0,0,0,1)` yet output differs, test an identity-composite control and inspect translated shader/precision; do not explain hundreds of half steps as harmless rounding without the actual values.
4. If sparse differences occur outside eligibility in fallback pixels, move derivative computation to uniform control flow in a separate correctness investigation. This is not an argument to reinstate the shortcut.

Only after establishing the cause should the lead decide whether this is removal of an existing rendering artifact or an unacceptable change. With only about .04 ms demonstrated saving, rejecting this optimization is a reasonable completed outcome; there is no need to accumulate unrelated renderer changes to justify it.

## Follow-up: targeted capture at 03:58 UTC

Inspected `profiles/2026-10-16T03-58-32-786Z.json` after the lead captured internal reconstruction. All eight outside-eligibility changed pixels are the eight largest reported changes; every one is sky (`distanceKm=-1`) and fallback. The maximum change is 1.65625 HDR. The remaining four reported worst pixels are eligible foreground, have zero reconstructed radiance and `1-T=2^-24`, and differ by at most .00390625 (one binary16 step around intensity 4). There are 327,423 eligible nonidentity reconstructions, but this count includes tiny signed arithmetic residuals and is not a count of visible cloud contamination.

This is materially stronger evidence for two separate mechanisms: widespread tiny normalization/rounding differences on foreground, and sparse derivative-sensitive fallback differences on sky. It weakens the hypothesis that large observed differences primarily represent foreground history leakage. The separately compiled diagnostic still does not prove that its intermediate values equal the control program's intermediate values; altering shader output can change optimization, and undefined derivative behavior is especially sensitive to compilation.

### Precise minimal derivative proposal (diagnostic first)

Split the current march implementation into a core taking an explicit cone and a compatibility wrapper. The core is the existing march body with its internal derivative line removed:

```glsl
vec4 vcMarchWithCone(vec3 rd, float steps, float jitter,
                    float maxDistance, float rayCone,
                    out float representativeDistance) {
  // Existing vcMarch body; no dFdx or dFdy here.
}
vec4 vcMarch(vec3 rd, float steps, float jitter, float maxDistance,
             out float representativeDistance) {
  float cone = max(length(dFdx(rd)), length(dFdy(rd)));
  return vcMarchWithCone(rd, steps, jitter, maxDistance, cone,
                        representativeDistance);
}
```

Leave the existing three-argument wrapper and unrelated callers intact. In **both** control and candidate composite variants, start `main` with:

```glsl
vec4 fallbackP = uInvViewProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
vec3 fallbackRay = normalize(fallbackP.xyz / fallbackP.w);
float fallbackCone = max(length(dFdx(fallbackRay)),
                         length(dFdy(fallbackRay)));
```

This must precede the candidate early return, not merely the fallback branch. Replace the fallback invocation with:

```glsl
vec4 exactCloud = vcMarchWithCone(fallbackRay, 24.0, 0.5,
  distanceKm > 0.0 ? distanceKm * 1000.0 : 1.0e30,
  fallbackCone, cloudDistance);
```

Compare uniform-cone control against uniform-cone candidate on identical inputs, and separately compare uniform-cone control against original control. The first tests whether the shortcut remains unsafe after the derivative dependency is repaired; the second measures the correction's independent output change. Only test exact taps separately afterward to avoid conflating causes. Re-measure performance if considering acceptance: paying ray reconstruction and derivatives on every full-resolution fragment changes the shortcut's economics.

The existing mipmapped shape samples already use explicit LOD derived from this cone (`clouds.ts:93,108` and `cloudModel.ts:93`). Haze uses explicit LOD in GLSL 300 (`clouds.ts:33–35`). Weather/detail retain implicit `texture` calls (`cloudModel.ts:89,102`), so this proposal repairs the explicit cone derivative dependency, not every possible implicit-derivative dependency in the shader. Detail is configured without mipmaps (`clouds.ts:328,337`). If the minimal cone experiment fails, inspect remaining sampling behavior rather than claiming all derivative hazards are solved.

## Follow-up: uniform cone did not resolve sparse errors

Inspected `profiles/2026-10-16T04-01-29-449Z.json`: `uniformCone=true`, seven outside-eligibility differences, maximum HDR difference 1.84375; worst records remain sky/fallback. Inspected the actual `repairCone` transformation in `foregroundPerformanceReview.ts`: it renames the implementation, removes its internal derivative expression, adds the compatibility wrapper, inserts ray/cone computation at the start of main before early return, replaces the fallback core call, and applies these edits to both programs. No missing transformation was found in this source inspection. The result rejects the explicit ray-cone dependency as a sufficient explanation, without ruling out other derivative-dependent sampling.

The weather texture is demonstrably mipmapped: `game.ts:166` passes `dataTexture(tex.cloudWeather,256)` and `textures.ts:9–14` configures trilinear mip filtering and generation. Within the active GLSL3 march implementation and callees, the two remaining implicit texture reads are exactly:

```glsl
texture(uCloudCover, q.xz / 42000.0) // cloudModel.ts:89
texture(uCloudDetail, q / 1500.0)   // cloudModel.ts:102
```

The coverage lookup executes inside adaptive view-march loops and near-light density loops, so it is a strong remaining candidate. Detail has no mipmaps. Shape, far-mean weather and haze use explicit LOD. The GLSL1 `textureCube` fallback is inactive for this GLSL3 material. Composite scene/depth/color texture reads remain outside this core; the cloud target has no mip pyramid, and they should not be silently bundled into this test.

Next bounded diagnostic: retain uniform-cone changes and replace only these two calls with `textureLod(...,0.0)` in both programs. Preserve `vcFarMeanDensity`'s deliberately computed `weatherLod`. If this resolves the sparse differences, a weather-only ablation can identify whether detail replacement contributes. This establishes sensitivity to the remaining implicit sampling, not a production choice to force weather LOD0: a final fix should choose an explicit footprint appropriate to the cloud integration and assess aliasing separately.

## Follow-up: explicit weather/detail LOD diagnostic succeeds

Verified `profiles/2026-10-16T04-04-54-000Z.json`: uniform cone plus explicit weather/detail LOD0 gives zero outside-eligibility changed pixels, maximum HDR difference .00390625, maximum half-pattern separation one, and maximum diagnostic preview difference one byte. No preview pixel differs by more than one byte. Candidate repeat remains identical. Foreground differences persist (212,480 changed pixels), so this is not bitwise-equivalent output.

The combined intervention eliminates the sparse large sky differences in this measured fixture. This is causal experimental evidence for sensitivity to the remaining implicit texture sampling, conditional on the cone repair. It does not yet isolate weather versus detail or establish that cone repair is necessary; the requested weather-only ablation addresses the former. It does not certify other views, devices, cloud states, or the actual final display pipeline.

### Production footprint principle, proposal only

Weather should receive an explicit footprint tied to the integration interval and the pixel cone, not derivatives of sample positions inside divergent loops. Reuse the existing pre-clamp world-space footprint inputs from the march:

- Probe: `max(cellLen * .25, (cellStart + cellLen) * rayCone)`.
- Fine sample: `max(fineStep * .5, t * rayCone)`.

At the current 256 texels per 42,000 m weather repeat, one weather texel spans 164.0625 m. An isotropic LOD policy consistent with the current march heuristic is `clamp(log2(max(footprintMetres / 164.0625, 1.0)), 0.0, 8.0)`, supplied explicitly to the weather sample. Prefer the actual texture dimension or a documented uniform if the weather resolution can change. Do not reconstruct this footprint from the already-clamped shape LOD, since that discards large-footprint information and uses a different texel scale.

This is an integration/filtering heuristic aligned with existing shape filtering, not an exact anisotropic Jacobian of horizontal weather coordinates and height-dependent wind shear. Near-light sample half-interval widths are below one weather texel in the current three-interval design, making explicit LOD0 a reasonable bounded starting policy there. Preserve the existing explicit far-light `weatherLod`, which already derives from horizontal segment length.

Treat that production policy as a separate rendering correctness change with its own visual and performance acceptance. Forcing LOD0 is sufficient for the diagnostic but can change distant aliasing and cannot be called the final fix merely because it eliminates this discrepancy. Keep the original shortcut rolled back while selecting and validating any production correction.

## Final bounded finding: weather-only ablation

Verified `profiles/2026-10-16T04-06-07-448Z.json` (`uniformCone=true`, `explicitLod=true`, `weatherLodOnly=true`): zero outside-eligibility differences, maximum HDR difference .00390625, maximum half-pattern separation one, diagnostic display maximum one byte, and zero candidate self-repeat differences. Explicit detail LOD is therefore unnecessary for eliminating the sparse large differences in this fixture once uniform cone and explicit weather LOD0 are present.

The demonstrated sufficient intervention is **uniform prebranch ray cone plus explicit weather LOD0**. Uniform cone alone was insufficient. The experiments did not test explicit weather LOD without cone repair, so neither cone necessity nor weather-only sufficiency is established. The evidence identifies implicit weather sampling as the decisive additional dependency in this controlled comparison; it does not validate a general production LOD policy or guarantee final display equivalence. Foreground normalization differences remain at up to one half-float step in the measured fixture.

Investigation stops here. Production remains unchanged, the foreground shortcut remains rolled back, and any rendering correction or renewed optimization requires separate acceptance.
