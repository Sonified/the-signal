// ---------- canvas2d (original path, kept as the last resort) ----------
import { S, layers, HUE_STEPS, Z_NEAR } from '../state.js';
import { cv } from '../dom.js';
import { shape, smoothstep, hslToRgb } from '../util.js';
import { ensurePalette, hueStr, bandHue } from '../color.js';
import { visW, visCx, perimeterPoint, px, py } from '../geometry.js';

// Gradients are expensive to build, so they are cached at full opacity and
// scaled with globalAlpha instead of being rebuilt every frame. Rebuilding
// five of these per frame was enough to blow the frame budget and drop frames,
// which is what made the strobe look uneven.
let gradCache = { key:'', disc:null, corners:null };

// Forces the shared gradients to rebuild on the next frame.
export function invalidateGradients() { gradCache.key = ''; }

function ensureGradients() {
  const ctx = S.ctx, W = S.W, H = S.H, rgb = S.rgb;
  // Color is quantised to 16 levels per channel for cache purposes. A walking
  // hue would otherwise rebuild five gradients every single frame, which is the
  // exact allocation churn that caused GC stalls before.
  const key = `${W}x${H}|${S.edgeInset>>3}|${rgb[0]>>4},${rgb[1]>>4},${rgb[2]>>4}`;
  if (gradCache.key === key) return;
  const cx = visCx(), cy = H/2, size = Math.min(visW(),H)*0.62;
  const solid = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  const clear = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`;

  const disc = ctx.createRadialGradient(cx,cy,0,cx,cy,size/2);
  disc.addColorStop(0, solid);
  disc.addColorStop(.72, solid);
  disc.addColorStop(1, clear);

  const R = Math.min(visW(),H)*0.46;
  const corners = [[S.edgeInset,0],[W,0],[W,H],[S.edgeInset,H]].map(([x,y]) => {
    const g = ctx.createRadialGradient(x,y,0,x,y,R);
    g.addColorStop(0, solid);
    g.addColorStop(1, clear);
    return { g, x, y, R };
  });

  gradCache = { key, disc, corners };
}

function drawField(lum) {
  const ctx = S.ctx, H = S.H, rgb = S.rgb;
  const level = S.effBright * (1 - S.effDepth + S.effDepth*lum);
  if (level <= 0.002) return;
  const cx = visCx(), cy = H/2, size = Math.min(visW(),H)*0.62;

  ctx.globalAlpha = level;
  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  if (S.fieldShape === 'full') {
    ctx.fillRect(S.edgeInset,0,visW(),H);
  } else if (S.fieldShape === 'panel') {
    const r = 18, x = cx-size/2, y = cy-size/2;
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+size,y,x+size,y+size,r);
    ctx.arcTo(x+size,y+size,x,y+size,r);
    ctx.arcTo(x,y+size,x,y,r);
    ctx.arcTo(x,y,x+size,y,r);
    ctx.fill();
  } else {
    ctx.fillStyle = gradCache.disc;
    ctx.beginPath(); ctx.arc(cx,cy,size/2,0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRings() {
  const ctx = S.ctx, H = S.H, rgb = S.rgb, rings = S.rings;
  const cx = visCx(), cy = H/2;
  const maxR = Math.hypot(visW(),H) * 0.62;
  const FOCAL = maxR * Z_NEAR;

  // sorted in place: slice() here allocated a fresh array every frame
  rings.sort((a,b) => b.z - a.z);
  if (!S.perElementColor) ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  for (const ring of rings) {
    const r = FOCAL / ring.z;
    const k = r / maxR;                       // 0 at the vanishing point, 1 at the rim
    // fade-in is driven by how far out the ring has travelled, not by its age,
    // so the slider reads as "how late do rings become visible"
    // The exponent biases the ramp later as the slider rises, so at 100% rings
    // stay essentially invisible through the middle and only bloom near the rim.
    const fadeIn  = S.ringFade < 0.01 ? 1
                  : Math.pow(smoothstep(0, S.ringFade * 0.98, k), 1 + S.ringFade*2);
    const fadeOut = k < 0.72 ? 1 : Math.max(0, (1 - k) / 0.28);
    const a = fadeIn * fadeOut * 0.62 * S.effRingBright;
    if (a <= 0.003) continue;
    if (S.perElementColor) ctx.strokeStyle = hueStr(ring.hue);
    ctx.globalAlpha = a;
    ctx.lineWidth = (0.7 + k * 3.4) * S.ringThick * ring.tw;   // nearer reads thicker
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawCorners() {
  const ctx = S.ctx;
  // each corner runs a quarter-cycle behind the last, so attention
  // travels around the periphery instead of pulsing all at once
  for (let i = 0; i < 4; i++) {
    const a = shape((S.phase + i/4) % 1) * 0.5 * S.bright * S.effDepth;
    if (a <= 0.003) continue;
    const c = gradCache.corners[i];

    // A corner glow is a gradient, so its color is baked in and cannot ride
    // globalAlpha the way a flat fill can. Its hue is quantised and the
    // gradient rebuilt only when it crosses a step, which at walking speed is
    // a handful of times a second rather than every frame.
    if (S.perElementColor) {
      const idx = (bandHue(S.cornerHue[i]) * HUE_STEPS | 0) % HUE_STEPS;
      if (c.hueIdx !== idx) {
        const col = hslToRgb(idx/HUE_STEPS, S.hueSat, S.hueLight);
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.R);
        g.addColorStop(0, `rgb(${col[0]},${col[1]},${col[2]})`);
        g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        c.g = g; c.hueIdx = idx;
      }
    } else if (c.hueIdx !== undefined) {
      c.hueIdx = undefined;
      gradCache.key = '';            // force the shared gradients to rebuild
    }

    ctx.globalAlpha = a;
    ctx.fillStyle = c.g;
    ctx.fillRect(c.x - c.R, c.y - c.R, c.R*2, c.R*2);
  }
  ctx.globalAlpha = 1;
}

// Scratch for the tail polygon. Reused every frame so this allocates nothing.
const _lx = new Float32Array(32), _ly = new Float32Array(32);
const _rx = new Float32Array(32), _ry = new Float32Array(32);

function drawEdge() {
  const ctx = S.ctx, rgb = S.rgb;
  ctx.lineJoin = 'round';
  if (!S.perElementColor) ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  for (const p of S.particles) {
    if (S.perElementColor) ctx.fillStyle = hueStr(p.hue);
    // each particle breathes on the master clock, offset so they shimmer
    const lum = shape((S.phase + p.off) % 1);
    const a = (0.25 + 0.75*lum) * 0.75 * S.bright;
    if (a < 0.004) continue;

    const len = p.len * S.trailMul;
    const wid = p.w * S.effEdgeSize;

    // A tail is just a triangle: full width at the head, tapering to a point.
    // Sampled along the perimeter only so it bends at corners; 12 samples is
    // plenty for a path that is straight apart from at most one right angle.
    const steps = 12, inv = 1/steps;
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i*inv;
      perimeterPoint(p.u - p.dir*len*t);
      const cx = px, cy = py;
      perimeterPoint(p.u - p.dir*len*(t + inv*0.5));
      let dx = px - cx, dy = py - cy;
      const m = Math.hypot(dx, dy) || 1;
      dx /= m; dy /= m;
      const hw = wid * 0.5 * (1 - t);           // straight taper to nothing
      _lx[n] = cx - dy*hw; _ly[n] = cy + dx*hw;
      _rx[n] = cx + dy*hw; _ry[n] = cy - dx*hw;
      n++;
    }

    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.moveTo(_lx[0], _ly[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(_lx[i], _ly[i]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(_rx[i], _ry[i]);
    ctx.closePath();
    ctx.fill();

    // rounds off the leading tip, same width as the tail's base
    perimeterPoint(p.u);
    ctx.beginPath(); ctx.arc(px, py, wid*0.5, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function initCanvas2D() {
  const ctx = cv.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) return null;
  S.ctx = ctx;
  ctx.setTransform(S.DPR, 0, 0, S.DPR, 0, 0);
  return {
    name: 'Canvas2D',
    resize() { if (S.ctx) S.ctx.setTransform(S.DPR, 0, 0, S.DPR, 0, 0); },
    draw(lum) {
      ensurePalette();
      ensureGradients();
      const c = S.ctx;
      c.globalAlpha = 1;
      c.fillStyle = '#000'; c.fillRect(0, 0, S.W, S.H);
      c.globalCompositeOperation = 'lighter';
      if (layers.field)   drawField(lum);
      if (layers.rings)   drawRings();
      if (layers.corners) drawCorners();
      if (layers.edge)    drawEdge();
      c.globalCompositeOperation = 'source-over';
    }
  };
}
