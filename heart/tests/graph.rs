//! The graph with nodes of its own: tiny test nodes that make what happens
//! inside a quantum visible (a DC source, a probe that plays its param as
//! audio, a pass-through with a set tail that counts its renders, a delay
//! allowed in a cycle), plus the real Gain and Delay where the seam matters.

use std::cell::Cell;
use std::rc::Rc;

use heart::graph::{Graph, PortKind};
use heart::node::{Activity, Bus, ChannelConfig, CountMode, Node, ParamSpec, QUANTUM, Rate, RenderCtx};
use heart::protocol_gen::{Command, attr, channel_count_mode, channel_interpretation, kind};

const SR: f32 = 48000.0;
const MASTER: u32 = 900;

// ---------- test nodes ----------

/// A source playing a constant on each channel from start to stop.
struct Dc { levels: Vec<f32>, start: f64, stop: f64 }

fn dc(level: f32) -> Box<Dc> { Box::new(Dc { levels: vec![level], start: f64::INFINITY, stop: f64::INFINITY }) }
fn stereo_dc(l: f32, r: f32) -> Box<Dc> { Box::new(Dc { levels: vec![l, r], start: f64::INFINITY, stop: f64::INFINITY }) }

impl Node for Dc {
    fn inputs(&self) -> usize { 0 }
    fn is_source(&self) -> bool { true }
    fn output_channels(&self, _: usize, _: &[usize]) -> usize { self.levels.len() }
    fn start(&mut self, frame: f64, _: f64, _: f64) { self.start = frame; }
    fn stop(&mut self, frame: f64) { self.stop = frame; }
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let f0 = ctx.frame as f64;
        if f0 >= self.stop { out[0].zero(); return Activity::Finished; }
        // Before its start, a source's quantum is silence, and says so.
        if f0 + QUANTUM as f64 <= self.start { out[0].zero(); return Activity::Silent; }
        for (c, level) in self.levels.iter().enumerate() {
            for (i, s) in out[0].data[c].iter_mut().enumerate() {
                let f = f0 + i as f64;
                *s = if f >= self.start && f < self.stop { *level } else { 0.0 };
            }
        }
        Activity::Active
    }
}

/// Plays its one param as mono audio, every quantum (no inputs, an endless
/// tail), and notes whether the graph handed it over as Const.
struct Probe { specs: &'static [ParamSpec], consts: Rc<Cell<u32>>, renders: Rc<Cell<u32>> }

static A_PARAM: [ParamSpec; 1] = [ParamSpec { name: "p", default: 0.0, min: -1.0, max: 1.0, rate: Rate::A }];
static K_PARAM: [ParamSpec; 1] = [ParamSpec { name: "p", default: 0.0, min: -1.0, max: 1.0, rate: Rate::K }];

fn probe(specs: &'static [ParamSpec]) -> (Box<Probe>, Rc<Cell<u32>>, Rc<Cell<u32>>) {
    let (consts, renders) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
    (Box::new(Probe { specs, consts: consts.clone(), renders: renders.clone() }), consts, renders)
}

impl Node for Probe {
    fn param_specs(&self) -> &'static [ParamSpec] { self.specs }
    fn inputs(&self) -> usize { 0 }
    fn output_channels(&self, _: usize, _: &[usize]) -> usize { 1 }
    fn tail_frames(&self) -> f64 { f64::INFINITY }
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        self.renders.set(self.renders.get() + 1);
        if ctx.params[0].is_const() { self.consts.set(self.consts.get() + 1); }
        for (i, s) in out[0].data[0].iter_mut().enumerate() { *s = ctx.params[0].at(i); }
        Activity::Active
    }
}

/// Passes its input through, as wide as it comes, with a set tail.
struct Pass { tail: f64, renders: Rc<Cell<u32>> }

fn pass(tail: f64) -> (Box<Pass>, Rc<Cell<u32>>) {
    let renders = Rc::new(Cell::new(0));
    (Box::new(Pass { tail, renders: renders.clone() }), renders)
}

impl Node for Pass {
    fn output_channels(&self, _: usize, inputs: &[usize]) -> usize { inputs[0] }
    fn tail_frames(&self) -> f64 { self.tail }
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        self.renders.set(self.renders.get() + 1);
        out[0].data = ctx.inputs[0].data;
        Activity::Active
    }
}

