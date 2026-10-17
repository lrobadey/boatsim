import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupAssetsPlugin } from './scripts/startup-assets-plugin.mjs';
import { talkProxy } from './scripts/talk-proxy.mjs';

/** largest real F9 capture so far is ~5 MB pretty-printed; anything far past that is not a capture */
const PROFILE_MAX_BYTES = 32 * 1024 * 1024;

/** dev server only: saves F9 performance captures (src/core/frameProfiler.ts) to profiles/ */
const profileSink: Plugin = {
  name: 'trieres-profile-sink',
  configureServer(server) {
    server.middlewares.use('/__trieres_profile__', (req, res) => {
      const reply = (status: number, payload?: object) => {
        res.statusCode = status;
        if (payload) res.setHeader('Content-Type', 'application/json');
        res.end(payload ? JSON.stringify(payload) : undefined);
      };
      if (req.method !== 'POST') return reply(405);
      // only same-origin pages (the game itself) may write here
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return reply(403, { error: 'cross-origin request' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'expected application/json' });
      if (Number(req.headers['content-length']) > PROFILE_MAX_BYTES) return reply(413, { error: 'capture too large' });

      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > PROFILE_MAX_BYTES) {
          done = true;
          chunks.length = 0;
          res.setHeader('Connection', 'close');
          reply(413, { error: 'capture too large' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('error', () => { done = true; });
      req.on('end', () => {
        if (done) return;
        done = true;
        let data: unknown;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reply(400, { error: 'invalid JSON' });
        }
        try {
          mkdirSync(join(server.config.root, 'profiles'), { recursive: true });
          const file = `profiles/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          writeFileSync(join(server.config.root, file), JSON.stringify(data, null, 2) + '\n');
          reply(200, { file });
        } catch (e) {
          server.config.logger.error(`[profile] could not save capture: ${(e as Error).message}`);
          reply(500, { error: 'could not save capture' });
        }
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
