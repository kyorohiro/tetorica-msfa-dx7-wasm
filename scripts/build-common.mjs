import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const sources = [
  'dx7note', 'env', 'exp2', 'fm_core', 'fm_op_kernel', 'freqlut', 'lfo',
  'patch', 'pitchenv', 'resofilter', 'ringbuffer', 'sin', 'synth_unit',
].map(name => `vendor/msfa/${name}.cc`);
export const common = [
  '-std=c++17', '-O2', '-DMSFA_FORCE_SCALAR', '-fwrapv', '-fno-strict-aliasing',
  '-ffp-contract=off', '-Ivendor/msfa', '-Inative', 'native/dx7.cc', ...sources,
];
