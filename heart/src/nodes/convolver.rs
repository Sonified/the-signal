//! ConvolverNode, as the Web Audio spec defines it and Chrome plays it: the
//! impulse normalised by the spec's calibration, the spec's channel rules,
//! and zero latency. The rooms (js/audio.js createRoom, the harmonics' room,
//! the piano's) are these, so this is where most of the engine's work goes.
//!
//! ---------- the partitions ----------
//! A long impulse convolved directly costs its length in multiplies per
//! sample; through the FFT it costs a few dozen. The catch is latency: an FFT
//! block of B samples can only be taken once B samples of input are in hand.
//! So the impulse is cut into partitions that grow along it (non-uniform
//! partitioned convolution, after Gardner and Wefers): short ones at the
//! start, where the answer is needed at once, long ones further down, whose
//! answers are not needed until later.
//!
//!   head    128 × HEAD          the first few quanta of the impulse
//!   then    B × (GROWTH − 1)    each level's blocks GROWTH times the last's
//!   tail    MAX_BLOCK × rest    the rest of the impulse, however long
//!
//! which for a 4.5 s impulse at 48 kHz is 128 × 8, 1024 × 3, 4096 × 3 and
//! 16384 × 13. (Measured natively against the other shapes worth trying,
//! doubling or a 32768 tail or an 8192 one, and a head of 4 or 16: this one
//! had the lowest mean and the lowest peaks together.)
//!
//! with the levels laid end to end so that every level starts exactly one
//! block of its own size into the impulse (offset = B). That one rule is the
//! whole timing argument. A level's block of input [jB, (j+1)B) is complete
//! at the end of the quantum that ends at (j+1)B, and the earliest output it
//! touches is jB + B, the very next quantum, so the level is computed whole
//! in the quantum its block completes and its B samples of result are read
//! out over the B / 128 quanta that follow, exactly until the next block's
//! result takes over. The head is the one level at offset 0: its block is the
//! current quantum, and its result is this quantum's output. Nothing is ever
//! late, so there is no latency anywhere.
//!
//! Each level is uniformly partitioned overlap-save: FFTs of 2B, the input's
//! spectra kept in a frequency-domain delay line, so one forward and one
//! inverse transform per block serve every partition of the level.
//!
//! ---------- when the work happens ----------
//! A level's block completes once every B / 128 quanta, and that quantum
//! carries its transforms. Its multiply-adds need not: the sum over the
//! level's later partitions uses only spectra of blocks already complete, so
//! it is accumulated a slice of bins per quantum across the block before
//! (time-distributed), and the completing quantum adds only the newest
//! block's product. The transforms themselves are computed whole when their
//! input is complete. That leaves a spike every MAX_BLOCK samples (one
//! forward and one inverse FFT of 2 × MAX_BLOCK per channel, plus the smaller
//! levels that complete on the same quantum), which the worker's lookahead
//! absorbs; the steady cost is spread flat. Both choices are exact: the same
//! sums are formed, only at different moments.
//!
//! ---------- numbers ----------
//! Transforms are f32 (realfft over rustfft, with its wasm SIMD path), as
//! Chrome's are. The spectra are kept planar (all real parts, then all
//! imaginary parts) so the multiply-add runs four bins to an instruction.
//! The inverse transform's 1/N is folded into the stored impulse spectra,
//! where for a power-of-two N it is exact.
//!
//! ---------- silence ----------
//! With silent input it keeps rendering until the impulse has rung out (the
//! tail is the impulse's length: after that many frames of silence the
//! output is exactly zero), then clears its memory once and reports Silent,
//! costing nothing until the input wakes. If the graph stops calling it
//! sooner, the gap in the frame count is noticed and the memory cleared then.
//!
//! ---------- the impulse ----------
//! `buffer` (attr 5) names a sample buffer in the BufferPool, of 1, 2 or 4
//! channels; `normalize` (attr 6, default true) is read when the buffer is
//! set, as the spec says. Setting a buffer starts from fresh state (the
//! app's rooms crossfade two convolvers themselves). The node is not handed
//! the pool when an attribute is set, so the impulse is taken up on the next
//! render that finds it in the pool: that quantum allocates the node's memory
//! and copies the impulse in (about a millisecond of wasm for a 4.5 s stereo
//! room). Its partitions are transformed just in time after that, each by
//! the quantum its first product with live input is taken, plus one more per
//! quantum, so a new room never lands as one long quantum (all at once it
//! was over 12 ms of wasm).

