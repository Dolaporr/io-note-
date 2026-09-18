// Optional browser check. Not part of `npm test`; the app itself has no dependencies.
// Needs Playwright and its Chromium reachable from this machine:
//   npx playwright install chromium && node scripts/browser-check.mjs
//   IO_NOTE_PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/browser-check.mjs
// It drives the built dist/io-note.html over file:// exactly as a person would:
// Run loopback, every adversarial case, Generate key. It never touches the
// microphone, so it establishes nothing about live audio or physical transport.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.IO_NOTE_PLAYWRIGHT || 'playwright');
const target = pathToFileURL(path.join(root, 'dist/io-note.html')).href;
const attacks = ['message', 'signature', 'public-key', 'truncate', 'nonce', 'bit'];
const text = (page, id) => page.evaluate(i => document.getElementById(i).textContent.trim(), id);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleOutput = [];
page.on('console', m => consoleOutput.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleOutput.push(`[pageerror] ${e.message}`));
await page.goto(target);
const report = { generatedAt: new Date().toISOString(), target, host: { node: process.version, platform: `${os.platform()} ${os.arch()}` }, userAgent: await page.evaluate(() => navigator.userAgent), microphoneExercised: false, physicalAudio: { attempted: false, reason: 'Headless browser check; no speaker, microphone, or second device involved.' } };

report.gate = { transmitDisabledBeforeLoopback: await page.isDisabled('#transmit'), listenDisabledBeforeLoopback: await page.isDisabled('#listen'), attackDisabledBeforeLoopback: await page.isDisabled('#run-attack') };
await page.click('#selftest');
await page.waitForFunction(() => !document.getElementById('gate-text').textContent.includes('Decoding'), null, { timeout: 60000 });
report.loopback = await page.evaluate(() => ({ gateText: document.getElementById('gate-text').textContent.trim(), gatePassed: document.getElementById('gate-dot').className.includes('pass'), mode: document.getElementById('mode').textContent.trim(), status: document.getElementById('status').textContent.trim(), message: document.getElementById('received').textContent.trim(), fingerprint: document.getElementById('received-key').textContent.trim(), packetBytes: document.getElementById('m-bytes').textContent.trim(), transmittedBits: document.getElementById('m-bits').textContent.trim(), audioSeconds: document.getElementById('m-time').textContent.trim(), timing: document.getElementById('timing').textContent.trim() }));
report.gate.listenEnabledAfterLoopback = !await page.isDisabled('#listen');
report.gate.attackEnabledAfterLoopback = !await page.isDisabled('#run-attack');

report.adversarial = [];
await page.evaluate(() => { document.querySelector('details').open = true; });
for (const attack of attacks) {
  await page.selectOption('#attack', attack);
  await page.click('#run-attack');
  await page.waitForFunction(a => document.getElementById('mode').textContent.includes(a.toUpperCase()), attack, { timeout: 60000 });
  report.adversarial.push({ attack, status: await text(page, 'status'), detail: await text(page, 'received') });
}

await page.click('#generate');
await page.waitForFunction(() => document.getElementById('sender-key').textContent.length === 64, null, { timeout: 60000 });
report.identity = { generatedFingerprintLength: (await text(page, 'sender-key')).length, transmitEnabledAfterKeygen: !await page.isDisabled('#transmit') };
report.decodeCounters = await text(page, 'm-decodes');
report.consoleOutput = consoleOutput;
await browser.close();

const expected = { message: 'SIGNATURE INVALID', signature: 'SIGNATURE INVALID', 'public-key': 'SIGNATURE INVALID', truncate: 'TRANSPORT CORRUPTED', nonce: 'REPLAYED PACKET', bit: 'TRANSPORT CORRUPTED' };
const failures = [
  ...(report.loopback.status === 'SIGNATURE VERIFIED' && report.loopback.gatePassed ? [] : ['loopback did not verify']),
  ...report.adversarial.filter(r => r.status !== expected[r.attack]).map(r => `${r.attack}: ${r.status} (expected ${expected[r.attack]})`),
  ...(consoleOutput.length ? [`console output: ${consoleOutput.join(' | ')}`] : []),
];
report.allExpectedOutcomes = failures.length === 0;
report.failures = failures;
await writeFile(path.join(root, 'results/browser-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${report.userAgent}\nloopback: ${report.loopback.status}; ${report.adversarial.map(r => `${r.attack}=${r.status}`).join(', ')}`);
console.log(failures.length ? `FAILED:\n- ${failures.join('\n- ')}` : 'All browser outcomes matched the documented expectations. Microphone and physical audio were NOT exercised.');
process.exit(failures.length ? 1 : 0);
