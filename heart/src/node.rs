//! The contract every node keeps. The graph (graph.rs) owns the nodes, mixes
//! each one's inputs to the channel count its rules ask for, works out its
//! params for the quantum, and hands it all over in a RenderCtx; the node
//! writes its outputs and says whether it is still making sound. Nothing in
//! a node knows about other nodes, the wire, or threads, so each one can be
//! written and tested on its own against the Web Audio spec.
//!
//! This file is a fixed contract shared by every Heart agent (see
//! documents/heart-audio-engine.md). Change it only by agreement.

use crate::buffers::BufferPool;
use crate::events::Events;

/// Web Audio's render quantum: every node renders 128 frames at a time.
pub const QUANTUM: usize = 128;
/// The widest bus the app uses. Every node here is mono or stereo.
pub const MAX_CHANNELS: usize = 2;

/// The node kinds, numbered as heart/protocol.json numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Kind {
    Gain = 1,
    ConstantSource = 2,
    StereoPanner = 3,
    Delay = 4,
    Biquad = 5,
    Oscillator = 6,
    BufferSource = 7,
    Analyser = 8,
    Convolver = 9,
    Fdn = 10,
    OnePole = 11,
    StrobeSignal = 12,
    Genus = 13,
    Egress = 14,
    Ingress = 15,
    Master = 16,
}

impl Kind {
    pub fn from_u32(k: u32) -> Option<Kind> {
        use Kind::*;
        Some(match k {
            1 => Gain, 2 => ConstantSource, 3 => StereoPanner, 4 => Delay,
            5 => Biquad, 6 => Oscillator, 7 => BufferSource, 8 => Analyser,
            9 => Convolver, 10 => Fdn, 11 => OnePole, 12 => StrobeSignal,
            13 => Genus, 14 => Egress, 15 => Ingress, 16 => Master,
            _ => return None,
        })
    }
}

/// One output (or one mixed input) for one quantum: up to two channels of
/// 128 frames. `silent` says the samples are all zero without anyone having
/// to look, which is how idle parts of the graph cost nothing (spec:
/// actively processing).
#[derive(Clone)]
pub struct Bus {
    pub channels: usize,
    pub silent: bool,
    pub data: [[f32; QUANTUM]; MAX_CHANNELS],
}

impl Bus {
    pub fn new(channels: usize) -> Bus {
        Bus { channels: channels.clamp(1, MAX_CHANNELS), silent: true, data: [[0.0; QUANTUM]; MAX_CHANNELS] }
    }
    /// All zeros, and marked so.
    pub fn zero(&mut self) {
        for c in self.data.iter_mut() { c.fill(0.0); }
        self.silent = true;
    }
    pub fn channel(&self, c: usize) -> &[f32; QUANTUM] { &self.data[c] }
    pub fn channel_mut(&mut self, c: usize) -> &mut [f32; QUANTUM] { &mut self.data[c] }
}

/// How a param is sampled: a-rate, a value per frame; k-rate, one per quantum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rate { A, K }

/// A node's param, as the Web Audio spec declares it for that node type.
/// The graph clamps every computed value to [min, max].
#[derive(Clone, Copy, Debug)]
pub struct ParamSpec {
    pub name: &'static str,
    pub default: f32,
    pub min: f32,
    pub max: f32,
    pub rate: Rate,
}

/// One param's values for this quantum, automation and audio-rate inputs
/// already applied. Const when nothing moves, so a node can take a fast path.
#[derive(Clone, Copy)]
pub enum ParamBlock<'a> {
    Const(f32),
    Varying(&'a [f32; QUANTUM]),
}

impl ParamBlock<'_> {
    #[inline]
    pub fn at(&self, i: usize) -> f32 {
        match self { ParamBlock::Const(v) => *v, ParamBlock::Varying(b) => b[i] }
    }
    #[inline]
    pub fn first(&self) -> f32 { self.at(0) }
    #[inline]
    pub fn is_const(&self) -> bool { matches!(self, ParamBlock::Const(_)) }
}

/// The spec's channel rules for a node's inputs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CountMode { Max, ClampedMax, Explicit }

