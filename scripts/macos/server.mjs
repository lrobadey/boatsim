// The native launcher owns this process. EOF on stdin also stops it if the app crashes.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, state: { type: 'string' }, port: { type: 'string' },
} });
let server;
let stopping = false;
let parentWatch;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(parentWatch);
  const deadline = setTimeout(() => process.exit(code), 3000);
  deadline.unref();
  await server?.close();
  process.exit(code);
}

try {
  if (!values.project) throw new Error('The Trieres project folder was not supplied.');
  const root = await realpath(values.project);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'trieres') throw new Error('This folder is not the Trieres game project.');
  const require = createRequire(join(root, 'package.json'));
  let vite;
  try { vite = require.resolve('vite'); }
  catch { throw new Error('Game dependencies are missing. Run npm install in the Trieres project folder.'); }
  let savedPort;
  if (values.state) {
    try {
      const state = JSON.parse(await readFile(values.state, 'utf8'));
      if (state.project === root && Number.isInteger(state.port) && state.port > 0 && state.port < 65536) savedPort = state.port;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not read the saved server port:', error.message);
    }
  }
  const port = values.port === undefined ? (savedPort ?? 5173) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port.');
  const { createServer } = await import(pathToFileURL(vite).href);
  server = await createServer({
    root, clearScreen: false,
    // Remember the first free port: changing origin would hide the game's local saves.
    server: { host: '127.0.0.1', port, strictPort: savedPort !== undefined, open: false },
    plugins: [{
      name: 'trieres-native-launcher',
      configureServer(instance) {
        instance.middlewares.use('/__trieres_launcher__/health', (_request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ app: 'trieres', project: root, pid: process.pid }));
        });
      },
    }],
  });
  try { await server.listen(); }
  catch (error) {
    if (savedPort !== undefined) throw new Error(`Trieres' saved port ${savedPort} is busy. Quit the other app using that port and reopen Trieres. Your saved games are unchanged.`, { cause: error });
    throw error;
  }
  if (stopping) await stop();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The game server did not report a local port.');
  if (values.state) {
    await mkdir(dirname(values.state), { recursive: true });
    await writeFile(values.state, JSON.stringify({ project: root, port: address.port }) + '\n');
  }
  const url = `http://127.0.0.1:${address.port}/`;
  // Only this prefixed record is interpreted by the launcher; Vite's other output is logged.
  console.log('TRIERES_READY ' + JSON.stringify({ url }));
  const parent = process.ppid;
  parentWatch = setInterval(() => {
    if (process.ppid !== parent) void stop();
  }, 2000);
  process.stdin.resume();
  process.stdin.on('end', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch (error) {
  console.error(error.stack ?? error.message);
  await stop(1);
}
