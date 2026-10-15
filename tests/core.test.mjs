import test from 'node:test';
import assert from 'node:assert/strict';
import { createDX7, createInitVoice, createVoiceSysex, createBankSysex, INTERNAL_SAMPLE_RATE } from '../src/index.js';

async function instrument(sampleRate = 44100, voice = createInitVoice()) {
  const synth = await createDX7({ sampleRate });
  await synth.loadSysex(createVoiceSysex(voice));
  return synth;
}

function rms(data, start = 0, end = data.length) {
  let energy = 0;
  for (let i = start; i < end; i++) energy += data[i] * data[i];
  return Math.sqrt(energy / (end - start));
}

function appendParts(synth, output, offset, count, pattern) {
  let index = 0;
  while (count > 0) {
    const take = Math.min(count, pattern[index++ % pattern.length]);
    output.set(synth.render(take), offset);
    count -= take;
    offset += take;
  }
  return offset;
}

test('note-on immediately following load produces bounded mono Float32 PCM', async () => {
  const synth = await instrument();
  try {
    assert.equal(INTERNAL_SAMPLE_RATE, 44100);
    assert.equal(synth.sampleRate, 44100);
    assert.equal(synth.internalSampleRate, 44100);
    assert.deepEqual(synth.voices, [{ index: 0, name: 'INIT SINE' }]);
    assert.equal(synth.selectedVoice, 0);
    synth.noteOn(69, 100);
    const pcm = synth.render(8192);
    assert.ok(pcm instanceof Float32Array);
    assert.equal(pcm.length, 8192);
    assert.ok(rms(pcm) > 0.001, 'the loaded voice must be audible');
    for (const value of pcm) assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
  } finally { synth.dispose(); }
});

for (const sampleRate of [44100, 48000]) {
  test(`render partitioning preserves PCM and event positions at ${sampleRate} Hz`, async () => {
    const whole = await instrument(sampleRate);
    const split = await instrument(sampleRate);
    try {
      const a = new Float32Array(30017);
      const b = new Float32Array(a.length);
      let offset = 0;
      const sections = [
        { count: 137, event: synth => synth.noteOn(69, 100) },
        { count: 3997, event: synth => synth.noteOn(64, 87) },
        { count: 7403, event: synth => synth.noteOff(69) },
        { count: 18480, event: synth => synth.allNotesOff() },
      ];
      for (const { count, event } of sections) {
        event(whole);
        event(split);
        a.set(whole.render(count), offset);
        appendParts(split, b, offset, count, [1, 7, 63, 64, 65, 127, 128, 129, 511, 1024, 1031]);
        offset += count;
      }
      assert.equal(offset, a.length);
      assert.deepEqual(b, a);
    } finally { whole.dispose(); split.dispose(); }
  });

  test(`renderInto and render agree, preserve caller boundaries and retained buffers at ${sampleRate} Hz`, async () => {
    const a = await instrument(sampleRate);
    const b = await instrument(sampleRate);
    try {
      a.noteOn(60, 97);
      b.noteOn(60, 97);
      assert.equal(a.render(0).length, 0);
      a.renderInto(new Float32Array(0));
      const expected = b.render(4099);
      const backing = new Float32Array(4103).fill(123);
      const target = backing.subarray(2, 4101);
      a.renderInto(target);
      assert.deepEqual(target, expected);
      assert.deepEqual([...backing.subarray(0, 2)], [123, 123]);
      assert.deepEqual([...backing.subarray(4101)], [123, 123]);
      const retained = a.render(257);
      const snapshot = retained.slice();
      assert.deepEqual(retained, b.render(257));
      a.render(9000);
      a.panic();
      a.dispose();
      assert.deepEqual(retained, snapshot);
    } finally { a.dispose(); b.dispose(); }
  });

  test(`panic clears held voices, release tails, and buffered PCM immediately at ${sampleRate} Hz`, async () => {
    const synth = await instrument(sampleRate);
    try {
      synth.noteOn(60);
      assert.ok(rms(synth.render(137)) > 0);
      synth.panic();
      assert.ok(synth.render(2051).every(value => value === 0));
      synth.noteOn(67);
      assert.ok(rms(synth.render(1024)) > 0.001);
    } finally { synth.dispose(); }
  });
}

