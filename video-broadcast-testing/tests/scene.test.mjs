import { perspective, multiply, panelModel, placeAhead } from '../js/scene.js';

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
  const p = placeAhead(0.75, 2.5, 1);
  ok(near(p.x, 0) && near(p.y, 0) && near(p.z, -2.5), `the window stands straight ahead at (0,0,-2.5): ${JSON.stringify(p)}`);
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

// upright on screen: the picture's left stays left, its top stays top
{
  const c = corners(proj, placeAhead(0.75, 2.5, 1));
  ok(c[1].x > c[0].x && c[2].y > c[0].y, 'not mirrored and not upside down');
}

// a phone held upright (9:19.5): the window is still centred and whole
{
  const tall = perspective(FOV, 9 / 19.5, 0.1, 100);
  const c = corners(tall, placeAhead(0.75, 2.5, 1));
  ok(near(c[0].x + c[1].x, 0) && near(c[0].y + c[2].y, 0), 'upright phone: centred');
  ok(c.every(q => Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1), `upright phone: the whole window is on screen (half-width ${c[1].x.toFixed(3)})`);
}

console.log(fails ?`${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
