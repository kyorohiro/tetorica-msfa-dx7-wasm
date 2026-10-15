import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBankSysex,
  createInitVoice,
  createVoiceSysex,
  packVoice,
  parseSysex,
  unpackVoice,
} from '../src/sysex.js';

function updateChecksum(message) {
  let sum = 0;
  for (let i = 6; i < message.length - 2; i++) sum += message[i];
  message[message.length - 2] = (128 - (sum % 128)) % 128;
  return message;
}

test('self-authored voice has valid bulk framing, name, channel, and independent output arrays', () => {
  const data = createInitVoice('OUR SINE');
  const message = createVoiceSysex(data, { channel: 15 });
  assert.equal(message.length, 163);
  assert.deepEqual([...message.subarray(0, 6)], [0xf0, 0x43, 15, 0, 1, 27]);
  assert.equal(message[162], 0xf7);
  const parsed = parseSysex(message);
  assert.equal(parsed.format, 'voice');
  assert.equal(parsed.channel, 15);
  assert.equal(parsed.voices.length, 1);
  assert.equal(parsed.voices[0].name, 'OUR SINE');
  assert.deepEqual(parsed.voices[0].data, data);
  assert.equal(parsed.voices[0].packedData.length, 128);
  const preserved = parsed.voices[0].data.slice();
  message.fill(0);
  data.fill(0);
  parsed.voices[0].packedData.fill(0);
  assert.deepEqual(parsed.voices[0].data, preserved);
});

test('known bitfields match VMEM operator layout and common parameters exactly', () => {
  const data = createInitVoice('PACK TEST');
  data.set([11, 22, 33, 44, 55, 66, 77, 88, 39, 45, 67, 2, 3, 5, 2, 6, 91, 1, 25, 73, 11], 0);
  data.set([12, 23, 34, 45, 56, 67, 78, 89, 23, 5, 1, 16, 27, 38, 49, 1, 5, 6, 48], 126);
  const packed = packVoice(data);
  assert.deepEqual([...packed.subarray(0, 17)], [11, 22, 33, 44, 55, 66, 77, 88, 39, 45, 67, 14, 93, 26, 91, 51, 73]);
  assert.deepEqual([...packed.subarray(102, 118)], [12, 23, 34, 45, 56, 67, 78, 89, 23, 13, 16, 27, 38, 49, 107, 48]);
  assert.equal(String.fromCharCode(...packed.subarray(118)), 'PACK TEST ');
  assert.deepEqual(unpackVoice(packed), data);
});

test('bank round trip preserves all 32 distinct voices and original packed bytes', () => {
  const voices = Array.from({ length: 32 }, (_, i) => {
    const data = createInitVoice(`VOICE ${String(i).padStart(2, '0')}`);
    data[134] = i;
    data[123] = i;
    data[125] = i % 15;
    return data;
  });
  const message = createBankSysex(voices, { channel: 7 });
  assert.equal(message.length, 4104);
  assert.deepEqual([...message.subarray(0, 6)], [0xf0, 0x43, 7, 9, 32, 0]);
  const parsed = parseSysex(message);
  assert.equal(parsed.format, 'bank');
  assert.equal(parsed.channel, 7);
  assert.equal(parsed.voices.length, 32);
  for (let i = 0; i < 32; i++) {
    assert.equal(parsed.voices[i].name, `VOICE ${String(i).padStart(2, '0')}`);
    assert.deepEqual(parsed.voices[i].data, voices[i]);
    assert.deepEqual(parsed.voices[i].packedData, message.slice(6 + i * 128, 6 + (i + 1) * 128));
  }
  assert.deepEqual(createBankSysex(parsed.voices.map(voice => voice.data), { channel: 7 }), message);
  message.fill(0);
  assert.equal(parsed.voices[31].data[134], 31);
  assert.equal(parsed.voices[31].packedData[110], 31);
});

test('all legal VCED values survive packing at low, high, and varied settings', () => {
  const opMax = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
  const commonMax = [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48];
  let random = 0x4d534641;
  for (let fixture = 0; fixture < 64; fixture++) {
    const voice = new Uint8Array(155);
    for (let i = 0; i < 155; i++) {
      const max = i < 126 ? opMax[i % 21] : i < 145 ? commonMax[i - 126] : 127;
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      voice[i] = fixture === 0 ? 0 : fixture === 1 ? max : random % (max + 1);
    }
    const packed = packVoice(voice);
    assert.deepEqual(unpackVoice(packed), voice);
    assert.deepEqual(parseSysex(createVoiceSysex(voice)).voices[0].data, voice);
  }
});

test('ArrayBuffer views respect byte offsets and byte lengths, including DataView', () => {
  const message = createVoiceSysex(createInitVoice());
  const padded = new Uint8Array(200).fill(255);
  padded.set(message, 11);
  assert.equal(parseSysex(padded.subarray(11, 174)).voices[0].name, 'INIT SINE');
  assert.equal(parseSysex(new DataView(padded.buffer, 11, 163)).voices[0].name, 'INIT SINE');
  assert.equal(parseSysex(message.buffer).voices[0].name, 'INIT SINE');
  const packed = packVoice(createInitVoice());
  assert.deepEqual(unpackVoice(new Uint16Array(packed.buffer)), createInitVoice());
  assert.throws(() => parseSysex(padded), /exactly/);
});