test('output resampling preserves A4 pitch and envelope duration at both output rates', async () => {
  const measurements = [];
  for (const sampleRate of [44100, 48000]) {
    const voice = createInitVoice();
    voice[108] = 55; // OP1 release rate; deliberately long enough to measure.
    const synth = await instrument(sampleRate, voice);
    try {
      synth.noteOn(69, 100);
      const held = synth.render(Math.round(sampleRate * 1.25));
      const crossings = [];
      for (let i = Math.round(sampleRate * 0.25); i < held.length - 1; i++) {
        if (held[i] < 0 && held[i + 1] >= 0) crossings.push(i + (-held[i] / (held[i + 1] - held[i])));
      }
      assert.ok(crossings.length > 400);
      const frequency = (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
      assert.ok(Math.abs(frequency - 440) < 1, `A4 is ${frequency.toFixed(4)} Hz at ${sampleRate} Hz output`);
      const steady = rms(held, Math.floor(held.length / 2));
      synth.noteOff(69);
      const released = synth.render(sampleRate * 3);
      const window = Math.round(sampleRate * 0.01);
      let releaseSeconds = null;
      for (let start = 0; start + window <= released.length; start += window) {
        if (rms(released, start, start + window) < steady * 0.1) {
          releaseSeconds = start / sampleRate;
          break;
        }
      }
      assert.notEqual(releaseSeconds, null, 'release envelope must decay');
      measurements.push({ frequency, releaseSeconds });
    } finally { synth.dispose(); }
  }
  assert.ok(Math.abs(measurements[0].frequency - measurements[1].frequency) < 0.05);
  assert.ok(Math.abs(measurements[0].releaseSeconds - measurements[1].releaseSeconds) <= 0.02,
    `release seconds differ: ${JSON.stringify(measurements)}`);
});

test('note-off decays and repeated same-pitch note-off releases all matching held voices', async () => {
  const noteOff = await instrument();
  const allOff = await instrument();
  try {
    for (const synth of [noteOff, allOff]) {
      synth.noteOn(60, 100);
      synth.render(509);
      synth.noteOn(60, 90);
    }
    const held = noteOff.render(5000);
    assert.deepEqual(held, allOff.render(5000));
    noteOff.noteOff(60);
    allOff.allNotesOff();
    const release = noteOff.render(44100);
    assert.deepEqual(release, allOff.render(44100));
    assert.ok(rms(release, 0, 1024) > 0, 'All Notes Off uses a release envelope');
    assert.ok(rms(release, 33075) < rms(held) * 0.01, 'both matching voices finish releasing');
  } finally { noteOff.dispose(); allOff.dispose(); }
});

test('polyphony is audible and the seventeenth simultaneously held note is ignored', async () => {
  const voice = createInitVoice();
  voice[121] = 55; // Quiet OP1 keeps the 16-note comparison below clipping.
  const sixteen = await instrument(44100, voice);
  const seventeen = await instrument(44100, voice);
  const single = await instrument(44100, voice);
  try {
    for (let note = 48; note < 64; note++) {
      sixteen.noteOn(note, 100);
      seventeen.noteOn(note, 100);
    }
    seventeen.noteOn(91, 127);
    single.noteOn(48, 100);
    const expected = sixteen.render(8192);
    assert.deepEqual(seventeen.render(8192), expected);
    assert.ok(rms(expected) > rms(single.render(8192)) * 1.5, 'multiple voices contribute PCM');
    sixteen.noteOff(48);
    seventeen.noteOff(48);
    sixteen.noteOn(91, 127);
    seventeen.noteOn(91, 127);
    assert.deepEqual(sixteen.render(8192), seventeen.render(8192), 'released slots become eligible again');
  } finally { sixteen.dispose(); seventeen.dispose(); single.dispose(); }
});

test('creating, rendering, selecting and disposing another rate/voice instance cannot change active PCM', async () => {
  const active = await instrument(48000);
  const control = await instrument(48000);
  let other;
  try {
    active.noteOn(67, 91);
    control.noteOn(67, 91);
    assert.deepEqual(active.render(137), control.render(137));
    const voice = createInitVoice('OTHER');
    voice[123] = 4;
    voice[135] = 7;
    other = await instrument(44100, voice);
    other.noteOn(25, 127);
    other.render(17003);
    assert.deepEqual(active.render(13001), control.render(13001));
    other.panic();
    other.dispose();
    assert.deepEqual(active.render(5309), control.render(5309));
    active.noteOff(67);
    control.noteOff(67);
    assert.deepEqual(active.render(48000), control.render(48000));
  } finally { active.dispose(); control.dispose(); other?.dispose(); }
});

test('malformed bank load is atomic and cannot replace a usable bank or selected voice', async () => {
  const synth = await createDX7();
  try {
    const voices = Array.from({ length: 32 }, (_, i) => createInitVoice(`OUR ${i}`));
    await synth.loadSysex(createBankSysex(voices));
    synth.selectVoice(15);
    const bad = createVoiceSysex(createInitVoice('BAD'));
    bad[6] ^= 1;
    await assert.rejects(synth.loadSysex(bad), /checksum/);
    assert.equal(synth.selectedVoice, 15);
    assert.equal(synth.voices.length, 32);
    assert.equal(synth.voices[15].name, 'OUR 15');
    synth.noteOn(60);
    assert.ok(rms(synth.render(4096)) > 0.001);
    const info = synth.voices;
    info[15].name = 'changed outside';
    info.pop();
    assert.equal(synth.voices[15].name, 'OUR 15');
    assert.equal(synth.voices.length, 32);
  } finally { synth.dispose(); }
});

test('voice selection affects subsequent notes while previously held voices continue', async () => {
  const changed = await createDX7();
  const control = await instrument();
  try {
    const quiet = createInitVoice('QUIET');
    quiet[121] = 0;
    await changed.loadSysex(createBankSysex([createInitVoice(), quiet, ...Array.from({ length: 30 }, () => createInitVoice())]));
    changed.noteOn(60);
    control.noteOn(60);
    assert.deepEqual(changed.render(1024), control.render(1024));
    changed.selectVoice(1);
    assert.equal(changed.selectedVoice, 1);
    assert.deepEqual(changed.render(1024), control.render(1024), 'held notes retain their original patch');
    changed.panic();
    changed.noteOn(72);
    assert.ok(rms(changed.render(4096)) < 0.0002, 'next note uses selected quiet voice');
  } finally { changed.dispose(); control.dispose(); }
});

test('invalid inputs fail explicitly and disposed instances cannot restart', async () => {
  for (const sampleRate of [0, 22050, 44101, 96000, NaN, Infinity, '44100']) {
    await assert.rejects(createDX7({ sampleRate }), /sampleRate/);
  }
  await assert.rejects(createDX7({ wasmBytes: 'invalid' }), /wasmBytes/);
  const synth = await instrument();
  try {
    for (const frames of [-1, 0.5, NaN, Infinity, '1', 16 * 1024 * 1024 + 1]) assert.throws(() => synth.render(frames), /Frame count/);
    for (const note of [-1, 128, 0.5, NaN, Infinity, '60']) {
      assert.throws(() => synth.noteOn(note), /MIDI note/);
      assert.throws(() => synth.noteOff(note), /MIDI note/);
    }
    for (const velocity of [-1, 128, 0.5, NaN, Infinity]) assert.throws(() => synth.noteOn(60, velocity), /Velocity/);
    for (const output of [[], new Float64Array(128), new Uint8Array(128), null]) assert.throws(() => synth.renderInto(output), /Float32Array/);
    for (const index of [-1, 1, 0.5, NaN]) assert.throws(() => synth.selectVoice(index), /Voice index/);
    synth.noteOn(60);
    synth.noteOn(60, 0);
    synth.dispose();
    synth.dispose();
    for (const call of [() => synth.noteOn(60), () => synth.noteOff(60), () => synth.allNotesOff(), () => synth.panic(), () => synth.selectVoice(0), () => synth.render(0), () => synth.renderInto(new Float32Array(0))]) {
      assert.throws(call, /disposed/);
    }
    await assert.rejects(synth.loadSysex(createVoiceSysex(createInitVoice())), /disposed/);
  } finally { synth.dispose(); }
});
