//! The graph a stage renders: every node, its connections and its params,
//! rendered a quantum at a time in an order where each node comes after
//! everything that feeds it.
//!
//! Nodes live in an arena, found by the u32 ids JS gives them. A node's
//! output buses are kept apart from the node itself, so a node can read
//! the buses feeding it while it writes its own. Each quantum, for each
//! node in order: its inputs are mixed (mixing.rs) to the width its channel
//! rules ask for, its params are worked out (the timeline, plus any audio
//! connected to the param, summed to mono, added and clamped), and then it
//! renders, or is skipped with silent outputs when it is not actively
//! processing (spec): all its inputs silent and its tail run out, or a
//! source not playing. Params advance either way, as Chrome's
//! ProcessOnlyAudioParams does, so automation keeps time while a node rests,
//! with one exception that is Chrome's too: a source's params are worked
//! out only in the quanta it plays, which is when Chrome first sees (and
//! clamps, param.rs) automation set on it before it started.
//!
//! **Order and cycles.** The order is rebuilt only when connections change.
//! It is Chrome's pull order: depth first from the stage's outputs, each
//! node after everything feeding it, its inputs in the order they were
//! connected and then its params. A connection back to a node still being
//! pulled reads what that node gave the quantum before, as Chrome's
//! ProcessIfNecessary does when a cycle comes round to a node it has already
//! begun, so a cycle's round trip is one quantum longer than its delays.
//! A cycle is allowed only through a DelayNode (spec); one with none, found
//! as the strongly connected components (Tarjan's) that remain once every
//! connection into a DelayNode's input is set aside, is cut as the spec
//! says: its nodes output silence, the stage counts them in its stats, and
//! nothing panics.
//!
//! **Ports** join stages. An Egress node is a sink copying its input into
//! one of the stage's egress ports; an Ingress node is a source playing an
//! ingress port, which JS fills before the render; the Master node sums
//! into the master output. Each port is planar f32, left then right, the
//! frames of the current render call apiece. An ingress port is found by
//! `sourceStage · PORTS_PER_STAGE + port` (js/heart/ring.js, ingressKey).
//!
//! **Release.** JS sends `destroy` when the page has dropped its handle on a
//! node, which is not the same as the node being done: as in a browser, a
//! dropped node goes on playing while anything feeds it, while its tail
//! rings, or, for a source, until it finishes. It is freed after that.
//! Ports are the exception, freed at once, because JS reuses their numbers.

use std::collections::HashMap;

use crate::buffers::BufferPool;
use crate::events::Events;
use crate::mixing::{computed_channels, mix_into};
use crate::node::{
    Activity, Bus, ChannelConfig, CountMode, Kind, MAX_CHANNELS, Node, NodeInit, ParamBlock, QUANTUM, Rate,
    RenderCtx,
};
use crate::nodes;
use crate::param::{Fill, Timeline};
use crate::protocol_gen::{Command, attr, channel_count_mode, channel_interpretation, log_code};
use crate::rng::node_seed;
use crate::simd;

/// The most frames one render call may ask for, which is also each port's
/// room per channel. JS's transport renders 512 at a time and the offline
/// context 8192.
pub const MAX_RENDER_FRAMES: usize = 8192;
/// Egress ports per stage; an ingress port's key is sourceStage times this,
/// plus the port.
pub const PORTS_PER_STAGE: u32 = 16;
/// The most params any node type has (genus has 27).
const MAX_PARAMS: usize = 32;

/// A stage's numbers for heart_stats (lib.rs documents each).
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub nodes: u32,
    pub renders: u32,
    pub skips: u32,
    pub cut: u32,
    pub rejected: u32,
    pub first_cut: u32,
    pub dropped: u32,
    pub rebuilds: u32,
}

/// What a port is, for heart_port_ptr.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PortKind { Egress, Ingress, Master }

impl PortKind {
    pub fn from_u32(k: u32) -> Option<PortKind> {
        match k { 0 => Some(PortKind::Egress), 1 => Some(PortKind::Ingress), 2 => Some(PortKind::Master), _ => None }
    }
}

struct Port {
    /// Left at 0, right at the render call's frame count.
    data: Vec<f32>,
    /// The port nodes using it; it goes with the last.
    users: u32,
}

enum Body {
    Node(Box<dyn Node>),
    Egress(u32),
    Ingress(u32),
    Master,
}