test('voice name display is safe while all original seven-bit name bytes survive', () => {
  const data = createInitVoice();
  data.set([65, 0, 66, 9, 67, 127, 68, 32, 32, 32], 145);
  const parsed = parseSysex(createVoiceSysex(data));
  assert.equal(parsed.voices[0].name, 'A B C D');
  assert.deepEqual(parsed.voices[0].data.subarray(145), data.subarray(145));
  assert.deepEqual(unpackVoice(parsed.voices[0].packedData), data);
  assert.equal(parseSysex(createVoiceSysex(createInitVoice(''))).voices[0].name, '');
  assert.throws(() => createInitVoice('11CHARACTER'), /at most 10/);
  assert.throws(() => createInitVoice('日本語'), /ASCII/);
  assert.throws(() => createInitVoice('bad\nname'), /ASCII/);
});

test('strictly reject malformed framing, unsupported formats, and concatenated dumps', () => {
  const valid = createVoiceSysex(createInitVoice());
  for (const [index, value] of [[0, 0], [1, 0x42], [2, 0x10], [2, 0x7f], [3, 9], [4, 0], [5, 26], [162, 0]]) {
    const bad = valid.slice();
    bad[index] = value;
    assert.throws(() => parseSysex(bad), /header|format|marker|substatus/);
  }
  for (const length of [0, 1, 155, 162, 164, 4103, 4105]) {
    assert.throws(() => parseSysex(new Uint8Array(length)), /exactly/);
  }
  const concatenated = new Uint8Array(326);
  concatenated.set(valid);
  concatenated.set(valid, 163);
  assert.throws(() => parseSysex(concatenated), /exactly/);
  assert.throws(() => parseSysex([0xf0, 0xf7]), TypeError);
  assert.throws(() => parseSysex('not bytes'), TypeError);
});

test('checksum and seven-bit checks reject corrupt voices and banks', () => {
  const valid = createVoiceSysex(createInitVoice());
  const corrupt = valid.slice();
  corrupt[6] ^= 1;
  assert.throws(() => parseSysex(corrupt), /checksum/);
  corrupt.set(valid);
  corrupt[161] = 128;
  assert.throws(() => parseSysex(corrupt), /checksum/);
  corrupt.set(valid);
  corrupt[6] = 128;
  updateChecksum(corrupt);
  assert.throws(() => parseSysex(corrupt), /7-bit/);
  const bank = createBankSysex(Array.from({ length: 32 }, () => createInitVoice()));
  bank[6 + 31 * 128] ^= 1;
  assert.throws(() => parseSysex(bank), /checksum/);
});

test('reject native-unsafe and non-DX7 parameter ranges rather than clamp silently', () => {
  const cases = [[0, 100], [4, 100], [11, 4], [12, 4], [13, 8], [14, 4], [15, 8], [16, 100], [17, 2], [18, 32], [19, 100], [20, 15], [126, 100], [130, 100], [134, 32], [135, 8], [136, 2], [137, 100], [141, 2], [142, 6], [143, 8], [144, 49]];
  for (const [offset, value] of cases) {
    const data = createInitVoice();
    data[offset] = value;
    assert.throws(() => packVoice(data), RangeError, `packing parameter ${offset}`);
    assert.throws(() => createVoiceSysex(data), RangeError, `encoding parameter ${offset}`);
    const message = createVoiceSysex(createInitVoice());
    message[6 + offset] = value;
    updateChecksum(message);
    assert.throws(() => parseSysex(message), RangeError, `parsing parameter ${offset}`);
  }
  assert.throws(() => packVoice(new Uint8Array(154)), /155 bytes/);
  assert.throws(() => unpackVoice(new Uint8Array(127)), /128 bytes/);
});

test('bank packed reserved bits and out-of-range bitfields are rejected, even with valid checksum', () => {
  const voices = Array.from({ length: 32 }, () => createInitVoice());
  for (const [offset, value] of [[11, 16], [12, 120], [13, 32], [15, 64], [111, 16], [116, 12], [117, 49]]) {
    const bank = createBankSysex(voices);
    bank[6 + 31 * 128 + offset] = value;
    updateChecksum(bank);
    assert.throws(() => parseSysex(bank), /reserved|parameter/);
  }
});

test('encoders reject invalid channel, bank count, and invalid voice in final bank slot', () => {
  for (const channel of [-1, 16, 0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => createVoiceSysex(createInitVoice(), { channel }), /channel/);
  }
  for (const options of [null, 1, 'options', []]) {
    assert.throws(() => createVoiceSysex(createInitVoice(), options), /options/);
  }
  assert.throws(() => createBankSysex([]), /exactly 32/);
  assert.throws(() => createBankSysex(Array.from({ length: 31 }, () => createInitVoice())), /exactly 32/);
  const voices = Array.from({ length: 32 }, () => createInitVoice());
  voices[31][134] = 127;
  assert.throws(() => createBankSysex(voices), /parameter 134/);
});
