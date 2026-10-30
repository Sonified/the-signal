// Brush notes, the sound: each drawing hand's voice (core/brush-notes.js has
// the law; core/brush.js says when one rings). A strike plays the hand's
// bell with Brush bells on (S.brushNotes) and a note with Brush notes on
// (S.brushTones), both with both.
//
// A bell is one FM pair, a carrier whose frequency a sine modulator swings
// at a whole number ratio (2, 3 or 4, so it rings in tune), the modulation's
// depth falling away quickly (bright onset, mellow tail) under an amplitude
// that rings down over about two seconds. The carrier's own shape is the
// Notes waveform row, sine as it always was unless he picks another; the
// modulator stays a sine whatever it says.
//
// A note is an FM pair at 1:1 (every harmonic, warm) under an ADSR made new
// for each strike (core/brush-notes.js noteShape): its length drawn between
// the Min and Max note length sliders, a quick attack, a decay to a
// sustain, a release at the end. Its brightness rides the same shape, the
// modulation peaking with the attack and settling with the decay.
//
// Each strike builds its own few nodes and lets them go when it has rung
// out, at most MAX_VOICES at once (a strike past that is let go, never a
// click).
//
// It plays on the music family's context into the family's master, as the
// piano does (so the master volume, the output guard and Heart's routing all
// apply), dry and through its own send into the master reverb room
// (js/room.js), the send being its own gate: a strike only sends while the
// room shares its context, so it never moves the room. The level is a
// gentle accent, PEAK well under the piano's notes. Nothing sounds before
// the sound is on (S.audioEnabled, after the viewer's audio unlock), and
// nothing at all is built while both switches are off.

import { S } from './state.js';
import { getContext, getMaster } from './audio.js';
import { peekCtxFor, peekMasterFor } from './heart/route.js';
import { roomInput, roomContext } from './room.js';
import { chanGate } from './mixgate.js';
import { bellFor, degreeHz, noteShape, BRUSH_WAVE_GAIN, waveOf } from '../core/brush-notes.js';

const PEAK = 0.05;        // the strike's peak gain (the piano's notes sit several times higher)
// The stereo walk (schema-brush brushPan, Notes stereo width). Strikes
// should fall across the field without clustering, so each one takes the
// side OPPOSITE where the recent ones have been sitting and a random
// distance out: ping-pong in its balance, never in its width. `bias` is
// that memory, every strike's place added in and the whole decayed, so it
// leans back toward the middle through a pause and a lone strike after
// silence may land either side. PAN_OUT is how near the middle the nearest
// strike may fall, as a share of the width, so a wide setting still reads
// as two sides rather than a smear.
const PAN_MEMORY = 0.6, PAN_OUT = 0.35;
let panBias = 0;
function nextPan(width) {
  if (!(width > 0)) return 0;
  const side = panBias > 0 ? -1 : panBias < 0 ? 1 : (Math.random() < 0.5 ? -1 : 1);
  const p = side * width * (PAN_OUT + (1 - PAN_OUT) * Math.random());
  panBias = panBias * PAN_MEMORY + p;
  return Math.max(-1, Math.min(1, p));
}
// The strikes' own filters (schema-brush brushHpf and brushLpf), a highpass
// 20 Hz open to 2 kHz and a lowpass 200 Hz up to 20 kHz open. A corner under
// the lowest note, or above everything the voice makes, is no filter at all,
// so each node is built only when its setting asks for one: a strike that
// wants neither carries exactly the nodes it always did.
const HPF_OPEN = 20, LPF_OPEN = 20000;
const noteHpfHz = () => {
  const hz = S.brushHpf;
  return typeof hz === 'number' && hz === hz ? Math.max(HPF_OPEN, Math.min(2000, hz)) : HPF_OPEN;
};
const noteLpfHz = () => {
  const hz = S.brushLpf;
  return typeof hz === 'number' && hz === hz ? Math.max(200, Math.min(LPF_OPEN, hz)) : LPF_OPEN;
};
const SEND = 0.35;        // into the room, when no Notes reverb is set
const MAX_VOICES = 12;
let live = 0;

// One strike for seed at a scale degree: the bell, the note, or both.
export function ringBell(seed, degree) {
  const bell = S.brushNotes === true, note = S.brushTones === true;
  if (!(bell || note) || !S.audioEnabled) return;
  // the notes' master volume (schema-brush brushVol, the remote's NOTES
  // fader): every strike's peak scales by it, and 0 strikes nothing
  // the Levels window's own channel rides with it: mute, or another
  // channel's solo, silences the strikes as it silences a voice
  const vol = Math.max(0, Math.min(1, typeof S.brushVol === 'number' ? S.brushVol : 1)) * chanGate('notes');
  if (vol <= 0) return;
  const ctx = peekCtxFor('music') || getContext();
  const master = peekMasterFor('music') || getMaster();
  if (!ctx || !master || ctx.state !== 'running') return;
  // Fine tuning (schema-brush brushDetune): the strike's pitch bent by up
  // to a semitone each way, in cents, bell and note together
  const cents = Math.max(-100, Math.min(100, typeof S.brushDetune === 'number' ? S.brushDetune : 0));
  const f = degreeHz(degree) * (cents ? Math.pow(2, cents / 1200) : 1);
  // On Heart a strike made now is heard from the present (js/piano.js
  // heardNow); natively the two are one.
  const t = ctx.presentTime !== undefined ? ctx.presentTime : ctx.currentTime;
  // The carrier's shape (schema-brush brushWave) and the level that shape is
  // played at: a sawtooth with every harmonic in it reads far louder than a
  // sine at the same peak, so the table takes that back out and the row
  // changes the strike's colour alone. No node for it: the peak itself is
  // scaled, which costs a strike nothing.
  const wave = waveOf(S.brushWave), peak = PEAK * vol * BRUSH_WAVE_GAIN[wave];
  if (bell) strikeBell(ctx, master, t, f, bellFor(seed), peak, wave);
  if (note) strikeNote(ctx, master, t, f, peak, wave);
}