impl Body {
    /// The port a port node uses.
    fn port(&self) -> Option<(PortKind, u32)> {
        match *self {
            Body::Egress(p) => Some((PortKind::Egress, p)),
            Body::Ingress(key) => Some((PortKind::Ingress, key)),
            Body::Master => Some((PortKind::Master, 0)),
            Body::Node(_) => None,
        }
    }
}

/// One connection into an input or a param: which node, which output.
#[derive(Clone, Copy, PartialEq)]
struct Feed { from: usize, output: usize }

#[derive(Clone, Copy, PartialEq)]
enum Dest { Input(usize), Param(usize) }

/// One connection out of a node, kept on the node it leaves.
#[derive(Clone, Copy, PartialEq)]
struct Edge { output: usize, to: usize, into: Dest }

struct Param {
    timeline: Timeline,
    default: f32,
    min: f32,
    max: f32,
    rate: Rate,
    feeds: Vec<Feed>,
    block: [f32; QUANTUM],
    /// This quantum's value when it is the same on every frame; otherwise
    /// the block holds it.
    constant: Option<f32>,
}

struct Slot {
    id: u32,
    body: Body,
    source: bool,
    channels: ChannelConfig,
    /// Per input, the connections feeding it, its mix this quantum, and
    /// whether any of them is live (not a source that has finished, whose
    /// output Chrome disables).
    inputs: Vec<Vec<Feed>>,
    mixed: Vec<Bus>,
    connected: Vec<bool>,
    /// The mixed inputs' widths, as output_channels wants them.
    widths: Vec<usize>,
    params: Vec<Param>,
    edges: Vec<Edge>,
    /// Connections into this node's inputs and params.
    fed_by: u32,
    started: bool,
    /// A source's start, as an engine frame; its params are worked out from
    /// the quantum this falls in.
    start_at: f64,
    finished: bool,
    /// The frame after which this node may rest: the end of the last
    /// quantum it heard sound, plus its tail.
    quiet_after: f64,
    dropped: bool,
    /// The sample buffer it holds, for the pool's count.
    buffer: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Step { Render(usize), Cut(usize) }

pub struct Graph {
    sample_rate: f32,
    seed: u32,
    /// The next frame to render.
    frame: u64,
    slots: Vec<Option<Slot>>,
    outs: Vec<Vec<Bus>>,
    /// Per slot, a source that has finished: its connections no longer
    /// count as connected (Chrome disables a finished source's output).
    ended: Vec<bool>,
    vacant: Vec<usize>,
    ids: HashMap<u32, usize>,
    order: Vec<Step>,
    dirty: bool,
    dropped: Vec<usize>,
    ports: HashMap<(PortKind, u32), Port>,
    /// Frames in the current render call: each port's channel stride.
    block: usize,
    /// Audio connected to a param, summed to mono.
    scratch: Bus,
    pub buffers: BufferPool,
    pub events: Events,
    pub stats: Stats,
}

impl Graph {
    pub fn new(sample_rate: f32, seed: u32) -> Graph {
        Graph {
            sample_rate,
            seed,
            frame: 0,
            slots: Vec::new(),
            outs: Vec::new(),
            ended: Vec::new(),
            vacant: Vec::new(),
            ids: HashMap::new(),
            order: Vec::new(),
            dirty: false,
            dropped: Vec::new(),
            ports: HashMap::new(),
            block: 0,
            scratch: Bus::new(1),
            buffers: BufferPool::default(),
            events: Events::default(),
            stats: Stats::default(),
        }
    }

    /// The next frame to render.
    pub fn frame(&self) -> u64 { self.frame }

    // ---------- commands ----------