#[derive(Clone, Copy, Debug)]
pub struct ChannelConfig {
    pub count: usize,
    pub mode: CountMode,
    /// true for 'speakers' interpretation (the app never uses 'discrete').
    pub speakers: bool,
}

impl Default for ChannelConfig {
    fn default() -> Self { ChannelConfig { count: 2, mode: CountMode::Max, speakers: true } }
}

/// What a node is told when it is made.
pub struct NodeInit {
    pub sample_rate: f32,
    /// A per-node seed for any randomness inside the DSP (rng.rs).
    pub seed: u32,
    /// create's opts, positional per kind (protocol.json kind_options).
    pub opts: [f64; 8],
}

/// An attribute value from the wire: enum values, booleans as 0/1,
/// seconds, buffer ids. Each node reads it the way its attr means.
pub type AttrValue = f64;

/// Everything a node gets for one quantum.
pub struct RenderCtx<'a> {
    /// This node's id, for the events it emits.
    pub node: u32,
    /// The engine frame of the quantum's first sample.
    pub frame: u64,
    pub sample_rate: f32,
    /// One bus per input, mixed to this node's channel rules. `silent` is set
    /// when nothing live feeds that input.
    pub inputs: &'a [Bus],
    /// Per input, whether anything is connected to it at all (a source that
    /// has finished no longer counts). Chrome hands an AudioWorklet no
    /// channels for an input with no connection, and zeros for one whose
    /// source is quiet, and a processor may tell the two apart.
    pub connected: &'a [bool],
    /// One block per param, in the order of param_specs().
    pub params: &'a [ParamBlock<'a>],
    pub buffers: &'a BufferPool,
    pub events: &'a mut Events,
}

/// What a node's render says about itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    /// Wrote real samples.
    Active,
    /// Wrote silence and has nothing more to say until its inputs wake
    /// (the outputs are zeroed and flagged).
    Silent,
    /// A source that has played to its end; the graph emits `ended` and
    /// releases it once nothing references it.
    Finished,
}

pub trait Node {
    /// The node type's params, in wire order. Most nodes have some.
    fn param_specs(&self) -> &'static [ParamSpec] { &[] }
    fn inputs(&self) -> usize { 1 }
    fn outputs(&self) -> usize { 1 }
    /// The channel count of output `o`, given the channel counts of the
    /// mixed inputs (after the channel rules).
    fn output_channels(&self, o: usize, input_channels: &[usize]) -> usize;
    /// The default channel rules for this node type (the spec's defaults).
    /// The wire's `channels` command can override count and mode.
    fn channel_config(&self) -> ChannelConfig { ChannelConfig::default() }

    /// Render one quantum into `out` (one bus per output, already sized).
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity;

    /// How long the node keeps sounding after its inputs fall silent, in
    /// frames (a delay's length, a convolver's impulse, a filter's ring).
    fn tail_frames(&self) -> f64 { 0.0 }

    /// Whether the node's arithmetic follows Chrome's HasSampleAccurateValues
    /// and not only the values themselves. If it does, every a-rate param
    /// that Chrome would call sample-accurate (one with automation, which
    /// Chrome keeps for good once set, or with audio connected) reaches it
    /// as a Varying block, even in a quantum where every frame is the same.
    fn sample_accurate(&self) -> bool { false }

    fn set_attr(&mut self, _attr: u32, _value: AttrValue) {}

    /// Sources only. `frame` is an engine frame (f64, may be fractional);
    /// offset and duration are seconds, duration < 0 for none.
    fn start(&mut self, _frame: f64, _offset: f64, _duration: f64) {}
    fn stop(&mut self, _frame: f64) {}
    fn is_source(&self) -> bool { false }

    /// A processor's port message (genus, strobe-signal), in its own encoding.
    fn message(&mut self, _bytes: &[u8], _node: u32, _events: &mut Events) {}

    /// The graph asks for an analyser's peak (protocol peak_request).
    fn request_peak(&mut self, _node: u32, _events: &mut Events) {}

    /// A DelayNode is the one node allowed inside a cycle (spec). The graph
    /// renders a cycle as Chrome pulls one: the connection that closes it
    /// reads what its source gave the quantum before (graph.rs).
    fn allowed_in_cycle(&self) -> bool { false }
}