/// Exactly 256 frames of delay, mono, allowed in a cycle.
struct Ring { buf: Vec<f32>, pos: usize }

fn ring() -> Box<Ring> { Box::new(Ring { buf: vec![0.0; 256], pos: 0 }) }

impl Node for Ring {
    fn output_channels(&self, _: usize, _: &[usize]) -> usize { 1 }
    fn tail_frames(&self) -> f64 { 256.0 }
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        for i in 0..QUANTUM { out[0].data[0][i] = self.buf[(self.pos + i) % 256]; }
        let input = &ctx.inputs[0];
        for i in 0..QUANTUM { self.buf[(self.pos + i) % 256] = if input.silent { 0.0 } else { input.data[0][i] }; }
        self.pos = (self.pos + QUANTUM) % 256;
        Activity::Active
    }
    fn allowed_in_cycle(&self) -> bool { true }
}

/// One sample of 1.0 at frame 0.
struct Impulse;

impl Node for Impulse {
    fn inputs(&self) -> usize { 0 }
    fn is_source(&self) -> bool { true }
    fn output_channels(&self, _: usize, _: &[usize]) -> usize { 1 }
    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        out[0].data[0].fill(0.0);
        if ctx.frame == 0 { out[0].data[0][0] = 1.0; }
        Activity::Active
    }
}

// ---------- helpers ----------

fn graph() -> Graph {
    let mut g = Graph::new(SR, 1);
    make(&mut g, MASTER, kind::MASTER, &[]);
    g
}

fn make(g: &mut Graph, id: u32, kind: u32, opts: &[f64]) {
    let mut o = [0.0; 8];
    o[..opts.len()].copy_from_slice(opts);
    g.apply(id, Command::Create { kind, island: 0, opts: o });
}

fn connect(g: &mut Graph, from: u32, to: u32) {
    g.apply(from, Command::Connect { output: 0, target: to, input: 0 });
}

fn connect_param(g: &mut Graph, from: u32, to: u32, param: u32) {
    g.apply(from, Command::ConnectParam { output: 0, target: to, param });
}

fn start(g: &mut Graph, id: u32, at: f64) {
    g.apply(id, Command::Start { time: at, offset: 0.0, duration: -1.0 });
}

fn set(g: &mut Graph, id: u32, param: u32, time: f64, value: f32) {
    g.apply(id, Command::ParamSet { param, time, value });
}

/// The master port's two channels after rendering `frames`.
fn play(g: &mut Graph, frames: usize) -> (Vec<f32>, Vec<f32>) {
    g.render(frames);
    let m = g.port(PortKind::Master, 0).expect("the master port");
    (m[..frames].to_vec(), m[frames..2 * frames].to_vec())
}

#[track_caller]
fn all(values: &[f32], want: f32) {
    for (i, v) in values.iter().enumerate() { assert!((v - want).abs() < 1e-6, "frame {i}: {v}, want {want}"); }
}

// ---------- sound through the graph ----------

#[test]
fn a_mono_source_reaches_both_sides_of_the_master() {
    let mut g = graph();
    g.add_node(1, dc(0.5));
    connect(&mut g, 1, MASTER);
    start(&mut g, 1, 0.0);
    let (l, r) = play(&mut g, 256);
    all(&l, 0.5);
    all(&r, 0.5);
}

#[test]
fn a_gain_follows_its_automation() {
    let mut g = graph();
    g.add_node(1, dc(1.0));
    make(&mut g, 2, kind::GAIN, &[]);
    connect(&mut g, 1, 2);
    connect(&mut g, 2, MASTER);
    start(&mut g, 1, 0.0);
    set(&mut g, 2, 0, 0.0, 0.0);
    g.apply(2, Command::ParamLinear { param: 0, time: 256.0, value: 1.0 });
    let (l, _) = play(&mut g, 384);
    for k in (0..256).step_by(5) { assert!((l[k] - k as f32 / 256.0).abs() < 1e-6, "frame {k}: {}", l[k]); }
    all(&l[256..], 1.0);
}