    /// Applies one decoded command to node `id`. Anything naming a node,
    /// output, input or param that is not there is counted and ignored.
    pub fn apply(&mut self, id: u32, command: Command) {
        let done = match command {
            Command::Create { kind, opts, .. } => self.create(id, kind, opts),
            Command::Destroy => self.destroy(id),
            Command::Connect { output, target, input } => {
                self.connect(id, output as usize, target, Dest::Input(input as usize))
            }
            Command::ConnectParam { output, target, param } => {
                self.connect(id, output as usize, target, Dest::Param(param as usize))
            }
            Command::DisconnectAll => self.disconnect(id, |_| true),
            Command::DisconnectNode { target } => {
                // Only the node's inputs: its params are let go by disconnect_param.
                let to = self.ids.get(&target).copied();
                self.disconnect(id, |e| Some(e.to) == to && matches!(e.into, Dest::Input(_)))
            }
            Command::DisconnectOutput { output } => self.disconnect(id, |e| e.output == output as usize),
            Command::DisconnectParam { target, param } => {
                let to = self.ids.get(&target).copied();
                self.disconnect(id, |e| Some(e.to) == to && e.into == Dest::Param(param as usize))
            }
            Command::ParamSet { param, time, value } => self.timeline(id, param, |t, now| t.set_value(time, value, now)),
            Command::ParamLinear { param, time, value } => self.timeline(id, param, |t, now| t.linear_ramp(time, value, now)),
            Command::ParamExp { param, time, value } => self.timeline(id, param, |t, now| t.exponential_ramp(time, value, now)),
            Command::ParamTarget { param, time, value, tau } => {
                self.timeline(id, param, |t, now| t.set_target(time, value, tau, now))
            }
            Command::ParamCurve { param, time, duration, values } => {
                self.timeline(id, param, |t, now| t.set_curve(time, duration, values, now))
            }
            Command::ParamCancel { param, time } => self.timeline(id, param, |t, now| t.cancel(time, now)),
            Command::ParamCancelHold { param, time } => self.timeline(id, param, |t, now| t.cancel_and_hold(time, now)),
            Command::Attr { attr, value } => self.attr(id, attr, value),
            Command::Channels { count, mode, interpretation } => self.channels(id, count, mode, interpretation),
            Command::Start { time, offset, duration } => {
                let now = self.frame as f64;
                self.slot_mut(id).is_some_and(|slot| match &mut slot.body {
                    Body::Node(node) => {
                        node.start(time.max(now), offset, duration);
                        if !slot.started { slot.start_at = time.max(now); }
                        slot.started = true;
                        true
                    }
                    _ => false,
                })
            }
            Command::Stop { time } => {
                let now = self.frame as f64;
                self.node_and_events(id, |node, _| node.stop(time.max(now)))
            }
            Command::Message { bytes } => self.node_and_events(id, |node, events| node.message(bytes, id, events)),
            Command::PeakRequest => self.node_and_events(id, |node, events| node.request_peak(id, events)),
        };
        if !done { self.stats.rejected += 1; }
    }

    fn slot_index(&self, id: u32) -> Option<usize> { self.ids.get(&id).copied() }

    fn slot_mut(&mut self, id: u32) -> Option<&mut Slot> {
        let i = self.slot_index(id)?;
        self.slots[i].as_mut()
    }

    fn create(&mut self, id: u32, kind: u32, opts: [f64; 8]) -> bool {
        if self.ids.contains_key(&id) { return false; }
        let Some(kind) = Kind::from_u32(kind) else { return false };
        let body = match kind {
            Kind::Egress => Body::Egress(opts[0] as u32),
            Kind::Ingress => Body::Ingress((opts[1] as u32).saturating_mul(PORTS_PER_STAGE).saturating_add(opts[0] as u32)),
            Kind::Master => Body::Master,
            _ => {
                let init = NodeInit { sample_rate: self.sample_rate, seed: node_seed(self.seed, id), opts };
                match nodes::make(kind, &init) {
                    Some(node) => Body::Node(node),
                    None => return false,
                }
            }
        };
        self.insert(id, body)
    }

    /// Puts a node made elsewhere into the graph under `id`, as `create`
    /// does with the ones it makes (the tests bring their own).
    pub fn add_node(&mut self, id: u32, node: Box<dyn Node>) -> bool {
        !self.ids.contains_key(&id) && self.insert(id, Body::Node(node))
    }

    fn insert(&mut self, id: u32, body: Body) -> bool {
        let port = body.port();
        let (inputs, outputs, source, channels, params) = match &body {
            Body::Node(node) => {
                let specs = node.param_specs();
                if specs.len() > MAX_PARAMS { return false; }
                let params = specs.iter().map(|s| Param {
                    timeline: Timeline::new(s.default, s.min, s.max, s.rate, self.sample_rate),
                    default: s.default,
                    min: s.min,
                    max: s.max,
                    rate: s.rate,
                    feeds: Vec::new(),
                    block: [0.0; QUANTUM],
                    constant: Some(s.default),
                }).collect();
                (node.inputs(), node.outputs(), node.is_source(), node.channel_config(), params)
            }
            // A destination's rules: two channels, explicit, speakers.
            Body::Egress(_) | Body::Master => (1, 0, false, sink_channels(), Vec::new()),
            Body::Ingress(_) => (0, 1, false, ChannelConfig::default(), Vec::new()),
        };
        let widths = vec![1; inputs];
        let outs = (0..outputs).map(|o| Bus::new(match &body {
            Body::Node(node) => node.output_channels(o, &widths),
            _ => MAX_CHANNELS,
        })).collect();
        if let Some(key) = port {
            self.ports.entry(key).or_insert_with(|| Port { data: vec![0.0; 2 * MAX_RENDER_FRAMES], users: 0 }).users += 1;
        }
        let slot = Slot {
            id,
            body,
            source,
            started: false,
            channels,
            inputs: vec![Vec::new(); inputs],
            mixed: (0..inputs).map(|_| Bus::new(1)).collect(),
            connected: vec![false; inputs],
            widths,
            params,
            edges: Vec::new(),
            fed_by: 0,
            start_at: f64::INFINITY,
            finished: false,
            quiet_after: f64::NEG_INFINITY,
            dropped: false,
            buffer: None,
        };
        let i = match self.vacant.pop() {
            Some(i) => { self.slots[i] = Some(slot); self.outs[i] = outs; self.ended[i] = false; i }
            None => {
                self.slots.push(Some(slot));
                self.outs.push(outs);
                self.ended.push(false);
                self.slots.len() - 1
            }
        };
        self.ids.insert(id, i);
        self.stats.nodes += 1;
        self.dirty = true;
        true
    }

