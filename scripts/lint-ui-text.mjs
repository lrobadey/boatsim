// UI text lint (cargo spec §13): scans the string literals of the new UI modules for the house rules.
// Flags: '!' (no exclamation marks); an em dash used between words (a bare '—' placeholder is allowed);
// and Title Case labels ("Order Total": two or more words, each of three or more letters, all capitalised).
// hud.ts is checked only inside its `// ui-text:begin` … `// ui-text:end` regions, since the rest of that
// file predates the rule. Exit 1 when anything is flagged.
//
// usage: node scripts/lint-ui-text.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  { file: 'src/ui/ledger.ts' },
  { file: 'src/trade/stall.ts' },
  { file: 'src/ui/ledgerSource.ts' },
  { file: 'src/ui/hud.ts', regions: true },
];

/** string and template literal text (template `${}` code is skipped; nested literals are read) */
function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  function code(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        str(c);
        continue;
      }
      if (c === '`') {
        tpl();
        continue;
      }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      i++;
    }
  }

  function str(q) {
    const startLine = line;
    let buf = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === '\n') line++;
      buf += src[i];
      i++;
    }
    i++;
    out.push({ text: buf, line: startLine });
  }

  function tpl() {
    let segLine = line;
    let buf = '';
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        out.push({ text: buf, line: segLine });
        buf = '';
        i += 2;
        code(true);
        segLine = line;
        continue;
      }
      if (src[i] === '\n') line++;
      buf += src[i];
      i++;
    }
    i++;
    out.push({ text: buf, line: segLine });
  }

  code(false);
  return out;
}

/** the regions of a file (1-based inclusive line ranges) between ui-text markers */
function regionsOf(src) {
  const lines = src.split('\n');
  const ranges = [];
  let start = -1;
  lines.forEach((l, idx) => {
    if (l.includes('ui-text:begin')) start = idx + 1;
    else if (l.includes('ui-text:end') && start > 0) {
      ranges.push([start, idx + 1]);
      start = -1;
    }
  });
  return ranges;
}

function check(text) {
  const problems = [];
  if (text.includes('!')) problems.push("exclamation mark '!'");
  if (text.includes('—') && text.trim() !== '—') problems.push('em dash');
  const words = text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  const long = words.filter((w) => w.length >= 3);
  const capitals = long.filter((w) => /^[A-Z]/.test(w));
  if (long.length >= 2 && capitals.length === long.length) problems.push('Title Case label');
  return problems;
}

let offenders = 0;
let scanned = 0;
for (const t of TARGETS) {
  const path = resolve(root, t.file);
  if (!existsSync(path)) continue;
  const src = readFileSync(path, 'utf8');
  const ranges = t.regions ? regionsOf(src) : null;
  scanned++;
  for (const lit of literals(src)) {
    if (ranges && !ranges.some(([a, b]) => lit.line >= a && lit.line <= b)) continue;
    for (const why of check(lit.text)) {
      offenders++;
      console.log(`${t.file}:${lit.line}  ${why}  ${JSON.stringify(lit.text.slice(0, 90))}`);
    }
  }
}

if (offenders > 0) {
  console.log(`\n${offenders} UI text problem(s).`);
  process.exit(1);
}
console.log(`UI text lint: ${scanned} file(s) clean.`);
