// Optional browser check. Not part of `npm test`; the app itself has no dependencies.
// Needs Playwright and its Chromium reachable from this machine:
//   npx playwright install chromium && node scripts/browser-check.mjs
//   IO_NOTE_PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/browser-check.mjs
//
// Stage 1 drives dist/io-note.html over file:// exactly as a person would: Run loopback,
// every adversarial case, Generate key. Stage 2 serves the same file from 127.0.0.1 (a
// secure context, like the HTTPS preview) and runs the REAL microphone path -- getUserMedia,
// AudioWorklet capture, worker decode, verification -- with Chromium's fake capture device
// fed from results/synthetic-input.wav.
//
// Stage 2 is a synthetic capture device, NOT a speaker, a room, or a second device. It
// establishes nothing about physical acoustic transport.
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.IO_NOTE_PLAYWRIGHT || 'playwright');
const attacks = ['message', 'signature', 'public-key', 'truncate', 'nonce', 'bit'];
const expected = { message: 'SIGNATURE INVALID', signature: 'SIGNATURE INVALID', 'public-key': 'SIGNATURE INVALID', truncate: 'TRANSPORT CORRUPTED', nonce: 'REPLAYED PACKET', bit: 'TRANSPORT CORRUPTED' };
const VERDICTS = ['SIGNATURE VERIFIED', 'SIGNATURE INVALID', 'TRANSPORT CORRUPTED', 'REPLAYED PACKET', 'NO PACKET DECODED', 'RECEIVER ERROR', 'ACTION FAILED'];
const html = await readFile(path.join(root, 'dist/io-note.html'));
const text = (page, id) => page.evaluate(i => document.getElementById(i).textContent.trim(), id);
const failures = [];
const report = { generatedAt: new Date().toISOString(), host: { node: process.version, platform: `${os.platform()} ${os.arch()}` }, physicalAudio: { attempted: false, reason: 'Headless browser check. Stage 2 uses a synthetic fake capture device; no speaker, room, or second device is involved.' } };

async function newPage(browser, origin) {
  const context = await browser.newContext(origin ? { permissions: ['microphone'], ignoreHTTPSErrors: true } : {});
  const page = await context.newPage();
  page.consoleOutput = [];
  page.on('console', m => page.consoleOutput.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => page.consoleOutput.push(`[pageerror] ${e.message}`));
  return page;
}
async function loopback(page) {
  await page.click('#selftest');
  await page.waitForFunction(() => !document.getElementById('gate-text').textContent.includes('Decoding'), null, { timeout: 60000 });
  return page.evaluate(() => ({ gateText: document.getElementById('gate-text').textContent.trim(), gatePassed: document.getElementById('gate-dot').className.includes('pass'), mode: document.getElementById('mode').textContent.trim(), status: document.getElementById('status').textContent.trim(), message: document.getElementById('received').textContent.trim(), fingerprint: document.getElementById('received-key').textContent.trim(), packetBytes: document.getElementById('m-bytes').textContent.trim(), transmittedBits: document.getElementById('m-bits').textContent.trim(), audioSeconds: document.getElementById('m-time').textContent.trim(), timing: document.getElementById('timing').textContent.trim() }));
}
const diagnostics = page => page.evaluate(() => Object.fromEntries(['d-framing', 'd-level', 'd-tone', 'd-symbols', 'd-sync', 'd-bits', 'd-crc', 'd-sig', 'd-trace', 'd-updated'].map(i => [i.slice(2), document.getElementById(i).textContent.trim()])));

