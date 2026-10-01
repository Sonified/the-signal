#!/usr/bin/env node
// Heart's wire format has one source of truth, heart/protocol.json, and two
// readers that must never drift from it: the Rust decoder inside the engine
// and the JS encoder on the page. This script writes both from the JSON, so
// a change to the protocol is a change to one file and a run of this one:
//
//   node tools/heart-protocol.mjs
//
// It writes heart/src/protocol_gen.rs (op codes, attr ids, enum values, the
// per-kind param tables, processor message types, and a typed decoder for
// every command) and js/heart/protocol-gen.js (the same tables, a Commands
// encoder with one method per command, and forEachEvent to walk the events
// coming back). The output depends on nothing but the JSON, in its own key
// order, so running it twice gives the same bytes.
//
// It also reads the Kind enum in heart/src/node.rs, the Rust side's own
// numbering of the node kinds, and refuses to write anything if the two
// disagree: a kind numbered differently on each side would build a gain
// where the page asked for a delay, silently.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = JSON.parse(readFileSync(join(root, 'heart/protocol.json'), 'utf8'));
const HEADER_BYTES = 8;   // u16 op, u16 byteLength, u32 node
const RECORD_MAX = 0xffff;

function fail(msg) {
  console.error(`heart-protocol: ${msg}`);
  process.exit(1);
}

// ---------- names ----------
// The JSON names things the way JS reads them (loopStart, clamped-max,
// param_cancel_hold); each side gets them in its own house style.
const words = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-\s]+/).filter(Boolean);
const upper = s => words(s).map(w => w.toUpperCase()).join('_');
const pascal = s => words(s).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
const camel = s => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); };
// The entries of a JSON section, without its "_" commentary.
const entries = o => Object.entries(o).filter(([k]) => !k.startsWith('_'));

