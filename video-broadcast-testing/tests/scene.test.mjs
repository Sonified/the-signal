import { perspective, multiply, panelModel, layoutPanels } from '../js/scene.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

function project(mvp, x, y) {
  const v = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) v[r] = mvp[r] * x + mvp[4 + r] * y + mvp[12 + r];
  return { x: v[0] / v[3], y: v[1] / v[3], z: v[2] / v[3], w: v[3] };
}
function corners(proj, p) {
  const m = multiply(proj, panelModel(p));
  return [project(m, -0.5, -0.5), project(m, 0.5, -0.5), project(m, -0.5, 0.5), project(m, 0.5, 0.5)];
}

const FOV = 50 * Math.PI / 180;
const aspect = 16 / 9;
const proj = perspective(FOV, aspect, 0.1, 100);

// depth range
{
  const m = proj;
  const zn = project(Object.assign(new Float32Array(16), m), 0, 0); // origin: skip
  const pn = (z) => { const zc = m[10] * z + m[14], w = m[11] * z; return zc / w; };
  ok(near(pn(-0.1), 0, 1e-4) && near(pn(-100), 1, 1e-4), `depth near->0 far->1: ${pn(-0.1).toFixed(5)} ${pn(-100).toFixed(5)}`);
}

// one 4:3 panel, 1 m at 2.5 m
{
  const [p] = layoutPanels([0.75], 2.5, 1);
  ok(near(p.x, 0) && near(p.y, 0) && near(p.z, -2.5) && near(p.yaw, 0), `single panel straight ahead at (0,0,-2.5): ${JSON.stringify(p)}`);
  const c = corners(proj, p);
  const hFrac = (c[2].y - c[0].y) / 2;
  const expectH = 0.75 / (2 * 2.5 * Math.tan(FOV / 2));
  ok(near(hFrac, expectH, 1e-5), `height fraction ${hFrac.toFixed(5)} expected ${expectH.toFixed(5)}`);
  const wFrac = (c[1].x - c[0].x) / 2;
  const expectW = 1 / (2 * 2.5 * Math.tan(FOV / 2) * aspect);
  ok(near(wFrac, expectW, 1e-5), `width fraction ${wFrac.toFixed(5)} expected ${expectW.toFixed(5)}`);
  ok(near(c[0].x + c[1].x, 0) && near(c[0].y + c[2].y, 0), 'centred on screen');
  ok(c.every(q => q.z > 0 && q.z < 1), 'inside depth range');
}

// symmetry for several panels, one row
for (const n of [2, 3, 5, 8]) {
  const L = layoutPanels(new Array(n).fill(0.5625), 2.5, 1);
  let sym = true;
  for (let i = 0; i < n; i++) {
    const a = L[i], b = L[n - 1 - i];
    if (!near(a.x, -b.x) || !near(a.z, b.z) || !near(a.yaw, -b.yaw) || !near(a.y, 0)) sym = false;
    if (!near(Math.hypot(a.x, a.z), 2.5)) sym = false;
  }
  // gap between neighbours' facing edges ~ 0.1 m
  const [ca] = [corners(proj, L[0])];
  ok(sym, `${n} panels symmetric about centre, all at 2.5 m, eye height`);
  // neighbours: centre chord = 1.1
  if (n > 1) ok(near(Math.hypot(L[1].x - L[0].x, L[1].z - L[0].z), 1.1), `${n} panels centre chord 1.1 m`);
  // faces viewer: normal (-sin a,0,cos a) with yaw=-a ... the normal points from panel to origin
  const p = L[n - 1];
  const nx = Math.sin(p.yaw), nz = Math.cos(p.yaw); // column 2 of model = (-s,0,c) with s = sin(yaw)
  const mdl = panelModel(p);
  const toEye = [-p.x / 2.5, -p.z / 2.5];
  ok(near(mdl[8], toEye[0]) && near(mdl[10], toEye[1]), `${n} panels: edge panel faces the viewer`);
}

// rows: 30 panels, 1 m at 2.5 m
{
  const n = 30;
  const L = layoutPanels(new Array(n).fill(0.75), 2.5, 1);
  const ys = [...new Set(L.map(p => p.y.toFixed(6)))];
  const counts = ys.map(y => L.filter(p => p.y.toFixed(6) === y).length);
  const step = 2 * Math.asin(1.1 / 5);
  console.log(`  30 panels: step ${(step * 180 / Math.PI).toFixed(2)} deg, per row max ${Math.floor(2 * Math.PI / step)}, rows y=${ys.join(', ')} counts=${counts.join(', ')}`);
  ok(near(ys.map(Number).reduce((a, b) => a + b, 0), 0, 1e-5), 'rows symmetric about eye height');
  ok(counts.every(c => c * step <= 2 * Math.PI + 1e-9), 'no row exceeds a full circle');
  ok(L.every(p => p.w === 1), 'panels not shrunk');
  // each row symmetric
  let rowSym = true;
  for (const y of ys) {
    const row = L.filter(p => p.y.toFixed(6) === y);
    for (let i = 0; i < row.length; i++) if (!near(row[i].x, -row[row.length - 1 - i].x) || !near(row[i].z, row[row.length - 1 - i].z)) rowSym = false;
  }
  ok(rowSym, 'each row symmetric about straight ahead');
}

// extra-panel balancing: 29 panels -> 3 rows
{
  const L = layoutPanels(new Array(29).fill(0.75), 2.5, 1);
  const ys = [...new Set(L.map(p => p.y.toFixed(6)))];
  const counts = ys.map(y => L.filter(p => p.y.toFixed(6) === y).length);
  console.log(`  29 panels: counts=${counts.join(', ')}`);
  ok(counts.join() === [...counts].reverse().join(), '29 panels: row counts symmetric');
}
// huge panel close: chord clamp
{
  const L = layoutPanels([0.75, 0.75, 0.75], 0.4, 1);
  ok(L.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), `panel wider than the circle stays finite (rows=${new Set(L.map(p => p.y)).size})`);
}

// right edge along the arc tangent, and on screen to the right of the left edge
{
  const L = layoutPanels([0.75, 0.75, 0.75], 2.5, 1);
  const p = L[2], a = -p.yaw, m = panelModel(p);
  ok(near(m[0], Math.cos(a)) && near(m[2], Math.sin(a)), 'right panel: its right edge runs along the arc tangent');
  const c = corners(proj, p);
  ok(c[1].x > c[0].x && c[3].y > c[1].y, 'right panel not mirrored on screen');
}
// every count 1..40: rows within a circle, total right, balanced where possible
{
  const step = 2 * Math.asin(1.1 / 5), perRow = Math.floor(2 * Math.PI / step);
  let good = true, seen = [];
  for (let n = 1; n <= 40; n++) {
    const L = layoutPanels(new Array(n).fill(0.75), 2.5, 1);
    const ys = [...new Set(L.map(p => p.y.toFixed(6)))];
    const counts = ys.map(y => L.filter(p => p.y.toFixed(6) === y).length);
    const balanced = counts.join() === [...counts].reverse().join();
    const canBalance = !(counts.length % 2 === 0 && n % counts.length % 2 === 1);
    if (L.length !== n || counts.some(c => c > perRow) || (canBalance && !balanced)) { good = false; console.log('  bad', n, counts); }
    if ([14, 15, 16, 29, 30, 40].includes(n)) seen.push(`${n}:${counts.join('/')}`);
  }
  console.log('  ' + seen.join('  '));
  ok(good, 'counts 1..40: right total, no row past a full circle, balanced whenever it can be');
}

console.log(fails ?`${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
