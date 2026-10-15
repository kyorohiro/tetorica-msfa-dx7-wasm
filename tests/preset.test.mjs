import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createDX7, createInitVoice, createVoiceSysex, createBankSysex} from '../src/index.js';
import {presetToVoice, voiceToPreset} from '../src/preset.js';

// Independently specified VCED rows in wire order OP6..OP1. Every operator
// parameter and common parameter is non-default, including the pitch EG.
const operatorRows = [
  [76,66,56,46,84,74,64,54,36,26,16,2,3,6,2,1,86,0,8,9,10],
  [75,65,55,45,85,75,65,55,35,25,15,1,2,5,1,2,85,1,7,8,9],
  [74,64,54,44,86,76,66,56,34,24,14,0,1,4,0,3,84,0,6,7,8],
  [73,63,53,43,87,77,67,57,33,23,13,3,0,3,3,4,83,1,5,6,7],
  [72,62,52,42,88,78,68,58,32,22,12,2,3,2,2,5,82,0,4,5,6],
  [71,61,51,41,89,79,69,59,31,21,11,1,2,1,1,6,81,1,3,4,5],
];
const fullVoice = new Uint8Array([
  ...operatorRows.flat(),
  61,62,63,64,51,52,53,54,17,5,0,45,46,47,48,1,4,6,31,
  ...new TextEncoder().encode('ROUNDTRIP!'),
]);
function fullPreset() {
  return {
    name:'ROUNDTRIP!', algorithm:17, feedback:5, oscillatorSync:false,
    pitchEnvelope:{rates:[61,62,63,64], levels:[51,52,53,54]},
    lfo:{speed:45, delay:46, pitchModDepth:47, ampModDepth:48, sync:true, waveform:4, pitchModSensitivity:6},
    transpose:31,
    operators:Object.fromEntries([1,2,3,4,5,6].map(op => [op, {
      envelope:{rates:[70+op,60+op,50+op,40+op], levels:[90-op,80-op,70-op,60-op]},
      keyboardScaling:{breakpoint:30+op, leftDepth:20+op, rightDepth:10+op, leftCurve:op%4, rightCurve:(op+1)%4},
      rateScaling:op, ampModSensitivity:op%4, velocitySensitivity:7-op,
      outputLevel:80+op, mode:op%2 ? 'fixed' : 'ratio', coarse:2+op, fine:3+op, detune:4+op,
    }])),
  };
}
function initPreset() {
  return {
    name:'INIT SINE', algorithm:31, feedback:0, oscillatorSync:true,
    pitchEnvelope:{rates:[99,99,99,99], levels:[50,50,50,50]},
    lfo:{speed:0, delay:0, pitchModDepth:0, ampModDepth:0, sync:false, waveform:0, pitchModSensitivity:0},
    transpose:24,
    operators:Object.fromEntries([1,2,3,4,5,6].map(op => [op, {
      envelope:{rates:[99,99,99,70], levels:[99,99,99,0]},
      keyboardScaling:{breakpoint:0, leftDepth:0, rightDepth:0, leftCurve:0, rightCurve:0},
      rateScaling:0, ampModSensitivity:0, velocitySensitivity:0,
      outputLevel:op === 1 ? 85 : 0, mode:'ratio', coarse:1, fine:0, detune:7,
    }])),
  };
}
function rms(pcm) { return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length); }
function setPath(object, path, value) {
  const parts = path.split('.');
  let parent = object;
  for (const key of parts.slice(0, -1)) parent = parent[key] ??= {};
  parent[parts.at(-1)] = value;
  return object;
}
async function loaded(voice = createInitVoice(), sampleRate = 44100) {
  const synth = await createDX7({sampleRate});
  await synth.loadSysex(createVoiceSysex(voice));
  return synth;
}

test('complete objects preserve all 155 VCED bytes, with public OP1 opposite the wire order', async () => {
  assert.equal(fullVoice.length, 155);
  for (const [voice, expected] of [[createInitVoice(), initPreset()], [fullVoice, fullPreset()]]) {
    assert.deepEqual(voiceToPreset(voice), expected);
    assert.deepEqual(presetToVoice(expected), voice);
    const synth = await loaded(voice);
    try {
      assert.deepEqual(synth.getPreset(), expected);
      synth.setPreset(expected);
      assert.deepEqual(presetToVoice(synth.getPreset()), voice);
    } finally { synth.dispose(); }
  }
});