// ---------- the Kind check ----------
function checkKinds() {
  const src = readFileSync(join(root, 'heart/src/node.rs'), 'utf8');
  const body = src.match(/pub enum Kind\s*\{([^}]*)\}/);
  if (!body) fail('could not find `pub enum Kind` in heart/src/node.rs');
  const rust = new Map([...body[1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map(m => [m[1], +m[2]]));
  const json = new Map(entries(P.kinds).map(([k, n]) => [pascal(k), n]));
  const problems = [];
  for (const [name, n] of json) {
    if (!rust.has(name)) problems.push(`${name} = ${n} is in protocol.json but not in node.rs`);
    else if (rust.get(name) !== n) problems.push(`${name} is ${n} in protocol.json but ${rust.get(name)} in node.rs`);
  }
  for (const [name, n] of rust) {
    if (!json.has(name)) problems.push(`${name} = ${n} is in node.rs but not in protocol.json`);
  }
  if (problems.length) fail(`node.rs's Kind and protocol.json's kinds disagree:\n  ${problems.join('\n  ')}`);
}

// ---------- field layouts ----------
// Each wire type's size, or null for the arrays, whose size is their count.
const FIXED = { u32: 4, f32: 4, f64: 8, f64x8: 64 };
const ARRAYS = { 'f32[]': 4, 'u8[]': 1 };

function checkFields(where, fields) {
  for (const [name, type] of fields) {
    if (!(type in FIXED) && !(type in ARRAYS)) fail(`${where}.${name}: unknown type ${type}`);
  }
  const arrays = fields.filter(([, t]) => t in ARRAYS);
  if (arrays.length > 1 || (arrays.length && fields[fields.length - 1][1] in FIXED)) {
    fail(`${where}: an array field must be the last and only one`);
  }
}

const commands = entries(P.commands).map(([name, c]) => {
  checkFields(`commands.${name}`, c.fields);
  return { name, op: c.op, fields: c.fields };
});
const events = entries(P.events).map(([name, e]) => {
  checkFields(`events.${name}`, e.fields);
  return { name, op: e.op, fields: e.fields };
});

// A param bound is a number or one of the named ones the JSON's params
// note explains; anything else is a typo, caught here rather than in a node.
function rustBound(b, where) {
  if (typeof b === 'number') return `Bound::Value(${rustF32(b)})`;
  const neg = b.startsWith('-'), name = neg ? b.slice(1) : b;
  if (name === 'max') return `Bound::Value(${neg ? '-' : ''}f32::MAX)`;
  if (name === 'nyquist') return `Bound::Nyquist(${neg ? '-1.0' : '1.0'})`;
  if (name === 'maxDelayTime' && !neg) return 'Bound::MaxDelayTime';
  fail(`${where}: unknown bound ${JSON.stringify(b)}`);
}
function rustF32(v) {
  if (!Number.isFinite(v)) fail(`not a finite number: ${v}`);
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

// ---------- Rust ----------
function rust() {
  const out = [];
  const w = s => out.push(s);
  const consts = (mod, doc, type, pairs) => {
    w(`/// ${doc}`);
    w(`pub mod ${mod} {`);
    for (const [k, v] of pairs) w(`    pub const ${upper(k)}: ${type} = ${v};`);
    w('}');
    w('');
  };

  w('//! Generated by tools/heart-protocol.mjs from heart/protocol.json. Do not edit:');
  w('//! change the JSON and run `node tools/heart-protocol.mjs`.');
  w('');
  w('use crate::node::Rate;');
  w('use crate::protocol::Reader;');
  w('');
  consts('op', 'Command op codes.', 'u16', commands.map(c => [c.name, c.op]));
  consts('event', 'Event op codes.', 'u16', events.map(e => [e.name, e.op]));
  consts('kind', 'Node kinds, as node.rs numbers them (checked when this file is made).', 'u32', entries(P.kinds));
  consts('attr', 'Attribute ids for the attr command.', 'u32', entries(P.attrs));
  for (const [name, values] of entries(P.enums)) {
    consts(name, `The ${name} enum's values on the wire.`, 'u32', entries(values));
  }
  for (const [name, types] of entries(P.processor_messages)) {
    if (typeof types !== 'object') continue;
    consts(name, `Message types of ${name} (processor_messages).`, 'u32',
      Object.keys(types).map(k => { const [n, t] = k.split(' '); return [t, +n]; }));
  }

  w('/// A param bound as the protocol gives it: a number, or one that depends on');
  w('/// the context (Nyquist(k) is k times half the sample rate) or on the node');
  w("/// (the delay's maxDelayTime, create's first option).");
  w('#[derive(Clone, Copy, Debug, PartialEq)]');
  w('pub enum Bound { Value(f32), Nyquist(f32), MaxDelayTime }');
  w('');
  w('#[derive(Clone, Copy, Debug)]');
  w('pub struct ParamRow { pub name: &\'static str, pub default: f32, pub min: Bound, pub max: Bound, pub rate: Rate }');
  w('');
  const kinds = entries(P.kinds);
  for (const [kind] of kinds) {
    const rows = P.params[kind] || [];
    w(`static ${upper(kind)}_PARAMS: [ParamRow; ${rows.length}] = [`);
    for (const [name, def, min, max, rate] of rows) {
      const where = `params.${kind}.${name}`;
      if (rate !== 'a' && rate !== 'k') fail(`${where}: rate must be "a" or "k"`);
      w(`    ParamRow { name: ${JSON.stringify(name)}, default: ${rustF32(def)}, min: ${rustBound(min, where)}, max: ${rustBound(max, where)}, rate: Rate::${rate.toUpperCase()} },`);
    }
    w('];');
  }
  w('');
  w('/// A kind\'s params in wire order (a param id is its index here).');
  w('pub fn params(kind: u32) -> &\'static [ParamRow] {');
  w('    match kind {');
  for (const [kind, n] of kinds) w(`        ${n} => &${upper(kind)}_PARAMS,`);
  w('        _ => &[],');
  w('    }');
  w('}');
  w('');

  const rustType = { u32: 'u32', f32: 'f32', f64: 'f64', f64x8: '[f64; 8]', 'f32[]': 'Vec<f32>', 'u8[]': "&'a [u8]" };
  const readFn = { u32: 'u32', f32: 'f32', f64: 'f64', f64x8: 'f64x8', 'f32[]': 'f32s', 'u8[]': 'bytes' };
  w('/// One command, its fields decoded (the node id is in the record head).');
  w('#[derive(Clone, Debug, PartialEq)]');
  w("pub enum Command<'a> {");
  for (const c of commands) {
    if (!c.fields.length) { w(`    ${pascal(c.name)},`); continue; }
    w(`    ${pascal(c.name)} { ${c.fields.map(([n, t]) => `${n}: ${rustType[t]}`).join(', ')} },`);
  }
  w('}');
  w('');
  w("/// Decodes a command's fields, the bytes after its record head. None for an");
  w('/// unknown op or fields cut short.');
  w("pub fn decode(op: u16, fields: &[u8]) -> Option<Command<'_>> {");
  w('    let mut r = Reader::new(fields);');
  w('    Some(match op {');
  for (const c of commands) {
    const body = c.fields.length
      ? ` { ${c.fields.map(([n, t]) => `${n}: r.${readFn[t]}()?`).join(', ')} }`
      : '';
    w(`        op::${upper(c.name)} => Command::${pascal(c.name)}${body},`);
  }
  w('        _ => return None,');
  w('    })');
  w('}');
  return out.join('\n') + '\n';
}

// ---------- JS ----------
function js() {
  const out = [];
  const w = s => out.push(s);
  const table = (name, doc, obj) => {
    w(`// ${doc}`);
    w(`export const ${name} = ${frozen(obj, '')};`);
    w('');
  };

  w('// Generated by tools/heart-protocol.mjs from heart/protocol.json. Do not edit:');
  w('// change the JSON and run `node tools/heart-protocol.mjs`.');
  w('//');
  w("// Records are little-endian: u16 op, u16 byteLength (the whole record), u32");
  w('// node, then the fields. Times are engine frames (f64), except a target\'s');
  w('// tau and a curve\'s duration, which are seconds.');
  w('');
  table('KINDS', 'Node kinds by name.', Object.fromEntries(entries(P.kinds)));
  table('ATTRS', "Attribute ids for Commands.attr.", Object.fromEntries(entries(P.attrs)));
  table('ENUMS', 'Enum values on the wire, by enum and name.',
    Object.fromEntries(entries(P.enums).map(([k, v]) => [k, Object.fromEntries(entries(v))])));
  table('PARAMS', "Each kind's params in wire order, as [name, default, min, max, rate]. A bound is a\n// number or a name: 'max' (f32's largest, '-max' its negative), 'nyquist' (half the\n// sample rate, '-nyquist'), 'maxDelayTime' (the delay's create option).",
    Object.fromEntries(entries(P.kinds).map(([k]) => [k, P.params[k] || []])));
  table('OPS', 'Command op codes.', Object.fromEntries(commands.map(c => [c.name, c.op])));
  table('EVENT_OPS', 'Event op codes.', Object.fromEntries(events.map(e => [e.name, e.op])));
  table('MESSAGES', "Processor message types (a message's leading u32), by direction and name.",
    Object.fromEntries(entries(P.processor_messages).filter(([, v]) => typeof v === 'object')
      .map(([k, types]) => [k, Object.fromEntries(Object.keys(types).map(t => { const [n, name] = t.split(' '); return [name, +n]; }))])));

  w('// A batch of command records, one method per command (arguments: the node,');
  w('// then the fields in protocol order). bytes() is a view of what has been');
  w('// written, valid until the next write or reset(); copy it (slice) to keep it');
  w('// or to transfer it.');
  w('export class Commands {');
  w('  constructor(capacity = 1024) {');
  w('    this._at = 0;');
  w('    this._take(new ArrayBuffer(capacity));');
  w('  }');
  w('  get length() { return this._at; }');
  w('  bytes() { return this._u8.subarray(0, this._at); }');
  w('  reset() { this._at = 0; }');
  w('');
  w('  _take(buf) {');
  w('    this._buf = buf;');
  w('    this._dv = new DataView(buf);');
  w('    this._u8 = new Uint8Array(buf);');
  w('  }');
  w('  // Starts a record of `len` bytes and returns where its fields go.');
  w('  _open(op, len, node) {');
  w(`    if (len > ${RECORD_MAX}) throw new RangeError(\`Heart: a ${'${len}'}-byte record is longer than the protocol's ${RECORD_MAX}\`);`);
  w('    const end = this._at + len;');
  w('    if (end > this._buf.byteLength) {');
  w('      let cap = this._buf.byteLength * 2;');
  w('      while (cap < end) cap *= 2;');
  w('      const old = this._u8.subarray(0, this._at);');
  w('      this._take(new ArrayBuffer(cap));');
  w('      this._u8.set(old);');
  w('    }');
  w('    const at = this._at, dv = this._dv;');
  w('    dv.setUint16(at, op, true);');
  w('    dv.setUint16(at + 2, len, true);');
  w('    dv.setUint32(at + 4, node >>> 0, true);');
  w('    this._at = end;');
  w(`    return at + ${HEADER_BYTES};`);
  w('  }');
  w('  // An array field: its u32 count, the items, zeros to the next 4 bytes.');
  w('  _f32s(at, values) {');
  w('    const n = values.length, dv = this._dv;');
  w('    dv.setUint32(at, n, true);');
  w('    for (let i = 0; i < n; i++) dv.setFloat32(at + 4 + 4 * i, values[i], true);');
  w('  }');
  w('  _bytes(at, bytes) {');
  w('    const n = bytes.length;');
  w('    this._dv.setUint32(at, n, true);');
  w('    this._u8.set(bytes, at + 4);');
  w('    this._u8.fill(0, at + 4 + n, at + 4 + n + pad(n));');
  w('  }');
  // The JS argument names say the units where the JSON's _notes give them.
  const argName = n => n === 'time' ? 'timeFrame' : n === 'duration' ? 'durationSec' : n === 'tau' ? 'tauSec' : camel(n);
  for (const c of commands) {
    const args = ['node', ...c.fields.map(([n]) => argName(n))];
    const fixed = c.fields.filter(([, t]) => t in FIXED).reduce((s, [, t]) => s + FIXED[t], HEADER_BYTES);
    const arr = c.fields.find(([, t]) => t in ARRAYS);
    w('');
    w(`  ${camel(c.name)}(${args.join(', ')}) {`);
    const len = !arr ? `${fixed}`
      : arr[1] === 'u8[]' ? `${fixed + 4} + ${argName(arr[0])}.length + pad(${argName(arr[0])}.length)`
      : `${fixed + 4} + 4 * ${argName(arr[0])}.length`;
    const body = [];
    let o = 0;
    for (const [n, t] of c.fields) {
      const a = argName(n), at = o ? `at + ${o}` : 'at';
      if (t === 'u32') body.push(`dv.setUint32(${at}, ${a} >>> 0, true);`);
      else if (t === 'f32') body.push(`dv.setFloat32(${at}, ${a}, true);`);
      else if (t === 'f64') body.push(`dv.setFloat64(${at}, ${a}, true);`);
      else if (t === 'f64x8') body.push(`for (let i = 0; i < 8; i++) dv.setFloat64(${at} + 8 * i, +((${a} && ${a}[i]) || 0), true);`);
      else if (t === 'f32[]') body.push(`this._f32s(${at}, ${a});`);
      else if (t === 'u8[]') body.push(`this._bytes(${at}, ${a});`);
      if (t in FIXED) o += FIXED[t];
    }
    if (body.length) {
      w(`    const at = this._open(${c.op}, ${len}, node)${body.some(b => b.includes('dv.')) ? ', dv = this._dv' : ''};`);
      for (const b of body) w(`    ${b}`);
    } else {
      w(`    this._open(${c.op}, ${len}, node);`);
    }
    w('  }');
  }
  w('}');
  w('');
  w('function pad(n) { return (4 - n % 4) % 4; }');
  w('');
  w('// Walks a batch of event records, calling fn(op, node, dataView, fieldOffset,');
  w('// recordEnd) for each; fieldOffset and recordEnd are byte offsets into the');
  w('// dataView, which spans exactly `u8`. Stops at a record that does not fit.');
  w('export function forEachEvent(u8, fn) {');
  w('  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);');
  w(`  for (let at = 0; at + ${HEADER_BYTES} <= u8.byteLength;) {`);
  w('    const op = dv.getUint16(at, true), len = dv.getUint16(at + 2, true);');
  w(`    if (len < ${HEADER_BYTES} || at + len > u8.byteLength) return;`);
  w(`    fn(op, dv.getUint32(at + 4, true), dv, at + ${HEADER_BYTES}, at + len);`);
  w('    at += len;');
  w('  }');
  w('}');
  return out.join('\n') + '\n';
}

// A JS literal of plain data, frozen all the way down.
function frozen(v, indent) {
  if (Array.isArray(v)) {
    if (v.every(x => !x || typeof x !== 'object')) return `Object.freeze(${JSON.stringify(v).replace(/,/g, ', ')})`;
    const inner = indent + '  ';
    return `Object.freeze([\n${v.map(x => inner + frozen(x, inner)).join(',\n')}\n${indent}])`;
  }
  if (v && typeof v === 'object') {
    const inner = indent + '  ';
    const keys = Object.keys(v);
    if (!keys.length) return 'Object.freeze({})';
    const key = k => /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    return `Object.freeze({\n${keys.map(k => `${inner}${key(k)}: ${frozen(v[k], inner)}`).join(',\n')}\n${indent}})`;
  }
  return JSON.stringify(v);
}

checkKinds();
const files = [['heart/src/protocol_gen.rs', rust()], ['js/heart/protocol-gen.js', js()]];
for (const [path, text] of files) {
  writeFileSync(join(root, path), text);
  console.log(`heart-protocol: wrote ${path} (${text.length} bytes)`);
}