#[test]
fn a_skip_moves_the_present_without_rendering_and_what_fell_due_meets_the_next_frame() {
    let mut g = graph();
    // A source that lives entirely inside the gap, and one that outlives it.
    g.add_node(1, dc(1.0));
    g.add_node(2, dc(0.5));
    make(&mut g, 3, kind::GAIN, &[]);
    connect(&mut g, 1, MASTER);
    connect(&mut g, 2, 3);
    connect(&mut g, 3, MASTER);
    start(&mut g, 1, 1000.0);
    g.apply(1, Command::Stop { time: 2000.0 });
    start(&mut g, 2, 1500.0);
    set(&mut g, 3, 0, 1200.0, 0.25);
    all(&play(&mut g, 256).0, 0.0);
    assert_eq!(g.skip(4000), 4096 + 128, "whole quanta only, from 256");
    assert_eq!(g.frame(), 4224);
    // The first source never sounds; the second plays through the gain
    // its event set inside the gap.
    all(&play(&mut g, 128).0, 0.125);
}

#[test]
fn audio_into_a_param_is_added_then_clamped() {
    let mut g = graph();
    let (p, _, _) = probe(&A_PARAM);
    g.add_node(2, p);
    connect(&mut g, 2, MASTER);
    set(&mut g, 2, 0, 0.0, 0.5);
    g.add_node(1, dc(0.25));
    connect_param(&mut g, 1, 2, 0);
    start(&mut g, 1, 0.0);
    all(&play(&mut g, 128).0, 0.75);

    // A second connection sums, and the sum is clamped to the param's range.
    g.add_node(3, dc(0.5));
    connect_param(&mut g, 3, 2, 0);
    start(&mut g, 3, 0.0);
    all(&play(&mut g, 128).0, 1.0);

    // A stereo connection is summed to mono first: ½(L + R).
    let mut g = graph();
    let (p, _, _) = probe(&A_PARAM);
    g.add_node(2, p);
    connect(&mut g, 2, MASTER);
    g.add_node(1, stereo_dc(0.2, 0.6));
    connect_param(&mut g, 1, 2, 0);
    start(&mut g, 1, 0.0);
    all(&play(&mut g, 128).0, 0.4);
}

#[test]
fn the_timeline_is_clamped_before_audio_is_added_too() {
    // Chrome clamps the automation, then the sum: 2 → 1, then 1 − 0.5.
    let mut g = graph();
    let (p, _, _) = probe(&A_PARAM);
    g.add_node(2, p);
    connect(&mut g, 2, MASTER);
    set(&mut g, 2, 0, 0.0, 2.0);
    g.add_node(1, dc(-0.5));
    connect_param(&mut g, 1, 2, 0);
    start(&mut g, 1, 0.0);
    all(&play(&mut g, 128).0, 0.5);
}

#[test]
fn a_param_holding_still_reaches_the_node_as_const() {
    let mut g = graph();
    let (p, consts, renders) = probe(&A_PARAM);
    g.add_node(2, p);
    connect(&mut g, 2, MASTER);
    set(&mut g, 2, 0, 200.0, 0.5);
    play(&mut g, 512);
    // Quanta 0, 2 and 3 hold still; quantum 1 changes at frame 200.
    assert_eq!((renders.get(), consts.get()), (4, 3));
}

#[test]
fn a_k_rate_param_is_one_value_a_quantum_with_audio_added_from_its_first_frame() {
    let mut g = graph();
    let (p, consts, _) = probe(&K_PARAM);
    g.add_node(2, p);
    connect(&mut g, 2, MASTER);
    set(&mut g, 2, 0, 0.0, 0.0);
    g.apply(2, Command::ParamLinear { param: 0, time: 512.0, value: 0.5 });
    let (l, _) = play(&mut g, 512);
    for q in 0..4 { all(&l[q * 128..(q + 1) * 128], q as f32 * 0.125); }
    assert_eq!(consts.get(), 4);

    g.add_node(1, dc(0.25));
    connect_param(&mut g, 1, 2, 0);
    g.apply(1, Command::Start { time: 640.0, offset: 0.0, duration: -1.0 });
    let (l, _) = play(&mut g, 256);
    // The source starts mid-quantum: the first quantum's first frame is 0.
    all(&l[..128], 0.5);
    all(&l[128..], 0.75);
}

// ---------- silence ----------

