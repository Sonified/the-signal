// Shader sources: the shared shader maths, expressed once per language.

export const WGSL = `
struct U {
  res: vec4f, col: vec4f, fieldP: vec4f,
  cornerA: vec4f, misc: vec4f, misc2: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> lut: array<f32>;

fn sdRoundBox(p: vec2f, b: f32, r: f32) -> f32 {
  let q = abs(p) - vec2f(b - r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fsFull(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let Wp = u.res.x; let Hp = u.res.y;
  let p = fc.xy;
  let ctr = vec2f(Wp * 0.5, Hp * 0.5);
  var acc = 0.0;

  if (u.fieldP.w > 0.5) {
    let mode = u.fieldP.x;
    var a = 1.0;
    if (mode < 0.5) {
      a = clamp((1.0 - length(p - ctr) / u.fieldP.y) / 0.28, 0.0, 1.0);
    } else if (mode < 1.5) {
      a = clamp(0.5 - sdRoundBox(p - ctr, u.fieldP.y, u.fieldP.z), 0.0, 1.0);
    }
    acc = acc + u.col.w * a;
  }

  if (u.misc.w > 0.5) {
    let n = u.misc.z;
    let x = length(p - ctr) / u.misc.y * n - 0.5;
    if (x > -1.0 && x < n) {
      let i0 = clamp(floor(x), 0.0, n - 2.0);
      let f  = clamp(x - i0, 0.0, 1.0);
      let idx = u32(i0);
      acc = acc + mix(lut[idx], lut[idx + 1u], f);
    }
  }

  if (u.misc2.x > 0.5) {
    let R = u.misc.x;
    acc = acc + u.cornerA.x * max(0.0, 1.0 - length(p) / R);
    acc = acc + u.cornerA.y * max(0.0, 1.0 - length(p - vec2f(Wp, 0.0)) / R);
    acc = acc + u.cornerA.z * max(0.0, 1.0 - length(p - vec2f(Wp, Hp)) / R);
    acc = acc + u.cornerA.w * max(0.0, 1.0 - length(p - vec2f(0.0, Hp)) / R);
  }

  return vec4f(min(u.col.rgb * acc, vec3f(1.0)), 1.0);
}

struct EOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec2f,
  @location(1) @interpolate(flat) seg: vec4f,
  @location(2) @interpolate(flat) wa: vec2f,
};

@vertex
fn vsEdge(@builtin(vertex_index) vi: u32,
          @location(0) p0: vec2f,
          @location(1) p1: vec2f,
          @location(2) wa: vec2f) -> EOut {
  var ks = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let k = ks[vi];
  let sx = select(-1.0, 1.0, (k & 1u) == 1u);
  let sy = select(-1.0, 1.0, (k & 2u) == 2u);
  let d = p1 - p0;
  let L = length(d);
  var ax = vec2f(1.0, 0.0);
  if (L > 1e-5) { ax = d / L; }
  let ay = vec2f(-ax.y, ax.x);
  let hw = wa.x + 1.5;
  let mid = (p0 + p1) * 0.5;
  let wp = mid + ax * (sx * (L * 0.5 + hw)) + ay * (sy * hw);
  var o: EOut;
  o.pos = vec4f(wp.x / u.res.x * 2.0 - 1.0, 1.0 - wp.y / u.res.y * 2.0, 0.0, 1.0);
  o.wp = wp;
  o.seg = vec4f(p0, p1);
  o.wa = wa;
  return o;
}

@fragment
fn fsEdge(o: EOut) -> @location(0) vec4f {
  let pa = o.wp - o.seg.xy;
  let ba = o.seg.zw - o.seg.xy;
  let dd = dot(ba, ba);
  var h = 0.0;
  if (dd > 1e-9) { h = clamp(dot(pa, ba) / dd, 0.0, 1.0); }
  let dist = length(pa - ba * h);
  let a = clamp(o.wa.x + 0.5 - dist, 0.0, 1.0) * o.wa.y;
  return vec4f(u.col.rgb * a, 0.0);
}
`;
export const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 uRes, uCol, uFieldP, uCornerA, uMisc, uMisc2;
`;

export const GL_VS_FULL = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GL_FS_FULL = GLSL_HEAD + `
uniform sampler2D uLut;
out vec4 frag;

