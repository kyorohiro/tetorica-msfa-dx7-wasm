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
    'src/sysex.js', 'src/sysex.d.ts', 'src/preset.js', 'src/preset.d.ts', 'src/dx7-worklet.js', 'wasm/msfa.wasm',
    'README.md', 'README.ja.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/msfa/COPYING', 'vendor/msfa/UPSTREAM.md', 'docs/research.md']) {
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
    synth.panic();
    synth.setPreset({name:'OBJECT', operators:{1:{outputLevel:85}}});
    synth.setOperator(1, {coarse:2});
    synth.setOperators([[1,{fine:0}], [6,{outputLevel:0}]]);
    const preset = synth.getPreset();
    assert.equal(preset.name, 'OBJECT');
    assert.equal(preset.operators[1].coarse, 2);
    assert.equal(preset.operators[1].fine, 0);
    assert.equal(preset.operators[6].outputLevel, 0);
    assert.throws(() => synth.setOperators([[1,{fine:99}], [6,{fine:100}]]));
    assert.deepEqual(synth.getPreset(), preset, 'Invalid object batches preserve the installed core');
    preset.operators[1].fine = 99;
    assert.equal(synth.getPreset().operators[1].fine, 0, 'Installed getPreset returns a copy');
    synth.noteOn(69, 100);
    const objectPcm = synth.render(4096);
    let objectSquare = 0;
    for (const value of objectPcm) { assert.ok(Number.isFinite(value) && value >= -1 && value <= 1); objectSquare += value * value; }
    assert.ok(Math.sqrt(objectSquare / objectPcm.length) > 0.001, 'Installed object preset must render actual sound');
    console.log(JSON.stringify({ sampleRate, frames: pcm.length, rms }));
  } finally { synth.dispose(); }
}
`);
  const nodeResult = await command(process.execPath, ['check-node.mjs'], consumer);
  process.stdout.write(nodeResult.stdout);

  await writeFile(join(consumer, 'check-types.ts'), `
import {createDX7, type DX7Preset, type DX7OperatorParams, type DX7OperatorEntries, type DX7PresetState} from 'tetorica-msfa-dx7-wasm';
import {createDX7Node, type DX7Node} from 'tetorica-msfa-dx7-wasm/browser';
const patch: DX7OperatorParams = {outputLevel:85, envelope:{rates:[99,99,99,70] as const}};
const preset: DX7Preset = {name:'TYPED', operators:{1:patch}};
const edits: DX7OperatorEntries = [[1,patch], [6,{outputLevel:0}]] as const;
async function checkCoreAndBrowser() {
  const core = await createDX7();
  const synchronous: void = core.setPreset(preset);
  core.setOperator(1, patch);
  core.setOperators(edits);
  const synchronousFeedback: void = core.setFeedback(5);
  const coreState: DX7PresetState = core.getPreset();
  const browser: DX7Node = await createDX7Node(new AudioContext());
  const applied: Promise<void> = browser.setPreset(preset);
  await applied;
  await browser.setOperator(1, patch);
  await browser.setOperators(edits);
  const feedbackApplied: Promise<void> = browser.setFeedback(5);
  await feedbackApplied;
  const browserState: DX7PresetState = await browser.getPreset();
  // @ts-expect-error Logical operator labels are 1..6.
  browser.setOperator(0, patch);
  // @ts-expect-error A batch uses tuples rather than an operator record.
  core.setOperators({1:patch});
  // @ts-expect-error Unknown preset fields are rejected.
  browser.setPreset({unknown:true});
  // @ts-expect-error Feedback is a DX7 integer number.
  browser.setFeedback('5');
  void synchronous; void synchronousFeedback; void coreState; void browserState;
}
void checkCoreAndBrowser;
`);
  await command(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', '--skipLibCheck', 'false', 'check-types.ts'], consumer);

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
  await synth.setPreset({name:'OBJECT', operators:{1:{outputLevel:85}}});
  await synth.setOperator(1, {coarse:2});
  await synth.setOperators([[1,{fine:0}], [6,{outputLevel:0}]]);
  const preset = await synth.getPreset();
  if (preset.name !== 'OBJECT' || preset.operators[1].coarse !== 2) throw new Error('Bundled object API did not apply');
  synth.node.connect(context.destination);
  synth.noteOn(69, 100);
  return { context, synth };
};
window.renderDX7 = async function () {
  const synth = await createDX7({ wasmUrl });
  await synth.loadSysex(createVoiceSysex(createInitVoice()));
  synth.setPreset({name:'OFFLINE'});
  synth.setOperators([[1,{outputLevel:85}]]);
  if (synth.getPreset().name !== 'OFFLINE') throw new Error('Bundled core object API did not apply');
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
  // Vite can emit both the browser API's raw default-URL asset and the explicit
  // ?worker&url bundled entry. Select by contents, not hash-dependent file order.
  const processors = javascript.filter(file => file.source.includes('registerProcessor') && file.source.includes('tetorica-msfa-dx7'));
  const processor = processors.find(file => file.source.includes('WebAssembly.instantiate'));
  assert.ok(processor, 'Vite must bundle the public Worklet export together with the WASM core loader.');
  assert.ok(!/from\s*["']\.\/index\.js["']/.test(processor.source), 'The Worklet cannot retain an unbundled private core import.');
  const processorName = processor.path.slice(dirname(processor.path).length + 1);
  assert.ok(javascript.some(file => file.path !== processor.path && file.source.includes(processorName)), 'The consumer must reference the emitted Worklet URL.');
  console.log(`Package consumer passed: ${manifest.name}@${manifest.version}; ${manifest.files.length} packaged files; Node 44100/48000 Hz SysEx/object PCM; strict public core/browser types; Vite public core/browser/worklet/WASM exports.`);
  succeeded = true;
} finally {
  if (succeeded && process.env.DX7_KEEP_PACKAGE_CHECK !== '1') {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`Package-check artifacts retained at ${directory}`);
  }
}