use crate::buffers::AudioData;
use crate::node::{Activity, Bus, ChannelConfig, CountMode, Node, NodeInit, RenderCtx, QUANTUM};
use crate::simd::add_into;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::cell::RefCell;
use std::sync::Arc;

/// Partitions of one quantum at the head of the impulse.
const HEAD: usize = 8;
/// Each level's blocks are this many times the last level's (2 or 4: the
/// next level must start exactly one of its own blocks in).
const GROWTH: usize = 4;
/// The largest block. Everything past the growing levels is cut in these.
const MAX_BLOCK: usize = 16384;

/// The spec's calibration: Chrome's kGainCalibration (−58 dB) at
/// kGainCalibrationSampleRate, with its floor on the measured power.
const GAIN_CALIBRATION_DB: f64 = -58.0;
const GAIN_CALIBRATION_SAMPLE_RATE: f64 = 44100.0;
const MIN_POWER: f64 = 0.000125;

/// The spec's normalisation scale for an impulse:
/// 1/√(Σx² / (channels·length)), floored at MIN_POWER, times the calibration
/// 10^(−58/20)·44100/sampleRate, halved for a four-channel (true stereo) one.
pub fn normalization_scale(ir: &AudioData) -> f32 {
    let channels = ir.channels.len();
    let len = ir.frames();
    let mut power = 0.0f64;
    for c in &ir.channels {
        let mut cp = 0.0f64;
        for &s in c { cp += s as f64 * s as f64; }
        power += cp;
    }
    let mut power = (power / (channels * len) as f64).sqrt();
    // Protect against accidental overload.
    if !power.is_finite() || power < MIN_POWER { power = MIN_POWER; }
    let mut scale = 1.0 / power;
    scale *= 10f64.powf(GAIN_CALIBRATION_DB / 20.0);
    if ir.sample_rate > 0.0 { scale *= GAIN_CALIBRATION_SAMPLE_RATE / ir.sample_rate as f64; }
    if channels == 4 { scale *= 0.5; }
    scale as f32
}

/// The partition levels for an impulse of `len` frames: (block, count,
/// offset), laid end to end, each non-head level at offset = its block.
pub fn plan_levels(len: usize) -> Vec<(usize, usize, usize)> {
    let mut levels = Vec::new();
    let head = HEAD.min(len.div_ceil(QUANTUM)).max(1);
    levels.push((QUANTUM, head, 0));
    let mut offset = QUANTUM * HEAD;
    while offset < len {
        let b = offset;
        let left = (len - offset).div_ceil(b);
        let m = if b >= MAX_BLOCK { left } else { (GROWTH - 1).min(MAX_BLOCK / b - 1).min(left) };
        levels.push((b, m, offset));
        offset += m * b;
    }
    levels
}

thread_local! {
    /// One planner per stage (a stage is one thread), which keeps every FFT
    /// it has planned: every room on the stage shares the same few sizes, so
    /// a new impulse reuses their twiddle tables instead of computing them.
    static PLANNER: RefCell<RealFftPlanner<f32>> = RefCell::new(RealFftPlanner::new());
}

/// One level of the plan, shared by every channel.
struct Level {
    /// Block size B (the FFT is 2B) and partition count.
    b: usize,
    m: usize,
    offset: usize,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
}

/// One convolution running on one input against one impulse channel (Chrome
/// keeps one per impulse channel, and two at least).
struct Lane {
    kernel: usize,
    levels: Vec<LaneLevel>,
}