    /// The page has let go of the node. Ports go now; anything else is freed
    /// once it is done (see the top), checked after each render.
    fn destroy(&mut self, id: u32) -> bool {
        let Some(i) = self.slot_index(id) else { return false };
        let slot = self.slots[i].as_mut().expect("ids only name live slots");
        if matches!(slot.body, Body::Egress(_) | Body::Ingress(_)) {
            self.free(i);
        } else if !slot.dropped {
            slot.dropped = true;
            self.dropped.push(i);
            self.stats.dropped += 1;
        }
        true
    }

    /// Frees dropped nodes that are done: nothing feeds them, and their tail
    /// has rung out, or, for a source, it has finished or never started.
    /// Freeing a node can leave the next one in a dropped chain unfed, so
    /// this goes round until a pass frees nothing, and a whole chain the page
    /// let go of goes at once rather than a link per render.
    fn release_done(&mut self) {
        let now = self.frame as f64;
        loop {
            let done: Vec<usize> = self.dropped.iter().copied().filter(|&i| {
                let slot = self.slots[i].as_ref().expect("dropped slots are live");
                slot.fed_by == 0 && match &slot.body {
                    Body::Node(_) if slot.source => slot.finished || !slot.started,
                    Body::Node(node) => node.tail_frames().is_finite() && now > slot.quiet_after,
                    _ => true,
                }
            }).collect();
            if done.is_empty() { return; }
            for i in done { self.free(i); }
        }
    }

    /// Takes node `i` out of the graph: its connections both ways, its port,
    /// its hold on a buffer, and its place in the arena.
    fn free(&mut self, i: usize) {
        self.disconnect_index(i, |_| true);
        let feeds: Vec<Feed> = {
            let slot = self.slots[i].as_ref().expect("freeing a live slot");
            slot.inputs.iter().flatten().chain(slot.params.iter().flat_map(|p| &p.feeds)).copied().collect()
        };
        for f in feeds {
            if let Some(from) = self.slots[f.from].as_mut() { from.edges.retain(|e| e.to != i); }
        }
        let slot = self.slots[i].take().expect("freeing a live slot");
        if let Some(key) = slot.body.port() && let Some(p) = self.ports.get_mut(&key) {
            p.users -= 1;
            if p.users == 0 { self.ports.remove(&key); }
        }
        if let Some(b) = slot.buffer { self.buffers.release(b); }
        if slot.dropped && let Some(k) = self.dropped.iter().position(|&d| d == i) {
            self.dropped.swap_remove(k);
            self.stats.dropped -= 1;
        }
        self.outs[i].clear();
        self.ids.remove(&slot.id);
        self.vacant.push(i);
        self.stats.nodes -= 1;
        self.dirty = true;
    }

    fn connect(&mut self, id: u32, output: usize, target: u32, into: Dest) -> bool {
        let (Some(from), Some(to)) = (self.slot_index(id), self.slot_index(target)) else { return false };
        if output >= self.outs[from].len() { return false; }
        let feed = Feed { from, output };
        let slot = self.slots[to].as_mut().expect("ids only name live slots");
        let feeds = match into {
            Dest::Input(k) => slot.inputs.get_mut(k),
            Dest::Param(p) => slot.params.get_mut(p).map(|p| &mut p.feeds),
        };
        let Some(feeds) = feeds else { return false };
        // A connection made twice is one connection (spec).
        if feeds.contains(&feed) { return true; }
        feeds.push(feed);
        slot.fed_by += 1;
        self.slots[from].as_mut().expect("ids only name live slots").edges.push(Edge { output, to, into });
        self.dirty = true;
        true
    }