test('a partial preset replaces the selected patch using INIT defaults; operator setters patch it', async () => {
  const synth = await createDX7();
  try {
    assert.throws(() => synth.getPreset(), /voice|preset|loaded/i);
    assert.deepEqual(synth.voices, []);
    synth.setOperators([]);
    assert.deepEqual(synth.voices, [], 'an empty batch must not silently create a voice');
    assert.equal(synth.selectedVoice, -1);
    synth.setOperator(1, {});
    assert.deepEqual(synth.getPreset(), initPreset(), 'the first operator edit initializes INIT SINE');
    synth.setPreset(fullPreset());
    synth.setPreset({name:'PARTIAL', operators:{6:{coarse:3}}});
    const expected = initPreset();
    expected.name = 'PARTIAL';
    expected.operators[6].coarse = 3;
    assert.deepEqual(synth.getPreset(), expected, 'setPreset must not inherit omitted fields from the previous voice');
    synth.setOperator(1, {envelope:{rates:[90,80,70,60]}, outputLevel:70});
    expected.operators[1].envelope.rates = [90,80,70,60];
    expected.operators[1].outputLevel = 70;
    synth.setOperators([[2,{fine:27}], [6,{keyboardScaling:{leftCurve:3}}]]);
    expected.operators[2].fine = 27;
    expected.operators[6].keyboardScaling.leftCurve = 3;
    assert.deepEqual(synth.getPreset(), expected, 'nested patches preserve untouched sibling values');
    synth.setPreset({});
    assert.deepEqual(synth.getPreset(), initPreset());
  } finally { synth.dispose(); }
});

test('caller-owned inputs and returned presets cannot mutate the synth or each other', async () => {
  const synth = await createDX7();
  try {
    const input = fullPreset();
    synth.setPreset(input);
    input.name = 'MUTATED';
    input.pitchEnvelope.rates[0] = 0;
    input.operators[1].envelope.levels[0] = 0;
    input.lfo.speed = 0;
    delete input.operators[6];
    assert.deepEqual(synth.getPreset(), fullPreset());
    const output = synth.getPreset();
    output.pitchEnvelope.levels.fill(0);
    output.operators[2].envelope.rates.fill(0);
    output.operators[3].keyboardScaling.leftDepth = 0;
    output.lfo.delay = 0;
    delete output.operators[4];
    assert.deepEqual(synth.getPreset(), fullPreset());
    const patch = {envelope:{rates:[1,2,3,4]}};
    synth.setOperator(1, patch);
    patch.envelope.rates.fill(99);
    assert.deepEqual(synth.getPreset().operators[1].envelope.rates, [1,2,3,4]);
    const entries = [[2,{envelope:{levels:[4,3,2,1]}}]];
    synth.setOperators(entries);
    entries[0][1].envelope.levels.fill(99);
    entries.push([3,{outputLevel:0}]);
    assert.deepEqual(synth.getPreset().operators[2].envelope.levels, [4,3,2,1]);
    assert.equal(synth.getPreset().operators[3].outputLevel, 83);
  } finally { synth.dispose(); }
});

test('strict validation rejects unknown fields and malformed nested objects without changing a patch', async () => {
  const synth = await loaded(fullVoice);
  try {
    const before = synth.getPreset();
    const invalid = [
      null, [], new Uint8Array(155), {unknown:1},
      {operators:[]}, {operators:{0:{}}}, {operators:{7:{}}}, {operators:{'01':{}}},
      {operators:{1:{unknown:1}}}, {operators:{1:{envelope:{duration:1}}}},
      {operators:{1:{keyboardScaling:{note:60}}}}, {lfo:{rate:1}}, {pitchEnvelope:{seconds:1}},
      {operators:{1:null}}, {lfo:null}, {pitchEnvelope:[]},
      {name:'12345678901'}, {name:'NON\nASCII'}, {name:'音色'}, {name:100},
      {oscillatorSync:1}, {oscillatorSync:'true'}, {lfo:{sync:0}},
      {operators:{1:{mode:0}}}, {operators:{1:{mode:'frequency'}}},
    ];
    for (const preset of invalid) {
      assert.throws(() => synth.setPreset(preset), undefined, `Invalid preset accepted: ${JSON.stringify(preset)}`);
      assert.deepEqual(synth.getPreset(), before);
    }
    for (const operator of [0,7,-1,1.5,NaN,Infinity,'1',null]) assert.throws(() => synth.setOperator(operator, {}));
    for (const entries of [{}, null, [1], [[1]], [[1,{},'extra']], [[7,{}]], [[1,null]], [[1,{}],[1,{}]]]) assert.throws(() => synth.setOperators(entries));
    assert.deepEqual(synth.getPreset(), before);
  } finally { synth.dispose(); }
});

