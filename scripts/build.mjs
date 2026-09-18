import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFile(path.join(root, f), 'utf8');
const plain = s => s.replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');
const protocol = plain(await read('src/protocol.mjs')), modem = plain(await read('src/modem.mjs'));
const worker = protocol + '\n' + modem + '\n' + plain(await read('src/decoder-worker.mjs'));
const script = `'use strict';\n(async () => {\nconst decoderWorkerSource = ${JSON.stringify(worker)};\nconst audioWorkletSource = ${JSON.stringify(await read('src/capture-worklet.js'))};\n${protocol}\n${modem}\n${plain(await read('src/selftest.mjs'))}\n${plain(await read('src/app.mjs'))}\n})();`;
const html = (await read('src/index.html')).replace('/* STYLE */', await read('src/style.css')).replace('/* SCRIPT */', () => script.replace(/<\/script/gi, '<\\/script'));
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/io-note.html'), html);
// docs/ is the same bytes, laid out for static hosting: GitHub Pages can serve it directly
// from a branch, which is what the HTTPS preview needs for microphone permissions. The
// host serves this file and nothing else; it carries no part of message transport.
await mkdir(path.join(root, 'docs'), { recursive: true });
await writeFile(path.join(root, 'docs/index.html'), html);
await writeFile(path.join(root, 'docs/robots.txt'), 'User-agent: *\nDisallow: /\n');
await writeFile(path.join(root, 'docs/.nojekyll'), '');
console.log(`Built dist/io-note.html and docs/index.html (${Buffer.byteLength(html)} bytes each); no dependencies or external resources.`);
