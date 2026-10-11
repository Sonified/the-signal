// node tools/build-cloud-presentation.mjs <empty output directory> <media manifest> <journey file>
// Package a snapshot separately from the ordinary Pages/Git deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [destination, manifestFile, journeyFile] = process.argv.slice(2);
if (!destination || !manifestFile || !journeyFile) throw Error('Output directory, media manifest and Journey file are required');
const output = path.resolve(destination);
if (output === path.resolve(root) || !output.startsWith('/private/tmp/')) throw Error('Use a separate /private/tmp output directory');
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw Error('Output directory must be empty');
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
const journeyText = await fs.readFile(journeyFile, 'utf8');
const journey = JSON.parse(journeyText);
if (journey.ver !== 2 || !Array.isArray(journey.steps) || !journey.steps.length) throw Error('Expected an exported v2 Journey');
const available = new Set(manifest.videos.map(v => v.file));
for (const step of journey.steps) {
  const file = step.overrides?.slideFile;
  if (file && file !== 'none' && !available.has(file)) throw Error('Journey video missing: ' + file);
}
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
for (const file of tracked) {
  if (file.startsWith('.') || file.startsWith('documents/')) continue;
  const from = path.join(root, file), to = path.join(output, file);
  let stat;
  try { stat = await fs.stat(from); } catch { continue; }
  if (!stat.isFile()) continue;
  if (stat.size > 25 * 1024 ** 2) throw Error('Pages asset exceeds 25 MiB: ' + file);
  await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
}
await fs.cp(path.join(root, 'slides/previews/144p-30fps'), path.join(output, 'slides/previews/144p-30fps'), { recursive: true });
await fs.copyFile(path.join(root, 'slides/qr_overlay_TSC2026@2x.png'), path.join(output, 'slides/qr_overlay_TSC2026@2x.png'));
await fs.copyFile(path.join(root, 'tools/presentation-media-handler.mjs'), path.join(output, 'presentation-media-handler.mjs'));
await fs.copyFile(path.join(root, 'tools/presentation-entry.html'), path.join(output, 'presentation.html'));
await fs.mkdir(path.join(output, 'functions/slides'), { recursive: true });
await fs.writeFile(path.join(output, 'functions/slides/[[path]].js'),
  `import { createSlideMediaHandler } from '../../presentation-media-handler.mjs';\nexport const onRequest = createSlideMediaHandler(${JSON.stringify(manifest)});\n`);
await fs.writeFile(path.join(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/slides/*'], exclude: ['/slides/previews/*', '/slides/*.png'] }, null, 2));
await fs.writeFile(path.join(output, 'wrangler.jsonc'), JSON.stringify({ name: 'presence-presentation',
  pages_build_output_dir: '.', compatibility_date: '2026-10-01',
  r2_buckets: [{ binding: 'SLIDE_MEDIA', bucket_name: manifest.bucket }] }, null, 2));
const revision = createHash('sha256').update(journeyText).digest('hex').slice(0, 16);
// A blocking script seeds storage before the engine modules evaluate. Each
// revision imports once; browser edits survive reload and stay local.
const seed = `(()=>{try{const marker='signal.presentationJourney.${revision}';if(localStorage.getItem(marker))return;\n` +
  `let lib;try{lib=JSON.parse(localStorage.getItem('signal.journeys.v1')||'null');}catch{}\n` +
  `if(!lib||!Array.isArray(lib.items))lib={ver:1,cur:'',items:[]};\n` +
  `const id='j'+(Math.max(0,...lib.items.map(it=>parseInt(String(it.id).slice(1),10)||0))+1);\n` +
  `localStorage.setItem('signal.journey.v1.'+id,JSON.stringify(${JSON.stringify(journey)}));\n` +
  `lib.items.push({id,title:'TSC 2026'});lib.cur=id;localStorage.setItem('signal.journeys.v1',JSON.stringify(lib));\n` +
  `localStorage.setItem(marker,'1');console.log('[presentation] TSC 2026 Journey installed (${journey.steps.length} steps)');\n` +
  `}catch(error){console.error('[presentation] Journey could not be installed',error);}})();\n` +
  // Every load starts in journey mode (the Journey window's mode switch,
  // signal.v1.ui journeyWin.active): Space and the arrows walk the show.
  `(()=>{try{let ui;try{ui=JSON.parse(localStorage.getItem('signal.v1.ui')||'null');}catch{}\n` +
  `if(!ui||typeof ui!=='object')ui={};const w=ui.journeyWin&&typeof ui.journeyWin==='object'?ui.journeyWin:{};\n` +
  `w.active=true;ui.journeyWin=w;localStorage.setItem('signal.v1.ui',JSON.stringify(ui));\n` +
  `}catch(error){console.error('[presentation] Journey mode could not be set',error);}})();\n` +
  // Every load broadcasts the TSC2026 stream (signal.broadcast.v1, read by
  // core/broadcast.js): key typed in, session present and switched on, so
  // the app opens it at boot. Viewers follow at ?follow=tsc2026.
  `(()=>{try{let b;try{b=JSON.parse(localStorage.getItem('signal.broadcast.v1')||'null');}catch{}\n` +
  `if(!b||typeof b!=='object')b={};if(!Array.isArray(b.sessions))b.sessions=[];b.key='presence';\n` +
  `let s=b.sessions.find(x=>x&&x.room==='tsc2026');if(!s){s={name:'TSC2026',room:'tsc2026',mode:'open',unlock:0};b.sessions.push(s);}\n` +
  `s.active=true;localStorage.setItem('signal.broadcast.v1',JSON.stringify(b));\n` +
  `}catch(error){console.error('[presentation] TSC2026 broadcast could not be set',error);}})();\n`;
await fs.writeFile(path.join(output, 'presentation-seed.js'), seed);
const indexFile = path.join(output, 'index.html');
const index = await fs.readFile(indexFile, 'utf8');
await fs.writeFile(indexFile, index.replace('<script type="module" src="main.js">', '<script src="presentation-seed.js"></script>\n<script type="module" src="main.js">'));
const showFile = path.join(output, 'show.html');
const show = await fs.readFile(showFile, 'utf8');
await fs.writeFile(showFile, show.replace("'https://sun-layer.presence-generator.pages.dev'", "'https://presence-presentation.pages.dev'"));
await fs.writeFile(path.join(output, 'presentation-build.json'), JSON.stringify({ builtAt: new Date().toISOString(),
  mediaRelease: manifest.release, journeyRevision: revision, steps: journey.steps.length, videos: manifest.videos.length }, null, 2));
console.log(JSON.stringify({ output, mediaRelease: manifest.release, journeyRevision: revision, steps: journey.steps.length, videos: manifest.videos.length }));