#[test]
fn a_node_rests_when_its_input_is_silent_and_its_tail_is_done() {
    for (tail, want) in [(0.0, 3), (300.0, 5)] {
        let mut g = graph();
        g.add_node(1, dc(1.0));
        let (p, renders) = pass(tail);
        g.add_node(2, p);
        connect(&mut g, 1, 2);
        connect(&mut g, 2, MASTER);
        start(&mut g, 1, 256.0);
        g.apply(1, Command::Stop { time: 512.0 });
        let (l, _) = play(&mut g, 1024);
        // Sound in quanta 2 and 3; then one more quantum (Chrome renders
        // while last-sound + tail ≥ now), or through the 300-frame tail.
        assert_eq!(renders.get(), want, "tail {tail}");
        all(&l[..256], 0.0);
        all(&l[256..512], 1.0);
        all(&l[512..], 0.0);
    }
}

#[test]
fn an_endless_tail_renders_every_quantum() {
    let mut g = graph();
    let (p, _, renders) = probe(&A_PARAM);
    g.add_node(2, p);
    play(&mut g, 1024);
    assert_eq!(renders.get(), 8);
}

#[test]
fn a_source_not_started_is_silent_and_skipped() {
    let mut g = graph();
    g.add_node(1, dc(1.0));
    connect(&mut g, 1, MASTER);
    all(&play(&mut g, 256).0, 0.0);
    assert_eq!(g.stats.renders, 0);
}

#[test]
fn a_finished_source_says_ended_once() {
    let mut g = graph();
    g.add_node(7, dc(1.0));
    connect(&mut g, 7, MASTER);
    start(&mut g, 7, 0.0);
    g.apply(7, Command::Stop { time: 300.0 });
    play(&mut g, 1024);
    let events = g.events.hand_over().to_vec();
    assert_eq!(events, [101u16.to_le_bytes(), 8u16.to_le_bytes()].concat().into_iter().chain(7u32.to_le_bytes()).collect::<Vec<u8>>());
    play(&mut g, 512);
    assert!(g.events.hand_over().is_empty());
}

// ---------- cycles ----------

#[test]
fn a_cycle_through_a_delay_feeds_back() {
    // impulse → sum → ring(256) → ×0.5 → sum, and sum → master. As Chrome
    // pulls it, the way back into the cycle reads the quantum before, so
    // each trip round is the ring's 256 frames and a quantum more.
    let mut g = graph();
    g.add_node(1, Box::new(Impulse));
    make(&mut g, 2, kind::GAIN, &[]);
    g.add_node(3, ring());
    make(&mut g, 4, kind::GAIN, &[]);
    set(&mut g, 4, 0, 0.0, 0.5);
    for (a, b) in [(1, 2), (2, 3), (3, 4), (4, 2), (2, MASTER)] { connect(&mut g, a, b); }
    start(&mut g, 1, 0.0);
    let (l, _) = play(&mut g, 1024);
    assert_eq!(g.stats.cut, 0);
    for (k, v) in l.iter().enumerate() {
        let want = if k % 384 == 0 { 0.5f32.powi(k as i32 / 384) } else { 0.0 };
        assert_eq!(*v, want, "frame {k}");
    }
}

#[test]
fn a_cycle_through_the_real_delay_feeds_back() {
    let mut g = graph();
    g.add_node(1, Box::new(Impulse));
    make(&mut g, 2, kind::GAIN, &[]);
    make(&mut g, 3, kind::DELAY, &[1.0]);
    // 1/128 s, exact in f32: 375 frames, and Chrome's quantum on the way
    // back makes each trip 503.
    set(&mut g, 3, 0, 0.0, 1.0 / 128.0);
    make(&mut g, 4, kind::GAIN, &[]);
    set(&mut g, 4, 0, 0.0, 0.5);
    for (a, b) in [(1, 2), (2, 3), (3, 4), (4, 2), (2, MASTER)] { connect(&mut g, a, b); }
    start(&mut g, 1, 0.0);
    let (l, _) = play(&mut g, 1024);
    assert_eq!(g.stats.cut, 0);
    for k in [0, 503, 1006] { assert!((l[k] - 0.5f32.powi(k as i32 / 503)).abs() < 1e-6, "frame {k}: {}", l[k]); }
    let rest: f32 = l.iter().enumerate().filter(|(k, _)| k % 503 != 0).map(|(_, v)| v.abs()).sum();
    assert!(rest < 1e-6, "nothing between the echoes ({rest})");
}