float sdRoundBox(vec2 p, float b, float r) {
  vec2 q = abs(p) - vec2(b - r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float Wp = uRes.x, Hp = uRes.y;
  // gl_FragCoord is bottom-left origin in GL; flip to match the WebGPU path
  vec2 p = vec2(gl_FragCoord.x, Hp - gl_FragCoord.y);
  vec2 ctr = vec2(Wp * 0.5, Hp * 0.5);
  float acc = 0.0;

  if (uFieldP.w > 0.5) {
    float a = 1.0;
    if (uFieldP.x < 0.5)      a = clamp((1.0 - length(p - ctr) / uFieldP.y) / 0.28, 0.0, 1.0);
    else if (uFieldP.x < 1.5) a = clamp(0.5 - sdRoundBox(p - ctr, uFieldP.y, uFieldP.z), 0.0, 1.0);
    acc += uCol.w * a;
  }

  if (uMisc.w > 0.5) {
    float n = uMisc.z;
    float x = length(p - ctr) / uMisc.y * n - 0.5;
    if (x > -1.0 && x < n) {
      float i0 = clamp(floor(x), 0.0, n - 2.0);
      float f  = clamp(x - i0, 0.0, 1.0);
      int idx = int(i0);
      float a0 = texelFetch(uLut, ivec2(idx, 0), 0).r;
      float a1 = texelFetch(uLut, ivec2(idx + 1, 0), 0).r;
      acc += mix(a0, a1, f);
    }
  }

  if (uMisc2.x > 0.5) {
    float R = uMisc.x;
    acc += uCornerA.x * max(0.0, 1.0 - length(p) / R);
    acc += uCornerA.y * max(0.0, 1.0 - length(p - vec2(Wp, 0.0)) / R);
    acc += uCornerA.z * max(0.0, 1.0 - length(p - vec2(Wp, Hp)) / R);
    acc += uCornerA.w * max(0.0, 1.0 - length(p - vec2(0.0, Hp)) / R);
  }

  frag = vec4(min(uCol.rgb * acc, vec3(1.0)), 1.0);
}`;

export const GL_VS_EDGE = GLSL_HEAD + `
in vec2 aP0, aP1, aWA;
out vec2 vWP;
flat out vec4 vSeg;
flat out vec2 vWA;
void main() {
  int ks[6] = int[6](0, 1, 2, 2, 1, 3);
  int k = ks[gl_VertexID];
  float sx = (k & 1) == 1 ? 1.0 : -1.0;
  float sy = (k & 2) == 2 ? 1.0 : -1.0;
  vec2 d = aP1 - aP0;
  float L = length(d);
  vec2 ax = L > 1e-5 ? d / L : vec2(1.0, 0.0);
  vec2 ay = vec2(-ax.y, ax.x);
  float hw = aWA.x + 1.5;
  vec2 wp = (aP0 + aP1) * 0.5 + ax * (sx * (L * 0.5 + hw)) + ay * (sy * hw);
  gl_Position = vec4(wp.x / uRes.x * 2.0 - 1.0, 1.0 - wp.y / uRes.y * 2.0, 0.0, 1.0);
  vWP = wp; vSeg = vec4(aP0, aP1); vWA = aWA;
}`;

export const GL_FS_EDGE = GLSL_HEAD + `
in vec2 vWP;
flat in vec4 vSeg;
flat in vec2 vWA;
out vec4 frag;
void main() {
  vec2 pa = vWP - vSeg.xy;
  vec2 ba = vSeg.zw - vSeg.xy;
  float dd = dot(ba, ba);
  float h = dd > 1e-9 ? clamp(dot(pa, ba) / dd, 0.0, 1.0) : 0.0;
  float dist = length(pa - ba * h);
  float a = clamp(vWA.x + 0.5 - dist, 0.0, 1.0) * vWA.y;
  frag = vec4(uCol.rgb * a, 0.0);
}`;
