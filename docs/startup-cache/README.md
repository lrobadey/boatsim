# Startup data reuse

Implemented October 15, 2026. This changes preparation of world and texture data;
simulation, terrain generation, saves, rendering quality and worker outputs retain
their existing behavior.

## World snapshots

The first launch generates the world through the original worker and stores a
complete structured clone in IndexedDB `trieres-startup`, database version 2,
store `worlds`. Subsequent matching launches load the snapshot without constructing
the worker. This includes heights, vegetation, AO, islands, sites, port profiles,
and every directional sea-shelter/depth map.

Keys include seed, heightmap resolution, world size, prevailing generation wind
direction, vegetation density, authored-harbor flag, and a SHA-256 source revision.
The revision includes the worker's complete local import graph, package lock, and
TypeScript configuration. Editing terrain, harbor grading, sea-state generation,
or imported constants invalidates the snapshot automatically. In development,
these edits refresh revisions and reload the page.

The cache retains the three most recently written worlds. Reads are read-only;
they do not rewrite large payloads to refresh eviction order. Put and eviction are
one transaction. Writes complete before gameplay receives the generated object,
so later runtime mutation cannot change a saved snapshot. This database contains
disposable startup data only, separate from voyage saves.

Schema, request dimensions, typed-array lengths, site/profile fields and sea-map
dimensions are validated on load. Missing/invalid entries regenerate. Unavailable,
blocked, full or failing storage falls back to the original worker. Opening the
database and each transaction have a one-second bound; timed-out transactions
abort. Storage eviction by the browser simply makes the next launch cold.

## Fixed textures

Vite prepares all five deterministic textures before dev serving or production
build copying: noise, ripple, cloud shape, cloud detail, and cloud weather. Their
original sizes and seeds are preserved. Generated files live in the ignored
`public/generated/startup-textures/` directory and are included in `dist/`.
The first server/build after a generator edit performs the bake; subsequent starts
validate and reuse its file. Normal gameplay does not regenerate those textures.

Files use source-fingerprinted URLs, an explicit little-endian binary format,
exact size and header validation, and a payload checksum. The loader waits at
most 1.5 seconds for fetching and reading before falling back to the original
texture worker. This fallback also handles missing or corrupt assets. Texture
fingerprints include the generator worker, codec, bake script and their imports.
The bake retains recent fingerprinted files and leaves other files untouched.

`toHalf` now reuses two scratch views, removing millions of temporary typed-array
allocations if fallback generation is needed. Its full texture output was checked
bit for bit against the pre-change generator.

## Verification and diagnostics

- `npm run test:startup-cache`: cache behavior, request invalidation, snapshot
  isolation, failure propagation, binary equality/corruption/timeouts, direct
  storage-adapter transaction/eviction tests, transitive source fingerprints.
  Adapter tests use an asynchronous transactional IndexedDB model, not a browser.
- `npm run benchmark:startup-cache`: real Ultra world generation plus structured
  clone cache reads; all five original/generated/baked texture arrays compared
  exactly. Writes `headless-benchmark.json` here.
- `npm run typecheck` and `npm run build` validate integration. An HTTP smoke check
  also checked Vite's virtual revision exports and exact served texture bytes.
- `?dev` logs `[startup]` source and elapsed milliseconds for both data paths.
  `?dev&startupCache=off` forces both original generation workers for diagnosis
  without changing saved caches.

The recorded local headless run measured about 1.85 s original texture generation
versus 8.6 ms file read/validation/decode, and 3.86 s world generation plus clone
versus 1.3–5.7 ms warm structured-clone reads. These are data-path measurements,
not browser startup times: the warm-world substitute omits actual IndexedDB I/O,
and the texture file read omits HTTP overhead. World, textures and visual asset
loading overlap, so their savings must not be added together. The JSON records
inputs, runtime version, source revisions and exact timings.

No browser tests or full application launch-time comparison were performed in
this session. Shader warmup, asset decoding and scene construction still occur.