function strikeBell(ctx, master, t, f, b, peak, wave) {
  if (live >= MAX_VOICES) return;
  try {
    const { car, mod, depth, amp } = fmPair(ctx, f, b.ratio, wave);
    const dev = f * b.ratio * b.index;
    depth.gain.setValueAtTime(dev, t);
    depth.gain.setTargetAtTime(dev * 0.12, t, b.modDecay);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + 0.004);
    amp.gain.setTargetAtTime(0, t + 0.004, b.decay / 5);
    play(ctx, master, t, t + b.decay * 1.25, car, mod, depth, amp);
  } catch (e) { /* a context that refuses a node: no bell this time */ }
}

const NOTE_INDEX = 1.6;   // the note's brightness at its attack, falling to a third of it
function strikeNote(ctx, master, t, f, peak, wave) {
  if (live >= MAX_VOICES) return;
  const n = noteShape(S.brushToneMin, S.brushToneMax, Math.random);
  try {
    const { car, mod, depth, amp } = fmPair(ctx, f, 1, wave);
    const dev = f * NOTE_INDEX, ta = t + n.attack, tr = t + n.len - n.release;
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(dev, ta);
    depth.gain.setTargetAtTime(dev / 3, ta, n.decay / 3);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, ta);
    // the decay, near its sustain by its end; held; then the release, all
    // but gone (under 1 %) by the note's length
    amp.gain.setTargetAtTime(peak * n.sustain, ta, n.decay / 3);
    amp.gain.setTargetAtTime(0, tr, n.release / 5);
    play(ctx, master, t, t + n.len + 0.02, car, mod, depth, amp);
  } catch (e) { /* a context that refuses a node: no note this time */ }
}

// A carrier at f and its modulator at f * ratio, the modulator's swing
// through depth into the carrier's frequency, the carrier through amp.
// `wave` shapes the CARRIER only; the modulator is always a sine, because a
// modulator with harmonics of its own swings the carrier at every one of
// them at once and the pair falls apart into noise long before the index
// has decayed. A richer carrier swung by a sine is still a note, with an
// edge on it.
function fmPair(ctx, f, ratio, wave) {
  const car = ctx.createOscillator(), mod = ctx.createOscillator();
  const depth = ctx.createGain(), amp = ctx.createGain();
  if (wave && wave !== 'sine') car.type = wave;
  car.frequency.value = f;
  mod.frequency.value = f * ratio;
  mod.connect(depth); depth.connect(car.frequency);
  car.connect(amp);
  return { car, mod, depth, amp };
}

// Out to the master, dry and through the room's send, from t until end,
// then let go.
function play(ctx, master, t, end, car, mod, depth, amp) {
  // amp -> [highpass] -> [lowpass] -> [panner] -> master, with the room's
  // send tapped before the panner: the dry strike ping-pongs, the room stays
  // even around the middle, which is the open focus the whole piece keeps.
  // The two filters are in the order the global filter puts them
  // (core/global-filter.js), so the pair reads as one band, and the room
  // hears the strike filtered as the master does.
  let tail = amp, hp = null, lp = null, pan = null;
  const hz = noteHpfHz();
  if (hz > HPF_OPEN) {
    hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hz;
    tail.connect(hp);
    tail = hp;
  }
  const lhz = noteLpfHz();
  if (lhz < LPF_OPEN) {
    lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lhz;
    tail.connect(lp);
    tail = lp;
  }
  const dry = tail;
  const width = Math.max(0, Math.min(1, typeof S.brushPan === 'number' ? S.brushPan : 0));
  const place = nextPan(width);
  if (place !== 0 && ctx.createStereoPanner) {
    pan = ctx.createStereoPanner();
    pan.pan.value = place;
    tail.connect(pan);
    tail = pan;
  }
  tail.connect(master);
  let send = null;
  if (roomContext() === ctx) {
    const room = roomInput(ctx, master);
    // the strike's share of the room (schema-brush brushVerb); 0 sends nothing
    const verb = Math.max(0, Math.min(1, typeof S.brushVerb === 'number' ? S.brushVerb : SEND));
    if (room && verb > 0) { send = ctx.createGain(); send.gain.value = verb; dry.connect(send); send.connect(room); }
  }
  car.start(t); mod.start(t);
  car.stop(end); mod.stop(end);
  live++;
  car.onended = () => {
    live--;
    try {
      car.disconnect(); mod.disconnect(); depth.disconnect(); amp.disconnect();
      if (hp) hp.disconnect();
      if (lp) lp.disconnect();
      if (pan) pan.disconnect();
      if (send) send.disconnect();
    } catch (e) {}
  };
}