/// A lane's state at one level.
struct LaneLevel {
    /// The overlap-save frame: the previous block, then the block filling.
    frame: Vec<f32>,
    /// Frames of the current block received.
    fill: usize,
    /// The spectra of the last m − 1 complete blocks, planar, a ring.
    fdl: Vec<f32>,
    fdl_head: usize,
    /// The later partitions' sum for the block completing next, planar,
    /// built a slice at a time.
    acc: Vec<f32>,
    /// The last block's B samples of output, read a quantum at a time.
    result: Vec<f32>,
}

/// Everything built from one impulse.
struct Engine {
    ir_channels: usize,
    len: usize,
    levels: Vec<Level>,
    /// Per impulse channel, per level: the m partitions' spectra, planar,
    /// each 2(B + 1) floats, scaled by 1/2B. Filled in just in time (see
    /// `prepare`); a partition not yet transformed is zeros.
    kernels: Vec<Vec<Vec<f32>>>,
    /// The impulse, scaled, kept until every partition is transformed.
    ir: Vec<Vec<f32>>,
    /// Partitions still to transform, by deadline: (the lane call by which
    /// it is needed, impulse channel, level, partition). `next` is the first
    /// one not yet done.
    todo: Vec<(u64, usize, usize, usize)>,
    next: usize,
    /// Quanta the lanes have run since they were last fresh.
    lane_calls: u64,
    lanes: Vec<Lane>,
    fft_in: Vec<f32>,
    spec: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    time_out: Vec<f32>,
}

impl Engine {
    fn build(ir: &AudioData, normalize: bool) -> Option<Engine> {
        let ir_channels = ir.channels.len();
        let len = ir.frames();
        if !(ir_channels == 1 || ir_channels == 2 || ir_channels == 4) || len == 0 { return None; }
        let scale = if normalize { normalization_scale(ir) } else { 1.0 };
        let levels: Vec<Level> = PLANNER.with(|planner| {
            let mut planner = planner.borrow_mut();
            plan_levels(len)
                .into_iter()
                .map(|(b, m, offset)| Level {
                    b, m, offset,
                    fwd: planner.plan_fft_forward(2 * b),
                    inv: planner.plan_fft_inverse(2 * b),
                })
                .collect()
        });
        let max_b = levels.iter().map(|l| l.b).max().unwrap_or(QUANTUM);
        let scratch_len = levels
            .iter()
            .map(|l| l.fwd.get_scratch_len().max(l.inv.get_scratch_len()))
            .max()
            .unwrap_or(0);
        // The impulse is scaled in f32, as Chrome scales its copy.
        let ir_scaled: Vec<Vec<f32>> = ir.channels.iter().map(|c| c.iter().map(|v| v * scale).collect()).collect();
        let kernels = (0..ir_channels)
            .map(|_| levels.iter().map(|l| vec![0.0f32; l.m * 2 * (l.b + 1)]).collect())
            .collect();
        // When each partition is first needed. Partition p of a level whose
        // blocks take P quanta first meets live input in the sum for block
        // p, whose first slice is taken on lane call p·P; the first partition
        // is needed when block 0 completes, on call P − 1.
        let mut todo = Vec::new();
        for ch in 0..ir_channels {
            for (lv, l) in levels.iter().enumerate() {
                let per = (l.b / QUANTUM) as u64;
                for p in 0..l.m {
                    let due = if p == 0 { per - 1 } else { p as u64 * per };
                    todo.push((due, ch, lv, p));
                }
            }
        }
        todo.sort_by_key(|t| t.0);
        // Two lanes at least, so a stereo input has one per side even
        // against a mono impulse; a lane uses impulse channel min(i, last).
        let lanes = (0..ir_channels.max(2))
            .map(|i| Lane {
                kernel: i.min(ir_channels - 1),
                levels: levels.iter().map(|l| LaneLevel {
                    frame: vec![0.0; 2 * l.b],
                    fill: 0,
                    fdl: vec![0.0; l.m.saturating_sub(1) * 2 * (l.b + 1)],
                    fdl_head: 0,
                    acc: vec![0.0; 2 * (l.b + 1)],
                    result: vec![0.0; l.b],
                }).collect(),
            })
            .collect();
        Some(Engine {
            ir_channels,
            len,
            kernels,
            ir: ir_scaled,
            todo,
            next: 0,
            lane_calls: 0,
            lanes,
            fft_in: vec![0.0; 2 * max_b],
            spec: vec![Complex::new(0.0, 0.0); max_b + 1],
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
            time_out: vec![0.0; 2 * max_b],
            levels,
        })
    }

