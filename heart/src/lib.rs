//! Heart: The Signal's audio engine. A twin of the Web Audio API in Rust,
//! rendered ahead in workers. See documents/heart-audio-engine.md.
//!
//! One wasm instance is one stage, and holds one `Engine`. The engine is a
//! render graph (graph.rs) for the combined, island and mix roles, which
//! differ only in which nodes JS puts on them, or the shadow (shadow.rs),
//! which keeps param timelines and never renders.
//!
//! ## The ABI (spec 5)
//!
//! Raw `extern "C"` exports, no glue; pointers are offsets into the
//! instance's memory, and any call may grow it, so JS takes its typed-array
//! views afresh after each one.
//!
//! | Export | Does |
//! |---|---|
//! | `heart_init(sample_rate, role, seed) -> u32` | role 0 combined, 1 island, 2 mix, 3 shadow. 1 if ready, 0 if refused. |
//! | `heart_alloc(bytes) -> u32`, `heart_free(ptr, bytes)` | scratch memory, 8-byte aligned, for command batches |
//! | `heart_commands(ptr, len)` | applies a batch of command records, in order |
//! | `heart_render(frames) -> u32` | renders `frames` (whole quanta, at most 8192); returns the new frame count, as a u32 that wraps (use heart_frame) |
//! | `heart_port_ptr(kind, port) -> u32` | kind 0 egress, 1 ingress (port = sourceStage·16 + port), 2 master; planar f32, left then right, each the last render's frames long (room for 8192). 0 when no such port exists. |
//! | `heart_events(ptr_out) -> u32` | writes the address of the events since the last call to `ptr_out` and returns their length; they stay valid until the next call |
//! | `heart_buffer_alloc(id, channels, frames, sample_rate) -> u32` | planar room for sample buffer `id` (channel c at ptr + 4·c·frames) for JS to fill before its next command batch or render; 0 if refused |
//! | `heart_buffer_free(id)` | JS is done with buffer `id`; it goes once no node holds it |
//! | `heart_param_value(node, param, frame) -> f32` | the shadow's intrinsic value of a param at a frame (a stage answers with its last computed value); NaN for an unknown param |
//! | `heart_frame() -> f64` | the next frame to render |
//! | `heart_skip(frames)` | a render stage's present moves on by `frames` (whole quanta) without rendering them; every node keeps its state (graph.rs, skip). The shadow ignores it. |
//! | `heart_now(frame)` | the shadow's present moves up to `frame` (a stage's present is its render head, and it ignores this) |
//! | `heart_stats() -> u32` | the address of eight u32 counters, below |
//!
//! `heart_stats` points at, in order: nodes alive; nodes rendered in the last
//! render call (summed over its quanta); nodes skipped as silent in it;
//! nodes cut off in a cycle with no delay at the last order rebuild; command
//! records rejected so far (unknown op, node, param or port, or cut short);
//! the id of the first node cut at the last rebuild (0 for none); dropped
//! nodes still sounding out; order rebuilds so far. A shadow fills in the
//! nodes it holds and its rejections.

pub mod node;
pub mod nodes;
pub mod buffers;
pub mod events;
pub mod rng;
pub mod simd;
pub mod mixing;
pub mod param;
pub mod protocol;
pub mod protocol_gen;
pub mod graph;
pub mod shadow;

use graph::{Graph, PortKind};
use protocol::for_each_command;
use shadow::Shadow;

enum Stage {
    Render(Graph),
    Shadow(Shadow),
}

pub struct Engine {
    stage: Stage,
    stats: [u32; 8],
}

impl Engine {
    /// An engine for `role` (0 combined, 1 island, 2 mix, 3 shadow), or None
    /// for a role or sample rate that makes no sense.
    pub fn new(sample_rate: f32, role: u32, seed: u32) -> Option<Engine> {
        if !(sample_rate > 0.0) || !sample_rate.is_finite() { return None; }
        let stage = match role {
            0..=2 => Stage::Render(Graph::new(sample_rate, seed)),
            3 => Stage::Shadow(Shadow::new(sample_rate)),
            _ => return None,
        };
        Some(Engine { stage, stats: [0; 8] })
    }

    pub fn commands(&mut self, batch: &[u8]) {
        let rejected = match &mut self.stage {
            Stage::Render(g) => {
                g.buffers.commit();
                for_each_command(batch, |node, c| g.apply(node, c))
            }
            Stage::Shadow(s) => for_each_command(batch, |node, c| s.apply(node, c)),
        };
        match &mut self.stage {
            Stage::Render(g) => g.stats.rejected += rejected,
            Stage::Shadow(s) => s.rejected += rejected,
        }
    }

    /// Renders `frames` and returns the new frame count. The shadow does not
    /// render.
    pub fn render(&mut self, frames: u32) -> u64 {
        match &mut self.stage {
            Stage::Render(g) => { g.render(frames as usize); g.frame() }
            Stage::Shadow(_) => 0,
        }
    }

    pub fn frame(&self) -> u64 {
        match &self.stage { Stage::Render(g) => g.frame(), Stage::Shadow(_) => 0 }
    }

    /// Moves a render stage's present on by `frames` without rendering them
    /// (graph.rs, skip). The shadow has no present of its own to move.
    pub fn skip(&mut self, frames: u64) -> u64 {
        match &mut self.stage { Stage::Render(g) => g.skip(frames), Stage::Shadow(_) => 0 }
    }

