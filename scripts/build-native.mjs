import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { common, root } from './build-common.mjs';
await mkdir(new URL('../build/', import.meta.url), { recursive: true });
const result = spawnSync(process.env.CXX ?? 'clang++', [
  ...common, 'native/reference.cc', '-o', 'build/dx7-reference',
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Built build/dx7-reference (same scalar MSFA and adapter).');
