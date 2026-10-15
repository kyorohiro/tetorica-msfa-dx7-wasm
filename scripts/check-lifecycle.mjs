// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { common, root } from './build-common.mjs';

await mkdir(new URL('../build/', import.meta.url), { recursive: true });
const executable = fileURLToPath(new URL(
  `../build/dx7-lifecycle${process.platform === 'win32' ? '.exe' : ''}`,
  import.meta.url,
));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.env.CXX ?? 'clang++', [
  ...common, '-O1', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
  'native/lifecycle.cc', '-o', executable,
]);
// Apple ASAN has no supported leak detector. The test's allocation counter
// checks native ownership on all platforms; Linux also keeps normal LSan.
const env = process.platform === 'darwin' ? {
  ...process.env,
  ASAN_OPTIONS: [process.env.ASAN_OPTIONS, 'detect_leaks=0'].filter(Boolean).join(':'),
} : process.env;
run(executable, [], env);
