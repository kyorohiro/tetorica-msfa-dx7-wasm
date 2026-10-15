// Exercise only the npm tarball's public files and exports, outside this checkout.
// This creates a local tarball; it never publishes a package.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'vite';

const project = fileURLToPath(new URL('../', import.meta.url));
// Vite resolves symlinks in module IDs. Canonicalize macOS /tmp before setting
// its project root, so HTML assets do not appear to live outside that root.
const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
const directory = await realpath(await mkdtemp(join(temporaryRoot, 'tetorica-dx7-package-')));
const consumer = join(directory, 'consumer');
const { mkdir } = await import('node:fs/promises');
await mkdir(consumer);

function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} ${args.join(' ')} failed (${signal ?? code}).\n${stdout}\n${stderr}`));
    });
  });
}

function npm(args, cwd) {
  // npm run supplies the CLI path, which also works without shell execution on Windows.
  const cli = process.env.npm_execpath;
  return cli
    ? command(process.execPath, [cli, ...args], cwd)
    : command(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

async function filesWithin(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await filesWithin(path));
    else paths.push(path);
  }
  return paths;
}

let succeeded = false;
try {
  const packed = await npm(['pack', '--json', '--pack-destination', directory], project);
  const [manifest] = JSON.parse(packed.stdout);
  assert.equal(manifest.name, 'tetorica-msfa-dx7-wasm');
  const packaged = new Set(manifest.files.map(file => file.path));
  for (const path of ['src/index.js', 'src/index.d.ts', 'src/browser.js', 'src/browser.d.ts',
    'src/sysex.js', 'src/sysex.d.ts', 'src/dx7-worklet.js', 'wasm/msfa.wasm',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/msfa/COPYING', 'vendor/msfa/UPSTREAM.md', 'docs/research.md']) {
    assert.ok(packaged.has(path), `The npm tarball must include ${path}.`);
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'dx7-isolated-consumer', version: '0.0.0', private: true, type: 'module' }));
  const tarball = join(directory, manifest.filename);
  await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);

  await writeFile(join(consumer, 'check-node.mjs'), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDX7, createInitVoice, createVoiceSysex, DEFAULT_WASM_URL } from 'tetorica-msfa-dx7-wasm';
import { parseSysex } from 'tetorica-msfa-dx7-wasm/sysex';
import { createDX7Node } from 'tetorica-msfa-dx7-wasm/browser';
assert.equal(typeof createDX7Node, 'function');
assert.equal(typeof DEFAULT_WASM_URL, 'string');
assert.ok(import.meta.resolve('tetorica-msfa-dx7-wasm/worklet').endsWith('/src/dx7-worklet.js'));
const asset = await readFile(new URL(import.meta.resolve('tetorica-msfa-dx7-wasm/wasm/msfa.wasm')));
assert.deepEqual([...asset.subarray(0, 4)], [0, 97, 115, 109]);
const message = createVoiceSysex(createInitVoice('PACKAGED'));
assert.equal(parseSysex(message).voices[0].name, 'PACKAGED');
for (const sampleRate of [44100, 48000]) {
  const synth = await createDX7({ sampleRate });
  try {
    await synth.loadSysex(message);
    synth.noteOn(69, 100);
    const pcm = synth.render(sampleRate);
    let square = 0;
    for (const value of pcm) { assert.ok(Number.isFinite(value) && value >= -1 && value <= 1); square += value * value; }
    const rms = Math.sqrt(square / pcm.length);
    assert.ok(rms > 0.001, 'installed package must render actual sound');
    console.log(JSON.stringify({ sampleRate, frames: pcm.length, rms }));
  } finally { synth.dispose(); }
}
`);
  const nodeResult = await command(process.execPath, ['check-node.mjs'], consumer);
  process.stdout.write(nodeResult.stdout);

  await writeFile(join(consumer, 'index.html'), '<!doctype html><meta charset="utf-8"><title>DX7 package consumer</title><script type="module" src="/main.js"></script>');
  await writeFile(join(consumer, 'main.js'), `
import { createDX7, createVoiceSysex, createInitVoice } from 'tetorica-msfa-dx7-wasm';
import { createDX7Node } from 'tetorica-msfa-dx7-wasm/browser';
import workletUrl from 'tetorica-msfa-dx7-wasm/worklet?worker&url';
import wasmUrl from 'tetorica-msfa-dx7-wasm/wasm/msfa.wasm?url';
window.startDX7 = async function () {
  const context = new AudioContext();
  const synth = await createDX7Node(context, { workletUrl, wasmUrl });
  await synth.loadSysex(createVoiceSysex(createInitVoice('BUNDLED')));
  synth.node.connect(context.destination);
  synth.noteOn(69, 100);
  return { context, synth };
};
window.renderDX7 = async function () {
  const synth = await createDX7({ wasmUrl });
  await synth.loadSysex(createVoiceSysex(createInitVoice()));
  synth.noteOn(60, 100);
  const pcm = synth.render(1024);
  synth.dispose();
  return pcm;
};
`);
  await build({
    configFile: false,
    root: consumer,
    base: './',
    logLevel: 'warn',
    worker: { format: 'es' },
    build: { target: 'es2022', assetsInlineLimit: 0, outDir: 'dist', rollupOptions: { input: join(consumer, 'index.html') } },
  });
  const outputFiles = await filesWithin(join(consumer, 'dist'));
  const wasm = outputFiles.filter(path => path.endsWith('.wasm'));
  assert.ok(wasm.length > 0, 'Vite must emit the exported WASM asset.');
  for (const path of wasm) assert.deepEqual([...(await readFile(path)).subarray(0, 4)], [0, 97, 115, 109]);
  const javascript = await Promise.all(outputFiles.filter(path => path.endsWith('.js')).map(async path => ({ path, source: await readFile(path, 'utf8') })));
  const processor = javascript.find(file => file.source.includes('registerProcessor') && file.source.includes('tetorica-msfa-dx7'));
  assert.ok(processor, 'Vite must bundle the public Worklet export into its own processor module.');
  assert.ok(processor.source.includes('WebAssembly.instantiate'), 'The bundled processor must contain the WASM core loader.');
  assert.ok(!/from\s*["']\.\/index\.js["']/.test(processor.source), 'The Worklet cannot retain an unbundled private core import.');
  const processorName = processor.path.slice(dirname(processor.path).length + 1);
  assert.ok(javascript.some(file => file.path !== processor.path && file.source.includes(processorName)), 'The consumer must reference the emitted Worklet URL.');
  console.log(`Package consumer passed: ${manifest.name}@${manifest.version}; ${manifest.files.length} packaged files; Node 44100/48000 Hz PCM; Vite public core/browser/worklet/WASM exports.`);
  succeeded = true;
} finally {
  if (succeeded && process.env.DX7_KEEP_PACKAGE_CHECK !== '1') {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`Package-check artifacts retained at ${directory}`);
  }
}
