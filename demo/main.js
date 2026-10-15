import { createDX7Node } from '../src/browser.js';
import { createInitVoice, createVoiceSysex } from '../src/index.js';
import workletUrl from '../src/dx7-worklet.js?worker&url';

const startButton = document.querySelector('#audio-start');
const loadButton = document.querySelector('#load-sysex');
const fileInput = document.querySelector('#sysex-file');
const voiceSelect = document.querySelector('#voice');
const allOffButton = document.querySelector('#all-notes-off');
const panicButton = document.querySelector('#panic');
const keyboard = document.querySelector('#keyboard');
const status = document.querySelector('#status');
const volumeInput = document.querySelector('#volume');
const volumeValue = document.querySelector('#volume-value');
const initSysex = createVoiceSysex(createInitVoice());
const pcNotes = new Map(['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'].map((key, i) => [key, 60 + i]));
const pcLabels = new Map([...pcNotes].map(([key, note]) => [note, key.toUpperCase()]));
const heldKeys = new Map();
const pointers = new Map();
const heldNotes = new Map();
const keyElements = new Map();
let context;
let instrument;
let outputGain;
let playable = false;
let busy = false;

function setStatus(message, state) {
  status.textContent = message;
  status.dataset.state = state;
}

function setPlayable(enabled) {
  playable = enabled;
  keyboard.setAttribute('aria-disabled', String(!enabled));
  for (const key of keyElements.values()) key.disabled = !enabled;
  loadButton.disabled = !instrument || busy;
  voiceSelect.disabled = !enabled;
  allOffButton.disabled = !enabled;
  panicButton.disabled = !enabled;
}

function noteOn(note) {
  if (!playable) return;
  const count = heldNotes.get(note) ?? 0;
  heldNotes.set(note, count + 1);
  if (count === 0) {
    instrument.noteOn(note, 100);
    keyElements.get(note)?.classList.add('active');
  }
}

function noteOff(note) {
  const count = heldNotes.get(note) ?? 0;
  if (count > 1) { heldNotes.set(note, count - 1); return; }
  if (count === 0) return;
  heldNotes.delete(note);
  instrument?.noteOff(note);
  keyElements.get(note)?.classList.remove('active');
}

function releaseAll(immediate = false) {
  heldKeys.clear();
  pointers.clear();
  heldNotes.clear();
  for (const key of keyElements.values()) key.classList.remove('active');
  if (instrument) {
    try { immediate ? instrument.panic() : instrument.allNotesOff(); } catch { /* An errored instrument is already silent. */ }
  }
}

const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const blackNotes = new Set([1, 3, 6, 8, 10]);
let whites = 0;
for (let note = 48; note <= 72; note++) {
  const black = blackNotes.has(note % 12);
  const key = document.createElement('button');
  key.type = 'button';
  key.className = `key ${black ? 'black' : 'white'}`;
  key.dataset.note = String(note);
  key.disabled = true;
  key.tabIndex = -1;
  const label = `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;
  key.setAttribute('aria-label', `${label} (MIDI ${note})`);
  const caption = document.createElement('span');
  caption.textContent = pcLabels.get(note) ?? (note % 12 === 0 ? label : '');
  key.append(caption);
  if (black) key.style.left = `calc(${whites / 15 * 100}% - 2.1%)`;
  else whites++;
  key.addEventListener('pointerdown', event => {
    if (!playable || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    key.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, note);
    noteOn(note);
  });
  const releasePointer = event => {
    const held = pointers.get(event.pointerId);
    if (held === undefined) return;
    pointers.delete(event.pointerId);
    noteOff(held);
  };
  key.addEventListener('pointerup', releasePointer);
  key.addEventListener('pointercancel', releasePointer);
  key.addEventListener('lostpointercapture', releasePointer);
  keyboard.append(key);
  keyElements.set(note, key);
}

function updateVoices() {
  voiceSelect.replaceChildren(...instrument.voices.map((voice, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${String(index + 1).padStart(2, '0')} · ${voice.name}`;
    return option;
  }));
  voiceSelect.value = '0';
}

startButton.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  startButton.disabled = true;
  setStatus('Preparing WASM and AudioWorklet…', 'loading');
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
    // Resume in this user gesture, before network/WASM awaits. In particular,
    // Safari may defer Worklet construction until the context is running.
    await context.resume();
    instrument = await createDX7Node(context, {
      workletUrl,
      onError(error) {
        setPlayable(false);
        releaseAll();
        setStatus(error.message, 'error');
      },
    });
    outputGain = context.createGain();
    outputGain.gain.value = Number(volumeInput.value) / 100;
    instrument.node.connect(outputGain).connect(context.destination);
    await instrument.loadSysex(initSysex);
    updateVoices();
    startButton.textContent = 'Audio Ready';
    setStatus(`Ready · ${context.sampleRate.toLocaleString()} Hz output · 44,100 Hz internal · INIT SINE`, 'ready');
    busy = false;
    setPlayable(true);
  } catch (error) {
    instrument?.dispose();
    instrument = undefined;
    await context?.close();
    setStatus(error.message, 'error');
    startButton.textContent = 'Retry Audio Start';
    startButton.disabled = false;
    busy = false;
    setPlayable(false);
  }
});

loadButton.addEventListener('click', () => { releaseAll(); fileInput.click(); });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || !instrument || busy) return;
  busy = true;
  releaseAll();
  setPlayable(false);
  setStatus(`Loading ${file.name}…`, 'loading');
  try {
    await instrument.loadSysex(await file.arrayBuffer());
    updateVoices();
    setStatus(`Ready · ${file.name} · ${instrument.voices.length} voice${instrument.voices.length === 1 ? '' : 's'}`, 'ready');
  } catch (error) {
    setStatus(`Could not load ${file.name}: ${error.message}`, 'error');
  } finally {
    busy = false;
    setPlayable(true);
  }
});

voiceSelect.addEventListener('change', () => {
  releaseAll();
  instrument.selectVoice(Number(voiceSelect.value));
  setStatus(`Ready · ${instrument.voices[Number(voiceSelect.value)].name}`, 'ready');
});
allOffButton.addEventListener('click', () => releaseAll());
panicButton.addEventListener('click', () => releaseAll(true));
volumeInput.addEventListener('input', () => {
  volumeValue.textContent = `${volumeInput.value}%`;
  if (outputGain) outputGain.gain.setTargetAtTime(Number(volumeInput.value) / 100, context.currentTime, 0.01);
});
document.querySelector('#download-init').addEventListener('click', () => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([initSysex], { type: 'application/octet-stream' }));
  link.href = url;
  link.download = 'tetorica-init-sine.syx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function editingTarget(target) {
  return target instanceof Element && !!target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]');
}
window.addEventListener('keydown', event => {
  if (!playable || event.repeat || event.ctrlKey || event.metaKey || event.altKey || editingTarget(event.target)) return;
  const note = pcNotes.get(event.key.toLowerCase());
  if (note === undefined) return;
  event.preventDefault();
  heldKeys.set(event.code, note);
  noteOn(note);
});
window.addEventListener('keyup', event => {
  const note = heldKeys.get(event.code);
  if (note === undefined) return;
  heldKeys.delete(event.code);
  noteOff(note);
});
window.addEventListener('blur', () => releaseAll());
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
window.addEventListener('pagehide', () => {
  releaseAll(true);
  instrument?.dispose();
  // Firefox may reject close() when its page is already being discarded.
  try { context?.close().catch(() => {}); } catch { /* Page teardown. */ }
});
