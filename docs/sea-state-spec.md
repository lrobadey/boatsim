# Sea state field specification (W1 exposure + W2 depth)

Status: implemented 2026-10-10 (uncommitted), after phase 2. §14 lists where the build differs from
this text and what was measured.
Supersedes the sketch in `docs/merchant-ship-plan.md` §6.1–6.2 (rev. 3) where they differ; every
difference is listed in §12. Phase 2b in that plan.

## 1. Outcome

The sea stops being the same everywhere. Each point of water gets its own wave size from what is
around it:

- **Fetch:** how much open water lies upwind. A lee is calm; a long open reach is rough.
- **Wind shelter:** high land upwind weakens the wind, which both grows smaller waves and fills the sail
  less.
- **Swell shadow:** islands block distant swell, which only partly wraps round behind them.
- **Depth:** waves cannot be taller than the water is deep.
- **The harbour:** the mole shelters the berths on its lee side. Which side that is depends on the wind.

Physics and rendering read **the same numbers at the same points**, so the ship still floats on the
water you see. Nothing in the wave model changes except a per-place amplitude multiplier: wave
phases, directions, dispersion and the clipmap renderer stay as they are.

Player-visible result: the harbour and island lees become calm, gaps and headlands stay rough, sails go
soft and gusty under tall islands, and the open water at the world's upwind edge is unchanged.

### Out of scope

