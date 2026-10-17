import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'trieres launcher checks '));
const children = new Set();
function start(args = []) {
  const child = spawn(process.execPath, [join(root, 'scripts/macos/server.mjs'), '--project', root, ...args], {
    cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const exited = once(child, 'exit');
  let logs = '';
  const ready = new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start:\n${logs}`)), 20000);
    child.stdout.on('data', data => {
      logs += data;
      const record = logs.split('\n').find(line => line.startsWith('TRIERES_READY '));
      if (record) { clearTimeout(timeout); resolveReady(JSON.parse(record.slice('TRIERES_READY '.length))); }
    });
    child.stderr.on('data', data => { logs += data; });
    exited.then(([code]) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}:\n${logs}`)); });
  });
  // Tests may intentionally wait for exit instead of readiness.
  ready.catch(() => {});
  return { child, ready, exited, logs: () => logs };
}
async function stop(instance, signal = 'SIGTERM') {
  if (signal === 'EOF') instance.child.stdin.end(); else instance.child.kill(signal);
  const [code] = await Promise.race([instance.exited, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not shut down')), 5000);
    timer.unref();
  })]);
  // Vite 8 closes its server then returns the conventional 128 + SIGTERM status.
  assert.ok(signal === 'SIGTERM' ? [0, 143].includes(code) : code === 0, `Unexpected shutdown status ${code}`);
  children.delete(instance.child);
}

try {
  const statePath = join(temporary, 'state with spaces', 'server.json');
  const first = start(['--state', statePath, '--port', '0']);
  const { url } = await first.ready;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const identity = await fetch(new URL('__trieres_launcher__/health', url)).then(response => response.json());
  assert.equal(identity.project, root);
  assert.equal(identity.pid, first.child.pid);
  const index = await fetch(url).then(response => response.text());
  assert.ok(index.includes('/src/main.ts'));
  const module = await fetch(new URL('src/main.ts', url));
  assert.equal(module.status, 200);
  assert.ok((await module.text()).includes('loadVisualAssets'));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.port, Number(new URL(url).port));
  assert.equal(state.project, root);

  // A second independent instance gets a different port instead of opening the wrong app.
  const second = start(['--port', String(state.port)]);
  const secondReady = await second.ready;
  assert.notEqual(secondReady.url, url);
  await stop(second, 'EOF');
  await assert.rejects(fetch(secondReady.url));
  await stop(first);
  await assert.rejects(fetch(url));

  // Relaunch preserves the origin used by localStorage saves.
  const relaunch = start(['--state', statePath]);
  assert.equal((await relaunch.ready).url, url);
  await stop(relaunch);

  // Never silently move a saved game's origin when another program takes its port.
  const blocker = createServer();
  blocker.listen(state.port, '127.0.0.1');
  await once(blocker, 'listening');
  try {
    const blocked = start(['--state', statePath]);
    assert.equal((await blocked.exited)[0], 1);
    assert.match(blocked.logs(), /saved port .* is busy/);
    children.delete(blocked.child);
  } finally { blocker.close(); }
  const missing = start(['--project', join(temporary, 'missing project')]);
  assert.equal((await missing.exited)[0], 1);
  children.delete(missing.child);
  console.log('Launcher checks passed: game/module serving, identity, port collision, persistent origin, relaunch, SIGTERM, stdin EOF, missing-project failure.');
} finally {
  for (const child of children) { child.kill('SIGKILL'); child.stdin.destroy(); }
  await rm(temporary, { recursive: true, force: true });
}
