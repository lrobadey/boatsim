import path from 'node:path';
import { sourceRevision } from './startup-revisions.mjs';
import { ensureStartupTextures } from './bake-startup-textures.mjs';

const MODULE = 'virtual:startup-assets';
const RESOLVED = `\0${MODULE}`;

/** Prepare exact texture bytes before serving/copying public/, in dev and production. */
export async function startupAssetsPlugin(root) {
  let watched = new Set();
  let exports;
  async function prepare() {
    const world = sourceRevision(root, ['src/world/worldgen.worker.ts']);
    const textures = sourceRevision(root, ['src/gfx/texgen.worker.ts', 'src/gfx/startupTextures.ts', 'scripts/bake-startup-textures.mjs']);
    const asset = await ensureStartupTextures(root, textures.revision);
    watched = new Set([...world.files, ...textures.files]);
    exports = { worldRevision: world.revision, textureUrl: asset.url };
  }
  await prepare();
  return {
    name: 'trieres-startup-assets',
    resolveId(id) { if (id === MODULE) return RESOLVED; },
    load(id) {
      if (id !== RESOLVED) return;
      for (const file of watched) this.addWatchFile(file);
      return Object.entries(exports).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n');
    },
    async handleHotUpdate(context) {
      if (!watched.has(path.resolve(context.file))) return;
      await prepare();
      const module = context.server.moduleGraph.getModuleById(RESOLVED);
      if (module) context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