// ---- Stage 1: file:// UI, loopback gate, adversarial lab, key generation ----
{
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await newPage(browser);
  await page.goto(pathToFileURL(path.join(root, 'dist/io-note.html')).href);
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  report.fileStage = { target: 'file://dist/io-note.html', gate: { transmitDisabledBeforeLoopback: await page.isDisabled('#transmit'), listenDisabledBeforeLoopback: await page.isDisabled('#listen'), attackDisabledBeforeLoopback: await page.isDisabled('#run-attack') } };
  report.fileStage.loopback = await loopback(page);
  report.fileStage.gate.listenEnabledAfterLoopback = !await page.isDisabled('#listen');
  report.fileStage.adversarial = [];
  await page.evaluate(() => { document.querySelector('details').open = true; });
  for (const attack of attacks) {
    await page.selectOption('#attack', attack);
    await page.click('#run-attack');
    await page.waitForFunction(a => document.getElementById('mode').textContent.includes(a.toUpperCase()), attack, { timeout: 60000 });
    report.fileStage.adversarial.push({ attack, status: await text(page, 'status'), detail: await text(page, 'received') });
  }
  await page.click('#generate');
  await page.waitForFunction(() => document.getElementById('sender-key').textContent.length === 64, null, { timeout: 60000 });
  report.fileStage.identity = { fingerprintLength: (await text(page, 'sender-key')).length, transmitEnabledAfterKeygen: !await page.isDisabled('#transmit') };
  // Role switching must hide the other device's panel.
  await page.click('#mode-sender');
  report.fileStage.roles = { senderHidesReceiver: !await page.isVisible('#receiver-panel') };
  await page.click('#mode-receiver');
  report.fileStage.roles.receiverHidesSender = !await page.isVisible('#sender-panel');
  report.fileStage.roles.receiverShowsDiagnostics = await page.isVisible('#diagnostics-panel');
  await page.click('#mode-both');
  report.fileStage.roles.bothShowsEverything = await page.isVisible('#sender-panel') && await page.isVisible('#receiver-panel');
  report.fileStage.consoleOutput = page.consoleOutput;
  await browser.close();
  if (!report.fileStage.loopback.gatePassed || report.fileStage.loopback.status !== 'SIGNATURE VERIFIED') failures.push('file:// loopback did not verify');
  for (const r of report.fileStage.adversarial) if (r.status !== expected[r.attack]) failures.push(`file:// ${r.attack}: ${r.status} (expected ${expected[r.attack]})`);
  for (const [k, v] of Object.entries(report.fileStage.roles)) if (!v) failures.push(`role switching: ${k} is false`);
  if (page.consoleOutput.length) failures.push(`file:// console output: ${page.consoleOutput.join(' | ')}`);
}

// ---- Stage 2: secure context over localhost, real microphone path, synthetic capture ----
{
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(root, 'results/synthetic-input.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await newPage(browser, origin);
  try {
    await page.goto(origin + '/');
    report.microphoneStage = { origin, secureContext: await page.evaluate(() => globalThis.isSecureContext), fakeCapture: 'results/synthetic-input.wav via --use-file-for-fake-audio-capture' };
    report.microphoneStage.loopback = await loopback(page);
    await page.click('#mode-receiver');
    await page.click('#listen');
    await page.waitForFunction(() => document.getElementById('mode').textContent.includes('ARMED') || document.getElementById('status').textContent.includes('ERROR'), null, { timeout: 30000 });
    report.microphoneStage.armed = await text(page, 'rx-note');
    await page.waitForFunction(v => v.includes(document.getElementById('status').textContent.trim()), VERDICTS, { timeout: 120000 });
    report.microphoneStage.verdict = { mode: await text(page, 'mode'), status: await text(page, 'status'), message: await text(page, 'received'), fingerprint: await text(page, 'received-key'), timing: await text(page, 'timing') };
    report.microphoneStage.diagnostics = await diagnostics(page);
    report.microphoneStage.log = (await text(page, 'd-log')).split('\n');
    report.microphoneStage.counters = await text(page, 'm-decodes');
  } catch (e) {
    report.microphoneStage = { ...report.microphoneStage, error: e.message, diagnostics: await diagnostics(page).catch(() => null), log: await text(page, 'd-log').catch(() => null) };
    failures.push(`microphone stage: ${e.message}`);
  }
  report.microphoneStage.consoleOutput = page.consoleOutput;
  await browser.close(); server.close();
  const v = report.microphoneStage.verdict;
  if (!v || v.status !== 'SIGNATURE VERIFIED') failures.push(`microphone stage verdict: ${v ? v.status : 'none'} (expected SIGNATURE VERIFIED)`);
  else if (v.message !== 'hello, io-note') failures.push(`microphone stage message: ${v.message}`);
  if (page.consoleOutput.length) failures.push(`microphone stage console output: ${page.consoleOutput.join(' | ')}`);
}

report.physicalAudioVerified = false;
report.allExpectedOutcomes = failures.length === 0;
report.failures = failures;
await writeFile(path.join(root, 'results/browser-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(report.userAgent);
console.log(`file:// loopback: ${report.fileStage.loopback.status}; ${report.fileStage.adversarial.map(r => `${r.attack}=${r.status}`).join(', ')}`);
console.log(`microphone path: ${report.microphoneStage?.verdict?.status ?? report.microphoneStage?.error} · ${report.microphoneStage?.diagnostics?.framing ?? ''} · crc ${report.microphoneStage?.diagnostics?.crc ?? ''}`);
console.log(failures.length ? `FAILED:\n- ${failures.join('\n- ')}` : 'All browser outcomes matched expectations. Physical acoustic transport was NOT exercised and is NOT verified.');
process.exit(failures.length ? 1 : 0);