test('built-in objects cannot silently become empty preset or operator patches', async () => {
  const synth = await loaded(fullVoice);
  try {
    const before = synth.getPreset();
    for (const value of [new Date(), new Map([['algorithm',5]]), new Set([1]), new Number(5), new Boolean(true), Promise.resolve()]) {
      for (const edit of [
        () => synth.setPreset(value),
        () => synth.setPreset({lfo:value}),
        () => synth.setPreset({operators:{1:{envelope:value}}}),
        () => synth.setOperator(1,value),
        () => synth.setOperators([[1,{outputLevel:0}],[2,value]]),
      ]) {
        assert.throws(edit, TypeError);
        assert.deepEqual(synth.getPreset(), before);
      }
    }
  } finally { synth.dispose(); }
});

test('cross-realm and null-prototype records remain valid preset inputs', async () => {
  const synth = await createDX7();
  try {
    synth.setPreset(runInNewContext('({name:"CROSSREALM", algorithm:5, operators:{1:{outputLevel:50}}})'));
    assert.equal(synth.getPreset().name, 'CROSSREALM');
    assert.equal(synth.getPreset().algorithm, 5);
    assert.equal(synth.getPreset().operators[1].outputLevel, 50);
    const record = values => Object.assign(Object.create(null), values);
    synth.setPreset(record({name:'NULLPROTO', operators:record({1:record({outputLevel:60})})}));
    assert.equal(synth.getPreset().name, 'NULLPROTO');
    assert.equal(synth.getPreset().operators[1].outputLevel, 60);
    synth.setOperator(2,runInNewContext('({coarse:3})'));
    synth.setOperator(3,record({fine:40}));
    assert.equal(synth.getPreset().operators[2].coarse, 3);
    assert.equal(synth.getPreset().operators[3].fine, 40);
  } finally { synth.dispose(); }
});

test('every numeric parameter rejects non-finite, fractional, boolean and out-of-range values', async () => {
  const synth = await loaded(fullVoice);
  const ranges = {
    algorithm:31, feedback:7, transpose:48,
    'lfo.speed':99, 'lfo.delay':99, 'lfo.pitchModDepth':99, 'lfo.ampModDepth':99, 'lfo.waveform':5, 'lfo.pitchModSensitivity':7,
    'operators.4.keyboardScaling.breakpoint':99, 'operators.4.keyboardScaling.leftDepth':99, 'operators.4.keyboardScaling.rightDepth':99,
    'operators.4.keyboardScaling.leftCurve':3, 'operators.4.keyboardScaling.rightCurve':3,
    'operators.4.rateScaling':7, 'operators.4.ampModSensitivity':3, 'operators.4.velocitySensitivity':7,
    'operators.4.outputLevel':99, 'operators.4.coarse':31, 'operators.4.fine':99, 'operators.4.detune':14,
  };
  try {
    const before = synth.getPreset();
    for (const [path, max] of Object.entries(ranges)) {
      for (const value of [-1,max+1,0.5,NaN,Infinity,-Infinity,true,'1']) {
        assert.throws(() => synth.setPreset(setPath({}, path, value)), undefined, `${path} accepted ${value}`);
      }
    }
    for (const path of ['pitchEnvelope.rates','pitchEnvelope.levels','operators.4.envelope.rates','operators.4.envelope.levels']) {
      for (const values of [[],[1,2,3],[1,2,3,4,5],new Uint8Array([1,2,3,4]),[1,2,3,NaN],[1,2,3,Infinity],[1,2,3,true],[-1,2,3,4],[1,2,3,100]]) {
        assert.throws(() => synth.setPreset(setPath({}, path, values)), undefined, `${path} accepted an invalid four-value tuple`);
      }
    }
    assert.deepEqual(synth.getPreset(), before);
  } finally { synth.dispose(); }
});

