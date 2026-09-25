// The merged control schema: visual controls (this lane), then the Flowers,
// Kaleidoscope and Particles layers' controls, then audio controls (lane E2), plus the two lookups everything else in v1 needs to go
// from an id to a Control. byId is what a screen calls when it wants to draw
// one control; byDomId is what presets.js (lane E2) calls, since js/presets.js
// still speaks in v0 DOM ids (an 'inputs' key, a 'selects' key, a 'buttons'
// array of ids) and this is the one place that knows how every one of those
// ids maps onto a Control or, for a segment, onto one of its options.

import { VISUAL_CONTROLS, VISUAL_SECTIONS } from './schema-visual.js';
import { AUDIO_CONTROLS, AUDIO_SECTIONS } from './schema-audio.js';
import { FLOWER_CONTROLS, FLOWER_SECTIONS } from './schema-flowers.js';
import { KALEIDO_CONTROLS, KALEIDO_SECTIONS } from './schema-kaleido.js';
import { PARTICLE_CONTROLS, PARTICLE_SECTIONS } from './schema-particles.js';
import { FIREWORK_CONTROLS, FIREWORK_SECTIONS } from './schema-fireworks.js';

// Flowers go straight after the visual controls, so their lFlowers toggle
// follows Field, Rings, Corners, Edge and Text within the Layers section, and
// the kaleidoscope follows the flowers, so lKaleido comes right after it,
// and the particles follow the kaleidoscope, so lParticles comes after that,
// with the fireworks' lFireworks last.
export const CONTROLS = [...VISUAL_CONTROLS, ...FLOWER_CONTROLS, ...KALEIDO_CONTROLS, ...PARTICLE_CONTROLS, ...FIREWORK_CONTROLS, ...AUDIO_CONTROLS];

// The Flowers section slots in after Edge, the Kaleidoscope section right
// after it and the Particles section right after that, all before Text, the
// order a screen that lists every section would show them in.
const visualSections = VISUAL_SECTIONS.slice();
{
  const at = visualSections.findIndex(s => s.id === 'edge');
  visualSections.splice(at < 0 ? visualSections.length : at + 1, 0, ...FLOWER_SECTIONS, ...KALEIDO_SECTIONS, ...PARTICLE_SECTIONS, ...FIREWORK_SECTIONS);
}
export const SECTIONS = [...visualSections, ...AUDIO_SECTIONS];

const byIdMap = new Map(CONTROLS.map(c => [c.id, c]));

// A toggle that other controls name as their `parent` heads a nested run in
// the drawer, so it is marked here once and drawn as a small heading (all
// caps, semibold; see widgets.js controlRow) rather than an ordinary row.
for (const c of CONTROLS) {
  if (c.parent) {
    const p = byIdMap.get(c.parent);
    if (p) p.hasChildren = true;
  }
}

export function byId(id) {
  return byIdMap.get(id);
}

// Built once, at module load, rather than scanned on every call: a preset
// apply looks up a handful of ids in quick succession, and this is a couple
// hundred entries either way, small enough to just keep flat.
const byDomIdMap = new Map();
for (const control of CONTROLS) {
  // A control whose own id is a real v0 DOM id (every slider, every color
  // picker, and edgeDir's <select>) is reachable by that id directly, with
  // no option.
  byDomIdMap.set(control.id, { control, option: null });
  if (control.options) {
    for (const option of control.options) {
      // Some segment options have no v0 DOM id at all (the theme chips were
      // built at runtime with no id attribute; edgeDir's options are select
      // entries, not buttons) and carry domId: null for that reason. Those
      // are simply never reachable through byDomId, which is correct: v0
      // never had an id to look them up by either.
      if (option.domId) byDomIdMap.set(option.domId, { control, option });
    }
  }
}

export function byDomId(domId) {
  return byDomIdMap.get(domId);
}
