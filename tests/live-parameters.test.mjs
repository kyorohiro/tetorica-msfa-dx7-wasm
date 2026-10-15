import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDX7, createInitVoice, createVoiceSysex, createBankSysex} from '../src/index.js';

// All fixtures are made here, without external or factory voice banks.
const steadyEnvelope = {rates:[99,99,99,50], levels:[99,99,99,0]};
const sine = (operator = {}) => ({operators:{1:{envelope:steadyEnvelope, ...operator}}});
const rms = pcm => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}
function assertBounded(pcm) {
  for (const value of pcm) assert(Number.isFinite(value) && Math.abs(value) <= 1);
}
function frequency(pcm, sampleRate) {
  const crossings = [];
  for (let i = 0; i + 1 < pcm.length; i++) {
    if (pcm[i] < 0 && pcm[i + 1] >= 0) crossings.push(i - pcm[i] / (pcm[i + 1] - pcm[i]));
  }
  assert(crossings.length > 5, 'frequency measurement needs an audible periodic signal');
  return (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
}
async function instrument(preset = sine(), sampleRate = 44100) {
  const synth = await createDX7({sampleRate});
  synth.setPreset(preset);
  return synth;
}
async function pair(preset = sine(), sampleRate = 44100) {
  const instances = await Promise.all([instrument(preset, sampleRate), instrument(preset, sampleRate)]);
  return {instances, dispose:() => instances.forEach(synth => synth.dispose())};
}
function baselineVoice() {
  const voice = createInitVoice('LIVE BASE');
  voice[134] = 0; voice[135] = 5; voice[137] = 42; voice[139] = 17; voice[143] = 3;
  for (let i = 0; i < 6; i++) {
    voice[i * 21 + 16] = 60 + i * 4;
    voice[i * 21 + 18] = i + 1;
    voice[i * 21 + 19] = i * 7;
  }
  return voice;
}

for (const sampleRate of [44100, 48000]) {
  test(`no-edit PCM matches the previously released engine at ${sampleRate} Hz`, async () => {
    // Captured from the unmodified 0.2.0 WASM before implementing live editing.
    const expected = {
      44100:'266652374992cb9fca371e047e750ab126f99333cf7fd21583db717fe9480a93',
      48000:'88215a3e6d91822d73e01848e543ef33fe3e6ed3b6aa21b55a78818654dabb80',
    };
    const synth = await createDX7({sampleRate});
    try {
      await synth.loadSysex(createVoiceSysex(baselineVoice()));
      const hash = createHash('sha256');
      for (const [notes, frames] of [[[48,60,67],137], [[72],8179], [[],1013], [null,24003]]) {
        if (notes === null) synth.allNotesOff();
        else for (const note of notes) synth.noteOn(note, 80 + note % 21);
        const pcm = synth.render(frames);
        hash.update(new Uint8Array(pcm.buffer));
      }
      assert.equal(hash.digest('hex'), expected[sampleRate]);
    } finally { synth.dispose(); }
  });

  test(`carrier level can move 0 to 99 to 0 without another Note On at ${sampleRate} Hz`, async () => {
    const synth = await instrument(sine({outputLevel:0}), sampleRate);
    try {
      synth.noteOn(69, 100);
      assert(rms(synth.render(4096)) < 0.00001);
      synth.setOperator(1, {outputLevel:99});
      const raised = synth.render(8192);
      assertBounded(raised);
      assert(rms(raised.subarray(1024)) > 0.05, 'an already-held silent operator must become audible');
      synth.setOperators([[1,{outputLevel:0}]]);
      assert(rms(synth.render(8192).subarray(1024)) < 0.00001, 'the same held note must become silent again');
      synth.noteOff(69);
      synth.render(sampleRate * 3);
      synth.setOperator(1, {outputLevel:99});
      assert(rms(synth.render(4096)) < 0.00001, 'editing a finished release must not resurrect the note');
      synth.panic();
      synth.setOperator(1, {outputLevel:85});
      assert(synth.render(1024).every(value => value === 0), 'panic does not leave an editable sounding voice');
    } finally { synth.dispose(); }
  });

  test(`live carrier levels retain velocity and keyboard scaling at ${sampleRate} Hz`, async () => {
    for (const [note, velocity] of [[35,48], [69,100], [96,120]]) {
      const settings = {outputLevel:85, velocitySensitivity:6,
        keyboardScaling:{breakpoint:45, leftDepth:35, rightDepth:48, leftCurve:0, rightCurve:1}};
      const actual = await instrument(sine(settings), sampleRate);
      const expected = await instrument(sine({...settings, outputLevel:65}), sampleRate);
      try {
        actual.noteOn(note, velocity); expected.noteOn(note, velocity);
        actual.render(8192); expected.render(8192);
        actual.setOperator(1, {outputLevel:65});
        const changed = actual.render(4096), reference = expected.render(4096);
        assert(rms(reference) > 0.00005, 'the reference must remain measurable');
        assert(difference(changed.subarray(512), reference.subarray(512)) < 1 / 32768,
          `live output must match the same patch started at level 65 (note ${note}, velocity ${velocity})`);
      } finally { actual.dispose(); expected.dispose(); }
    }
  });

  test(`a modulator level changes timbre, rather than only final gain, at ${sampleRate} Hz`, async () => {
    // Algorithm 1 routes OP2 into carrier OP1; every other chain is silent.
    const preset = {algorithm:0, operators:{
      1:{outputLevel:75, envelope:steadyEnvelope},
      2:{outputLevel:0, coarse:3, envelope:steadyEnvelope},
    }};
    const {instances:[edited,control], dispose} = await pair(preset, sampleRate);
    try {
      for (const synth of [edited,control]) { synth.noteOn(60,100); synth.render(4096); }
      edited.setOperator(2, {outputLevel:85});
      const modulated = edited.render(8192), plain = control.render(8192);
      assertBounded(modulated);
      assert(difference(modulated.subarray(512), plain.subarray(512)) > rms(plain) * 0.5);
      // A gain-only change preserves this single-frequency sine. Fit its best
      // scalar multiple and require a substantial non-sinusoidal remainder.
      let cross = 0, energy = 0;
      for (let i = 512; i < plain.length; i++) { cross += plain[i] * modulated[i]; energy += plain[i] ** 2; }
      const gain = cross / energy;
      const residual = modulated.subarray(512).map((value, i) => value - gain * plain[i + 512]);
      assert(rms(residual) > rms(modulated) * 0.3, 'operator modulation must introduce harmonic changes');
      edited.setOperator(2, {outputLevel:0});
      assert(difference(edited.render(4096).subarray(512), control.render(4096).subarray(512)) < 1 / 32768,
        'turning the modulator down restores the original carrier without resetting phase');
    } finally { dispose(); }
  });

  test(`ratio, fine, detune and fixed frequency edits retune a held note at ${sampleRate} Hz`, async () => {
    const synth = await instrument(sine(), sampleRate);
    try {
      synth.noteOn(69,100); synth.render(8192);
      const measure = () => frequency(synth.render(sampleRate).subarray(1024), sampleRate);
      assert(Math.abs(measure() - 440) < 1);
      synth.setOperator(1, {coarse:2});
      assert(Math.abs(measure() - 880) < 1.5);
      synth.setOperator(1, {fine:50});
      assert(Math.abs(measure() - 1320) < 2);
      synth.setOperator(1, {detune:14});
      assert(measure() > 1322, 'detune must change the already-held frequency');
      synth.setOperator(1, {mode:'fixed', coarse:2, fine:0, detune:7});
      assert(Math.abs(measure() - 100) < 0.3, 'fixed coarse=2 means 100 Hz, independent of MIDI A4');
      synth.setOperator(1, {coarse:3, fine:0});
      assert(Math.abs(measure() - 1000) < 1.5);
      synth.setOperator(1, {mode:'ratio', coarse:1, fine:0, detune:7});
      assert(Math.abs(measure() - 440) < 1);
      synth.noteOff(69);
      assert(rms(synth.render(sampleRate * 3).subarray(sampleRate * 2)) < 0.00001,
        'retuning must preserve the Note Off identity and release');
    } finally { synth.dispose(); }
  });

  test(`legal extreme frequency edits stay bounded and partition-independent at ${sampleRate} Hz`, async () => {
    const preset = {...sine(), pitchEnvelope:{rates:[99,99,99,99],levels:[99,99,99,99]}};
    const {instances:[whole,split], dispose} = await pair(preset,sampleRate);
    try {
      for (const synth of [whole,split]) synth.noteOn(127,127);
      const parts = [1,63,65,127,1031];
      function render(frames) {
        const expected = whole.render(frames), actual = new Float32Array(frames);
        for (let offset = 0, part = 0; offset < frames; part++) {
          const count = Math.min(parts[part % parts.length],frames - offset);
          split.renderInto(actual.subarray(offset,offset + count)); offset += count;
        }
        assert.deepEqual(actual,expected);
        assertBounded(actual);
        return actual;
      }
      render(137);
      for (const synth of [whole,split]) synth.setOperator(1,{mode:'ratio',coarse:31,fine:99,detune:14});
      const maximum = render(8199);
      assert(rms(maximum) > 0.001, 'extreme valid ratios produce deterministic aliased PCM rather than aborting');
      for (const synth of [whole,split]) synth.setOperator(1,{coarse:30});
      const differentRatio = render(8199);
      assert(difference(maximum.subarray(512),differentRatio.subarray(512)) > 0.001,
        'different above-Nyquist frequencies retain distinct modular phases instead of sharing a frequency clamp');
      for (const synth of [whole,split]) synth.setOperator(1,{mode:'fixed',coarse:31,fine:99,detune:14});
      render(4099); // The output filter may strongly attenuate this high frequency.
      for (const synth of [whole,split]) synth.setOperator(1,{mode:'fixed',coarse:0,fine:0,detune:0});
      const low = render(sampleRate);
      // Fixed 1 Hz plus the captured maximum pitch EG (almost +4 octaves).
      const lowFrequency = frequency(low.subarray(1024),sampleRate);
      assert(lowFrequency > 15 && lowFrequency < 17, 'a held voice can return from an extreme ratio to a low fixed frequency');
      for (const synth of [whole,split]) synth.noteOff(127);
      render(sampleRate * 3);
    } finally { dispose(); }
  });

  test(`empty, identical and invalid operator edits leave sounding PCM exactly unchanged at ${sampleRate} Hz`, async () => {
    const preset = {...sine(), lfo:{speed:67, pitchModDepth:43, pitchModSensitivity:5}};
    const {instances:[edited,control], dispose} = await pair(preset, sampleRate);
    try {
      for (const synth of [edited,control]) synth.noteOn(69,100);
      for (const frames of [137,4099,8192]) {
        assert.deepEqual(edited.render(frames), control.render(frames));
        edited.setOperators([]);
        edited.setOperator(1, {});
        edited.setOperator(1, {outputLevel:85, mode:'ratio', coarse:1, fine:0, detune:7});
        edited.setFeedback(0);
        assert.throws(() => edited.setOperators([[1,{outputLevel:0}], [2,{coarse:32}]]));
        for (const feedback of [-1,8,0.5,NaN,Infinity,'1']) assert.throws(() => edited.setFeedback(feedback));
        // Editing a silent operator must not restart the shared LFO either.
        edited.setOperator(2, {coarse:3, fine:19});
      }
      assert.deepEqual(edited.render(4096), control.render(4096));
    } finally { dispose(); }
  });

  test(`live edits preserve deterministic render partitioning with 16 voices at ${sampleRate} Hz`, async () => {
    const {instances:[whole,split], dispose} = await pair(sine({outputLevel:55}), sampleRate);
    try {
      for (const synth of [whole,split]) for (let note = 48; note < 64; note++) synth.noteOn(note,80 + note % 20);
      const events = [
        [137, synth => synth.setOperator(1,{outputLevel:65})],
        [4099, synth => synth.setOperators([[1,{coarse:2, fine:3, detune:9}], [2,{outputLevel:0}]])],
        [8197, synth => synth.setOperator(1,{mode:'fixed', coarse:2, fine:43})],
        [2399, synth => synth.allNotesOff()],
        [1013, synth => synth.setOperator(1,{outputLevel:45})],
        [sampleRate, () => {}],
      ];
      const pattern = [1,7,63,64,65,127,128,129,1031];
      for (const [frames,event] of events) {
        const expected = whole.render(frames), actual = new Float32Array(frames);
        for (let offset = 0, part = 0; offset < frames; part++) {
          const count = Math.min(pattern[part % pattern.length], frames - offset);
          split.renderInto(actual.subarray(offset, offset + count)); offset += count;
        }
        assert.deepEqual(actual, expected);
        assertBounded(actual);
        event(whole); event(split);
      }
    } finally { dispose(); }
  });

  test(`all 16 active voices receive level edits without changing allocation at ${sampleRate} Hz`, async () => {
    const edited = await instrument(sine({outputLevel:55}), sampleRate);
    const reference = await instrument(sine({outputLevel:65}), sampleRate);
    try {
      for (const synth of [edited,reference]) {
        for (let note = 48; note < 64; note++) synth.noteOn(note,70 + note % 30);
        synth.render(8192);
      }
      edited.setOperator(1,{outputLevel:65});
      edited.noteOn(91,127); // The 17th held voice must still be ignored.
      const actual = edited.render(8192), expected = reference.render(8192);
      assert(rms(expected) > 0.01);
      assert(difference(actual.subarray(512),expected.subarray(512)) < 1 / 32768,
        'every original voice must sound as the corresponding static new-level voice');
      for (const synth of [edited,reference]) { synth.noteOff(48); synth.noteOn(91,127); }
      assert.deepEqual(edited.render(4096),reference.render(4096), 'a released slot remains reusable after edits');
    } finally { edited.dispose(); reference.dispose(); }
  });
}

test('a carrier frequency edit keeps oscillator phase at the next internal block', async () => {
  const {instances:[edited,control], dispose} = await pair();
  try {
    for (const synth of [edited,control]) { synth.noteOn(69,100); synth.render(10240); }
    const unchanged = control.render(64);
    assert(Math.abs(unchanged[0]) > 0.005, 'fixture avoids the zero phase of a restarted oscillator');
    edited.setOperator(1, {coarse:2});
    const changed = edited.render(64);
    assert.equal(changed[0], unchanged[0], 'the first sample uses the retained phase, not phase zero');
    assert(Math.abs(changed[20] - unchanged[20]) > 0.005, 'the frequency must still change within the block');
  } finally { dispose(); }
});

test('an abrupt carrier level rise uses the existing block gain ramp', async () => {
  const synth = await instrument(sine({outputLevel:0}));
  try {
    synth.noteOn(69,100); synth.render(10240);
    synth.setOperator(1,{outputLevel:99});
    const pcm = synth.render(256);
    let largestStep = Math.abs(pcm[0]);
    for (let i = 1; i < pcm.length; i++) largestStep = Math.max(largestStep,Math.abs(pcm[i] - pcm[i - 1]));
    assert(Math.max(...pcm.map(Math.abs)) > 0.1, 'the measurement must reach full-level audio');
    assert(Math.abs(pcm[0]) < 0.005, 'the first sample must not jump directly to full gain');
    assert(largestStep < 0.02, `440 Hz full-level carrier step was ${largestStep}`);
  } finally { synth.dispose(); }
});

test('level edits in attack and release preserve progression rather than retriggering', async () => {
  const preset = sine({envelope:{rates:[35,99,99,35], levels:[99,99,99,0]}});
  const {instances:[edited,control], dispose} = await pair(preset);
  try {
    for (const synth of [edited,control]) { synth.noteOn(69,100); synth.render(22050); }
    edited.setOperator(1,{outputLevel:75});
    const changedAttack = edited.render(4410), attack = control.render(4410);
    assert(rms(changedAttack) > rms(attack) * 0.1, 'the half-completed attack must not restart from silence');
    assert(rms(changedAttack) < rms(attack) * 0.9, 'the level change must affect the running attack');
    for (const synth of [edited,control]) { synth.render(22050); synth.noteOff(69); synth.render(22050); }
    const firstRelease = edited.render(4410);
    control.render(4410);
    edited.setOperator(1,{outputLevel:85});
    const changedRelease = edited.render(4410);
    const laterRelease = edited.render(22050);
    assert(rms(changedRelease) > rms(firstRelease) * 1.2, 'the output level can rise during an active release');
    assert(rms(laterRelease.subarray(-4410)) < rms(changedRelease), 'the release must continue instead of returning to sustain');
    assert(rms(edited.render(44100 * 15).subarray(-4410)) < 0.00001);
  } finally { dispose(); }
});

test('a temporary mute in a slow release does not finish the hidden envelope early', async () => {
  const preset = sine({envelope:{rates:[99,99,99,0], levels:[99,99,99,0]}});
  const {instances:[edited,control], dispose} = await pair(preset);
  try {
    for (const synth of [edited,control]) {
      synth.noteOn(69,100); synth.render(4096); synth.noteOff(69); synth.render(4096);
    }
    edited.setOperator(1,{outputLevel:0});
    const muted = edited.render(8192); control.render(8192);
    assert(rms(muted.subarray(512)) < 0.00001);
    edited.setOperator(1,{outputLevel:85});
    const restored = edited.render(4096).subarray(512), expected = control.render(4096).subarray(512);
    assert(rms(expected) > 0.01, 'the control release is still clearly sounding');
    assert(difference(restored,expected) < 1 / 32768,
      'restoring the level must reveal the still-progressing release at its original phase');
  } finally { dispose(); }
});

test('a temporary mute during attack preserves the progressing attack and held key', async () => {
  const preset = sine({envelope:{rates:[35,99,99,50], levels:[99,99,99,0]}});
  const {instances:[edited,control], dispose} = await pair(preset);
  try {
    for (const synth of [edited,control]) { synth.noteOn(69,100); synth.render(13248); }
    edited.setOperator(1,{outputLevel:0});
    const muted = edited.render(8832); control.render(8832);
    assert(rms(muted.subarray(512)) < 0.00001);
    edited.setOperator(1,{outputLevel:85});
    const restored = edited.render(4410).subarray(512), expected = control.render(4410).subarray(512);
    assert(rms(restored) > rms(expected) * 0.5, 'unmuting a half-completed attack must not restart at silence');
    edited.render(44100);
    assert(rms(edited.render(4096)) > 0.02, 'the held envelope must still reach sustain');
    edited.noteOff(69);
    assert(rms(edited.render(44100 * 3).subarray(-4096)) < 0.00001);
  } finally { dispose(); }
});

test('a small level increase during attack cannot turn into a large volume drop', async () => {
  const preset = sine({envelope:{rates:[35,99,99,50], levels:[99,99,99,0]}});
  const {instances:[edited,control], dispose} = await pair(preset);
  try {
    for (const synth of [edited,control]) { synth.noteOn(69,100); synth.render(13248); }
    edited.setOperator(1,{outputLevel:86});
    const raised = edited.render(4410).subarray(512), original = control.render(4410).subarray(512);
    assert(rms(raised) >= rms(original) * 0.95,
      'raising Output Level by one must retain the current attack amplitude and progression');
    assert(rms(raised) < rms(original) * 1.5, 'a one-step increase must remain a small change');
  } finally { dispose(); }
});

test('edits affect the selected bank cohort, including after switching away and back', async () => {
  const synth = await createDX7(), control = await createDX7();
  try {
    const bank = createBankSysex(Array.from({length:32}, (_, i) => createInitVoice(`COHORT ${i}`)));
    for (const instance of [synth,control]) {
      await instance.loadSysex(bank); instance.noteOn(69,100); instance.render(4096); instance.selectVoice(1);
    }
    synth.setOperator(1,{outputLevel:0, coarse:3});
    assert.deepEqual(synth.render(4096), control.render(4096), 'editing slot 1 cannot change a note started from slot 0');
    for (const instance of [synth,control]) instance.selectVoice(0);
    synth.setOperator(1,{outputLevel:0});
    assert(rms(synth.render(4096).subarray(512)) < 0.00001, 'slot identity survives selection changes');
    assert(rms(control.render(4096)) > 0.001);
  } finally { synth.dispose(); control.dispose(); }
});

test('release tails follow their originating slot when the selected voice changes', async () => {
  const synth = await createDX7(), control = await createDX7();
  try {
    const bank = createBankSysex(Array.from({length:32}, (_, i) => {
      const voice = createInitVoice(`TAIL ${i}`);
      voice[108] = 35; // OP1 R4, leaving enough time to edit a released note.
      return voice;
    }));
    for (const instance of [synth,control]) {
      await instance.loadSysex(bank); instance.noteOn(69,100); instance.render(4096);
      instance.noteOff(69); instance.render(4096); instance.selectVoice(1);
    }
    synth.setOperator(1,{outputLevel:0});
    assert.deepEqual(synth.render(4096),control.render(4096), 'a different slot must not capture an existing release');
    for (const instance of [synth,control]) instance.selectVoice(0);
    synth.setOperator(1,{outputLevel:0});
    assert(rms(synth.render(4096).subarray(512)) < 0.00001, 'the original slot can edit its release tail');
    assert(rms(control.render(4096)) > 0.001);
  } finally { synth.dispose(); control.dispose(); }
});

for (const replacement of ['setPreset','loadSysex']) {
  test(`${replacement} starts a new cohort, leaving old held and release voices untouched`, async () => {
    const {instances:[edited,control], dispose} = await pair();
    try {
      for (const synth of [edited,control]) { synth.noteOn(69,100); synth.render(4096); }
      if (replacement === 'setPreset') edited.setPreset(sine());
      else await edited.loadSysex(createVoiceSysex(createInitVoice('NEW BANK')));
      edited.setOperator(1,{outputLevel:0, coarse:3});
      assert.deepEqual(edited.render(8192), control.render(8192), 'replacement cannot commandeer old voices through a reused slot index');
      edited.noteOff(69); control.noteOff(69);
      edited.setOperator(1,{outputLevel:99, fine:37});
      assert.deepEqual(edited.render(44100), control.render(44100), 'release tails retain their originating cohort');
      edited.panic(); edited.noteOn(72,100);
      assert(rms(edited.render(8192)) > 0.05, 'the edited replacement is used by later notes');
    } finally { dispose(); }
  });
}

test('future-only envelope edits do not replace an already-held envelope during a live level edit', async () => {
  const {instances:[edited,control], dispose} = await pair();
  try {
    for (const synth of [edited,control]) { synth.noteOn(60,100); synth.render(4096); }
    edited.setOperator(1,{outputLevel:75, envelope:{rates:[0,0,0,0], levels:[0,0,0,0]}});
    control.setOperator(1,{outputLevel:75});
    assert.deepEqual(edited.render(8192), control.render(8192));
    edited.noteOff(60); control.noteOff(60);
    assert.deepEqual(edited.render(44100), control.render(44100), 'the captured release rate must remain intact');
  } finally { dispose(); }
});

test('feedback can change a held feedback operator without retriggering its phase', async () => {
  const preset = {algorithm:31, feedback:0, operators:{1:{outputLevel:0},6:{outputLevel:85,envelope:steadyEnvelope}}};
  const {instances:[edited,control], dispose} = await pair(preset);
  try {
    for (const synth of [edited,control]) { synth.noteOn(60,100); synth.render(4096); }
    edited.setFeedback(7);
    const changed = edited.render(8192), plain = control.render(8192);
    assertBounded(changed);
    assert(difference(changed,plain) > rms(plain) * 0.5);
    edited.setFeedback(0);
    assert(difference(edited.render(4096).subarray(512), control.render(4096).subarray(512)) < 1 / 32768);
    assert.equal(edited.getPreset().feedback, 0);
    assert.throws(() => edited.setFeedback(8));
    assert.throws(() => edited.setFeedback(NaN));
  } finally { dispose(); }
});
