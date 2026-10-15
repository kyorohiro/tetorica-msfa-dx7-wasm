import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { common, root } from './build-common.mjs';
await mkdir(new URL('../wasm/', import.meta.url), { recursive: true });
const exports = [
  'dx7_create', 'dx7_destroy', 'dx7_voice_ptr', 'dx7_set_voice', 'dx7_output_ptr',
  'dx7_note_on', 'dx7_note_off', 'dx7_all_notes_off', 'dx7_panic', 'dx7_render',
];
const result = spawnSync(process.env.EMXX ?? 'em++', [
  ...common, '--no-entry', '-sSTANDALONE_WASM=1', '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=0', '-sINITIAL_MEMORY=16777216', '-sSTACK_SIZE=1048576',
  '-sSUPPORT_LONGJMP=0', '-sDISABLE_EXCEPTION_CATCHING=1',
  `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map(name => '_' + name))}`,
  '-o', 'wasm/msfa.wasm',
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Built wasm/msfa.wasm (fixed 44,100 Hz, scalar MSFA).');