    /// Transforms the impulse's partitions just in time: every one the lanes
    /// need by this quantum, and one more besides, so the whole impulse is
    /// ready within a few dozen quanta and no single one carries it all.
    /// (Transforming a 4.5 s stereo impulse in one go is over 12 ms of wasm,
    /// a good share of the lookahead on a phone.)
    fn prepare(&mut self) {
        let mut spare = 1;
        while self.next < self.todo.len() {
            let (due, ch, lv, p) = self.todo[self.next];
            if due > self.lane_calls {
                if spare == 0 { break; }
                spare -= 1;
            }
            self.transform(ch, lv, p);
            self.next += 1;
        }
        // Done with the samples once every partition holds its spectrum.
        if self.next == self.todo.len() && !self.ir.is_empty() { self.ir = Vec::new(); }
    }

    /// Partition p of level lv of impulse channel ch, zero-padded to 2B,
    /// transformed, with the inverse transform's 1/2B folded in.
    fn transform(&mut self, ch: usize, lv: usize, p: usize) {
        let l = &self.levels[lv];
        let nb = l.b + 1;
        let x = &mut self.fft_in[..2 * l.b];
        x.fill(0.0);
        let start = (l.offset + p * l.b).min(self.len);
        let end = (start + l.b).min(self.len);
        x[..end - start].copy_from_slice(&self.ir[ch][start..end]);
        let spec = &mut self.spec[..nb];
        let _ = l.fwd.process_with_scratch(x, spec, &mut self.scratch);
        let norm = 1.0 / (2 * l.b) as f32;
        let (re, im) = self.kernels[ch][lv][p * 2 * nb..(p + 1) * 2 * nb].split_at_mut(nb);
        for i in 0..nb {
            re[i] = spec[i].re * norm;
            im[i] = spec[i].im * norm;
        }
    }

    /// Forgets every input heard, as if fed silence forever.
    fn clear(&mut self) {
        for lane in &mut self.lanes {
            for s in &mut lane.levels {
                s.frame.fill(0.0);
                s.fill = 0;
                s.fdl.fill(0.0);
                s.fdl_head = 0;
                s.acc.fill(0.0);
                s.result.fill(0.0);
            }
        }
        self.lane_calls = 0;
    }

