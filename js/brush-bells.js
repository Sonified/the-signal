// Brush notes, the sound: each drawing hand's bell (core/brush-notes.js has
// the law; core/brush.js says when one rings). A bell is one FM pair, a
// sine carrier whose frequency a sine modulator swings (ratio near 3.5 for
// the inharmonic shimmer of a struck bar), the modulation's depth falling
// away quickly (bright onset, mellow tail) under an amplitude that rings
// down over about two seconds. Each strike builds its own few nodes and
// lets them go when it has rung out, at most MAX_VOICES at once (a strike
// past that is let go, never a click).
//
// It plays on the music family's context into the family's master, as the
// piano does (so the master volume, the output guard and Heart's routing all
// apply), dry and through its own send into the master reverb room
// (js/room.js), the send being its own gate: a strike only sends while the
// room shares its context, so it never moves the room. The level is a
// gentle accent, PEAK well under the piano's notes. Nothing sounds before
// the sound is on (S.audioEnabled, after the viewer's audio unlock), and
// nothing at all is built while Brush notes is off.

import { S } from './state.js';
import { getContext, getMaster } from './audio.js';
import { peekCtxFor, peekMasterFor } from './heart/route.js';
import { roomInput, roomContext } from './room.js';
import { bellFor, degreeHz } from '../core/brush-notes.js';

const PEAK = 0.05;        // the strike's peak gain (the piano's notes sit several times higher)
const SEND = 0.35;        // into the room
const MAX_VOICES = 12;
let live = 0;

// One strike of the bell for seed at a scale degree.
export function ringBell(seed, degree) {
  if (S.brushNotes !== true || !S.audioEnabled || live >= MAX_VOICES) return;
  const ctx = peekCtxFor('music') || getContext();
  const master = peekMasterFor('music') || getMaster();
  if (!ctx || !master || ctx.state !== 'running') return;
  const b = bellFor(seed);
  const f = degreeHz(degree) * Math.pow(2, b.detune / 1200);
  // On Heart a strike made now is heard from the present (js/piano.js
  // heardNow); natively the two are one.
  const t = ctx.presentTime !== undefined ? ctx.presentTime : ctx.currentTime;
  try {
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const depth = ctx.createGain(), amp = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * b.ratio;
    const dev = f * b.ratio * b.index;
    depth.gain.setValueAtTime(dev, t);
    depth.gain.setTargetAtTime(dev * 0.12, t, b.modDecay);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(PEAK, t + 0.004);
    amp.gain.setTargetAtTime(0, t + 0.004, b.decay / 5);
    mod.connect(depth); depth.connect(car.frequency);
    car.connect(amp); amp.connect(master);
    let send = null;
    if (roomContext() === ctx) {
      const room = roomInput(ctx, master);
      if (room) { send = ctx.createGain(); send.gain.value = SEND; amp.connect(send); send.connect(room); }
    }
    const end = t + b.decay * 1.25;
    car.start(t); mod.start(t);
    car.stop(end); mod.stop(end);
    live++;
    car.onended = () => {
      live--;
      try { car.disconnect(); mod.disconnect(); depth.disconnect(); amp.disconnect(); if (send) send.disconnect(); } catch (e) {}
    };
  } catch (e) { /* a context that refuses a node: no bell this time */ }
}
