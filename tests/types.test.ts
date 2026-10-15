import {
  createDX7, INTERNAL_SAMPLE_RATE, DEFAULT_WASM_URL,
  parseSysex, createInitVoice, createVoiceSysex, createBankSysex, packVoice, unpackVoice,
  type DX7, type DX7Voice, type DX7Sysex, type VoiceInfo,
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