test('an invalid last batch entry is atomic, including held audio and bank selection', async () => {
  const synth = await createDX7(), control = await createDX7();
  try {
    const bank = createBankSysex(Array.from({length:32}, (_, index) => createInitVoice(`ATOMIC ${index}`)));
    for (const instance of [synth,control]) {
      await instance.loadSysex(bank);
      instance.selectVoice(15);
      instance.noteOn(60,100);
    }
    assert.deepEqual(synth.render(137), control.render(137));
    const before = synth.getPreset();
    assert.throws(() => synth.setOperators([[1,{outputLevel:0}], [6,{coarse:32}]]));
    assert.deepEqual(synth.getPreset(), before);
    assert.deepEqual(synth.render(8192), control.render(8192), 'valid early entries must not reach the native synth before the full batch validates');
    assert.equal(synth.selectedVoice, 15);
    assert.equal(synth.voices.length, 32);
    assert.equal(synth.voices[15].name, 'ATOMIC 15');
  } finally { synth.dispose(); control.dispose(); }
});

test('edits preserve all 32 bank slots and their selected index when switching away and back', async () => {
  const synth = await createDX7();
  try {
    const voices = Array.from({length:32}, (_, index) => createInitVoice(`OUR ${index}`));
    await synth.loadSysex(createBankSysex(voices));
    synth.selectVoice(15);
    synth.setPreset(fullPreset());
    assert.equal(synth.selectedVoice, 15);
    assert.equal(synth.voices.length, 32);
    assert.equal(synth.voices[15].name, 'ROUNDTRIP!');
    for (const index of [0,2,31]) {
      synth.selectVoice(index);
      assert.deepEqual(presetToVoice(synth.getPreset()), voices[index]);
    }
    synth.selectVoice(15);
    assert.deepEqual(synth.getPreset(), fullPreset());
    synth.setOperator(1, {outputLevel:12});
    synth.selectVoice(0);
    synth.selectVoice(15);
    assert.equal(synth.getPreset().operators[1].outputLevel, 12);
    assert.equal(synth.getPreset().operators[6].outputLevel, 86);
    assert.equal(synth.voices.length, 32);
  } finally { synth.dispose(); }
});

for (const sampleRate of [44100,48000]) {
  test(`object presets produce exactly the equivalent SysEx PCM at ${sampleRate} Hz`, async () => {
    const object = await createDX7({sampleRate}), sysex = await loaded(fullVoice,sampleRate);
    try {
      object.setPreset(fullPreset());
      let audible = false;
      for (const [event, frames] of [
        [synth => synth.noteOn(60,100),137],
        [synth => synth.noteOn(67,85),8199],
        [synth => synth.noteOff(60),4097],
        [synth => synth.allNotesOff(),sampleRate],
      ]) {
        event(object); event(sysex);
        const actual = object.render(frames);
        assert.deepEqual(actual, sysex.render(frames));
        audible ||= rms(actual) > 0.00001;
      }
      assert(audible, 'the fixture must exercise actual audible synthesis');
      object.panic(); sysex.panic();
      assert(object.render(2048).every(value => value === 0));
      assert.deepEqual(object.render(257), sysex.render(257));
    } finally { object.dispose(); sysex.dispose(); }
  });

  test(`setPreset affects later Note On while held notes keep their original patch at ${sampleRate} Hz`, async () => {
    const edited = await loaded(createInitVoice(),sampleRate), control = await loaded(createInitVoice(),sampleRate);
    try {
      for (const synth of [edited,control]) synth.noteOn(60,100);
      assert.deepEqual(edited.render(257), control.render(257));
      edited.setPreset({algorithm:0, operators:{1:{outputLevel:0}}});
      assert.deepEqual(edited.render(8192), control.render(8192), 'held operators and algorithm are not rewritten');
      edited.noteOff(60); control.noteOff(60);
      assert.deepEqual(edited.render(sampleRate), control.render(sampleRate), 'original release envelopes continue after an edit');
      edited.panic(); control.panic();
      edited.noteOn(67,100); control.noteOn(67,100);
      assert(rms(edited.render(8192)) < 0.000001, 'the next Note On uses the edited silent patch');
      assert(rms(control.render(8192)) > 0.001, 'the control patch is still audible');
      edited.allNotesOff();
      edited.panic();
      assert(edited.render(1024).every(value => value === 0));
    } finally { edited.dispose(); control.dispose(); }
  });
}

test('all object API calls reject disposed instances, including otherwise empty edits', async () => {
  const synth = await loaded();
  synth.dispose();
  for (const call of [() => synth.getPreset(), () => synth.setPreset({}), () => synth.setOperator(1,{}), () => synth.setOperators([]), () => synth.setFeedback(0)]) {
    assert.throws(call, /disposed/);
  }
  synth.dispose();
});
