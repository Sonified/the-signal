// WGSL for the reusable video feedback (see feedback.js): the two fullscreen
// passes around a layer's feedback image, a ping-pong pair of rgba16float
// textures holding premultiplied colour.
//
// fsDecay starts each frame's image from a faded copy of the last one, so
// whatever the layer drew there keeps showing, dimmer each frame, and dies
// away. Fading all four channels alike keeps every texel a valid
// premultiplied colour. With no stream and no twist the copy is read texel
// for texel and the trails stay exactly where they were drawn. Otherwise
// each pixel reads the last image at its own place pulled back through a
// small scale and turn about the centre, so the whole trail image grows or
// shrinks and turns about the centre a little every frame: trails stream
// outward or inward and swirl, alike in every direction. That read is
// filtered, and the slight softening it adds each frame builds up along a
// trail, which is part of the look.
//
// fsComposite lays the finished image over the scene, one texel per device
// pixel, with the premultiplied "over" blend the pipeline sets. Its colour
// is first scaled by the composite's gain (look.x), alpha left alone, so a
// gain below 1 darkens the image without letting the scene show through it
// any more. A gain in 0..1 keeps every texel a valid premultiplied colour.
// The texel is clamped to 0..1 first: a half float image is not clamped as
// light is added into it, so where the edge's light overlaps it can hold more
// than 1, and the clamp shows it as the 8-bit image did, which clamped as it
// stored (so the composite's opacity scales what can show, not a sum the
// screen would clip anyway).
// Then the whole texel, colour and alpha alike, is scaled by the composite's
// opacity (look.w), so the image goes see-through over the scene as a whole;
// that too keeps it a valid premultiplied colour.

export const FEEDBACK_WGSL = /* wgsl */ `
struct FB {
  fade: vec4f,  // the decay factor k, the FLOOR under which a channel snaps to 0, last frame's unit / this frame's / the stream's scale, 1 when plain (still, no stream or twist)
  turn: vec4f,  // this frame's centre x, y (texels), cos and sin of the twist's angle this frame
  size: vec4f,  // the image's width, height (texels), and their reciprocals
  look: vec4f,  // the composite's colour gain, last frame's centre x, y (texels), the composite's opacity
};
@group(0) @binding(0) var<uniform> fb: FB;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var prevSamp: sampler;

@vertex
fn vsFeedback(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// out = min(prev, 1) * k, and exactly 0 for any channel that falls under
// FLOOR. The image is half float, so the multiply alone is the whole fade
// and the half-life is honest; the CPU keeps k low enough that the half
// float store can never round a texel back to itself (feedback.js K_CAP).
// The snap is what ends a trail in bounded time, at true zero rather than
// at a tail too faint to see, so an image left alone becomes exactly
// transparent black and the module can stop working on it. The clamp to 1
// first matches the 8-bit image, which clamped as it stored: light added
// over light can hold more than 1 in half float, and its trail fades as
// the clipped value's would, not a brighter hidden sum. A channel under 0,
// which nothing draws, snaps to 0 with the rest.
//
// prev is read at src = cLast + R(-a) * (p - cNow) * (uLast / uNow) / s:
// the pixel's offset from this frame's centre, rescaled from this frame's
// texels per pixel to last frame's, undone by this frame's stream scale s
// and twist angle a, and placed about last frame's centre, so what was at
// src shows at p. When the centre moves (the drawer sliding) the old image
// travels with it: what sat at the old centre lands on the new one, and the
// trails stay with the scene. With a still centre and unit it is the plain
// stream and twist about the centre. With y growing downward, as on screen,
// a positive a turns the image clockwise. A src outside the image reads as nothing, not
// as the border's colour, or streaming inward would drag the border in as
// smears.
@fragment
fn fsDecay(@builtin(position) p: vec4f) -> @location(0) vec4f {
  var prev: vec4f;
  if (fb.fade.w > 0.5) {
    prev = textureLoad(prevTex, vec2i(p.xy), 0);
  } else {
    let d = (p.xy - fb.turn.xy) * fb.fade.z;
    let ca = fb.turn.z;
    let sa = fb.turn.w;
    let src = fb.look.yz + vec2f(ca * d.x + sa * d.y, ca * d.y - sa * d.x);
    let inside = all(src >= vec2f(0.0)) && all(src <= fb.size.xy);
    let read = textureSampleLevel(prevTex, prevSamp, src * fb.size.zw, 0.0);
    prev = select(vec4f(0.0), read, inside);
  }
  let v = min(prev, vec4f(1.0)) * fb.fade.x;
  return select(v, vec4f(0.0), v < vec4f(fb.fade.y));
}

@fragment
fn fsComposite(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = clamp(textureLoad(prevTex, vec2i(p.xy), 0), vec4f(0.0), vec4f(1.0));
  return vec4f(c.rgb * fb.look.x, c.a) * fb.look.w;
}
`;
