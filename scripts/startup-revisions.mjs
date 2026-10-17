import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

/** Hash the complete local import graph, plus locked package/compiler inputs. */
export function sourceRevision(root, entries) {
  const files = new Set();
  function visit(file) {
    file = path.resolve(file);
    if (files.has(file)) return;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(imported.fileName, file, {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      }, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error(`Cannot fingerprint ${imported.fileName} from ${file}`);
      visit(resolved);
    }
  }
  entries.forEach(entry => visit(path.resolve(root, entry)));
  for (const input of ['package-lock.json', 'tsconfig.json']) {
    const file = path.join(root, input);
    if (fs.existsSync(file)) files.add(file);
  }
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    const bytes = fs.readFileSync(file);
    hash.update(`${path.relative(root, file).split(path.sep).join('/')}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return { revision: hash.digest('hex'), files: [...files] };
}