#[test]
fn a_delay_set_by_value_reads_in_f32() {
    // Chrome reads a delayTime that has an event (here a set, as `.value`
    // makes) a frame at a time in f32, so the graph hands it to the delay as
    // a block though it never moves. An impulse delayed 590.4 frames comes
    // out on frame 591 weighted by the f32 read position's fraction.
    let mut g = graph();
    g.add_node(1, Box::new(Impulse));
    make(&mut g, 2, kind::DELAY, &[1.0]);
    let frames = 590.4f32;
    set(&mut g, 2, 0, 0.0, frames / SR);
    for (a, b) in [(1, 2), (2, MASTER)] { connect(&mut g, a, b); }
    start(&mut g, 1, 0.0);
    let (l, _) = play(&mut g, 1024);
    let len = 48128.0f32;
    let mut p = 591.0f32 + (len - frames / SR * SR);
    if p >= len { p -= len; }
    let want = 1.0 - (p - p.floor());
    assert_eq!(l[591], want, "f32 read position");
    assert!((l[591] - 0.4).abs() > 1e-3, "not the f64 one");
}

/// Notes, each quantum, whether its input counts as connected.
struct Listen { seen: Rc<std::cell::RefCell<Vec<bool>>> }

impl Node for Listen {
    fn output_channels(&self, _: usize, _: &[usize]) -> usize { 1 }
    fn tail_frames(&self) -> f64 { f64::INFINITY }
    fn render(&mut self, ctx: &mut RenderCtx, _: &mut [Bus]) -> Activity {
        self.seen.borrow_mut().push(ctx.connected[0]);
        Activity::Silent
    }
}

#[test]
fn a_source_counts_as_connected_until_it_finishes() {
    // Chrome hands a worklet's input zeros while a connected source waits
    // to start, and nothing at all once it has finished (its output is
    // disabled then): the FDN wakes on the first and sleeps after the second.
    let mut g = graph();
    let seen = Rc::new(std::cell::RefCell::new(Vec::new()));
    g.add_node(1, dc(0.5));
    g.add_node(2, Box::new(Listen { seen: seen.clone() }));
    for (a, b) in [(1, 2), (2, MASTER)] { connect(&mut g, a, b); }
    start(&mut g, 1, 128.0);
    g.apply(1, Command::Stop { time: 384.0 });
    play(&mut g, 640);
    assert_eq!(*seen.borrow(), vec![true, true, true, false, false]);
}

#[test]
fn a_sources_automation_starts_where_the_source_does() {
    // Chrome works out a source's params only once it plays, and clamps
    // automation set before then to that quantum: a ramp from time 0 on a
    // ConstantSource started at frame 4801.3 runs from frame 4736 (the
    // quantum it starts in), not from 0. (The bench's a-rate offset.)
    let mut g = graph();
    make(&mut g, 1, kind::CONSTANT_SOURCE, &[]);
    connect(&mut g, 1, MASTER);
    set(&mut g, 1, 0, 0.0, 0.2);
    g.apply(1, Command::ParamLinear { param: 0, time: 33600.0, value: -0.8 });
    start(&mut g, 1, 4801.3);
    let (l, _) = play(&mut g, 5120);
    assert_eq!(l[4801], 0.0, "the start rounds up");
    let at = |f: f64| 0.2 - (f - 4736.0) / (33600.0 - 4736.0);
    assert!((l[4802] as f64 - at(4802.0)).abs() < 1e-6, "{} vs {}", l[4802], at(4802.0));
    assert!((l[5000] as f64 - at(5000.0)).abs() < 1e-6, "{} vs {}", l[5000], at(5000.0));
}

#[test]
fn a_cycle_with_no_delay_is_cut_and_the_rest_plays() {
    let mut g = graph();
    g.add_node(1, dc(0.25));
    make(&mut g, 2, kind::GAIN, &[]);
    make(&mut g, 3, kind::GAIN, &[]);
    for (a, b) in [(1, 2), (2, 3), (3, 2), (3, MASTER), (1, MASTER)] { connect(&mut g, a, b); }
    start(&mut g, 1, 0.0);
    all(&play(&mut g, 256).0, 0.25);
    assert_eq!(g.stats.cut, 2);
    assert!([2, 3].contains(&g.stats.first_cut));
    // The page hears of it once, naming the first node cut.
    assert_eq!(logs(&mut g), vec![(g.stats.first_cut, 1, 2)]);
    let first = g.stats.first_cut;
    // Breaking the cycle brings the chain back, and says so.
    g.apply(3, Command::DisconnectNode { target: 2 });
    all(&play(&mut g, 256).0, 0.5);
    assert_eq!(g.stats.cut, 0);
    assert_eq!(logs(&mut g), vec![(first, 1, 0)]);
}

