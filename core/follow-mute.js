// Mute followers: the broadcaster's switch at the top of the drawer's
// Broadcast section, for a talk whose sound goes out another way (a Zoom
// call sharing the laptop's sound). While it is on, every follower of the
// room (?livestream, ?follow) plays NO sound and shows no volume control;
// off, they play and show it as before.
//
// The broadcaster's side is a machine setting kept in this browser (never a
// preset, a journey or a snapshot): core/broadcast.js sends it as fm beside
// the snapshot, so the relay's kept copy hands a late joiner a muted room.
// A follower's side is memory only, from the room's state, and the room
// ending lets it go. Nothing here writes a follower's own saved volume: the
// mute is a multiplier on what leaves the speakers (followGain), read where
// the master volume (js/audio.js), the Live Sound monitor (js/livesound.js)
// and Live Sound's player (platform/live-media.js) meet the output, and the
// duck the slides, heartbeat and hum share (core/broadcast.js takeDuck).
//
// It imports nothing: js/audio.js reads it as it loads, and the store's
// imports lead back into js/audio.js, so this keeps its one setting in
// localStorage itself.
const KEY = 'signal.broadcast.muteFollowers';
const ls = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };

// ---------- the broadcaster's switch ----------
let sendMute = null;
export function muteFollowersOn() {
  if (sendMute === null) {
    try { const st = ls(); sendMute = !!st && st.getItem(KEY) === 'true'; } catch (e) { sendMute = false; }
  }
  return sendMute;
}
export function setMuteFollowers(on) {
  sendMute = !!on;
  try { const st = ls(); if (st) st.setItem(KEY, sendMute ? 'true' : 'false'); } catch (e) { /* this load only */ }
}

// ---------- a follower's side ----------
let muted = false;
const listeners = [];
export function followMuted() { return muted; }
// 0 while this page follows a muted room, else 1
export function followGain() { return muted ? 0 : 1; }
export function onFollowMute(fn) { listeners.push(fn); }
// From the room's state (true muted), or false when the room is gone.
export function setFollowMuted(on) {
  on = !!on;
  if (on === muted) return;
  muted = on;
  for (const fn of listeners) { try { fn(on); } catch (e) { console.warn('[follow-mute]', e); } }
}