    pub fn port(&mut self, kind: u32, port: u32) -> Option<&mut [f32]> {
        match &mut self.stage {
            Stage::Render(g) => g.port(PortKind::from_u32(kind)?, port),
            Stage::Shadow(_) => None,
        }
    }

    /// The events since the last call; they stay put until the next one.
    pub fn events(&mut self) -> &[u8] {
        match &mut self.stage { Stage::Render(g) => g.events.hand_over(), Stage::Shadow(_) => &[] }
    }

    pub fn buffer_alloc(&mut self, id: u32, channels: u32, frames: u32, sample_rate: f32) -> Option<&mut [f32]> {
        match &mut self.stage {
            Stage::Render(g) => g.buffers.stage(id, channels as usize, frames as usize, sample_rate),
            Stage::Shadow(_) => None,
        }
    }

    pub fn buffer_free(&mut self, id: u32) {
        if let Stage::Render(g) = &mut self.stage { g.buffers.free(id); }
    }

    pub fn param_value(&mut self, node: u32, param: u32, frame: f64) -> f32 {
        match &mut self.stage {
            Stage::Render(g) => g.param_value(node, param),
            Stage::Shadow(s) => s.value(node, param, frame),
        }
    }

    /// The page's present, as a frame, for the shadow: where an automation
    /// call made now is anchored (a ramp with nothing before it starts here,
    /// as Chrome starts it at the time of the call).
    pub fn set_now(&mut self, frame: f64) {
        if let Stage::Shadow(s) = &mut self.stage { s.advance(frame); }
    }

    pub fn stats(&mut self) -> &[u32; 8] {
        self.stats = match &self.stage {
            Stage::Render(g) => {
                let s = g.stats;
                [s.nodes, s.renders, s.skips, s.cut, s.rejected, s.first_cut, s.dropped, s.rebuilds]
            }
            Stage::Shadow(s) => [s.nodes() as u32, 0, 0, 0, s.rejected, 0, 0, 0],
        };
        &self.stats
    }
}

/// The exports. They exist only in the wasm build, where a pointer is a
/// u32; natively the engine above is used directly (and tested).
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::Engine;
    use std::alloc::{Layout, alloc, dealloc};
    use std::cell::UnsafeCell;

    /// The instance's one engine. A wasm instance runs on one thread and JS
    /// never calls back in during a call, so the cell is only ever reached
    /// by one export at a time.
    struct Global(UnsafeCell<Option<Engine>>);
    // SAFETY: see above; there is no second thread to share it with.
    unsafe impl Sync for Global {}
    static ENGINE: Global = Global(UnsafeCell::new(None));

    fn engine() -> Option<&'static mut Engine> {
        // SAFETY: single-threaded and not re-entered (see Global).
        unsafe { (*ENGINE.0.get()).as_mut() }
    }

    fn ptr<T>(p: *const T) -> u32 { p as usize as u32 }

    fn layout(bytes: u32) -> Option<Layout> { Layout::from_size_align(bytes.max(1) as usize, 8).ok() }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_init(sample_rate: f32, role: u32, seed: u32) -> u32 {
        let engine = Engine::new(sample_rate, role, seed);
        let ready = engine.is_some();
        // SAFETY: as in engine().
        unsafe { *ENGINE.0.get() = engine; }
        ready as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_alloc(bytes: u32) -> u32 {
        // SAFETY: the layout has a non-zero size.
        layout(bytes).map_or(0, |l| ptr(unsafe { alloc(l) }))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_free(p: u32, bytes: u32) {
        if p == 0 { return; }
        // SAFETY: JS hands back a pointer heart_alloc gave it, with the same size.
        if let Some(l) = layout(bytes) { unsafe { dealloc(p as usize as *mut u8, l) } }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_commands(p: u32, len: u32) {
        let Some(e) = engine() else { return };
        if p == 0 || len == 0 { return; }
        // SAFETY: JS wrote `len` bytes at `p`, memory it took from heart_alloc.
        let batch = unsafe { std::slice::from_raw_parts(p as usize as *const u8, len as usize) };
        e.commands(batch);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_render(frames: u32) -> u32 {
        engine().map_or(0, |e| e.render(frames) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_port_ptr(kind: u32, port: u32) -> u32 {
        engine().and_then(|e| e.port(kind, port)).map_or(0, |p| ptr(p.as_ptr()))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_events(ptr_out: u32) -> u32 {
        let Some(e) = engine() else { return 0 };
        let bytes = e.events();
        if ptr_out != 0 {
            // SAFETY: JS gives the address of four bytes it took from heart_alloc.
            unsafe { (ptr_out as usize as *mut u32).write_unaligned(ptr(bytes.as_ptr())) }
        }
        bytes.len() as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_buffer_alloc(id: u32, channels: u32, frames: u32, sample_rate: f32) -> u32 {
        engine().and_then(|e| e.buffer_alloc(id, channels, frames, sample_rate)).map_or(0, |b| ptr(b.as_ptr()))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_buffer_free(id: u32) {
        if let Some(e) = engine() { e.buffer_free(id); }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_param_value(node: u32, param: u32, frame: f64) -> f32 {
        engine().map_or(f32::NAN, |e| e.param_value(node, param, frame))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_frame() -> f64 {
        engine().map_or(0.0, |e| e.frame() as f64)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_skip(frames: f64) {
        if let Some(e) = engine() { if frames > 0.0 { e.skip(frames as u64); } }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_now(frame: f64) {
        if let Some(e) = engine() { e.set_now(frame); }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn heart_stats() -> u32 {
        engine().map_or(0, |e| ptr(e.stats().as_ptr()))
    }
}
