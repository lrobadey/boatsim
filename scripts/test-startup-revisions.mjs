import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceRevision } from './startup-revisions.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trieres-revisions-'));
try {
  await fs.writeFile(path.join(root, 'entry.ts'), "import { value } from './child'; export const result = value;\n");
  await fs.writeFile(path.join(root, 'child.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"version":1}');
  const first = sourceRevision(root, ['entry.ts']).revision;
  assert.equal(sourceRevision(root, ['entry.ts']).revision, first);
  await fs.writeFile(path.join(root, 'unrelated.ts'), 'export const x = 4;');
  assert.equal(sourceRevision(root, ['entry.ts']).revision, first, 'unrelated edits must not invalidate');
  await fs.writeFile(path.join(root, 'child.ts'), 'export const value = 2;\n');
  const second = sourceRevision(root, ['entry.ts']).revision;
  assert.notEqual(second, first, 'transitive source changes must invalidate');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"version":2}');
  assert.notEqual(sourceRevision(root, ['entry.ts']).revision, second, 'dependency lock changes must invalidate');
  await fs.writeFile(path.join(root, 'child.ts'), "export { missing } from './missing';\n");
  assert.throws(() => sourceRevision(root, ['entry.ts']), /Cannot fingerprint/, 'missing source must fail explicitly');
  console.log('PASS stable revisions, transitive source and lock invalidation, unrelated isolation, missing dependencies');
} finally { await fs.rm(root, { recursive: true, force: true }); }
