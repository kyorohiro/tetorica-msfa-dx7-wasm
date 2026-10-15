import {
  createDX7, INTERNAL_SAMPLE_RATE, DEFAULT_WASM_URL,
  parseSysex, createInitVoice, createVoiceSysex, createBankSysex, packVoice, unpackVoice,
  type DX7, type DX7Voice, type DX7Sysex, type VoiceInfo,
  type DX7Preset, type DX7PresetState, type DX7Operator, type DX7OperatorParams, type DX7OperatorEntries,
} from '../src/index.js';
import { createDX7Node, type DX7Node } from '../src/browser.js';

async function coreApi(): Promise<void> {
  const fixed: 44100 = INTERNAL_SAMPLE_RATE;
  const asset: string = DEFAULT_WASM_URL;
  const data = createInitVoice('MY VOICE');
  const message = createVoiceSysex(data, { channel: 15 });
  const parsed: DX7Sysex = parseSysex(new DataView(message.buffer));
  const voice: DX7Voice = parsed.voices[0]!;
  const packed: Uint8Array = packVoice(voice.data);
  const unpacked: Uint8Array = unpackVoice(packed);
  const bank = createBankSysex(Array.from({ length: 32 }, () => unpacked));
  const synth: DX7 = await createDX7({ sampleRate: 48000, wasmUrl: asset });
  const names: VoiceInfo[] = await synth.loadSysex(bank);
  synth.selectVoice(names[0]!.index);
  const operator: DX7Operator = 1;
  const operatorPatch: DX7OperatorParams = {
    mode:'ratio', coarse:1, fine:0, detune:7,
    envelope:{rates:[99,90,80,70], levels:[99,80,60,0]},
    keyboardScaling:{breakpoint:39, leftCurve:0, rightCurve:3},
    outputLevel:85, ampModSensitivity:0,
  };
  const preset: DX7Preset = {
    name:'JS VOICE', algorithm:31, feedback:0, oscillatorSync:true,
    pitchEnvelope:{rates:[99,99,99,99], levels:[50,50,50,50]},
    lfo:{sync:false, speed:20, waveform:4}, transpose:24,
    operators:{1:operatorPatch, 6:{mode:'fixed', coarse:2}},
  };
  const batch: DX7OperatorEntries = [[1,operatorPatch], [6,{outputLevel:0}]] as const;
  const coreSet: void = synth.setPreset(preset);
  synth.setOperator(operator, operatorPatch);
  synth.setOperators(batch);
  synth.setOperators([]);
  const current: DX7PresetState = synth.getPreset();
  const rate: number = current.operators[1].envelope.rates[3];
  const sync: boolean = current.lfo.sync;
  const name: string = current.name;
  synth.setPreset(current);
  void coreSet;
  void rate;
  void sync;
  void name;
  // @ts-expect-error Operator labels are OP1..OP6, not zero-based.
  synth.setOperator(0, {outputLevel:80});
  // @ts-expect-error Operator mode is explicit, not a raw numeric bit.
  synth.setOperator(1, {mode:1});
  // @ts-expect-error DX7 envelopes contain exactly four values.
  synth.setOperator(1, {envelope:{rates:[99,80,60]}});
  // @ts-expect-error Batches are tuples, not keyed objects.
  synth.setOperators({1:{outputLevel:80}});
  // @ts-expect-error Each batch entry contains only an operator and patch.
  synth.setOperators([[1,{outputLevel:80},true]]);
  // @ts-expect-error Unknown chip-specific properties must not compile.
  synth.setPreset({operators:{1:{tl:32}}});
  // @ts-expect-error A seventh operator does not exist.
  synth.setPreset({operators:{7:{outputLevel:80}}});
  synth.noteOn(60, 100);
  const owned: Float32Array = synth.render(1024);
  synth.renderInto(owned);
  synth.noteOff(60);
  synth.allNotesOff();
  synth.panic();
  synth.dispose();
  void fixed;
  // @ts-expect-error Only the MVP output rates are accepted.
  await createDX7({ sampleRate: 96000 });
  // @ts-expect-error renderInto writes mono Float32 PCM.
  synth.renderInto(new Float64Array(128));
  // @ts-expect-error The exposed output sample rate is read-only.
  synth.sampleRate = 44100;
}

async function browserApi(context: AudioContext): Promise<void> {
  const synth: DX7Node = await createDX7Node(context, {
    wasmBytes: new Uint8Array(0),
    onError(error) { console.error(error.message); },
  });
  synth.node.connect(context.destination);
  const list = await synth.loadSysex(createVoiceSysex(createInitVoice()));
  synth.selectVoice(list[0]!.index);
  const applied: Promise<void> = synth.setPreset({name:'WEB VOICE', operators:{1:{outputLevel:80}}});
  await applied;
  await synth.setOperator(1, {mode:'ratio', coarse:2});
  await synth.setOperators([[1,{fine:5}], [6,{outputLevel:0}]] as const);
  const current: DX7PresetState = await synth.getPreset();
  const request: Promise<DX7PresetState> = synth.getPreset();
  await synth.setPreset(current);
  void request;
  // @ts-expect-error Browser getPreset resolves asynchronously after Worklet application.
  const synchronous: DX7PresetState = synth.getPreset();
  // @ts-expect-error Worklet setters use the same OP1..OP6 labels.
  synth.setOperator(7, {});
  // @ts-expect-error Browser batches use the same tuple shape as the core.
  synth.setOperators({1:{outputLevel:80}});
  // @ts-expect-error Booleans are not numeric DX7 raw values.
  synth.setPreset({lfo:{speed:true}});
  void synchronous;
  synth.noteOn(60, 100);
  synth.noteOff(60);
  synth.allNotesOff();
  synth.panic();
  synth.dispose();
  // @ts-expect-error Offline PCM rendering belongs to the core, not the Worklet controller.
  synth.render(128);
}

void coreApi;
void browserApi;
