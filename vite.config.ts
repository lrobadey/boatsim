import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupAssetsPlugin } from './scripts/startup-assets-plugin.mjs';
import { talkProxy } from './scripts/talk-proxy.mjs';

/** dev server only: saves F9 performance captures (src/core/frameProfiler.ts) to profiles/ */
const profileSink: Plugin = {
  name: 'trieres-profile-sink',
  configureServer(server) {
    server.middlewares.use('/__trieres_profile__', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const dir = join(server.config.root, 'profiles');
        mkdirSync(dir, { recursive: true });
        const file = `profiles/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        writeFileSync(join(server.config.root, file), JSON.stringify(JSON.parse(body), null, 2) + '\n');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ file }));
      });
    });
  },
};

export default defineConfig(async () => ({
  server: { port: Number(process.env.PORT) || 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  plugins: [profileSink, talkProxy(), await startupAssetsPlugin(process.cwd())],
}));
