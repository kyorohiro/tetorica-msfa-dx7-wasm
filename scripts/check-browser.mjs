import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, build, preview } from 'vite';
import { chromium, webkit, firefox } from 'playwright';
import { createInitVoice, createVoiceSysex, createBankSysex, parseSysex } from '../src/sysex.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bank = createBankSysex(Array.from({ length: 32 }, (_, i) => createInitVoice(`TEST ${i + 1}`)));
const single = createVoiceSysex(createInitVoice('AFTER LOAD'));
const missing = [];
const results = [];
const configFile = path.join(root, 'vite.config.js');

async function testDemo(page, base, name) {
  await page.setViewportSize({ width: 1280, height: 850 });
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  await page.goto(`${base}/demo/`);
  await page.waitForSelector('#keyboard .key');
  assert.equal(await page.locator('#keyboard .key:disabled').count(), 25);
  await page.locator('#audio-start').click();
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', null, { timeout: 60000 });
  assert.equal(await page.locator('#keyboard .key:disabled').count(), 0);
  assert.match(await page.locator('#voice').textContent(), /INIT SINE/);
  await page.locator('#sysex-file').setInputFiles({ name: 'own-test-bank.syx', mimeType: 'application/octet-stream', buffer: Buffer.from(bank) });
  await page.waitForFunction(() => document.querySelector('#voice').options.length === 32);
  await page.locator('#voice').selectOption('31');
  assert.match(await page.locator('#status').textContent(), /TEST 32/);
  await page.locator('#voice').focus();
  await page.keyboard.press('a');
  assert.equal(await page.locator('.key.active').count(), 0, 'Voice select keeps its native letter-key behavior');
  const volume = page.locator('#volume');
  await volume.focus();
  const previousVolume = Number(await volume.inputValue());
  await page.keyboard.press('ArrowRight');
  assert.equal(Number(await volume.inputValue()), previousVolume + 1, 'Focused volume keeps native arrow control');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.key.active').count(), 0, 'Space does not trigger an instrument note');
  await page.keyboard.down('a');
  assert.equal(await page.locator('.key[data-note="60"]').evaluate(element => element.classList.contains('active')), true, 'Musical keys still play while Volume is focused');
  await page.keyboard.up('a');
  assert.equal(await page.locator('.key.active').count(), 0);
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'test-text-editor';
    document.body.prepend(input);
    input.focus();
  });
  await page.keyboard.press('a');
  assert.equal(await page.locator('#test-text-editor').inputValue(), 'a', 'Text inputs retain typing');
  assert.equal(await page.locator('.key.active').count(), 0);
  await page.locator('#test-text-editor').evaluate(element => element.remove());
  await page.locator('#voice').evaluate(element => element.blur());
  await page.keyboard.down('a');
  assert.equal(await page.locator('.key[data-note="60"]').evaluate(key => key.classList.contains('active')), true);
  await page.keyboard.up('a');
  assert.equal(await page.locator('.key.active').count(), 0);
  await page.keyboard.down('a');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('a');
  assert.equal(await page.locator('.key.active').count(), 0, 'Window blur releases held notes');
  const key = page.locator('.key[data-note="64"]');
  const rect = await key.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 20);
  await page.mouse.down();
  assert.equal(await key.evaluate(element => element.classList.contains('active')), true);
  await page.mouse.move(4, 4);
  await page.mouse.up();
  assert.equal(await page.locator('.key.active').count(), 0, 'Pointer capture releases outside the keyboard');
  await page.locator('#sysex-file').setInputFiles({ name: 'broken.syx', mimeType: 'application/octet-stream', buffer: Buffer.from([0xf0, 1, 0xf7]) });
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error');
  assert.equal(await page.locator('#voice option').count(), 32, 'Rejected bank leaves existing voices available');
  assert.equal(await page.locator('#keyboard .key:disabled').count(), 0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-init').click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(parseSysex(Buffer.concat(chunks)).voices[0].name, 'INIT SINE');
  await page.locator('#voice').selectOption('0');
  await page.screenshot({ path: `/private/tmp/msfa-dx7-${name.replaceAll('/', '-')}-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `/private/tmp/msfa-dx7-${name.replaceAll('/', '-')}.png` });
  assert.deepEqual(errors, []);
  page.off('pageerror', onError);
}

async function testAudio(page, base, rate) {
  await page.goto(`${base}/demo/`);
  // Run initialization from an actual user gesture, including AudioContext.resume.
  await page.evaluate(({ rate, single, bank }) => {
    const button = document.createElement('button');
    button.id = 'probe-start';
    button.textContent = 'Run Worklet test';
    document.body.prepend(button);
    button.onclick = async () => {
      try {
        const context = new AudioContext({ sampleRate: rate });
        await context.resume();
        const { createDX7Node } = await import('/src/browser.js');
        const errors = [];
        const instrument = await createDX7Node(context, { onError: error => errors.push(error.message) });
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        const muted = context.createGain();
        muted.gain.value = 0;
        instrument.node.connect(analyser).connect(muted).connect(context.destination);
        const bytes = new Uint8Array(single);
        await instrument.loadSysex(bytes);
        // No delay between load acknowledgement, selection and Note On.
        instrument.selectVoice(0);
        instrument.noteOn(69, 100);
        const pcm = new Float32Array(analyser.fftSize);
        const peak = () => {
          analyser.getFloatTimeDomainData(pcm);
          let result = 0;
          for (const value of pcm) result = Math.max(result, Math.abs(value));
          return result;
        };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        let maxPeak = 0;
        for (let i = 0; i < 30 && maxPeak < .001; i++) { await wait(30); maxPeak = Math.max(maxPeak, peak()); }
        const name = instrument.voices[0].name;
        let rejected = false;
        try { await instrument.loadSysex(new Uint8Array([0xf0, 0xf7])); } catch { rejected = true; }
        const preserved = instrument.voices[0].name;
        // UI activity and repeated commands should not terminate the processor.
        for (let i = 0; i < 20; i++) {
          instrument.noteOff(69);
          instrument.noteOn(69, 100);
          document.body.style.setProperty('--test-ui', String(i));
          await wait(10);
        }
        instrument.panic();
        await wait(100);
        const presetInput = {name:'OBJECT', algorithm:31, operators:{1:{outputLevel:85}}};
        const presetApplied = instrument.setPreset(presetInput);
        presetInput.name = 'MUTATED';
        presetInput.operators[1].outputLevel = 0;
        // The following Note On must stay behind the preset command even when
        // the caller has not awaited its acknowledgement yet.
        instrument.noteOn(69, 100);
        await presetApplied;
        const objectPreset = await instrument.getPreset();
        const objectMetadata = {voices:instrument.voices, selectedVoice:instrument.selectedVoice};
        objectPreset.operators[1].outputLevel = 0;
        const independentPreset = await instrument.getPreset();
        let objectPeak = 0;
        for (let i = 0; i < 30 && objectPeak < .001; i++) { await wait(30); objectPeak = Math.max(objectPeak, peak()); }
        await instrument.setOperator(1, {coarse:2});
        const edits = [[1,{fine:0}], [6,{outputLevel:0}]];
        const editsApplied = instrument.setOperators(edits);
        edits[0][1].fine = 99;
        await editsApplied;
        const editedPreset = await instrument.getPreset();
        const stable = JSON.stringify(editedPreset);
        let objectRejected = 0;
        for (const update of [
          () => instrument.setOperators([[1,{outputLevel:99}], [6,{fine:100}]]),
          () => instrument.setPreset({name:()=>'invalid'}),
          () => instrument.setOperator(0, {}),
        ]) { try { await update(); } catch { objectRejected++; } }
        const objectPreserved = JSON.stringify(await instrument.getPreset()) === stable;
        // Editing one selected voice must retain the other 31 bank slots.
        await instrument.loadSysex(new Uint8Array(bank));
        instrument.selectVoice(31);
        await instrument.setPreset({name:'BANK EDIT'});
        await instrument.setOperator(1, {fine:12});
        const editedBank = {voices:instrument.voices, selectedVoice:instrument.selectedVoice};
        instrument.selectVoice(0);
        const untouchedBankVoice = await instrument.getPreset();
        instrument.selectVoice(31);
        const restoredBankVoice = await instrument.getPreset();
        instrument.selectVoice(0);
        const feedbackBeforeSelection = instrument.setFeedback(3);
        instrument.selectVoice(31);
        await feedbackBeforeSelection;
        const metadataRace = {afterFeedback:instrument.selectedVoice};
        const presetBeforeSelection = instrument.getPreset();
        instrument.selectVoice(0);
        metadataRace.presetSnapshot = (await presetBeforeSelection).name;
        metadataRace.afterPreset = instrument.selectedVoice;
        // Probe held notes rather than retriggering after each edit. This catches
        // bridges that update the saved preset but leave active voices unchanged.
        const measure = async () => {
          await wait(100);
          const frames = [];
          for (let frame = 0; frame < 3; frame++) {
            analyser.getFloatTimeDomainData(pcm);
            const crossings = [];
            let energy = 0;
            for (let i = 0; i < pcm.length; i++) {
              energy += pcm[i] * pcm[i];
              if (i && pcm[i - 1] <= 0 && pcm[i] > 0) crossings.push(i - 1 - pcm[i - 1] / (pcm[i] - pcm[i - 1]));
            }
            frames.push({rms:Math.sqrt(energy / pcm.length), hz:crossings.length > 1 ? context.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]) : 0});
            await wait(20);
          }
          return {rms:frames.reduce((sum, frame) => sum + frame.rms, 0) / frames.length, hz:frames.reduce((sum, frame) => sum + frame.hz, 0) / frames.length};
        };
        const live = {};
        const heldPreset = name => ({name, algorithm:31, operators:{1:{coarse:1, fine:0, detune:7, outputLevel:90, envelope:{rates:[99,99,99,0], levels:[99,99,99,0]}}}});
        instrument.panic();
        await instrument.setPreset(heldPreset('LIVE A'));
        instrument.noteOn(69, 100);
        live.initial = await measure();
        await instrument.setFeedback(7);
        live.feedback = (await instrument.getPreset()).feedback;
        await instrument.setFeedback(0);
        await instrument.setOperator(1, {coarse:2});
        live.octave = await measure();
        await instrument.setOperators([[1,{outputLevel:55}], [6,{fine:12}]]);
        live.quiet = await measure();
        let liveRejected = false;
        try { await instrument.setOperators([[1,{outputLevel:0}], [6,{coarse:32}]]); } catch { liveRejected = true; }
        live.afterInvalid = await measure();
        await instrument.setOperator(1, {outputLevel:0});
        live.muted = await measure();
        await instrument.setOperator(1, {outputLevel:90, mode:'fixed', coarse:2, fine:0});
        live.fixed = await measure();
        await instrument.setOperator(1, {mode:'ratio', coarse:1});
        live.restored = await measure();
        // Replacing a preset starts a new edit cohort. The old held/released
        // sound is kept, even when the same bank slot is subsequently edited.
        await instrument.setPreset({...heldPreset('LIVE B'), operators:{1:{...heldPreset('LIVE B').operators[1], coarse:2}}});
        await instrument.setOperator(1, {outputLevel:0, coarse:3});
        live.oldCohort = await measure();
        instrument.panic(); instrument.noteOn(69, 100);
        live.newMuted = await measure();
        await instrument.setOperator(1, {outputLevel:90});
        live.newHeld = await measure();
        instrument.noteOff(69);
        await instrument.setOperator(1, {outputLevel:0});
        live.releaseMuted = await measure();
        await instrument.setOperator(1, {outputLevel:90});
        live.releaseRestored = await measure();
        instrument.panic();
        await wait(100);
        const silentPeak = peak();
        instrument.dispose();
        instrument.dispose();
        let disposedRejected = false;
        try { instrument.noteOn(60); } catch { disposedRejected = true; }
        await context.close();
        window.__probe = { rate: context.sampleRate, maxPeak, silentPeak, name, rejected, preserved, disposedRejected,
          objectPreset, independentPreset, objectMetadata, objectPeak, editedPreset, objectRejected, objectPreserved,
          editedBank, untouchedBankVoice, restoredBankVoice, metadataRace, live, liveRejected, errors };
      } catch (error) { window.__probe = { error: error.stack ?? String(error) }; }
    };
  }, { rate, single: [...single], bank:[...bank] });
  await page.locator('#probe-start').click();
  await page.waitForFunction(() => window.__probe, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__probe);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.rate, rate);
  assert.ok(result.maxPeak > .001 && result.maxPeak <= 1, `Audible normalized PCM: ${result.maxPeak}`);
  assert.equal(result.silentPeak, 0, 'Panic clears queued output and release tails');
  assert.equal(result.name, 'AFTER LOAD');
  assert.equal(result.preserved, 'AFTER LOAD');
  assert.equal(result.rejected, true);
  assert.equal(result.disposedRejected, true);
  assert.equal(result.objectPreset.name, 'OBJECT', 'Caller mutation cannot change a queued preset');
  assert.equal(result.independentPreset.operators[1].outputLevel, 85, 'getPreset returns an independent copy');
  assert.equal(result.objectMetadata.voices[0].name, 'OBJECT');
  assert.equal(result.objectMetadata.selectedVoice, 0);
  assert.ok(result.objectPeak > .001 && result.objectPeak <= 1, 'Object preset produces normalized Worklet PCM');
  assert.equal(result.editedPreset.operators[1].coarse, 2);
  assert.equal(result.editedPreset.operators[1].fine, 0, 'Tuple patches are copied before queuing');
  assert.equal(result.editedPreset.operators[6].outputLevel, 0);
  assert.equal(result.objectRejected, 3);
  assert.equal(result.objectPreserved, true, 'Invalid updates preserve the working patch and processor');
  assert.equal(result.editedBank.voices.length, 32);
  assert.equal(result.editedBank.selectedVoice, 31);
  assert.equal(result.editedBank.voices[0].name, 'TEST 1');
  assert.equal(result.editedBank.voices[31].name, 'BANK EDIT');
  assert.equal(result.untouchedBankVoice.name, 'TEST 1');
  assert.equal(result.restoredBankVoice.name, 'BANK EDIT');
  assert.equal(result.restoredBankVoice.operators[1].fine, 12);
  assert.deepEqual(result.metadataRace, {afterFeedback:31, presetSnapshot:'BANK EDIT', afterPreset:0}, 'Earlier metadata acknowledgements retain later optimistic selection while reads return ordered snapshots');
  const live = result.live;
  const nearHz = (frame, expected, label) => assert.ok(Math.abs(frame.hz / expected - 1) < .03, `${label}: ${JSON.stringify(frame)} expected ${expected} Hz`);
  nearHz(live.initial, 440, 'Held ratio note');
  assert.equal(live.feedback, 7, 'Feedback acknowledgement updates the selected preset');
  nearHz(live.octave, 880, 'Live coarse edit');
  assert.ok(live.quiet.rms < live.octave.rms * .15 && live.quiet.rms > .00001, 'Live Output Level lowers a held note');
  assert.equal(result.liveRejected, true);
  assert.ok(Math.abs(live.afterInvalid.rms / live.quiet.rms - 1) < .1, 'Rejected batch cannot partly mute a held note');
  assert.ok(live.muted.rms < live.initial.rms * .002, 'Output Level zero mutes a held note');
  nearHz(live.fixed, 100, 'Live ratio to fixed mode');
  nearHz(live.restored, 440, 'Live fixed to ratio mode');
  nearHz(live.oldCohort, 440, 'Replacing a preset preserves its old held notes');
  assert.ok(Math.abs(live.oldCohort.rms / live.restored.rms - 1) < .1, 'New-preset edits do not change an older cohort');
  assert.ok(live.newMuted.rms < live.initial.rms * .002, 'New notes use the edited preset');
  nearHz(live.newHeld, 1320, 'New cohort responds to live edits');
  assert.ok(live.releaseMuted.rms < live.newHeld.rms * .002, 'Released notes also receive Output Level edits');
  assert.ok(live.releaseRestored.rms > live.newHeld.rms * .7, `A slow release continues without retriggering: ${JSON.stringify(live)}`);
  assert.deepEqual(result.errors, []);
  return result;
}

async function testErrors(page, base) {
  await page.goto(`${base}/demo/`);
  await page.evaluate(single => {
    const button = document.createElement('button');
    button.id = 'errors-start';
    button.textContent = 'Run error cleanup test';
    document.body.prepend(button);
    button.onclick = async () => {
      let context;
      try {
        context = new AudioContext();
        await context.resume();
        const { createDX7Node } = await import('/src/browser.js');
        const initErrors = [];
        let initRejected = false;
        try {
          await createDX7Node(context, { wasmBytes: new Uint8Array([0, 1, 2]), onError: error => initErrors.push(error.message) });
        } catch { initRejected = true; }

        const fatalErrors = [];
        const fatal = await createDX7Node(context, { onError: error => fatalErrors.push(error.message) });
        // Exercise an actual processor failure after readiness, with a following
        // request pending. The unknown command is rejected inside the Worklet.
        fatal.node.port.postMessage({ type: 'invalid-test-command' });
        const fatalRejected = await fatal.loadSysex(new Uint8Array(single)).then(() => false, () => true);
        const fatalClean = fatal.node.port.onmessage === null && fatal.node.onprocessorerror === null;
        let noteRejected = false;
        try { fatal.noteOn(60); } catch { noteRejected = true; }
        fatal.dispose();

        const disposing = await createDX7Node(context);
        const beforeDispose = disposing.node.port.onmessage;
        disposing.node.port.onmessage = event => { if (event.data.type !== 'result') beforeDispose(event); };
        const pendingPreset = disposing.setPreset({name:'DISPOSING'});
        const disposedPresetRejected = pendingPreset.then(() => false, () => true);
        disposing.dispose();
        const rejectedOnDispose = await disposedPresetRejected;

        const closeErrors = [];
        const closing = await createDX7Node(context, { onError: error => closeErrors.push(error.message) });
        // Hold the acknowledgement on the main thread so the request is known
        // to be pending when the real AudioContext close event arrives.
        const onMessage = closing.node.port.onmessage;
        closing.node.port.onmessage = event => { if (event.data.type !== 'result') onMessage(event); };
        const pending = closing.setOperators([]);
        const closeRejected = pending.then(() => false, () => true);
        await context.close();
        const rejectedOnClose = await closeRejected;
        const closeClean = closing.node.port.onmessage === null && closing.node.onprocessorerror === null;
        closing.dispose();
        window.__errorProbe = { initRejected, initErrors, fatalRejected, fatalErrors, fatalClean, noteRejected, rejectedOnDispose, rejectedOnClose, closeErrors, closeClean };
      } catch (error) {
        window.__errorProbe = { error: error.stack ?? String(error) };
        await context?.close().catch(() => {});
      }
    };
  }, [...single]);
  await page.locator('#errors-start').click();
  await page.waitForFunction(() => window.__errorProbe, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__errorProbe);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.initRejected, true);
  assert.equal(result.initErrors.length, 1, 'Initialization reports its fatal error once');
  assert.equal(result.fatalRejected, true);
  assert.equal(result.fatalErrors.length, 1, 'Processor failure reports its fatal error once');
  assert.equal(result.fatalClean, true);
  assert.equal(result.noteRejected, true);
  assert.equal(result.rejectedOnDispose, true, 'Disposal rejects an unacknowledged object update');
  assert.equal(result.rejectedOnClose, true);
  assert.equal(result.closeErrors.length, 1);
  assert.equal(result.closeClean, true);
}

const server = await createServer({ root, configFile, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const devBase = `http://127.0.0.1:${server.httpServer.address().port}`;
let built;
try {
  await build({ root, configFile, logLevel: 'error' });
  built = await preview({ root, configFile, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  const productionBase = `http://127.0.0.1:${built.httpServer.address().port}`;
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) {
    let browser;
    try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}) }); }
    catch (error) {
      if (/Executable doesn't exist|Please run.*playwright install/s.test(error.message)) { missing.push(name); continue; }
      throw error;
    }
    try {
      const page = await browser.newPage({ acceptDownloads: true });
      page.on('console', message => { if (message.type() === 'error') console.error(`[${name}] ${message.text()}`); });
      page.on('pageerror', error => console.error(`[${name}] ${error.message}`));
      for (const rate of [44100, 48000]) {
        const audio = await testAudio(page, devBase, rate);
        results.push({ browser: name, mode: 'AudioWorklet SysEx + live object API', rate, peak: audio.maxPeak, objectPeak:audio.objectPeak, live:audio.live });
      }
      await testErrors(page, devBase);
      results.push({ browser: name, mode: 'fatal + initialization + context-close cleanup', passed: true });
      await testDemo(page, devBase, `${name}-dev`);
      await testDemo(page, productionBase, `${name}-production`);
      results.push({ browser: name, mode: 'demo source + production', passed: true });
    } finally { await browser.close(); }
  }
  assert.ok(results.length, 'At least one installed browser is required.');
  console.log(JSON.stringify({ results, missingBrowsers: missing }, null, 2));
} finally {
  await server.close();
  if (built) await new Promise(resolve => built.httpServer.close(resolve));
}