    fn disconnect(&mut self, id: u32, which: impl Fn(&Edge) -> bool) -> bool {
        match self.slot_index(id) {
            Some(i) => { self.disconnect_index(i, which); true }
            None => false,
        }
    }

    /// Removes the connections leaving node `i` that `which` picks.
    fn disconnect_index(&mut self, i: usize, which: impl Fn(&Edge) -> bool) {
        let Some(slot) = self.slots[i].as_mut() else { return };
        let (gone, kept): (Vec<Edge>, Vec<Edge>) = slot.edges.iter().partition(|e| which(e));
        if gone.is_empty() { return; }
        slot.edges = kept;
        for e in gone {
            let Some(to) = self.slots[e.to].as_mut() else { continue };
            let feeds = match e.into {
                Dest::Input(k) => &mut to.inputs[k],
                Dest::Param(p) => &mut to.params[p].feeds,
            };
            feeds.retain(|f| *f != Feed { from: i, output: e.output });
            to.fed_by -= 1;
        }
        self.dirty = true;
    }

    /// Runs `op` on a param's timeline with the stage's present.
    fn timeline(&mut self, id: u32, param: u32, op: impl FnOnce(&mut Timeline, f64)) -> bool {
        let now = self.frame as f64;
        match self.slot_mut(id).and_then(|s| s.params.get_mut(param as usize)) {
            Some(p) => { op(&mut p.timeline, now); true }
            None => false,
        }
    }

    fn node_and_events(&mut self, id: u32, op: impl FnOnce(&mut dyn Node, &mut Events)) -> bool {
        let Some(i) = self.slot_index(id) else { return false };
        match self.slots[i].as_mut().map(|s| &mut s.body) {
            Some(Body::Node(node)) => { op(node.as_mut(), &mut self.events); true }
            _ => false,
        }
    }

    /// An attribute goes to the node; a `buffer` one is also counted, so a
    /// buffer JS frees stays until no node holds it (-1 is null).
    fn attr(&mut self, id: u32, which: u32, value: f64) -> bool {
        let Some(i) = self.slot_index(id) else { return false };
        let slot = self.slots[i].as_mut().expect("ids only name live slots");
        let Body::Node(node) = &mut slot.body else { return false };
        if which == attr::BUFFER {
            let held = (value >= 0.0).then_some(value as u32);
            if held != slot.buffer {
                if let Some(b) = held { self.buffers.hold(b); }
                if let Some(b) = slot.buffer { self.buffers.release(b); }
                slot.buffer = held;
            }
        }
        node.set_attr(which, value);
        true
    }

    fn channels(&mut self, id: u32, count: u32, mode: u32, interpretation: u32) -> bool {
        let mode = match mode {
            channel_count_mode::MAX => CountMode::Max,
            channel_count_mode::CLAMPED_MAX => CountMode::ClampedMax,
            channel_count_mode::EXPLICIT => CountMode::Explicit,
            _ => return false,
        };
        let Some(slot) = self.slot_mut(id) else { return false };
        slot.channels = ChannelConfig {
            count: (count as usize).clamp(1, MAX_CHANNELS),
            mode,
            speakers: interpretation != channel_interpretation::DISCRETE,
        };
        true
    }

    /// A param's last computed value (its timeline's, before audio inputs),
    /// or NaN for one that is not there.
    pub fn param_value(&self, id: u32, param: u32) -> f32 {
        let slot = self.slot_index(id).and_then(|i| self.slots[i].as_ref());
        slot.and_then(|s| s.params.get(param as usize)).map_or(f32::NAN, |p| p.timeline.value())
    }

    // ---------- ports ----------

    /// A port's planar buffer, or None when no port node has made it.
    pub fn port(&mut self, kind: PortKind, key: u32) -> Option<&mut [f32]> {
        let key = if kind == PortKind::Master { 0 } else { key };
        self.ports.get_mut(&(kind, key)).map(|p| p.data.as_mut_slice())
    }

    // ---------- rendering ----------

