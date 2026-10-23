import { mergeConfig, type ConfigEnv } from 'vite';
import gameConfig from '../vite.config.ts';

/** Dedicated dev entry; the normal game and the isolated engineering trial keep their URLs. */
export default async (env: ConfigEnv) => mergeConfig(await gameConfig(env), {
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  plugins: [{ name: 'thalassa-dev-entry', configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/') return next();
      response.writeHead(302, { Location: '/?dev&ship=thalassa&start=sea&hud=1&wind=8' }); response.end();
    });
  } }],
});
