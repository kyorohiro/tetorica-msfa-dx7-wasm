import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createDX7,createInitVoice} from '../src/index.js';

// Reproducible offline throughput probe, not an AudioWorklet deadline test.
// No timing assertion: machines, CPU power modes and concurrent work vary.
const seconds = Number(process.argv[2] ?? 10);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new RangeError('Duration must be > 0 and <= 120 seconds.');
const repeats = 5;
const sampleRate = 44100;
const buffer = new Float32Array(1024);
const envelope = {rates:[99,99,99,60],levels:[99,99,99,0]};
const median = values => [...values].sort((a,b) => a - b)[Math.floor(values.length / 2)];

async function measure(updatesPerSecond) {
  const synth = await createDX7({sampleRate});
  try {
    synth.setPreset({algorithm:0,operators:{
      1:{outputLevel:50,envelope}, 2:{outputLevel:60,coarse:2,envelope},
      3:{outputLevel:50,envelope}, 4:{outputLevel:60,coarse:3,envelope},
      5:{outputLevel:50,envelope}, 6:{outputLevel:60,coarse:4,envelope},
    }});
    for (let note = 48; note < 64; note++) synth.noteOn(note,80 + note % 30);
    synth.renderInto(buffer); // Exclude initial attack and WASM initialization.
    const total = Math.round(seconds * sampleRate);
    let updates = 0, rendered = 0, peak = 0;
    let updateAt = updatesPerSecond ? Math.round(sampleRate / updatesPerSecond) : Infinity;
    const started = performance.now();
    while (rendered < total) {
      if (rendered === updateAt) {
        const progress = updates / updatesPerSecond;
        const level = Math.round(55 + 15 * Math.sin(progress * Math.PI));
        synth.setOperators([[2,{outputLevel:level,fine:updates % 100}], [4,{outputLevel:level}], [6,{outputLevel:level,detune:updates % 15}]]);
        synth.setFeedback(updates % 8);
        updates++;
        updateAt = Math.round((updates + 1) * sampleRate / updatesPerSecond);
      }
      const count = Math.min(buffer.length,total - rendered,updateAt - rendered);
      const target = count === buffer.length ? buffer : buffer.subarray(0,count);
      synth.renderInto(target);
      for (let i = 0; i < count; i++) peak = Math.max(peak,Math.abs(buffer[i]));
      rendered += count;
    }
    const milliseconds = performance.now() - started;
    assert(Number.isFinite(peak) && peak > 0 && peak <= 1);
    return {milliseconds,updates,peak};
  } finally { synth.dispose(); }
}

// Warm up each path before comparing repeated, interleaved runs.
for (const rate of [0,60,240]) await measure(rate);
const results = new Map([0,60,240].map(rate => [rate,[]]));
for (let round = 0; round < repeats; round++) {
  const rates = round % 2 ? [240,60,0] : [0,60,240];
  for (const rate of rates) results.get(rate).push(await measure(rate));
}
const baseline = median(results.get(0).map(result => result.milliseconds));
let engineComparison;
if (process.argv[3]) {
  // Optional comparison with an archived, unmodified WASM. Both modules expose
  // the old dx7_set_voice API, so this path does not depend on old JavaScript.
  const [before,after] = await Promise.all([
    readFile(process.argv[3]), readFile(new URL('../wasm/msfa.wasm',import.meta.url)),
  ]);
  async function directRender(bytes) {
    const abort = () => { throw new Error('Benchmark WASM aborted.'); };
    const {instance:{exports:api}} = await WebAssembly.instantiate(bytes,{
      env:{abort},wasi_snapshot_preview1:{proc_exit:abort},
    });
    api._initialize?.();
    const handle = api.dx7_create();
    try {
      const voice = createInitVoice('PERF BASE');
      voice[134] = 0;
      for (let op = 0; op < 6; op++) {
        voice[op * 21 + 3] = 60;
        voice[op * 21 + 16] = op % 2 ? 50 : 60;
        voice[op * 21 + 18] = op + 1;
      }
      new Uint8Array(api.memory.buffer,api.dx7_voice_ptr(handle),155).set(voice);
      api.dx7_set_voice(handle);
      for (let note = 48; note < 64; note++) api.dx7_note_on(handle,note,80 + note % 30);
      api.dx7_render(handle,1024);
      const started = performance.now();
      for (let remaining = Math.round(seconds * sampleRate); remaining > 0;) {
        const count = Math.min(1024,remaining); api.dx7_render(handle,count); remaining -= count;
      }
      const milliseconds = performance.now() - started;
      const pcm = new Float32Array(api.memory.buffer,api.dx7_output_ptr(handle),1024);
      assert(pcm.some(value => Math.abs(value) > 0.0001));
      return milliseconds;
    } finally { api.dx7_destroy(handle); }
  }
  await directRender(before); await directRender(after);
  const oldRuns = [],newRuns = [];
  for (let round = 0; round < repeats; round++) {
    if (round % 2) { newRuns.push(await directRender(after)); oldRuns.push(await directRender(before)); }
    else { oldRuns.push(await directRender(before)); newRuns.push(await directRender(after)); }
  }
  const oldMedian = median(oldRuns), newMedian = median(newRuns);
  engineComparison = {scope:'Direct WASM no-edit rendering of 16 six-operator voices; excludes JS PCM scanning',
    oldMedianMilliseconds:oldMedian,newMedianMilliseconds:newMedian,
    changeVsOldPercent:(newMedian / oldMedian - 1) * 100,
    oldRealtimeCpuPercent:oldMedian / (seconds * 10),newRealtimeCpuPercent:newMedian / (seconds * 10)};
}
console.log(JSON.stringify({
  node:process.version,platform:process.platform,architecture:process.arch,
  sampleRate,seconds,voices:16,repeats,scope:'offline WASM + JS, three operators and feedback per update; excludes Worklet message/OS audio scheduling',
  measurements:[...results].map(([updatesPerSecond,runs]) => {
    const milliseconds = median(runs.map(result => result.milliseconds));
    return {updatesPerSecond,updates:runs[0].updates,medianMilliseconds:milliseconds,
      minMilliseconds:Math.min(...runs.map(result => result.milliseconds)),
      maxMilliseconds:Math.max(...runs.map(result => result.milliseconds)),
      realtimeCpuPercent:milliseconds / (seconds * 10),
      changeVsBaselinePercent:(milliseconds / baseline - 1) * 100,
      peak:Math.max(...runs.map(result => result.peak))};
  }),
  engineComparison,
},null,2));