- Wave refraction or bending (waves don't turn to follow the coast; only their size changes).
- Shoaling growth, surf, breaking-wave visuals and slower waves in shallow water (a later visual-only
  shoreline pass).
- Ships making waves (two-way coupling).
- Wave growth over time, weather on a game clock, the 360° direction fan (W3/W4).
- The seabed-type map, FFT h0 crossfade and CPU short-wave bins: separate 2b/2c items with their own specs.

## 2. Model

### 2.1 The envelope

For every wave component *i*, the local amplitude is

    A_i(x, z) = A_i,global × E_i(x, z),   0 ≤ E_i ≤ 1

`A_i,global` is today's amplitude: the open sea at the capped 40 km fetch. `E_i` is the **envelope**.
The validity rule from rev. 3 holds: **E ≤ 1 everywhere**. Shelter only attenuates. Because of that:

- the global steepness budget (Σ Q·k·A ≤ 0.75) still holds locally, so crests never loop
- the inverse `heightAt` iteration still contracts
- envelope gradient terms are dropped (they're under 1% at a ≥ 300 m blur, since |∇E|·A ≲ 0.003)
- E is always sampled at the **undisplaced** grid point, on both the CPU and the GPU

### 2.2 Bands

E isn't stored per component (24 lookups per vertex). It is stored per **band**, four in one RGBA
texel:

| Channel | Band | Components |
|---|---|---|
| R | swell | the 3 swell components (110, 85, 70 m) |
| G | long | wind sea, λ around 48 m |
| B | mid | wind sea, λ around 26 m |
| A | short | wind sea, λ around 14 m |

Each wind-sea component gets **soft band weights** `w_i = (w_long, w_mid, w_short)`, triangular in
log λ with centres 48 / 26 / 14 m and summing to 1. Swell components get (1, 0, 0, 0). Then

    E_i = dot(env0, w_i)

Weights are computed once in the `WaveField` constructor and packed into a new uniform array
`uWaveC[WAVE_COUNT]` (vec4). The CPU uses the same Float32 values.

A fourth band is the FFT. A second RGBA texel `env1` holds:

| Channel | Meaning | Used by |
|---|---|---|
| R | `eA`: FFT cascade A multiplier (1–11 m waves) | vertex displacement, slopes, foam |
| G | `s`: wind-shelter factor (local mean wind / free wind) | cascade B ripples, the sail's wind |
| B | `hb`: blurred depth (m) | diagnostics, audio |
| A | `g`: lee gustiness multiplier minus 1 | the sail's wind |

### 2.3 What is baked and what is computed live

The wind's direction and speed change all the time; the terrain doesn't. So the **worldgen worker
bakes geometry only**, per direction. The **main thread composes** the envelope for the current wind.

**Baked once** (per cell, per direction d of 16, every 22.5°):

- `F[d]`: effective fetch (m), capped at 40 km
- `S[d]`: wind-shelter factor, 0.3–1
- `W[d]`: swell open fraction, 0–1

Plus, per cell: `hb`, the blurred depth (m).

**Composed live** (per cell, from the current wind bearing β, mean speed U, swell bearing and height):
the eight values of `env0` and `env1`.

## 3. The bake (worldgen worker)

New pure module `src/world/seaState.ts`, with no `three` import so it runs in the worker and in Node
tests. It exports `bakeSeaState(input): SeaStateBake`. The worker calls it after the pier and dredge
step, so it sees the final heights, and posts the result as transferable buffers in
`WorldGenResult.seaState`. Progress label: "Mapping sea shelter".

### 3.1 Grids

- **Global map:** 128 × 128 cells over the 12 km world (93.75 m cells). It's always 128², whatever the
  heightmap size, so quality settings don't change the physics grid. (The heightmap itself already
  differs between quality levels, so the terrain isn't bit-identical across them; the map just doesn't
  add a second source of difference.)
- **Harbour detail map:** 128 × 128 cells over a 1024 m square centred on the pier midpoint, axis-aligned
  (8 m cells). The data model is a **list** of detail regions, so future harbours and player-built
  docks fit; there's one today.

From the heightmap the bake derives per cell:

- `landMax`: max terrain height in the cell (conservative obstacle: sea stacks of 25 m survive)
- `depthMean`: mean of max(0, −H) over the cell

The detail map rasterises the **mole footprint** into its land mask: every cell whose centre is within
`width / 2 + 4 m` of the pier axis between root and head. The footprint comes from a pure helper,
`pierFootprint(pier)`, extracted from `harbour.ts`, so the colliders, the visuals and the bake can't
disagree. The mole blocks waves but not wind (it's 1.8 m high), so it goes into the wave land mask only.

### 3.2 Rays

For each cell, cast **64 rays** (5.625° apart) from the cell centre toward where waves or wind come
from. Step with a DDA over the cell grid. Inside a detail region, step over the detail grid, then
continue on the global grid once outside it. For each ray record:

- `dLand`: distance to the first cell with `landMax > 0` (wave land mask). If the ray leaves the world
  first, the remaining distance counts as open sea, up to the 40 km cap.
- `shelter`: along the ray up to 8 km, the strongest wind obstacle:

      sh = max over land samples of  clamp(1 − d / (15·h), 0, 1) · smoothstep(5, 40, h)

  where h is `landMax` and d the distance. The wake runs about 15 hill heights; land under 5 m does
  nothing.

The cell's own sample is skipped. Cells that are land get E = 0 and are never sampled by the physics
in practice.

### 3.3 Per-direction quantities

For each of the 16 output directions d (every 4th ray), combine nearby rays with cosine weights. α is
a ray's angle from d.

- **Effective fetch** (Saville / SPM method), rays within ±45° (±8 rays):

      F[d] = Σ dLand·cos²α / Σ cos α

- **Wind shelter**, rays within ±11° (±2 rays), weights cos α:

      S[d] = 1 − 0.7 · weightedMean(sh)

  The deep-lee floor is 0.3.
- **Swell open fraction**, rays within ±22.5° (±4 rays), weights cos α. A ray counts as open if
  `dLand ≥ 40 km` (it reaches open water beyond the world):

      W[d] = weightedMean(open)

  A small islet far away blocks only a few rays, so its shadow fills in with distance. That is the
  diffraction behaviour we want, without solving it.

### 3.4 Smoothing

- Global map: F (in log space), S and W get a separable Gaussian with σ = 1 cell (about 94 m;
  footprint about 300 m). W also gets a second pass with σ = 3 cells (about 600 m swell diffraction
  spread).
- Detail map: σ = 1 cell (8 m) for F, S and W; σ = 4 cells for W.
- Depth `hb`: σ = 1.6 cells on the global map (≥ 300 m, rev. 3) and σ = 2.5 cells (20 m) on the detail map.

### 3.5 Output

    SeaStateBake {
      dirs: 16
      maps: [ { originX, originZ, cell, n: 128,
                F: Float32Array(n·n·16), S: Float32Array(n·n·16), W: Float32Array(n·n·16),
                hb: Float32Array(n·n), land: Uint8Array(n·n) } ]   // [0] = global, [1..] = detail
    }

That's about 6.4 MB, transferred, not copied. If `seaState` is missing (headless tests, old saves),
the runtime field is absent and every code path behaves exactly as today (§6.1).

Bake time target: ≤ 800 ms in the worker at high quality, logged with the other worldgen stages. If
it's over, drop the detail rays to 32 first.

## 4. Live composition (main thread)

New class `SeaStateField` in `src/world/seaState.ts`. It owns the Float32 envelope arrays and has no
`three` dependency. A small wrapper in `ocean.ts` turns them into `DataTexture`s.

### 4.1 Band energy tables

At every wave retarget (currently every 1 s of game time), rebuild two lookup tables for the current
wind U:

- `bandLUT[s][logF]`: the envelope of each band (long, mid, short) and of FFT cascade A, for
  - local wind `U·s` with s in [0.3, 1], 15 steps
  - fetch F in [50 m, 40 km], log-spaced, 32 steps

  Each entry is

      e_b = sqrt( Σ_i w_ib · share_i · S_J(ω_i; U·s, F) · dω_i  /  Σ_i w_ib · target_i² / 2 )

  using exactly the components, bin widths and directional shares `WaveField.retarget` uses, so the
  open sea (s = 1, F = 40 km) gives exactly 1. Cascade A uses the 1D integral of S_J over
  [kMin_A, kMax_A], local over reference. All values are clamped to [0, 1].
- That's 480 entries × 21 JONSWAP evaluations, well under 1 ms per second.

### 4.2 Per cell

For each cell of each map (16 384 × number of maps):

1. Interpolate `F` (in log space), `S` and `W` linearly between the two baked directions either side
   of the wind's source bearing β (`wind.from`). W uses the swell bearing (`waves.swellFrom`).
2. `env0.gba` = bilinear `bandLUT` at (S, log F). `env1.r` = the cascade-A LUT.
3. `env0.r` (swell) = W.
4. **Depth cap.** Work out the local significant height from the local band variances (the global band
   variances scaled by env²), plus swell. Then

       c = min(1, 0.5 · hb / Hs_local)

   and multiply `env0` (all four channels) and `env1.r` by c. The figure 0.5·h is the depth-limited
   random-sea limit (Battjes); it only bites over shoals and near beaches.
5. `env1.g` = S. `env1.b` = hb. `env1.a` = `0.8 · (1 − S)` (lee gustiness, §5).
6. Land cells: `env0 = 0`, `env1.r = 0`, S as baked.

### 4.3 Smoothing in time and the clock

The composed result is a **target**. The live envelope relaxes toward it on **simulation time** with
τ = 40 s, the same rate the global amplitudes already use, so a wind shift moves the lee gradually.
Relaxation and upload run on a 0.25 s simulation-time tick:

    live += (target − live) · (1 − exp(−0.25 / 40))

A step is at most 0.6% of the remaining difference, which is invisible.

The tick runs **at the top of `Game.frame`, before the fixed sim steps**, and uploads the textures at
the same point. Physics in that frame and the rendered water then read identical bytes.

**Clock unification** (rev. 3 §6.3) lands first, as step 0 of §10: `wind.update` and the retarget timer
advance by simulated time (`SIM_DT` per step), not frame `dt`. Otherwise the envelope tick and the ship
drift apart on hitches.

## 5. Sail wind

`Wind` gains an optional `shelterAt: ((x: number, z: number, out: {s: number, g: number}) => void) | null`,
set by `Game` once the world loads. Inside `sampleAt`:

    speed = base · (1 + slow) · (1 + gust · (1 + g)) · heightFactor · s

The mean wind drops to `s` in a lee, while gusts there are relatively stronger (up to 1.56× the
relative amplitude in the deepest lee). This is the downslope-gust effect rev. 3 asked for, in its
simplest form. The direction isn't bent.

- `Wind.update`'s cached `speed`, `vx` and `vz` (the global readouts at the origin) are unchanged.
- `meanSpeed` stays global: it is the free wind that drives the spectrum, and shelter enters through S.
- The visual cat's paws (`uWindStrength`) stay global; cascade B ripples carry the local effect.

## 6. CPU integration (`waves.ts`)

`WaveField` gets `field: SeaStateField | null = null` and the per-component band weights.

### 6.1 Exact fallback

When `field` is null, every method runs today's code unchanged: separate branch, no multiply by 1.
`npm run test:golden` must stay bit-identical.

### 6.2 With a field

- `displacement(x, z, t, out)` samples env0 once at (x, z), the undisplaced point, then uses
  `amp_i · E_i` for both the horizontal (`q·amp·E`) and vertical terms. `heightAt` calls it inside the
  inverse iteration, so the envelope is re-sampled at each iterate. That matches the GPU, which
  samples at the grid point.
- `sampleFlowAt` samples env0 at the converged undisplaced point, stores the four values in the
  `FlowSample` (new field `env: Float64Array(4)`), and uses `amp_i · E_i` in height, slopes, the
  Jacobian, `H`, `Hx` and the flow. `flowAtDepth` reuses `cache.env`. Envelope gradients are dropped
  (§2.1).
- New `localHs(x, z)` and `shelterAt(x, z)` readers for audio, the HUD and the wind.
- `hs`, `jVar` and `peakLambda` stay open-sea diagnostics.

Every caller of `heightAt` and `sampleFlowAt` inherits the envelope with no changes: hull columns,
rudders, oars, crew water, the mooring, the walker, the chase camera, buoys, the berth marker, and the
future wave forces of phase 2.

### 6.3 Sampling

`SeaStateField.sample(x, z, out0, out1)` does:

1. Global map: manual bilinear over texel centres, clamped to the map edge; outside the world it
   returns the open-sea value (env = 1, S = 1, hb = 60).
2. Each detail region containing the point: the same bilinear, then

       mix(global, detail, f)

   where the feather f ramps from 0 to 1 over the outer 64 m of the region.

The GLSL `seaEnv(p)` is a line-for-line transliteration with `texelFetch`. Both use the same Float32
bytes, so they differ by float32 rounding only.

Cost: about 8 extra array reads per `displacement` call, against 24 sin/cos pairs. Expect around +5%
of wave-sampling time; measure it.

## 7. GPU integration (`ocean.ts`)

### 7.1 Textures

Two RGBA32F `DataTexture`s, `uSeaEnv0` and `uSeaEnv1`:

- Atlas layout: the global map, then each detail map, side by side (256 × 128 today).
- `NearestFilter`, no mips, read only with `texelFetch`.
- Uniforms: `uSeaGlobal` (origin.xy, cell, n) and `uSeaDetail` (origin.xy, cell, atlas x offset).
  One detail slot, bound to the region nearest the camera.
- `uSeaOn` (0 or 1): with 0 the shader skips everything and is identical to today.

### 7.2 Vertex shader

At the undisplaced point p, before `gerstner()`, sample both textures once:

- `gerstner(p, dist, N, J, env0)`: in the loop, `amp = A.w · fade · dot(env0, uWaveC[i])`. `gLostVar`
  uses the same enveloped amplitude.
- The FFT displacement is multiplied by `env1.r`.
- Pass the values on as varyings: `vEnv0` (vec4) and `vEnv1` (vec2: eA and s).

### 7.3 Fragment shader

**No new samplers.** The fragment budget is at the 16-sampler limit
(`test-ocean-sampler-budget.mjs`), and the envelope varies over hundreds of metres, so interpolating it
per vertex is accurate. It's only used for shading.

- The per-pixel `gerstner(vGrid, dist, gN, gJ, vEnv0)`.
- Cascade A slopes ×`eA`, slope variance ×`eA²`.
- Cascade B slopes ×`s`, variance ×`s²`. These are multiplied on top of the existing gust and slick
  gains.
- Foam Jacobian `JA = 1 + eA·(J − 1)`. The persistent trail is ×`eA²`.
- The whitecap threshold stays global (open-sea statistics). In a lee the local Jacobian deviations
  shrink with E, so whitecaps thin out by themselves.

Sampler test update: the vertex shader adds two samplers. Extend the test to count vertex samplers
too (limit 16) and to assert the fragment shader still declares none of the sea textures.

### 7.4 Dev view

`?debug=seastate` tints the water by the local Hs ratio (blue = calm, red = exposed) and logs the bake
time. It's a tuning aid only, never visible in normal play.

`?windFrom=<deg>` overrides `wind.baseFrom`, so tests and screenshots can try any wind direction. It
sits alongside the existing `?wind=<m/s>`.

## 8. Audio

The wave-slap and hull-wash gains get multiplied by `localHs / openHs` at the ship (clamped, eased over
2 s), so the harbour sounds quiet. Wind audio already follows the ship's apparent wind, so it follows
the sail shelter by itself. No HUD readout, chart or minimap shading is added (§11.3).

## 9. Validation

### 9.1 Headless (`scripts/test-sea-state.mjs`, `npm run test:sea-state`)

1. **Open world:** a heightmap with no land gives F = 40 km, S = 1, W = 1 and an envelope of exactly
   1 everywhere, for every wind direction.
2. **E ≤ 1:** on a generated world (seed 1, worker code run in Node) at 4, 8, 12 and 16 m/s across 16
   bearings, every channel is in [0, 1].
3. **Round island:** a 1 km cone 200 m high in an otherwise open world.
   - The upwind side is within 2% of 1.
   - 1 km downwind, the long band is < 0.3 and S < 0.6.
   - Results are mirror-symmetric about the wind axis within 1%.
   - The swell shadow fills back above 0.6 by 6 km downwind.
4. **Harbour:** generated world, prevailing wind and swell.
   - Hs at the lee-side berth centre ≤ 0.25 × open-sea Hs.
   - The windward-side berth is measurably rougher than the lee side.
   - Rotating the wind 180° swaps which side is calmer.
5. **Fallback:** `test:golden` bit-identical with no field; the existing rowing, sailing, mooring and
   walker tests are unchanged.
6. **Inverse convergence:** with the field on, at 1000 random sea points with open-sea Hs 2 m, the
   `heightAt` residual is < 1 mm after 4 iterations.
7. **Sampling:** CPU `sample()` matches a reference bilinear at texel centres, edges, detail feathers
   and outside the world.
8. **Determinism:** the same seed and the same sequence of sim steps give byte-identical envelopes.
   An envelope tick with a 0.1 s frame hitch matches one without (clock unification).
9. **Shader parity, by source:** the GLSL uses the same band centres, texel-centre convention and
   feather width as the TS constants (regex checks, as in the sampler test).

### 9.2 Browser

1. **CPU/GPU parity readback:** a dev pass renders `seaEnv()` at 64 probe points into a float target.
   Each value matches `SeaStateField.sample` within 1e-5.
2. **Waterline:** in the harbour and in a lee, the hull's visual waterline still matches. No sea
   showing inside the hull beyond today's level.
3. **Screenshots** at 12 m/s from NNE, with the dev tint and without it:
   - harbour, open strait, lee of the main island, a gap between islands
   - then the same set with `?windFrom=200`
4. **Performance:** CPU per-frame cost of the envelope tick and the extra sampling, and GPU ocean time
   before and after (`gpuProfiler`), on high quality. Budget: +0.3 ms CPU, +0.2 ms GPU.

## 10. Order of work

| Step | Work | Gate |
|---|---|---|
| 0 | Clock unification (wind and retarget on sim time) | golden trace, existing tests |
| 1 | `seaState.ts` bake plus Node tests 1–3 on synthetic worlds | tests 1–3 |
| 2 | Worker integration, `pierFootprint` extraction, detail map, `?debug=seastate` | test 4, bake time |
| 3 | `SeaStateField` composition, LUTs, relaxation tick | tests 2, 7, 8 |
| 4 | `WaveField` CPU envelope with the exact fallback | tests 5, 6 |
| 5 | Ocean shaders, textures, sampler test | browser 1–2 |
| 6 | Sail wind shelter (`Wind.shelterAt`) | sailing tests unchanged without a field |
| 7 | Audio | listening check |
| 8 | Screenshots, performance, constant tuning (§13) | browser 3–4 |

Each step is a commit. Steps 1–3 change nothing in the game until step 4 wires them in.

**Relation to phase 2** (wave forces and added mass): the two are independent. Phase 2's excitation
reads `sampleFlowAt`, which carries the envelope after step 4. Whichever lands second needs no
rework.

## 11. User decisions (2026-10-10)

1. **The archipelago gets calmer: accepted.** Global amplitudes stay defined at the open sea (40 km
   fetch). Water downwind of islands is calmer than today; only water near the world's upwind edge
   keeps today's size.
2. **Phase 2 (wave forces, added mass, Munk moment) lands first.** This spec follows it. Phase 2 is
   tuned against today's uniform sea; any tuning that depends on harbour conditions (docking hold,
   anchor loads) waits until this spec lands.
3. **No chart or minimap shading.** Shelter is learned from the water, the sound and the sail, in line
   with "show the gradient, not the answer". `?debug=seastate` stays dev-only.
4. **The visual shoreline pass comes later**, after phase 2 and the open hold.

## 12. Changes from rev. 3 (§6.1–6.2)

- **The harbour uses a detail map, not an explicit pier-frame attenuation.** Reasons:
  - it shelters whichever side of the mole is actually in the lee for the current wind, so "pick the
    lee side" (plan §5.2) works by itself
  - it covers any future harbour or player-built dock with the same code
  - the cost is one extra 128² bake
- **Fetch and shelter are baked per direction, U-independent.** Band multipliers are composed live
  through a LUT. Rev. 3 implied baking band multipliers, but they depend on the wind speed, because the
  spectral peak moves with U.
- **The whitecap threshold stays global.** Local whitecaps fall naturally with the enveloped Jacobian.
  A second statistic per place isn't needed.
- **One wave direction per place.** All wind-sea components use the fetch at the mean wind bearing,
  not their own direction. The ±45° effective fetch already averages across the spread.
- **The FFT cascade A multiplier is clamped at 1.** A young sea in a lee is physically a bit steeper
  in the 1–11 m band than the open-sea tail, but going above 1 risks fold-over and breaks the
  validity rule. It can be revisited after screenshots (cap 1.3).

## 13. Tunable constants (start values)

| Constant | Value | Where |
|---|---|---|
| Wake length | 15 hill heights | §3.2 |
| Obstacle height ramp | 5–40 m | §3.2 |
| Deep-lee wind floor | 0.3 | §3.3 |
| Lee gustiness | 0.8·(1 − S) | §4.2 |
| Swell fan | ±22.5°; second blur 600 m | §3.3–3.4 |
| Depth limit | Hs ≤ 0.5·h | §4.2 |
| Envelope τ | 40 s | §4.3 |
| Detail region | 1024 m at 8 m; 64 m feather | §3.1, §6.3 |

## 14. Implementation notes (2026-10-10)

Code: `src/world/seaState.ts` (bake, composition, sampling), `src/world/spectrum.ts` (JONSWAP, split
out of `waves.ts` to avoid an import cycle), `waves.ts` (envelope on every CPU query, `SEA_ENV_GLSL`),
`ocean.ts`, `oceanFFT.ts`, `wind.ts`, `worldgen.worker.ts`, `game.ts`, `main.ts`, `audio.ts`.
Tests: `npm run test:sea-state`, `scripts/test-ocean-sampler-budget.mjs`.

Where the build differs from the text above, and why:

- **Fetch weights** are cos²α normalised by their own sum (not Σcos α), so open sea gives exactly the
  40 km cap and E = 1.
- **Swell floor 0.2** (rev. 3's diffraction floor) is back: without it the lee of the mole was dead flat.
- **Harbour map: 512 m at 4 m cells** (not 1024 m at 8 m), and the mole padded by 1 m (not 4 m): ships
  berth 6 m from the mole's axis, which the coarser map and the wider rubble strip had turned into land.
- **Land cells** take their sea neighbours' values (4 rings) instead of E = 0, so bilinear sampling
  beside a coast or quay wall reads the nearby water. Depth is blurred over water cells only (the berths
  read 4.2 m, not 0.8 m).
- **Edges clamp** to the map's last texel instead of returning open sea outside the world (same on CPU
  and GPU; the world edge is open water anyway).
- **Texture budget.** three.js counts texture units across both shader stages against 16, and the
  ocean was at 16. So:
  - the envelope is one texture (env0 rows, then env1 rows)
  - the FFT now writes two outputs instead of three: slope = (sx, sz, sx² + sz², J), displacement =
    (Dx, Dy, Dz, persistent foam). The ocean shader only ever used the total slope variance, so this
    is exact.
  - the fragment stage reads foam through `uDispA`, which the vertex stage already binds (one unit),
    and the separate foam texture is gone. The budget test now also counts the samplers declared in
    `waves.ts`.
- **The band lookup table** is cached while wind speed, direction and swell hold, so compose costs
  about 1–3 ms once a second rather than every time.

Measured:

| What | Result |
|---|---|
| Bake in the worker (2048 heightmap, with harbour map) | 880–970 ms (target 800; the detail rays are the cost) |
| CPU/GPU parity, 64 probes incl. 18 in the harbour map (raw WebGL readback of `SEA_ENV_GLSL`) | worst 5×10⁻⁶ |
| `heightAt` with the field | 2.2 µs vs 1.75 µs |
| Compose / tick | ≤3.4 ms at 1 Hz / 0.17 ms at 4 Hz |
| Generated world, prevailing wind 12 m/s: berths vs open water | Hs 0.07 m vs 1.35 m |
| Synthetic mole, wind from either side | lee-side berth flat, windward berth exposed; swaps with the wind |
| 1 km island: wind 1 km downwind / 200 m downwind | 79% / under 65% of the free wind (the spec's "S < 0.6 at 1 km" was too strong) |
| No field: trireme golden trace with the original oar banks | bit-identical |

Open: the bake is slightly over its 800 ms target; dropping the detail map to 32 rays is the
planned lever if it matters.
