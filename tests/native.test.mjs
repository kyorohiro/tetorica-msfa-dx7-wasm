import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDX7, createInitVoice, createVoiceSysex } from '../src/index.js';

const reference = fileURLToPath(new URL('../build/dx7-reference', import.meta.url));
const available = existsSync(reference);
if (!available && process.env.DX7_REQUIRE_NATIVE === '1') throw new Error('Build the native reference first: npm run build:native');

function fmVoice() {
  const voice = createInitVoice('OUR FM');
  voice[134] = 0;
  voice[135] = 7;
  voice[137] = 42;
  voice[139] = 17;
  voice[140] = 9;
  voice[143] = 3;
  for (let op = 0; op < 6; op++) {
    const start = op * 21;
    voice[start + 16] = 65 + op * 4;
    voice[start + 18] = op + 1;
    voice[start + 19] = op * 7;
    voice[start + 14] = op % 4;
  }
  return voice;
}

for (const [label, voice, note, offAt] of [
  ['clean one-carrier sine', createInitVoice(), 69, 22037],
  ['six operators, feedback and LFO', fmVoice(), 57, 11039],
]) {
  test(`native and WASM PCM comparison: ${label}`, { skip: available ? false : 'native reference has not been built' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tetorica-dx7-reference-'));
    const voicePath = join(directory, 'own-voice.bin');
    const total = 44100;
    let synth;
    try {
      await writeFile(voicePath, voice);
      const native = spawnSync(reference, [voicePath, String(total), String(note), String(offAt)], {
        maxBuffer: total * 4 + 1024 * 1024,
      });
      if (native.error) throw native.error;
      assert.equal(native.status, 0, native.stderr.toString());
      assert.equal(native.stdout.length, total * 4);
      const nativeView = new DataView(native.stdout.buffer, native.stdout.byteOffset, native.stdout.byteLength);
      synth = await createDX7({ sampleRate: 44100 });
      await synth.loadSysex(createVoiceSysex(voice));
      synth.noteOn(note, 100);
      const wasm = new Float32Array(total);
      wasm.set(synth.render(offAt));
      synth.noteOff(note);
      wasm.set(synth.render(total - offAt), offAt);
      let maxDifference = 0;
      let squaredDifference = 0;
      let peak = 0;
      for (let i = 0; i < total; i++) {
        const expected = nativeView.getFloat32(i * 4, true);
        const difference = Math.abs(wasm[i] - expected);
        maxDifference = Math.max(maxDifference, difference);
        squaredDifference += difference * difference;
        peak = Math.max(peak, Math.abs(wasm[i]));
      }
      const rmsDifference = Math.sqrt(squaredDifference / total);
      t.diagnostic(`44100 Hz mono Float32; ${total} frames; off@${offAt}; max=${maxDifference}; RMS=${rmsDifference}; peak=${peak}`);
      assert.ok(peak > 0.001, 'comparison must contain actual sound');
      // Both builds use the same scalar core, adapter, and fixed internal rate.
      // One 16-bit LSB allows platform LUT rounding; report the exact measured error.
      assert.ok(maxDifference <= 1 / 32768, `native/WASM maximum error ${maxDifference} exceeds one Int16 LSB`);
      assert.ok(rmsDifference <= 1 / 32768, `native/WASM RMS error ${rmsDifference} exceeds one Int16 LSB`);
    } finally {
      synth?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
