// WGSL for the UI renderer. One pipeline draws every DrawList instance: the
// vertex stage expands a quad from six float32x4 instance attributes (the
// DrawList's 24-float stride, chunked into six vec4s in order) and the
// fragment stage switches on `kind` to shade a rounded rect, a frosted glass
// pane, an SDF glyph, or an analytic icon. Everything is computed straight
// from the instance data; there is nothing per-frame here that allocates,
// the GPU just runs the same program over however many instances the UI
// emitted this frame.
//
// Distances are carried in css pixels wherever they reach an anti-aliasing
// step, because `fwidth` of a css-pixel quantity already scales itself to
// roughly one physical pixel regardless of device pixel ratio, so edges stay
// crisp at any dpr without the shader ever asking what the dpr is.

export const UI_WGSL = /* wgsl */ `
// Every fragment of an instance shares one kind, so the per-kind branch below
// never splits a 2x2 pixel quad and derivatives (fwidth, textureSample's
// implicit LOD) are well defined inside it. The compiler cannot prove that
// from a vertex input, so its uniformity check is turned off, deliberately.
diagnostic(off, derivative_uniformity);
struct Uniforms {
  viewport: vec2f,   // css px
  dpr: f32,
  hasBlur: f32,       // 0 or 1; forces GLASS to render flat when no capture exists yet
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var blurTex: texture_2d<f32>;
@group(1) @binding(1) var blurSamp: sampler;
@group(2) @binding(0) var textTex: texture_2d<f32>;
@group(2) @binding(1) var textSamp: sampler;

struct VertexIn {
  @location(0) a0: vec4f, // kind, x, y, w
  @location(1) a1: vec4f, // h, radius, fill.r, fill.g
  @location(2) a2: vec4f, // fill.b, fill.a, borderWidth, border.r
  @location(3) a3: vec4f, // border.g, border.b, border.a, shadowRadius
  @location(4) a4: vec4f, // shadowAlpha, f17, f18, f19
  @location(5) a5: vec4f, // f20, fieldA(21), fieldB(22), opacity
  @builtin(vertex_index) vertexIndex: u32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,        // css px, relative to the rect centre
  @location(1) kind: f32,
  @location(2) halfSize: vec2f,     // unexpanded half rect size, css px
  @location(3) radius: f32,
  @location(4) fill: vec4f,
  @location(5) borderWidth: f32,
  @location(6) borderColor: vec4f,
  @location(7) shadow: vec2f,       // radius, alpha
  @location(8) uv01: vec4f,         // GLYPH: u0 v0 u1 v1. ICON: f17=rotation in .x
  @location(9) fieldAB: vec2f,      // A (sdfRange / icon id / blurMix), B (icon stroke)
  @location(10) opacity: f32,
};

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
);

@vertex
fn vsMain(in: VertexIn) -> VOut {
  var out: VOut;
  let kind = in.a0.x;
  let rectPos = in.a0.yz;
  let rectSize = vec2f(in.a0.w, in.a1.x);
  let radius = in.a1.y;
  let fill = vec4f(in.a1.z, in.a1.w, in.a2.x, in.a2.y);
  let borderWidth = in.a2.z;
  let borderColor = vec4f(in.a2.w, in.a3.x, in.a3.y, in.a3.z);
  let shadowRadius = in.a3.w;
  let shadowAlpha = in.a4.x;
  let uv01 = vec4f(in.a4.y, in.a4.z, in.a4.w, in.a5.x);
  let fieldAB = vec2f(in.a5.y, in.a5.z);
  let opacity = in.a5.w;

  let halfSize = rectSize * 0.5;
  let expand = shadowRadius + 1.0;
  let halfSizeExp = halfSize + vec2f(expand, expand);
  let center = rectPos + halfSize;
  let unit = QUAD[in.vertexIndex];
  let local = unit * halfSizeExp;
  // A GLYPH carries a rotation in the radius slot (the centre word's
  // transitions). Only the placed corner turns; local stays unrotated, so
  // the fragment stage still maps it straight onto the atlas cell.
  var placed = local;
  if (kind > 1.5 && kind < 2.5 && radius != 0.0) { placed = rotate2(local, radius); }
  let worldCss = center + placed;

  // css px -> clip space. The ratio to the css viewport is dpr-independent:
  // the physical target is always the same css area, just sampled denser.
  let ndc = vec2f(worldCss.x / uniforms.viewport.x, worldCss.y / uniforms.viewport.y) * 2.0 - vec2f(1.0, 1.0);
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);

  out.local = local;
  out.kind = kind;
  out.halfSize = halfSize;
  out.radius = radius;
  out.fill = fill;
  out.borderWidth = borderWidth;
  out.borderColor = borderColor;
  out.shadow = vec2f(shadowRadius, shadowAlpha);
  out.uv01 = uv01;
  out.fieldAB = fieldAB;
  out.opacity = opacity;
  return out;
}

// ---- shared SDF and compositing helpers ----

fn sdRoundBox(p: vec2f, halfSize: vec2f, r: f32) -> f32 {
  let rr = min(r, min(halfSize.x, halfSize.y));
  let q = abs(p) - halfSize + vec2f(rr, rr);
  return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// IQ's arc distance: a ring cut to an aperture, symmetric about +y, opened by
// half-angle whose sine/cosine are sc. ra is the arc radius, rb the thickness.
fn sdArc(pIn: vec2f, sc: vec2f, ra: f32, rb: f32) -> f32 {
  var p = pIn;
  p.x = abs(p.x);
  var d: f32;
  if (sc.y * p.x > sc.x * p.y) {
    d = length(p - sc * ra);
  } else {
    d = abs(length(p) - ra);
  }
  return d - rb;
}

fn rotate2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
}

// A convex shape rounded by shrinking its true edge distance and giving the
// slack back as radius: the standard "SDF minus r" trick, which only rounds
// corners correctly when the input distance is a true (not Chebyshev) SDF, so
// the triangle below is built from real per-edge point-to-line distances.
fn sdTriangleRounded(p: vec2f, a: vec2f, b: vec2f, c: vec2f, r: f32) -> f32 {
  let e0 = b - a; let e1 = c - b; let e2 = a - c;
  let v0 = p - a; let v1 = p - b; let v2 = p - c;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d0 = vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x));
  let d1 = vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x));
  let d2 = vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x));
  let d = min(min(d0, d1), d2);
  return -sqrt(d.x) * sign(d.y) - r;
}

// Evan Wallace's erf-based rounded rectangle shadow: a real Gaussian blur of
// a rounded box, integrated analytically along x and sampled a handful of
// times along y. Cheap, and it does not flatten into a smoothstep ring the
// way a distance-field falloff does.
fn erf2(x: vec2f) -> vec2f {
  let s = sign(x);
  let a = abs(x);
  var y = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  y = y * y;
  return s - s / (y * y);
}

fn gaussian(x: f32, sigma: f32) -> f32 {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (sqrt(2.0 * 3.14159265359) * sigma);
}

fn roundedBoxShadowX(x: f32, y: f32, sigma: f32, corner: f32, halfSize: vec2f) -> f32 {
  let delta = min(halfSize.y - corner - abs(y), 0.0);
  let curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  let integral = 0.5 + 0.5 * erf2((vec2f(-curved, curved) + x) * (0.7071067811865476 / sigma));
  return integral.y - integral.x;
}

fn roundedBoxShadow(halfSize: vec2f, point: vec2f, sigmaIn: f32, corner: f32) -> f32 {
  let sigma = max(sigmaIn, 0.5);
  let low = point.y - halfSize.y;
  let high = point.y + halfSize.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let step = (end - start) / 4.0;
  var y = start + step * 0.5;
  var value = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    value += roundedBoxShadowX(point.x, point.y - y, sigma, corner, halfSize) * gaussian(y, sigma) * step;
    y += step;
  }
  return value;
}

// dst and src are straight alpha; returns src-over-dst, still straight.
fn overStraight(dst: vec4f, src: vec4f) -> vec4f {
  let outA = src.a + dst.a * (1.0 - src.a);
  if (outA <= 0.0001) { return vec4f(0.0, 0.0, 0.0, 0.0); }
  let outRGB = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA;
  return vec4f(outRGB, outA);
}

fn hash13(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + vec3f(dot(p3, p3.yzx + vec3f(33.33, 33.33, 33.33)));
  return fract((p3.x + p3.y) * p3.z);
}

// ---- rect / glass shape shared by RECT and GLASS ----

// Builds the shape layer (fill over border) plus the shadow-behind
// composite, given the already-decided interior colour (straight alpha; for
// GLASS this is opaque frost, for RECT it is the plain fill colour).
fn shapeLayer(local: vec2f, halfSize: vec2f, radius: f32, interior: vec4f,
              borderWidth: f32, borderColor: vec4f, shadowRadius: f32, shadowAlpha: f32) -> vec4f {
  let d = sdRoundBox(local, halfSize, radius);
  let aa = max(fwidth(d), 0.0001);
  let outerCoverage = clamp(0.5 - d / aa, 0.0, 1.0);

  var layer = vec4f(interior.rgb, interior.a * outerCoverage);
  if (borderWidth > 0.0) {
    let dInner = d + borderWidth;
    let innerCoverage = clamp(0.5 - dInner / aa, 0.0, 1.0);
    let borderCoverage = clamp(outerCoverage - innerCoverage, 0.0, 1.0);
    layer = vec4f(interior.rgb, interior.a * innerCoverage);
    let borderLayer = vec4f(borderColor.rgb, borderColor.a * borderCoverage);
    layer = overStraight(layer, borderLayer);
  }

  if (shadowRadius > 0.0) {
    let amt = roundedBoxShadow(halfSize, local, shadowRadius, min(radius, min(halfSize.x, halfSize.y))) * shadowAlpha;
    let shadowLayer = vec4f(0.0, 0.0, 0.0, clamp(amt, 0.0, 1.0) * (1.0 - outerCoverage));
    layer = overStraight(shadowLayer, layer);
  }
  return layer;
}

fn shadeRect(in: VOut) -> vec4f {
  let layer = shapeLayer(in.local, in.halfSize, in.radius, in.fill,
                          in.borderWidth, in.borderColor, in.shadow.x, in.shadow.y);
  let outA = layer.a * in.opacity;
  return vec4f(layer.rgb * outA, outA);
}

fn shadeGlass(in: VOut, fragXY: vec2f) -> vec4f {
  let screenUV = fragXY / (uniforms.viewport * uniforms.dpr);
  let blurSample = textureSample(blurTex, blurSamp, screenUV).rgb;
  let tint = in.fill;
  let flatColor = tint.rgb;
  let frostedColor = mix(blurSample, tint.rgb, tint.a);
  let blurMix = in.fieldAB.x * uniforms.hasBlur;
  var interiorRGB = mix(flatColor, frostedColor, blurMix);

  // A faint top-edge highlight, like light catching the top of real glass.
  let t = clamp((in.local.y + in.halfSize.y) / max(in.halfSize.y * 2.0, 0.0001), 0.0, 1.0);
  interiorRGB += vec3f(1.0, 1.0, 1.0) * (1.0 - smoothstep(0.0, 0.35, t)) * 0.05;

  // Dither before quantisation to 8 bits hides the blur's soft bands.
  interiorRGB += vec3f(hash13(fragXY) - 0.5) * (1.0 / 255.0);

  let interior = vec4f(interiorRGB, 1.0);
  let layer = shapeLayer(in.local, in.halfSize, in.radius, interior,
                          in.borderWidth, in.borderColor, in.shadow.x, in.shadow.y);
  let outA = layer.a * in.opacity;
  return vec4f(layer.rgb * outA, outA);
}

fn shadeGlyph(in: VOut) -> vec4f {
  let t = clamp((in.local / in.halfSize) * 0.5 + vec2f(0.5, 0.5), vec2f(0.0, 0.0), vec2f(1.0, 1.0));
  let uv = mix(in.uv01.xy, in.uv01.zw, t);
  let s = textureSample(textTex, textSamp, uv).r;
  let sdfRange = in.fieldAB.x;
  // Atlas encoding (lane B, text-atlas.js): texel = 0.5 + signedDistance /
  // (2 * sdfRange), signedDistance in atlas texels, positive inside. Decode
  // it back to atlas texels, then rescale into physical screen pixels using
  // this instance's own uv span versus its quad size, so a glyph drawn at
  // any point size still gets a one-pixel-wide edge.
  let dist = (s - 0.5) * 2.0 * sdfRange;
  let quadWidthPx = in.halfSize.x * 2.0 * uniforms.dpr;
  let texelsPerPixel = ((in.uv01.z - in.uv01.x) * 2048.0) / max(quadWidthPx, 0.0001);
  let distPx = dist / max(texelsPerPixel, 0.0001);
  // Field B is an extra edge softness in css px (the word's transitions blur
  // letters with it). It widens the anti-aliasing ramp, capped short of the
  // SDF range, since past that the field is flat and the ramp would clip.
  let rangePx = sdfRange / max(texelsPerPixel, 0.0001);
  let softPx = min(in.fieldAB.y * uniforms.dpr, rangePx * 0.9);
  let w = max(fwidth(distPx) * 0.5, 0.0001) + softPx;
  let coverage = clamp(smoothstep(-w, w, distPx), 0.0, 1.0);
  let outA = in.fill.a * coverage * in.opacity;
  return vec4f(in.fill.rgb * outA, outA);
}

// ---- icons ----
// Authored on a 24-unit grid (matching v0's feather-style svg icons) mapped
// into the unit box [-0.5, 0.5] via pt(), so paths can be transcribed from
// svg path data almost as written. Rotation is applied to the query point
// before evaluating any primitive, and every distance stays in unit-box
// units until the very end, where it is scaled back to css px for AA.

fn pt(x: f32, y: f32) -> vec2f { return vec2f((x - 12.0) / 24.0, (y - 12.0) / 24.0); }

fn iconSDF(id: i32, pIn: vec2f, strokeQ: f32) -> f32 {
  let hs = max(strokeQ * 0.5, 0.006);
  var p = pIn;
  switch (id) {
    case 1: { // CIRCLE, filled
      return length(p) - 0.36;
    }
    case 2: { // RING, stroked
      return abs(length(p) - 0.30) - hs;
    }
    case 3: { // PLAY, rounded triangle pointing right
      let a = pt(9.0, 6.0); let b = pt(18.0, 12.0); let c = pt(9.0, 18.0);
      return sdTriangleRounded(p, a, b, c, 0.03);
    }
    case 4: { // PAUSE, two bars
      let d0 = sdSegment(p, pt(9.0, 6.0), pt(9.0, 18.0)) - hs;
      let d1 = sdSegment(p, pt(15.0, 6.0), pt(15.0, 18.0)) - hs;
      return min(d0, d1);
    }
    case 5: { // BURGER, three bars
      let d0 = sdSegment(p, pt(4.0, 7.0), pt(20.0, 7.0)) - hs;
      let d1 = sdSegment(p, pt(4.0, 12.0), pt(20.0, 12.0)) - hs;
      let d2 = sdSegment(p, pt(4.0, 17.0), pt(20.0, 17.0)) - hs;
      return min(min(d0, d1), d2);
    }
    case 6: { // CLOSE, x
      let d0 = sdSegment(p, pt(6.0, 6.0), pt(18.0, 18.0)) - hs;
      let d1 = sdSegment(p, pt(18.0, 6.0), pt(6.0, 18.0)) - hs;
      return min(d0, d1);
    }
    case 7: { // CHEVRON, V pointing down at rotation 0
      let d0 = sdSegment(p, pt(5.0, 9.0), pt(12.0, 16.0)) - hs;
      let d1 = sdSegment(p, pt(12.0, 16.0), pt(19.0, 9.0)) - hs;
      return min(d0, d1);
    }
    case 8: { // CHECK
      let d0 = sdSegment(p, pt(5.0, 12.5), pt(10.0, 17.5)) - hs;
      let d1 = sdSegment(p, pt(10.0, 17.5), pt(19.5, 7.0)) - hs;
      return min(d0, d1);
    }
    case 9: { // EXPAND, four corner brackets opening outward
      var d = 1e5;
      d = min(d, sdSegment(p, pt(8.0, 3.0), pt(5.0, 3.0)) - hs);
      d = min(d, sdSegment(p, pt(5.0, 3.0), pt(3.0, 5.0)) - hs);
      d = min(d, sdSegment(p, pt(3.0, 5.0), pt(3.0, 8.0)) - hs);
      d = min(d, sdSegment(p, pt(16.0, 3.0), pt(19.0, 3.0)) - hs);
      d = min(d, sdSegment(p, pt(19.0, 3.0), pt(21.0, 5.0)) - hs);
      d = min(d, sdSegment(p, pt(21.0, 5.0), pt(21.0, 8.0)) - hs);
      d = min(d, sdSegment(p, pt(8.0, 21.0), pt(5.0, 21.0)) - hs);
      d = min(d, sdSegment(p, pt(5.0, 21.0), pt(3.0, 19.0)) - hs);
      d = min(d, sdSegment(p, pt(3.0, 19.0), pt(3.0, 16.0)) - hs);
      d = min(d, sdSegment(p, pt(16.0, 21.0), pt(19.0, 21.0)) - hs);
      d = min(d, sdSegment(p, pt(19.0, 21.0), pt(21.0, 19.0)) - hs);
      d = min(d, sdSegment(p, pt(21.0, 19.0), pt(21.0, 16.0)) - hs);
      return d;
    }
    case 10: { // CONTRACT, four corner brackets closing inward
      var d = 1e5;
      d = min(d, sdSegment(p, pt(8.0, 3.0), pt(8.0, 6.0)) - hs);
      d = min(d, sdSegment(p, pt(8.0, 6.0), pt(5.0, 6.0)) - hs);
      d = min(d, sdSegment(p, pt(5.0, 6.0), pt(3.0, 8.0)) - hs);
      d = min(d, sdSegment(p, pt(21.0, 8.0), pt(18.0, 8.0)) - hs);
      d = min(d, sdSegment(p, pt(18.0, 8.0), pt(18.0, 5.0)) - hs);
      d = min(d, sdSegment(p, pt(18.0, 5.0), pt(16.0, 3.0)) - hs);
      d = min(d, sdSegment(p, pt(3.0, 16.0), pt(6.0, 16.0)) - hs);
      d = min(d, sdSegment(p, pt(6.0, 16.0), pt(6.0, 19.0)) - hs);
      d = min(d, sdSegment(p, pt(6.0, 19.0), pt(8.0, 21.0)) - hs);
      d = min(d, sdSegment(p, pt(16.0, 21.0), pt(16.0, 18.0)) - hs);
      d = min(d, sdSegment(p, pt(16.0, 18.0), pt(19.0, 18.0)) - hs);
      d = min(d, sdSegment(p, pt(19.0, 18.0), pt(21.0, 16.0)) - hs);
      return d;
    }
    case 11: { // DOT, small filled
      return length(p) - 0.09;
    }
    case 12: { // PLUS
      let d0 = sdSegment(p, pt(12.0, 5.0), pt(12.0, 19.0)) - hs;
      let d1 = sdSegment(p, pt(5.0, 12.0), pt(19.0, 12.0)) - hs;
      return min(d0, d1);
    }
    case 13: { // MINUS
      return sdSegment(p, pt(5.0, 12.0), pt(19.0, 12.0)) - hs;
    }
    case 14, 15: { // SPEAKER / MUTE: v0's glyph (its 24x16 viewBox, moved down 4)
      // body: a box from x 1 to 5 and a cone flaring to x 10, as two triangles
      let boxD = sdRoundBox(p - pt(3.0, 12.0), vec2f(2.0 / 24.0, 3.0 / 24.0), 0.0);
      let cone0 = sdTriangleRounded(p, pt(5.0, 9.0), pt(10.0, 4.5), pt(10.0, 19.5), 0.0);
      let cone1 = sdTriangleRounded(p, pt(5.0, 9.0), pt(10.0, 19.5), pt(5.0, 15.0), 0.0);
      var d = min(boxD, min(cone0, cone1));
      if (id == 15) {
        let x0 = sdSegment(p, pt(14.0, 9.0), pt(20.0, 15.0)) - hs;
        let x1 = sdSegment(p, pt(20.0, 9.0), pt(14.0, 15.0)) - hs;
        d = min(d, min(x0, x1));
      } else {
        // v0's two waves: radius 5 through (13.5, 8.5..15.5), radius 9.5
        // through (16.5, 6..18), each centred on the axis left of its chord
        let q0 = rotate2(p - pt(9.93, 12.0), -1.5707963);
        let q1 = rotate2(p - pt(9.13, 12.0), -1.5707963);
        let arc0 = sdArc(q0, vec2f(sin(0.775), cos(0.775)), 5.0 / 24.0, hs);
        let arc1 = sdArc(q1, vec2f(sin(0.684), cos(0.684)), 9.5 / 24.0, hs);
        d = min(d, min(arc0, arc1));
      }
      return d;
    }
    case 16: { // GRIP, six dots
      var d = 1e5;
      let r = 0.045;
      for (var col = 0; col < 2; col = col + 1) {
        for (var row = 0; row < 3; row = row + 1) {
          let cx = 9.0 + f32(col) * 6.0;
          let cy = 6.0 + f32(row) * 6.0;
          d = min(d, length(p - pt(cx, cy)) - r);
        }
      }
      return d;
    }
    default: {
      return 1e5;
    }
  }
}

fn shadeIcon(in: VOut) -> vec4f {
  let s = max(min(in.halfSize.x, in.halfSize.y), 0.0001);
  let boxSize = 2.0 * s;
  let rotation = in.uv01.x;
  var p = in.local / boxSize;
  p = rotate2(p, rotation);
  let strokeQ = in.fieldAB.y / boxSize;
  let id = i32(round(in.fieldAB.x));
  let dUnit = iconSDF(id, p, strokeQ);
  let distCss = dUnit * boxSize;
  let aa = max(fwidth(distCss), 0.0001);
  let coverage = clamp(0.5 - distCss / aa, 0.0, 1.0);
  let outA = in.fill.a * coverage * in.opacity;
  return vec4f(in.fill.rgb * outA, outA);
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4f {
  let k = i32(round(in.kind));
  if (k == 0) { return shadeRect(in); }
  if (k == 1) { return shadeGlass(in, in.pos.xy); }
  if (k == 2) { return shadeGlyph(in); }
  return shadeIcon(in);
}
`;