/// The log events handed over since the last call: (node, code, value).
fn logs(g: &mut Graph) -> Vec<(u32, u32, u32)> {
    let u32_at = |b: &[u8], at: usize| u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    let bytes = g.events.hand_over().to_vec();
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= bytes.len() {
        let op = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let len = u16::from_le_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if op == heart::protocol_gen::event::LOG {
            out.push((u32_at(&bytes, at + 4), u32_at(&bytes, at + 8), u32_at(&bytes, at + 12)));
        }
        at += len;
    }
    out
}

// ---------- connections ----------

#[test]
fn every_disconnect() {
    let mut g = graph();
    g.add_node(1, dc(0.25));
    let (p, _, _) = probe(&A_PARAM);
    g.add_node(2, p);
    let (q, _) = pass(0.0);
    g.add_node(3, q);
    connect(&mut g, 2, MASTER);
    connect(&mut g, 3, MASTER);
    start(&mut g, 1, 0.0);
    let reconnect = |g: &mut Graph| { connect(g, 1, 3); connect_param(g, 1, 2, 0); };
    reconnect(&mut g);
    all(&play(&mut g, 128).0, 0.5);

    // From one node: its inputs only, never its params (spec).
    g.apply(1, Command::DisconnectNode { target: 2 });
    all(&play(&mut g, 128).0, 0.5);
    g.apply(1, Command::DisconnectNode { target: 3 });
    all(&play(&mut g, 128).0, 0.25);

    reconnect(&mut g);
    g.apply(1, Command::DisconnectParam { target: 2, param: 0 });
    all(&play(&mut g, 128).0, 0.25);

    reconnect(&mut g);
    g.apply(1, Command::DisconnectOutput { output: 0 });
    all(&play(&mut g, 128).0, 0.0);

    reconnect(&mut g);
    g.apply(1, Command::DisconnectAll);
    all(&play(&mut g, 128).0, 0.0);
    assert_eq!(g.stats.rejected, 0);
}

#[test]
fn a_connection_made_twice_is_one() {
    let mut g = graph();
    g.add_node(1, dc(0.25));
    connect(&mut g, 1, MASTER);
    connect(&mut g, 1, MASTER);
    start(&mut g, 1, 0.0);
    all(&play(&mut g, 128).0, 0.25);
}

#[test]
fn commands_for_what_is_not_there_are_counted() {
    let mut g = graph();
    connect(&mut g, 41, MASTER);
    set(&mut g, MASTER, 3, 0.0, 1.0);
    g.apply(MASTER, Command::Connect { output: 5, target: MASTER, input: 0 });
    make(&mut g, MASTER, kind::GAIN, &[]);
    make(&mut g, 50, 999, &[]);
    assert_eq!(g.stats.rejected, 5);
}

// ---------- channels ----------

#[test]
fn channel_rules() {
    let setup = |mode: u32, count: u32, interpretation: u32| {
        let mut g = graph();
        g.add_node(1, stereo_dc(1.0, 0.0));
        g.add_node(2, dc(0.5));
        let (p, _) = pass(0.0);
        g.add_node(3, p);
        g.apply(3, Command::Channels { count, mode, interpretation });
        for (a, b) in [(1, 3), (2, 3), (3, MASTER)] { connect(&mut g, a, b); }
        start(&mut g, 1, 0.0);
        start(&mut g, 2, 0.0);
        play(&mut g, 128)
    };
    let speakers = channel_interpretation::SPEAKERS;
    // max: stereo; the mono connection is copied to both sides.
    let (l, r) = setup(channel_count_mode::MAX, 2, speakers);
    all(&l, 1.5);
    all(&r, 0.5);
    // clamped-max at 1, and explicit 1: ½(L + R) plus the mono.
    for mode in [channel_count_mode::CLAMPED_MAX, channel_count_mode::EXPLICIT] {
        let (l, r) = setup(mode, 1, speakers);
        all(&l, 1.0);
        all(&r, 1.0);
    }
    // discrete into one channel keeps only the left.
    let (l, _) = setup(channel_count_mode::EXPLICIT, 1, channel_interpretation::DISCRETE);
    all(&l, 1.5);
}

