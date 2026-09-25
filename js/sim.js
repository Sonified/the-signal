import { S, Z_FAR, Z_NEAR, MAX_RINGS } from './state.js';
import { walkHue } from './color.js';

// ---------- edge particles ----------
export function seedParticles(n) {
  const particles = [];
  for (let i = 0; i < n; i++) {
    particles.push({
      u: i / n,
      speed: 0.018 + Math.random()*0.03,
      len: 0.012 + Math.random()*0.03,
      w: 1 + Math.random()*2.4,
      off: Math.random(),
      dir: 1,
      hue: Math.random(), hv: 0
    });
  }
  S.particles = particles;
  applyEdgeDir();
}

// Applied to the live particles rather than reseeding, so switching direction
// turns the existing stream around instead of restarting it. "Both" alternates
// by index so the two directions stay evenly interleaved at any density.
export function applyEdgeDir() {
  S.particles.forEach((p, i) => {
    p.dir = S.edgeDir === 'ccw' ? -1 : S.edgeDir === 'both' ? (i % 2 ? -1 : 1) : 1;
  });
}

export function updateParticles(dt) {
  if (!S.running) return;
  if (S.effEdgeSpeed <= 0) return;             // parked, but still breathing
  for (const p of S.particles) {
    p.u += p.dir * p.speed * S.effEdgeSpeed * dt * (0.5 + S.freq/10);
    if (S.perElementColor && S.colorWalk > 0) walkHue(p, dt);
    p.u -= Math.floor(p.u);                    // wraps correctly when running backwards
  }
}

// ---------- tunnel rings ----------
// Rings that pass the viewer are kept here and handed out again rather than
// left for the collector, since one is born on every strobe cycle for the
// whole session. Nothing holds a ring past the frame it is drawn in (the
// renderers read S.rings afresh each frame), so reusing one is invisible.
const ringPool = [];

export function emitRing(z) {
  if (S.rings.length >= MAX_RINGS) return;
  // squared distribution biases hard toward slow, so the field keeps
  // depth layers instead of everything moving as one sheet
  const s = Math.random() * Math.random();
  // Each ring keeps its own thickness factor for life. Variance widens the
  // range it is drawn from, so turning it up does not thicken everything, it
  // spreads the population between the thinnest and thickest possible line.
  const tw = 1 + (Math.random() * 2 - 1) * S.ringThickVar;
  const ring = ringPool.length ? ringPool.pop() : { z: 0, v: 0, hue: 0, hv: 0, tw: 1 };
  ring.z = z !== undefined ? z : Z_FAR; ring.v = 0.10 + s * 0.62;
  ring.hue = Math.random(); ring.hv = 0; ring.tw = Math.max(0.05, tw);
  S.rings.push(ring);
}

export function seedTunnel(n) {
  S.rings = [];
  for (let i = 0; i < n; i++) emitRing(Z_NEAR + Math.random() * (Z_FAR - Z_NEAR));
}

export function updateRings(dt, t) {
  if (S.running && S.phase < S.lastPhase && (t - S.lastRingEmit) > 0.19) {
    emitRing();
    S.lastRingEmit = t;
  }
  if (!S.running) return;
  // compacted in place; filter() built a new array every frame
  const rings = S.rings;
  let w = 0;
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    ring.z -= ring.v * S.ringSpeedMul * dt;
    if (S.perElementColor && S.colorWalk > 0) walkHue(ring, dt);
    if (ring.z > Z_NEAR) rings[w++] = ring;
    else if (ringPool.length < MAX_RINGS) ringPool.push(ring);
  }
  rings.length = w;
}