    /// Runs lane `li` on one quantum of input `x`, adding its output to `out`.
    fn run_lane(&mut self, li: usize, x: &[f32; QUANTUM], out: &mut [f32; QUANTUM]) {
        let Engine { levels, kernels, lanes, fft_in, spec, scratch, time_out, .. } = self;
        let lane = &mut lanes[li];
        let kernel = &kernels[lane.kernel];
        for (lv, (l, s)) in levels.iter().zip(lane.levels.iter_mut()).enumerate() {
            let b = l.b;
            let nb = b + 1;
            let head = lv == 0;
            // A later level's result for this quantum was computed when its
            // last block completed; read it before this quantum completes the
            // next one.
            if !head { add_into(out, &s.result[s.fill..s.fill + QUANTUM]); }
            s.frame[b + s.fill..b + s.fill + QUANTUM].copy_from_slice(x);
            s.fill += QUANTUM;

            // This quantum's slice of the later partitions' sum: partition p
            // meets the spectrum of the block p before the one now filling.
            let slices = b / QUANTUM;
            let si = s.fill / QUANTUM - 1;
            let (lo, hi) = (si * nb / slices, (si + 1) * nb / slices);
            let ring = l.m.saturating_sub(1);
            for p in 1..l.m {
                let slot = (s.fdl_head + ring - (p - 1)) % ring;
                let xs = &s.fdl[slot * 2 * nb..(slot + 1) * 2 * nb];
                let hs = &kernel[lv][p * 2 * nb..(p + 1) * 2 * nb];
                mac(&mut s.acc, xs, hs, nb, lo, hi);
            }

            if s.fill == b {
                // The block is complete: transform it, keep its spectrum for
                // the partitions to come, add its product with the first
                // partition to the sum, and transform back. Overlap-save's
                // valid half is the last B samples.
                let n = 2 * b;
                fft_in[..n].copy_from_slice(&s.frame);
                let sp = &mut spec[..nb];
                let _ = l.fwd.process_with_scratch(&mut fft_in[..n], sp, scratch);
                if ring > 0 {
                    s.fdl_head = (s.fdl_head + 1) % ring;
                    let (re, im) = s.fdl[s.fdl_head * 2 * nb..(s.fdl_head + 1) * 2 * nb].split_at_mut(nb);
                    for i in 0..nb {
                        re[i] = sp[i].re;
                        im[i] = sp[i].im;
                    }
                }
                let (hr, hi_) = kernel[lv][..2 * nb].split_at(nb);
                let (ar, ai) = s.acc.split_at(nb);
                for i in 0..nb {
                    let (xr, xi) = (sp[i].re, sp[i].im);
                    sp[i] = Complex::new(ar[i] + (xr * hr[i] - xi * hi_[i]), ai[i] + (xr * hi_[i] + xi * hr[i]));
                }
                // A real signal's spectrum has no imaginary part at DC or at
                // Nyquist; any rounding there is dropped.
                sp[0].im = 0.0;
                sp[b].im = 0.0;
                let _ = l.inv.process_with_scratch(sp, &mut time_out[..n], scratch);
                s.result.copy_from_slice(&time_out[b..n]);
                s.acc.fill(0.0);
                s.frame.copy_within(b..n, 0);
                s.fill = 0;
            }
            // The head's result is this very quantum's.
            if head { add_into(out, &s.result[..QUANTUM]); }
        }
    }
}

/// acc += x · h over bins [lo, hi), all three planar spectra of nb bins.
#[inline]
fn mac(acc: &mut [f32], x: &[f32], h: &[f32], nb: usize, lo: usize, hi: usize) {
    let (ar, ai) = acc.split_at_mut(nb);
    let (ar, ai) = (&mut ar[lo..hi], &mut ai[lo..hi]);
    let (xr, xi) = (&x[lo..hi], &x[nb + lo..nb + hi]);
    let (hr, hi_) = (&h[lo..hi], &h[nb + lo..nb + hi]);
    for k in 0..ar.len() {
        ar[k] += xr[k] * hr[k] - xi[k] * hi_[k];
        ai[k] += xr[k] * hi_[k] + xi[k] * hr[k];
    }
}

pub struct Convolver {
    engine: Option<Engine>,
    normalize: bool,
    /// A buffer set but not yet partitioned, with the normalize in force when
    /// it was set.
    pending: Option<(u32, bool)>,
    /// Frames of silent input since the last live quantum.
    quiet: usize,
    /// The memory holds nothing but zeros.
    clean: bool,
    /// The frame the next render should start at, to notice a gap.
    next_frame: u64,
    /// The input's channel count while it was last live, which the tail keeps.
    last_in: usize,
}

impl Convolver {
    pub fn new(_init: &NodeInit) -> Self {
        Convolver { engine: None, normalize: true, pending: None, quiet: 0, clean: true, next_frame: 0, last_in: 1 }
    }

    fn out_channels(&self, input: usize) -> usize {
        // A buffer named but not yet partitioned may be any width, and the
        // bus is sized before the render that partitions it; stereo is the
        // safe guess (a mono result is then heard on both sides).
        let ir = if self.pending.is_some() { 2 } else { self.engine.as_ref().map_or(0, |e| e.ir_channels) };
        input.max(ir).clamp(1, 2)
    }
}

impl Node for Convolver {
    /// The spec's: two channels, clamped-max, speakers.
    fn channel_config(&self) -> ChannelConfig {
        ChannelConfig { count: 2, mode: CountMode::ClampedMax, speakers: true }
    }

