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
if (!available && process.env.DX7_REQUIRE_NATIVE === '1') {
  throw new Error('Build the native reference first: npm run build:native');
}

for (const [label, fm, editAt, entries, feedback] of [
  ['held carrier output level', false, 4099, [[1, { outputLevel: 63 }]], undefined],
  ['held ratio, fixed frequency, detune and feedback', true, 4099, [
    [1, { coarse: 2, fine: 23, detune: 10 }],
    [2, { mode: 'fixed', coarse: 2, fine: 17, detune: 8, outputLevel: 74 }],
  ], 3],
  ['output level in an existing release tail', false, 15011, [[1, { outputLevel: 70 }]], undefined],
  ['extreme valid ratio with positive pitch envelope', 'extreme', 4099,
    [[1, { coarse: 31, fine: 99, detune: 14 }]], undefined],
]) {
  test(`live native and WASM PCM comparison: ${label}`, {
    skip: available ? false : 'native reference has not been built',
  }, async t => {
    const voice = createInitVoice('LIVE PCM');
    voice[3 + 5 * 21] = 0; // Slow release keeps the tail audible at the edit.
    const note = fm === 'extreme' ? 127 : 69;
    if (fm === 'extreme') voice.fill(99, 130, 134);
    if (fm === true) {
      voice[134] = 0;
      voice[135] = 7;
      for (let wire = 0; wire < 6; ++wire) {
        voice[wire * 21 + 16] = 65 + wire * 3;
        voice[wire * 21 + 18] = wire + 1;
      }
    }
    const changed = new Uint8Array(voice);
    const byteIndex = { outputLevel: 16, mode: 17, coarse: 18, fine: 19, detune: 20 };
    for (const [op, values] of entries) {
      for (const [name, value] of Object.entries(values)) {
        changed[(6 - op) * 21 + byteIndex[name]] = name === 'mode' ? Number(value === 'fixed') : value;
      }
    }
    if (feedback !== undefined) changed[135] = feedback;
    const directory = await mkdtemp(join(tmpdir(), 'tetorica-dx7-live-reference-'));
    let synth;
    try {
      const voicePath = join(directory, 'initial.bin');
      const editPath = join(directory, 'edited.bin');
      await Promise.all([writeFile(voicePath, voice), writeFile(editPath, changed)]);
      const total = 22050;
      const offAt = 11039;
      const native = spawnSync(reference, [voicePath, String(total), String(note), String(offAt), editPath, String(editAt)], {
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
      const events = [
        [offAt, () => synth.noteOff(note)],
        [editAt, () => {
          synth.setOperators(entries);
          if (feedback !== undefined) synth.setFeedback(feedback);
        }],
        [total, () => {}],
      ].sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [at, apply] of events) {
        wasm.set(synth.render(at - cursor), cursor);
        apply();
        cursor = at;
      }
      let maxDifference = 0;
      let sum = 0;
      let peakAfterEdit = 0;
      for (let frame = 0; frame < total; ++frame) {
        const difference = Math.abs(wasm[frame] - nativeView.getFloat32(frame * 4, true));
        maxDifference = Math.max(maxDifference, difference);
        sum += difference * difference;
        if (frame > editAt + 128) peakAfterEdit = Math.max(peakAfterEdit, Math.abs(wasm[frame]));
      }
      const rms = Math.sqrt(sum / total);
      t.diagnostic(`edit@${editAt}, NoteOff@${offAt}; max=${maxDifference}; RMS=${rms}; post-edit peak=${peakAfterEdit}`);
      assert.ok(peakAfterEdit > 0.001, 'comparison includes audible live-edited output');
      assert.ok(maxDifference <= 1 / 32768, 'native/WASM live PCM differs by more than one Int16 LSB');
      assert.ok(rms <= 1 / 32768);
    } finally {
      synth?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
