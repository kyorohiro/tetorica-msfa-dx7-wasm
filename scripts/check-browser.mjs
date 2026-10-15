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
  await page.evaluate(({ rate, single }) => {
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
        const silentPeak = peak();
        instrument.dispose();
        instrument.dispose();
        let disposedRejected = false;
        try { instrument.noteOn(60); } catch { disposedRejected = true; }
        await context.close();
        window.__probe = { rate: context.sampleRate, maxPeak, silentPeak, name, rejected, preserved, disposedRejected, errors };
      } catch (error) { window.__probe = { error: error.stack ?? String(error) }; }
    };
  }, { rate, single: [...single] });
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

        const closeErrors = [];
        const closing = await createDX7Node(context, { onError: error => closeErrors.push(error.message) });
        // Hold the acknowledgement on the main thread so the request is known
        // to be pending when the real AudioContext close event arrives.
        const onMessage = closing.node.port.onmessage;
        closing.node.port.onmessage = event => { if (event.data.type !== 'result') onMessage(event); };
        const pending = closing.loadSysex(new Uint8Array(single));
        const closeRejected = pending.then(() => false, () => true);
        await context.close();
        const rejectedOnClose = await closeRejected;
        const closeClean = closing.node.port.onmessage === null && closing.node.onprocessorerror === null;
        closing.dispose();
        window.__errorProbe = { initRejected, initErrors, fatalRejected, fatalErrors, fatalClean, noteRejected, rejectedOnClose, closeErrors, closeClean };
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
        results.push({ browser: name, mode: 'AudioWorklet', rate, peak: audio.maxPeak });
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