    /// One channel only with a mono input and a mono impulse; stereo
    /// otherwise (Chrome's ComputeNumberOfOutputChannels). A ringing tail
    /// keeps the width it had.
    fn output_channels(&self, _o: usize, input_channels: &[usize]) -> usize {
        let input = input_channels.first().copied().unwrap_or(1);
        let ringing = !self.clean && self.quiet > 0;
        self.out_channels(if ringing { input.max(self.last_in) } else { input })
    }

    fn tail_frames(&self) -> f64 { self.engine.as_ref().map_or(0.0, |e| e.len as f64) }

    fn set_attr(&mut self, attr: u32, value: f64) {
        match attr {
            5 => {
                if value.is_nan() || value < 0.0 {
                    // No buffer: silence, as the spec's null buffer.
                    self.engine = None;
                    self.pending = None;
                } else {
                    self.pending = Some((value as u32, self.normalize));
                }
            }
            6 => self.normalize = value != 0.0 && !value.is_nan(),
            _ => {}
        }
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        if let Some((id, normalize)) = self.pending {
            // Kept waiting until the pool has it, should the samples arrive
            // after the command that names them.
            if let Some(data) = ctx.buffers.get(id) {
                self.engine = Engine::build(data, normalize);
                self.pending = None;
                self.quiet = 0;
                self.clean = true;
            }
        }
        let o = &mut out[0];
        let gap = ctx.frame != self.next_frame;
        self.next_frame = ctx.frame + QUANTUM as u64;
        let Some(engine) = self.engine.as_mut() else {
            o.zero();
            return Activity::Silent;
        };
        // Not called for a while: whatever was ringing is long gone, and the
        // memory must not carry it into a later block.
        if gap && !self.clean {
            engine.clear();
            self.clean = true;
        }
        // The impulse's partitions this quantum's lanes will need, and one
        // more, even through silence.
        engine.prepare();
        let inp = &ctx.inputs[0];
        let live = !inp.silent;
        if live {
            self.quiet = 0;
            self.clean = false;
            self.last_in = inp.channels.clamp(1, 2);
        } else {
            if self.clean || self.quiet >= engine.len {
                // Rung out: from here the output is exactly zero.
                if !self.clean { engine.clear(); self.clean = true; }
                o.zero();
                return Activity::Silent;
            }
            self.quiet += QUANTUM;
        }

        let zeros = [0.0f32; QUANTUM];
        let in_ch = self.last_in;
        let (x0, x1) = if live {
            (&inp.data[0], if inp.channels > 1 { &inp.data[1] } else { &inp.data[0] })
        } else {
            (&zeros, &zeros)
        };
        let out_ch = in_ch.max(engine.ir_channels).clamp(1, 2);
        for c in o.data.iter_mut() { c.fill(0.0); }
        {
            let [l, r] = &mut o.data;
            match (in_ch, engine.ir_channels) {
                (1, 1) => engine.run_lane(0, x0, l),
                // Stereo in, mono or stereo impulse: each side through its own.
                (2, 1) | (2, 2) => {
                    engine.run_lane(0, x0, l);
                    engine.run_lane(1, x1, r);
                }
                // Mono in, stereo or true-stereo impulse: the input through
                // the first two channels.
                (1, _) => {
                    engine.run_lane(0, x0, l);
                    engine.run_lane(1, x0, r);
                }
                // True stereo: left through 0 and 1, right through 2 and 3.
                _ => {
                    engine.run_lane(0, x0, l);
                    engine.run_lane(1, x0, r);
                    engine.run_lane(2, x1, l);
                    engine.run_lane(3, x1, r);
                }
            }
        }
        engine.lane_calls += 1;
        // A bus wider than the result (sized before the impulse widened it)
        // hears the one channel on both sides.
        if o.channels > out_ch {
            let [l, r] = &mut o.data;
            r.copy_from_slice(l);
        }
        o.silent = false;
        Activity::Active
    }
}