#[test]
fn computed_channels_follow_the_spec() {
    use heart::mixing::computed_channels;
    let cfg = |mode, count| ChannelConfig { count, mode, speakers: true };
    assert_eq!(computed_channels(&cfg(CountMode::Max, 1), 2), 2);
    assert_eq!(computed_channels(&cfg(CountMode::Max, 2), 0), 1);
    assert_eq!(computed_channels(&cfg(CountMode::ClampedMax, 1), 2), 1);
    assert_eq!(computed_channels(&cfg(CountMode::ClampedMax, 2), 1), 1);
    assert_eq!(computed_channels(&cfg(CountMode::Explicit, 2), 1), 2);
}

// ---------- ports ----------

#[test]
fn egress_and_ingress_ports() {
    let mut g = graph();
    g.add_node(1, dc(0.5));
    make(&mut g, 2, kind::EGRESS, &[3.0]);
    connect(&mut g, 1, 2);
    start(&mut g, 1, 0.0);
    // Ingress: port 1 of stage 2 is key 2·16 + 1.
    make(&mut g, 3, kind::INGRESS, &[1.0, 2.0]);
    connect(&mut g, 3, MASTER);
    assert!(g.port(PortKind::Egress, 4).is_none());
    assert!(g.port(PortKind::Ingress, 1).is_none());
    let input = g.port(PortKind::Ingress, 33).expect("the ingress port");
    input[..512].fill(0.1);
    input[512..1024].fill(0.2);
    let (l, r) = play(&mut g, 512);
    all(&l, 0.1);
    all(&r, 0.2);
    let out = g.port(PortKind::Egress, 3).expect("the egress port");
    all(&out[..1024], 0.5);
    // A port node goes at once when destroyed, and its port with it.
    g.apply(2, Command::Destroy);
    assert!(g.port(PortKind::Egress, 3).is_none());
}

// ---------- release ----------

#[test]
fn a_dropped_node_plays_on_until_it_is_done() {
    let mut g = graph();
    g.add_node(1, dc(0.5));
    make(&mut g, 2, kind::GAIN, &[]);
    connect(&mut g, 1, 2);
    connect(&mut g, 2, MASTER);
    start(&mut g, 1, 0.0);
    g.apply(2, Command::Destroy);
    g.apply(1, Command::Destroy);
    all(&play(&mut g, 256).0, 0.5);
    assert_eq!((g.stats.nodes, g.stats.dropped), (3, 2));
    g.apply(1, Command::Stop { time: 300.0 });
    play(&mut g, 128);
    assert_eq!(g.stats.nodes, 3, "both play on to the stop");
    play(&mut g, 128);
    assert_eq!((g.stats.nodes, g.stats.dropped), (1, 0),
        "the source goes once finished, and with it the gain, nothing feeding it and its sound gone");

    // A dropped chain goes whole, in one render, not a link per render.
    for id in 10..60 { make(&mut g, id, kind::GAIN, &[]); }
    for id in 10..59 { connect(&mut g, id, id + 1); }
    for id in 10..60 { g.apply(id, Command::Destroy); }
    play(&mut g, 128);
    assert_eq!((g.stats.nodes, g.stats.dropped), (1, 0), "the whole chain");

    // A source never started goes at once.
    g.add_node(5, dc(1.0));
    g.apply(5, Command::Destroy);
    play(&mut g, 128);
    assert_eq!(g.stats.nodes, 1);
}

#[test]
fn a_buffer_freed_while_held_waits_for_its_holder() {
    let mut g = graph();
    let (p, _, _) = probe(&A_PARAM);
    g.add_node(1, p);
    g.buffers.stage(9, 1, 4, SR).expect("room").copy_from_slice(&[1.0, 2.0, 3.0, 4.0]);
    g.apply(1, Command::Attr { attr: attr::BUFFER, value: 9.0 });
    g.buffers.commit();
    g.buffers.free(9);
    assert_eq!(g.buffers.get(9).map(|b| b.channels[0].clone()), Some(vec![1.0, 2.0, 3.0, 4.0]));
    g.apply(1, Command::Attr { attr: attr::BUFFER, value: -1.0 });
    assert!(g.buffers.get(9).is_none());
}