    /// Renders `frames` (whole quanta, at most MAX_RENDER_FRAMES) from the
    /// present, filling the egress and master ports, then frees whatever
    /// dropped nodes have finished. Returns the frames rendered.
    pub fn render(&mut self, frames: usize) -> usize {
        self.buffers.commit();
        let frames = frames.min(MAX_RENDER_FRAMES) / QUANTUM * QUANTUM;
        self.block = frames;
        for ((kind, _), port) in self.ports.iter_mut() {
            if *kind != PortKind::Ingress { port.data[..2 * frames].fill(0.0); }
        }
        self.stats.renders = 0;
        self.stats.skips = 0;
        for q in 0..frames / QUANTUM {
            if self.dirty { self.rebuild(); }
            for k in 0..self.order.len() {
                let step = self.order[k];
                self.step(step, q * QUANTUM);
            }
            self.frame += QUANTUM as u64;
        }
        self.release_done();
        frames
    }

    /// Moves the present on by `frames` (whole quanta) without rendering
    /// them: the stage's rest (js/heart/render-worker.js, a paused session
    /// whose master is shut). Every node keeps the state it had, so this is
    /// the same gap a node skipped as silent sees, on every node at once:
    /// whatever falls due in between (a start, a stop, a param event) is
    /// met at the next frame rendered, a source started and stopped inside
    /// the gap never sounds, and a tail that would have rung out has.
    /// Returns the new frame.
    pub fn skip(&mut self, frames: u64) -> u64 {
        self.frame += frames / QUANTUM as u64 * QUANTUM as u64;
        self.release_done();
        self.frame
    }

    /// One step of one quantum; `at` is the quantum's offset in the ports.
    fn step(&mut self, step: Step, at: usize) {
        let Graph { slots, outs, ended, ports, block, scratch, buffers, events, stats, frame, sample_rate, .. } = self;
        let i = match step {
            Step::Render(i) => i,
            Step::Cut(i) => {
                for b in outs[i].iter_mut() { if !b.silent { b.zero(); } }
                return;
            }
        };
        let frame = *frame;
        let Some(slot) = slots[i].as_mut() else { return };

        // The inputs, mixed. A bus that heard nothing is all zeros and says
        // so, which every node and port relies on. A feed from a node later
        // in the order (a cycle's way back) still holds the quantum before.
        let mut sounding = false;
        let speakers = slot.channels.speakers;
        for (k, feeds) in slot.inputs.iter().enumerate() {
            let bus = &mut slot.mixed[k];
            let had_sound = !bus.silent;
            let widest = feeds.iter().map(|f| outs[f.from][f.output].channels).max().unwrap_or(1);
            bus.channels = computed_channels(&slot.channels, widest);
            bus.silent = true;
            for f in feeds { mix_into(bus, &outs[f.from][f.output], speakers); }
            if bus.silent && had_sound { bus.zero(); }
            sounding |= !bus.silent;
            slot.widths[k] = bus.channels;
            slot.connected[k] = feeds.iter().any(|f| !ended[f.from]);
        }

        // The params, once a quantum: always, except that a source's wait
        // until it plays (Chrome's sources work theirs out only then).
        let plays = !slot.source
            || (slot.started && !slot.finished && slot.start_at.ceil() < (frame + QUANTUM as u64) as f64);
        if plays {
            let exact = matches!(&slot.body, Body::Node(node) if node.sample_accurate());
            for p in slot.params.iter_mut() { p.compute(frame, outs, scratch, exact); }
        }

        match &mut slot.body {
            Body::Egress(port) => {
                if let Some(p) = ports.get_mut(&(PortKind::Egress, *port)) { add_to_port(&mut p.data, *block, at, &slot.mixed[0]); }
            }
            Body::Master => {
                if let Some(p) = ports.get_mut(&(PortKind::Master, 0)) { add_to_port(&mut p.data, *block, at, &slot.mixed[0]); }
            }
            Body::Ingress(key) => {
                let out = &mut outs[i][0];
                match ports.get(&(PortKind::Ingress, *key)) {
                    Some(p) => read_port(&p.data, *block, at, out),
                    None => if !out.silent { out.zero(); },
                }
            }
            Body::Node(node) => {
                let tail = node.tail_frames();
                if sounding { slot.quiet_after = (frame + QUANTUM as u64) as f64 + tail; }
                let active = if slot.source {
                    slot.started && !slot.finished
                } else {
                    sounding || tail == f64::INFINITY || frame as f64 <= slot.quiet_after
                };
                // Widths before render: a node that knows better (a buffer
                // source, from its buffer) sets its own during render.
                for (o, bus) in outs[i].iter_mut().enumerate() {
                    bus.channels = node.output_channels(o, &slot.widths).clamp(1, MAX_CHANNELS);
                }
                if !active {
                    for b in outs[i].iter_mut() { if !b.silent { b.zero(); } }
                    stats.skips += 1;
                    return;
                }
                stats.renders += 1;
                let mut views = [ParamBlock::Const(0.0); MAX_PARAMS];
                for (v, p) in views.iter_mut().zip(&slot.params) {
                    *v = match p.constant { Some(c) => ParamBlock::Const(c), None => ParamBlock::Varying(&p.block) };
                }
                let mut ctx = RenderCtx {
                    node: slot.id,
                    frame,
                    sample_rate: *sample_rate,
                    inputs: &slot.mixed,
                    connected: &slot.connected,
                    params: &views[..slot.params.len()],
                    buffers,
                    events,
                };
                let out = &mut outs[i];
                let activity = node.render(&mut ctx, out);
                match activity {
                    Activity::Active => for b in out.iter_mut() { b.silent = false; },
                    Activity::Silent | Activity::Finished => for b in out.iter_mut() { if !b.silent { b.zero(); } },
                }
                if activity == Activity::Finished && slot.source && !slot.finished {
                    slot.finished = true;
                    ended[i] = true;
                    ctx.events.ended(slot.id);
                }
            }
        }
    }

