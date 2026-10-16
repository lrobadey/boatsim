import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

if (process.platform !== 'darwin') throw new Error('The Trieres app launcher must be built on macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'trieres-launcher-'));
const destination = join(root, 'Trieres.app');
const app = join(temporary, 'Trieres.app');
const contents = join(app, 'Contents');
const resources = join(contents, 'Resources');
const iconset = join(temporary, 'Trieres.iconset');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

try {
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(iconset);
  const sizes = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
  for (const [size, scale] of sizes) {
    execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), join(root, 'assets/launcher/trieres-icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
  }
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'Trieres.icns')]);
  run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', join(temporary, 'swift-cache'),
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
    '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'scripts/macos/Trieres.swift'),
    '-o', join(contents, 'MacOS/Trieres')]);
  await copyFile(join(root, 'scripts/macos/server.mjs'), join(resources, 'server.mjs'));
  await writeFile(join(resources, 'launcher.json'), JSON.stringify({ projectPath: root, nodePath: process.execPath }, null, 2) + '\n');
  await writeFile(join(contents, 'PkgInfo'), 'APPL????');
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Trieres</string>
  <key>CFBundleDisplayName</key><string>Trieres</string>
  <key>CFBundleIdentifier</key><string>dev.lucarobadey.trieres.launcher</string>
  <key>CFBundleExecutable</key><string>Trieres</string>
  <key>CFBundleIconFile</key><string>Trieres</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHumanReadableCopyright</key><string>Trieres — Aegean sailing</string>
</dict></plist>\n`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  try {
    const previous = await readFile(join(destination, 'Contents/Info.plist'), 'utf8');
    if (!previous.includes('<string>dev.lucarobadey.trieres.launcher</string>')) throw new Error('Refusing to replace an unrelated Trieres.app.');
    await rm(destination, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(app, destination);
  console.log(`Built ${destination}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
