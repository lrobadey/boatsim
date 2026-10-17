# Ormos — standalone harbor study

A separate Blender-authored waterfront scene for reviewing the harbor before game integration. Work in progress: see [HANDOFF.md](HANDOFF.md) for visual limitations and next steps.

From the boatsim repository root:

```sh
node node_modules/vite/bin/vite.js --config harbor-study/vite.config.mjs
```

Open http://127.0.0.1:5186/. Orbit with drag, zoom with the wheel, pan with right-drag. Seven camera presets cover approach, berth, quay, loading court, shore, overview and boat. Settings provide lighting, water movement, render quality, material notes and PNG capture. Walk ashore uses WASD and drag-look; Esc returns to orbit; H hides controls.

Build a self-contained static folder (no CDN/runtime game dependency):

```sh
node harbor-kit/tools/pack.mjs harbor-study
node harbor-kit/tools/validate.mjs harbor-study
node harbor-study/tests/walk.mjs
node node_modules/vite/bin/vite.js build --config harbor-study/vite.config.mjs
python3 -m http.server 5186 --bind 127.0.0.1 --directory harbor-study/dist
```

Stop the dev server before serving on the same port. Serve the whole `dist` directory; opening `index.html` via file:// is not supported.

Editable Blender source: `blender/ormos-harbor.blend`. Deterministic rebuild:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-study/blender/build_harbor.py
```

The boat is a scenic moored vessel, not a port of the game's sailing/docking physics. This study does not modify the game.