    // ---------- order ----------

    /// The render order, Chrome's pull order, with any cycle that has no
    /// DelayNode in it cut (see the top).
    fn rebuild(&mut self) {
        self.dirty = false;
        self.stats.rebuilds += 1;
        let n = self.slots.len();
        // What feeds each node: its inputs' connections in the order they
        // were made, then its params'. `open` leaves out the connections
        // into a DelayNode's input, so a cycle left in it has no delay.
        let mut feeds_of: Vec<Vec<usize>> = Vec::with_capacity(n);
        let mut open: Vec<Vec<usize>> = Vec::with_capacity(n);
        for slot in &self.slots {
            let Some(s) = slot else {
                feeds_of.push(Vec::new());
                open.push(Vec::new());
                continue;
            };
            let delay = matches!(&s.body, Body::Node(node) if node.allowed_in_cycle());
            let params = s.params.iter().flat_map(|p| &p.feeds).map(|f| f.from);
            feeds_of.push(s.inputs.iter().flatten().map(|f| f.from).chain(params.clone()).collect());
            open.push(if delay { params.collect() } else { feeds_of[feeds_of.len() - 1].clone() });
        }
        let mut cut = vec![false; n];
        for scc in components(&open) {
            if is_cycle(&scc, &open) { for v in scc { cut[v] = true; } }
        }

        // Depth first from the outputs (then from whatever else is left,
        // which Chrome would not render at all but a stage still keeps in
        // time), each node once everything it pulls is done. A feed found
        // still being pulled is a cycle's way back, and is simply passed by.
        let sinks: Vec<usize> = (0..n)
            .filter(|&i| matches!(self.slots[i], Some(Slot { body: Body::Master | Body::Egress(_), .. })))
            .collect();
        let mut state = vec![0u8; n]; // unseen, being pulled, done
        let mut stack: Vec<(usize, usize)> = Vec::new();
        self.order.clear();
        let was = (self.stats.cut, self.stats.first_cut);
        self.stats.cut = 0;
        self.stats.first_cut = 0;
        for root in sinks.into_iter().chain(0..n) {
            if state[root] != 0 || self.slots[root].is_none() { continue; }
            state[root] = 1;
            stack.push((root, 0));
            while let Some((v, next)) = stack.last_mut() {
                let v = *v;
                if let Some(&w) = feeds_of[v].get(*next) {
                    *next += 1;
                    if state[w] == 0 {
                        state[w] = 1;
                        stack.push((w, 0));
                    }
                    continue;
                }
                stack.pop();
                state[v] = 2;
                if cut[v] {
                    self.stats.cut += 1;
                    if self.stats.first_cut == 0 { self.stats.first_cut = self.slots[v].as_ref().map_or(0, |s| s.id); }
                    self.order.push(Step::Cut(v));
                } else {
                    self.order.push(Step::Render(v));
                }
            }
        }
        // A cut cycle is a mistake in the page's graph, silent by nature, so
        // the page is told whenever the cut changes, and when it heals.
        let now = (self.stats.cut, self.stats.first_cut);
        if now != was {
            let (count, first) = if now.0 > 0 { now } else { (0, was.1) };
            self.events.log(first, log_code::CYCLE_CUT, count);
        }
    }
}

impl Param {
    /// This quantum's values: the timeline, then (Chrome's summing junction)
    /// any audio connected to the param, summed to mono and added, a NaN
    /// from it replaced by the default, and the sum clamped. With `exact`
    /// (the node's Node::sample_accurate), an a-rate param that Chrome would
    /// call sample-accurate, automated or fed, comes as a block even when
    /// every frame of it is the same.
    fn compute(&mut self, frame: u64, outs: &[Vec<Bus>], sum: &mut Bus, exact: bool) {
        let fill = self.timeline.fill(&mut self.block, frame);
        sum.channels = 1;
        sum.silent = true;
        for f in &self.feeds { mix_into(sum, &outs[f.from][f.output], true); }
        if sum.silent {
            self.constant = match fill {
                Fill::Const(v) if exact && self.rate == Rate::A
                    && (!self.feeds.is_empty() || self.timeline.has_values(frame)) =>
                {
                    self.block.fill(v);
                    None
                }
                Fill::Const(v) => Some(v),
                Fill::Varying => None,
            };
            return;
        }
        let clean = |v: f32, d: f32, lo: f32, hi: f32| if v.is_nan() { d } else { v.max(lo).min(hi) };
        let (d, lo, hi) = (self.default, self.min, self.max);
        match self.rate {
            Rate::K => {
                let v = match fill { Fill::Const(v) => v, Fill::Varying => self.block[0] };
                self.constant = Some(clean(v + sum.data[0][0], d, lo, hi));
            }
            Rate::A => {
                if let Fill::Const(v) = fill { self.block.fill(v); }
                simd::add_into(&mut self.block, &sum.data[0]);
                for v in self.block.iter_mut() { *v = clean(*v, d, lo, hi); }
                self.constant = None;
            }
        }
    }
}

/// The rules of a destination: two channels, explicit, speakers.
fn sink_channels() -> ChannelConfig {
    ChannelConfig { count: MAX_CHANNELS, mode: CountMode::Explicit, speakers: true }
}

/// Adds a stereo bus into a planar port at frame offset `at`.
fn add_to_port(port: &mut [f32], stride: usize, at: usize, bus: &Bus) {
    if bus.silent { return; }
    for c in 0..MAX_CHANNELS {
        let src = bus.channel(c.min(bus.channels - 1));
        simd::add_into(&mut port[c * stride + at..c * stride + at + QUANTUM], src);
    }
}

/// A stereo bus from a planar port at frame offset `at`, silent if all zero.
fn read_port(port: &[f32], stride: usize, at: usize, out: &mut Bus) {
    out.channels = MAX_CHANNELS;
    let mut peak = 0.0f32;
    for c in 0..MAX_CHANNELS {
        let src = &port[c * stride + at..c * stride + at + QUANTUM];
        simd::copy(&mut out.data[c], src);
        peak = peak.max(simd::max_abs(src));
    }
    out.silent = peak == 0.0;
}

/// Tarjan's strongly connected components, without recursion (a wasm stack
/// is small and a graph can be deep). Each component comes out after every
/// component it leads to.
fn components(adj: &[Vec<usize>]) -> Vec<Vec<usize>> {
    const NONE: usize = usize::MAX;
    let n = adj.len();
    let (mut index, mut low, mut on) = (vec![NONE; n], vec![0; n], vec![false; n]);
    let (mut stack, mut out, mut next) = (Vec::new(), Vec::new(), 0);
    let mut calls: Vec<(usize, usize)> = Vec::new();
    for root in 0..n {
        if index[root] != NONE { continue; }
        calls.push((root, 0));
        index[root] = next; low[root] = next; next += 1;
        stack.push(root); on[root] = true;
        while let Some(&(v, child)) = calls.last() {
            if let Some(&w) = adj[v].get(child) {
                calls.last_mut().expect("just read").1 += 1;
                if index[w] == NONE {
                    index[w] = next; low[w] = next; next += 1;
                    stack.push(w); on[w] = true;
                    calls.push((w, 0));
                } else if on[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            calls.pop();
            if let Some(&(u, _)) = calls.last() { low[u] = low[u].min(low[v]); }
            if low[v] == index[v] {
                let mut scc = Vec::new();
                loop {
                    let w = stack.pop().expect("v is on the stack");
                    on[w] = false;
                    scc.push(w);
                    if w == v { break; }
                }
                out.push(scc);
            }
        }
    }
    out
}

/// A component is a cycle if it has more than one vertex or a vertex that
/// feeds itself.
fn is_cycle(scc: &[usize], adj: &[Vec<usize>]) -> bool {
    scc.len() > 1 || adj[scc[0]].contains(&scc[0])
}
