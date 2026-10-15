// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { common, root } from './build-common.mjs';

await mkdir(new URL('../build/', import.meta.url), { recursive: true });
const executable = fileURLToPath(new URL(
  `../build/dx7-live${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url,
));
for (const [command, args] of [
  [process.env.CXX ?? 'clang++', [...common, 'native/live.cc', '-o', executable]],
  [executable, []],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const bounds = fileURLToPath(new URL(
  `../build/dx7-frequency-bounds${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url,
));
for (const [command, args] of [
  [process.env.CXX ?? 'clang++', [
    ...common, '-fsanitize=shift', '-fno-sanitize-recover=shift',
    'native/frequency_bounds.cc', '-o', bounds,
  ]],
  [bounds, []],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
