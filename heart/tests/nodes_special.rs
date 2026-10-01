//! Tests for the special nodes (convolver, FDN, one-pole, strobe-signal,
//! genus), driven straight through the Node trait with a RenderCtx built by
//! hand, so they need nothing of the graph.

use heart::buffers::{AudioData, BufferPool};
use heart::events::Events;
use heart::node::{Activity, Bus, Node, NodeInit, ParamBlock, RenderCtx, QUANTUM};
use heart::nodes::convolver::{normalization_scale, plan_levels, Convolver};
use heart::nodes::fdn::Fdn;
use heart::nodes::genus::{bilateral, flash_align, pip, Align, Genus};
use heart::nodes::one_pole::OnePole;
use heart::nodes::strobe_signal::StrobeSignal;
use heart::rng::Rng;

const SR: f32 = 48000.0;

fn init(seed: u32) -> NodeInit { NodeInit { sample_rate: SR, seed, opts: [0.0; 8] } }

/// Every param at its default, as Const blocks.
fn defaults(node: &dyn Node) -> Vec<f32> { node.param_specs().iter().map(|s| s.default).collect() }

/// One quantum through `node`, params constant at `params`.
fn render(
    node: &mut dyn Node, frame: u64, inputs: &[Bus], params: &[f32], buffers: &BufferPool,
    events: &mut Events, outs: &mut [Bus],
) -> Activity {
    // Connected while it sounds, as the tests' inputs come and go.
    let connected: Vec<bool> = inputs.iter().map(|b| !b.silent).collect();
    render_connected(node, frame, inputs, &connected, params, buffers, events, outs)
}

/// The same, saying outright which inputs are connected.
#[allow(clippy::too_many_arguments)]
fn render_connected(
    node: &mut dyn Node, frame: u64, inputs: &[Bus], connected: &[bool], params: &[f32], buffers: &BufferPool,
    events: &mut Events, outs: &mut [Bus],
) -> Activity {
    let blocks: Vec<ParamBlock> = params.iter().map(|&v| ParamBlock::Const(v)).collect();
    let mut ctx = RenderCtx { node: 7, frame, sample_rate: SR, inputs, connected, params: &blocks, buffers, events };
    node.render(&mut ctx, outs)
}

fn bus_from(ch: &[&[f32]], at: usize) -> Bus {
    let mut b = Bus::new(ch.len());
    let mut any = false;
    for (c, data) in ch.iter().enumerate() {
        for i in 0..QUANTUM {
            let v = data.get(at + i).copied().unwrap_or(0.0);
            b.data[c][i] = v;
            any |= v != 0.0;
        }
    }
    b.silent = !any;
    b
}

fn noise(rng: &mut Rng, n: usize) -> Vec<f32> { (0..n).map(|_| (rng.next_f64() * 2.0 - 1.0) as f32).collect() }

// ======================================================================
// Convolver
// ======================================================================

/// Direct time-domain convolution in f64.
fn direct(x: &[f32], h: &[f32], n: usize) -> Vec<f64> {
    let mut y = vec![0.0f64; n];
    for (s, &xv) in x.iter().enumerate() {
        if xv == 0.0 { continue; }
        for (k, &hv) in h.iter().enumerate() {
            if s + k >= n { break; }
            y[s + k] += xv as f64 * hv as f64;
        }
    }
    y
}

/// Runs a convolver over `inputs` (one Vec per input channel) for `frames`
/// frames, returning each output channel and the activity per quantum.
fn convolve(ir: Vec<Vec<f32>>, normalize: bool, inputs: &[Vec<f32>], frames: usize) -> (Vec<Vec<f32>>, Vec<Activity>) {
    let mut pool = BufferPool::default();
    pool.insert(3, AudioData { sample_rate: SR, channels: ir });
    let mut c = Convolver::new(&init(1));
    c.set_attr(6, if normalize { 1.0 } else { 0.0 });
    c.set_attr(5, 3.0);
    let mut ev = Events::default();
    let mut out = vec![vec![0.0f32; frames]; 2];
    let mut acts = Vec::new();
    let refs: Vec<&[f32]> = inputs.iter().map(|v| v.as_slice()).collect();
    for q in 0..frames / QUANTUM {
        let at = q * QUANTUM;
        let inb = [bus_from(&refs, at)];
        let ch = c.output_channels(0, &[inputs.len()]);
        let mut o = [Bus::new(ch)];
        acts.push(render(&mut c, at as u64, &inb, &[], &pool, &mut ev, &mut o));
        for c2 in 0..2 { out[c2][at..at + QUANTUM].copy_from_slice(&o[0].data[if c2 < ch { c2 } else { 0 }]); }
    }
    (out, acts)
}

/// The largest error against the reference, in dB relative to its peak.
fn err_db(got: &[f32], want: &[f64]) -> f64 {
    let peak = want.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let err = got.iter().zip(want).fold(0.0f64, |m, (g, w)| m.max((*g as f64 - w).abs()));
    20.0 * (err / peak).log10()
}

#[test]
fn convolver_plan_starts_each_level_one_block_in() {
    for len in [1, 100, 512, 513, 5000, 48000, 216000, 1_000_000] {
        let levels = plan_levels(len);
        assert_eq!(levels[0].0, QUANTUM);
        assert_eq!(levels[0].2, 0);
        // after the head, its quanta laid end to end
        let mut end = QUANTUM * levels[0].1;
        for &(b, m, off) in &levels[1..] {
            assert_eq!(off, b, "a level must start one block of its own size in ({len})");
            assert_eq!(off, end, "levels lie end to end ({len})");
            assert!(m >= 1);
            end = off + m * b;
        }
        assert!(end >= len, "the plan covers the impulse ({len})");
    }
}

#[test]
fn convolver_matches_direct_convolution() {
    let mut rng = Rng::new(42);
    // Lengths that are not powers of two among them, and ones that reach
    // the growing levels and the tail.
    for &len in &[1usize, 37, 128, 129, 300, 511, 1000, 2049, 5003, 20001, 70001] {
        let h = noise(&mut rng, len);
        // A burst of input, then silence (flagged), long enough for the
        // whole tail to play out and the node to go quiet.
        let burst = 3000.min(4 * len + 500);
        let frames = (burst + len + 3 * QUANTUM).div_ceil(QUANTUM) * QUANTUM + 2 * QUANTUM;
        let mut x = noise(&mut rng, burst);
        x.resize(frames, 0.0);
        let (out, acts) = convolve(vec![h.clone()], false, &[x.clone()], frames);
        let want = direct(&x, &h, frames);
        let e = err_db(&out[0], &want);
        assert!(e < -100.0, "len {len}: error {e:.1} dB");
        assert_eq!(*acts.last().unwrap(), Activity::Silent, "len {len}: rung out by the end");
    }
}

#[test]
fn convolver_continuous_input_long_impulse() {
    let mut rng = Rng::new(7);
    // Long enough to reach the 16384 level and see two of its blocks.
    let len = 20000;
    let h = noise(&mut rng, len);
    let frames = 300 * QUANTUM;
    let x = noise(&mut rng, frames);
    let (out, _) = convolve(vec![h.clone()], false, &[x.clone()], frames);
    let want = direct(&x, &h, frames);
    let e = err_db(&out[0], &want);
    assert!(e < -100.0, "error {e:.1} dB");
}

#[test]
fn convolver_channel_rules() {
    let mut rng = Rng::new(9);
    let len = 900;
    let frames = 30 * QUANTUM;
    let h: Vec<Vec<f32>> = (0..4).map(|_| noise(&mut rng, len)).collect();
    let mut xl = noise(&mut rng, 2000);
    xl.resize(frames, 0.0);
    let mut xr = noise(&mut rng, 2000);
    xr.resize(frames, 0.0);
    let mut case = 0;
    let mut ok = |got: &[f32], want: Vec<f64>| {
        case += 1;
        let e = err_db(got, &want);
        assert!(e < -100.0, "case {case}: {e:.1} dB");
    };

    // Mono in, stereo impulse: L = in∗IR0, R = in∗IR1.
    let (o, _) = convolve(vec![h[0].clone(), h[1].clone()], false, &[xl.clone()], frames);
    ok(&o[0], direct(&xl, &h[0], frames));
    ok(&o[1], direct(&xl, &h[1], frames));

    // Stereo in, stereo impulse: L = inL∗IR0, R = inR∗IR1.
    let (o, _) = convolve(vec![h[0].clone(), h[1].clone()], false, &[xl.clone(), xr.clone()], frames);
    ok(&o[0], direct(&xl, &h[0], frames));
    ok(&o[1], direct(&xr, &h[1], frames));

    // Stereo in, mono impulse: the one channel on both sides.
    let (o, _) = convolve(vec![h[0].clone()], false, &[xl.clone(), xr.clone()], frames);
    ok(&o[0], direct(&xl, &h[0], frames));
    ok(&o[1], direct(&xr, &h[0], frames));

    // True stereo: L = inL∗IR0 + inR∗IR2, R = inL∗IR1 + inR∗IR3.
    let (o, _) = convolve(h.clone(), false, &[xl.clone(), xr.clone()], frames);
    let sum = |a: Vec<f64>, b: Vec<f64>| a.iter().zip(&b).map(|(p, q)| p + q).collect::<Vec<f64>>();
    ok(&o[0], sum(direct(&xl, &h[0], frames), direct(&xr, &h[2], frames)));
    ok(&o[1], sum(direct(&xl, &h[1], frames), direct(&xr, &h[3], frames)));

    // Mono in, true-stereo impulse: the first two channels.
    let (o, _) = convolve(h.clone(), false, &[xl.clone()], frames);
    ok(&o[0], direct(&xl, &h[0], frames));
    ok(&o[1], direct(&xl, &h[1], frames));

    // Mono in, mono impulse: one channel out.
    let mut pool = BufferPool::default();
    pool.insert(1, AudioData { sample_rate: SR, channels: vec![h[0].clone()] });
    let mut c = Convolver::new(&init(1));
    c.set_attr(5, 1.0);
    let mut ev = Events::default();
    let mut o = [Bus::new(1)];
    render(&mut c, 0, &[bus_from(&[&xl], 0)], &[], &pool, &mut ev, &mut o);
    assert_eq!(c.output_channels(0, &[1]), 1);
    assert_eq!(c.output_channels(0, &[2]), 2);
}

#[test]
fn convolver_normalization() {
    let mut rng = Rng::new(11);
    let h: Vec<Vec<f32>> = (0..2).map(|_| noise(&mut rng, 3000).iter().map(|v| v * 0.3).collect()).collect();
    let data = AudioData { sample_rate: SR, channels: h.clone() };
    let mut sq = 0.0f64;
    for c in &h { for &v in c { sq += v as f64 * v as f64; } }
    let want = 1.0 / (sq / 6000.0).sqrt() * 10f64.powf(-58.0 / 20.0) * 44100.0 / SR as f64;
    let got = normalization_scale(&data) as f64;
    assert!((got / want - 1.0).abs() < 1e-6, "{got} vs {want}");
    // Four channels halve it; a silent impulse is floored, not infinite.
    let four = AudioData { sample_rate: SR, channels: vec![h[0].clone(), h[1].clone(), h[0].clone(), h[1].clone()] };
    assert!((normalization_scale(&four) as f64 / want / 0.5 - 1.0).abs() < 1e-6);
    let silent = AudioData { sample_rate: SR, channels: vec![vec![0.0; 100]] };
    let floor = 1.0 / 0.000125 * 10f64.powf(-58.0 / 20.0) * 44100.0 / SR as f64;
    assert!((normalization_scale(&silent) as f64 / floor - 1.0).abs() < 1e-6);

    // Rendered with normalize on, the output is the scaled convolution.
    let frames = 60 * QUANTUM;
    let mut x = noise(&mut rng, 1000);
    x.resize(frames, 0.0);
    let (o, _) = convolve(h.clone(), true, &[x.clone()], frames);
    let s = normalization_scale(&data);
    let hs: Vec<f32> = h[0].iter().map(|v| v * s).collect();
    assert!(err_db(&o[0], &direct(&x, &hs, frames)) < -100.0);
}

#[test]
fn convolver_rings_out_then_sleeps_and_wakes_clean() {
    let mut rng = Rng::new(5);
    let len = 6000;
    let h = noise(&mut rng, len);
    let mut pool = BufferPool::default();
    pool.insert(2, AudioData { sample_rate: SR, channels: vec![h.clone()] });
    let mut c = Convolver::new(&init(1));
    c.set_attr(6, 0.0);
    c.set_attr(5, 2.0);
    let mut ev = Events::default();
    let x = noise(&mut rng, QUANTUM * 3);
    let mut acts = Vec::new();
    let mut frame = 0u64;
    let mut out = Vec::new();
    let quanta = (3 * QUANTUM + len) / QUANTUM + 4;
    for q in 0..quanta {
        let mut o = [Bus::new(1)];
        acts.push(render(&mut c, frame, &[bus_from(&[&x], q * QUANTUM)], &[], &pool, &mut ev, &mut o));
        out.extend_from_slice(&o[0].data[0]);
        frame += QUANTUM as u64;
    }
    assert_eq!(c.tail_frames(), len as f64);
    // Active while the tail rings, Silent once it has rung out.
    let first_silent = acts.iter().position(|a| *a == Activity::Silent).unwrap();
    assert!(first_silent * QUANTUM >= 3 * QUANTUM + len - QUANTUM, "went quiet too soon");
    assert!(acts[first_silent..].iter().all(|a| *a == Activity::Silent));
    let want = direct(&x, &h, out.len());
    assert!(err_db(&out, &want) < -100.0);

    // After a gap in the frame clock (the graph stopped calling), a fresh
    // burst convolves exactly as from silence.
    frame += 100 * QUANTUM as u64;
    let y = noise(&mut rng, QUANTUM * 2);
    let mut out2 = Vec::new();
    for q in 0..(2 * QUANTUM + len) / QUANTUM + 2 {
        let mut o = [Bus::new(1)];
        render(&mut c, frame, &[bus_from(&[&y], q * QUANTUM)], &[], &pool, &mut ev, &mut o);
        out2.extend_from_slice(&o[0].data[0]);
        frame += QUANTUM as u64;
    }
    assert!(err_db(&out2, &direct(&y, &h, out2.len())) < -100.0);
}

#[test]
fn convolver_cut_off_mid_tail_wakes_clean() {
    // The graph stops calling while the tail still rings (its own idea of
    // the tail ran out first): the memory must not leak into the next burst.
    let mut rng = Rng::new(6);
    let h = noise(&mut rng, 3000);
    let mut pool = BufferPool::default();
    pool.insert(2, AudioData { sample_rate: SR, channels: vec![h.clone()] });
    let mut c = Convolver::new(&init(1));
    c.set_attr(6, 0.0);
    c.set_attr(5, 2.0);
    let mut ev = Events::default();
    let x = noise(&mut rng, QUANTUM * 4);
    for q in 0..6 {
        let mut o = [Bus::new(1)];
        render(&mut c, (q * QUANTUM) as u64, &[bus_from(&[&x], q * QUANTUM)], &[], &pool, &mut ev, &mut o);
    }
    let y = noise(&mut rng, QUANTUM * 2);
    let start = 1000 * QUANTUM as u64;
    let mut out = Vec::new();
    for q in 0..40 {
        let mut o = [Bus::new(1)];
        render(&mut c, start + (q * QUANTUM) as u64, &[bus_from(&[&y], q * QUANTUM)], &[], &pool, &mut ev, &mut o);
        out.extend_from_slice(&o[0].data[0]);
    }
    assert!(err_db(&out, &direct(&y, &h, out.len())) < -100.0);
}

#[test]
fn convolver_buffer_waits_for_pool_and_null_silences() {
    let mut c = Convolver::new(&init(1));
    c.set_attr(5, 9.0);
    let mut pool = BufferPool::default();
    let mut ev = Events::default();
    let x = vec![1.0f32; QUANTUM];
    let mut o = [Bus::new(2)];
    assert_eq!(render(&mut c, 0, &[bus_from(&[&x], 0)], &[], &pool, &mut ev, &mut o), Activity::Silent);
    pool.insert(9, AudioData { sample_rate: SR, channels: vec![vec![0.5]] });
    assert_eq!(render(&mut c, 128, &[bus_from(&[&x], 0)], &[], &pool, &mut ev, &mut o), Activity::Active);
    c.set_attr(5, -1.0);
    assert_eq!(render(&mut c, 256, &[bus_from(&[&x], 0)], &[], &pool, &mut ev, &mut o), Activity::Silent);
}

/// The cost of a 4.5 s stereo impulse at 48 kHz on a stereo input, per
/// quantum. Native release: `cargo test --release --test nodes_special --
/// --ignored --nocapture convolver_cost`.
#[test]
#[ignore]
fn convolver_cost() {
    let mut rng = Rng::new(3);
    let len = (4.5 * SR) as usize;
    let h: Vec<Vec<f32>> = (0..2).map(|_| noise(&mut rng, len)).collect();
    let mut pool = BufferPool::default();
    pool.insert(1, AudioData { sample_rate: SR, channels: h });
    let mut c = Convolver::new(&init(1));
    c.set_attr(5, 1.0);
    let mut ev = Events::default();
    let quanta = 20 * len / QUANTUM;
    let x: Vec<Vec<f32>> = (0..2).map(|_| noise(&mut rng, QUANTUM * 64)).collect();
    let mut o = [Bus::new(2)];
    let t0 = std::time::Instant::now();
    render(&mut c, 0, &[bus_from(&[&x[0], &x[1]], 0)], &[], &pool, &mut ev, &mut o);
    let build = t0.elapsed();
    let mut worst = std::time::Duration::ZERO;
    let mut times = Vec::with_capacity(quanta);
    let t1 = std::time::Instant::now();
    for q in 1..quanta {
        let at = (q % 64) * QUANTUM;
        let inb = [bus_from(&[&x[0], &x[1]], at)];
        let s = std::time::Instant::now();
        render(&mut c, (q * QUANTUM) as u64, &inb, &[], &pool, &mut ev, &mut o);
        let d = s.elapsed();
        times.push(d.as_secs_f64() * 1e6);
        worst = worst.max(d);
    }
    let total = t1.elapsed().as_secs_f64();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let q_us = QUANTUM as f64 / SR as f64 * 1e6;
    println!(
        "convolver 4.5 s stereo IR @48k, stereo in: build {:.2} ms; per quantum mean {:.1} µs, \
         median {:.1} µs, p99 {:.1} µs, worst {:.1} µs (a quantum is {:.0} µs; mean load {:.2}%); \
         plan {:?}; loop {:.2} s",
        build.as_secs_f64() * 1e3, mean, times[times.len() / 2], times[times.len() * 99 / 100],
        worst.as_secs_f64() * 1e6, q_us, mean / q_us * 100.0, plan_levels(len), total
    );
}

// ======================================================================
// FDN
// ======================================================================

/// The FDN's impulse response, `secs` long, with the given params.
fn fdn_impulse(decay: f32, damping: f32, modv: f32, secs: f64) -> (Vec<f32>, Vec<f32>, Vec<Activity>) {
    let mut f = Fdn::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let n = (secs * SR as f64) as usize / QUANTUM;
    let (mut l, mut r, mut acts) = (Vec::new(), Vec::new(), Vec::new());
    for q in 0..n {
        let mut inb = Bus::new(1);
        if q == 0 { inb.data[0][0] = 1.0; inb.silent = false; }
        let mut o = [Bus::new(2)];
        acts.push(render(&mut f, (q * QUANTUM) as u64, &[inb], &[decay, damping, modv], &pool, &mut ev, &mut o));
        l.extend_from_slice(&o[0].data[0]);
        r.extend_from_slice(&o[0].data[1]);
    }
    (l, r, acts)
}

/// Schroeder's backward-integrated energy decay, in dB.
fn edc_db(x: &[f32]) -> Vec<f64> {
    let mut acc = 0.0f64;
    let mut e: Vec<f64> = x.iter().rev().map(|v| { acc += *v as f64 * *v as f64; acc }).collect();
    e.reverse();
    let e0 = e[0];
    e.iter().map(|v| 10.0 * (v / e0).log10()).collect()
}

#[test]
fn fdn_decays_sixty_db_in_decay_seconds() {
    for &t in &[1.0f32, 2.5] {
        let (l, r, _) = fdn_impulse(t, 0.0, 0.0, t as f64 * 2.5);
        for ch in [&l, &r] {
            let e = edc_db(ch);
            let at = |db: f64| e.iter().position(|v| *v <= db).unwrap() as f64 / SR as f64;
            // The slope between −5 and −35 dB, extrapolated to 60.
            let t60 = (at(-35.0) - at(-5.0)) * 2.0;
            assert!((t60 / t as f64 - 1.0).abs() < 0.05, "decay {t}: T60 {t60:.3} s");
        }
    }
}

#[test]
fn fdn_tail_energy_matches_convolver_calibration() {
    // A convolver normalises its impulse to an RMS of 10^(−58/20)·44100/sr,
    // so a T-second impulse's energy per channel is that squared times T·sr.
    let t = 2.0;
    let (l, r, _) = fdn_impulse(t, 0.0, 0.0, t as f64 * 3.0);
    let rms = 10f64.powf(-58.0 / 20.0) * 44100.0 / SR as f64;
    let want = rms * rms * t as f64 * SR as f64;
    for ch in [&l, &r] {
        let e: f64 = ch.iter().map(|v| *v as f64 * *v as f64).sum();
        let db = 10.0 * (e / want).log10();
        assert!(db.abs() < 1.0, "tail energy off by {db:.2} dB");
    }
}

#[test]
fn fdn_sleeps_after_decay_and_a_second() {
    let t = 0.5f32;
    let (_, _, acts) = fdn_impulse(t, 0.35, 0.3, 2.0);
    let first_silent = acts.iter().position(|a| *a == Activity::Silent).unwrap();
    let frames = first_silent * QUANTUM;
    let want = ((t as f64 + 1.0) * SR as f64) as usize;
    assert!(frames > want && frames <= want + 2 * QUANTUM, "slept at {frames}, want ~{want}");
    assert!(acts[first_silent..].iter().all(|a| *a == Activity::Silent));
}

#[test]
fn fdn_wakes_on_a_connection_and_its_drift_runs_in_silence() {
    // Chrome hands the worklet a channel of zeros while a connected source
    // is quiet (not yet started), so it wakes then, and its lines' drift
    // runs through the silence: an impulse 19 quanta after the connection
    // meets the network further on in its drift than one heard at once.
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let params = [4.5, 0.35, 0.3];
    let impulse = |f: &mut Fdn, ev: &mut Events, at: u64| {
        let mut inb = Bus::new(1);
        inb.data[0][0] = 1.0;
        inb.silent = false;
        let mut tail = Vec::new();
        for q in 0..400u64 {
            let input = if q == 0 { inb.clone() } else { Bus::new(1) };
            let mut o = [Bus::new(2)];
            render_connected(f, at + q * QUANTUM as u64, &[input], &[true], &params, &pool, ev, &mut o);
            tail.extend_from_slice(&o[0].data[0]);
        }
        tail
    };
    let mut early = Fdn::new(&init(1));
    for q in 0..19u64 {
        let mut o = [Bus::new(2)];
        let a = render_connected(&mut early, q * QUANTUM as u64, &[Bus::new(1)], &[true], &params, &pool, &mut ev, &mut o);
        assert_eq!(a, Activity::Active, "awake while connected, silent or not");
        assert!(o[0].data.iter().all(|c| c.iter().all(|&x| x == 0.0)));
    }
    let late = impulse(&mut early, &mut ev, 19 * QUANTUM as u64);
    let now = impulse(&mut Fdn::new(&init(1)), &mut ev, 0);
    let first = late.iter().zip(&now).position(|(a, b)| a != b);
    assert!(first.is_some(), "the drift ran on through the silence");
    // The modulation moves the read slowly, so the two agree until the
    // network's first returns are read through drifted lengths.
    assert!(first.unwrap() > 1000, "differs from frame {}", first.unwrap());
}

#[test]
fn fdn_never_wakes_without_input() {
    let mut f = Fdn::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut o = [Bus::new(2)];
    assert_eq!(render(&mut f, 0, &[Bus::new(1)], &[4.5, 0.35, 0.3], &pool, &mut ev, &mut o), Activity::Silent);
    assert!(o[0].silent);
}

// ======================================================================
// One-pole
// ======================================================================

#[test]
fn one_pole_constant_cutoff_is_the_exact_filter() {
    let mut p = OnePole::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut rng = Rng::new(1);
    let x = noise(&mut rng, QUANTUM * 4);
    let f = 1000.0f64;
    let g = (std::f64::consts::PI / SR as f64 * f).tan();
    let gg = g / (1.0 + g);
    let mut s = 0.0f64;
    for q in 0..4 {
        let mut o = [Bus::new(2)];
        render(&mut p, (q * QUANTUM) as u64, &[bus_from(&[&x], q * QUANTUM)], &[f as f32], &pool, &mut ev, &mut o);
        for i in 0..QUANTUM {
            let v = (x[q * QUANTUM + i] as f64 - s) * gg;
            let y = v + s;
            s = y + v;
            // a mono input feeds both channels
            assert_eq!(o[0].data[0][i], y as f32);
            assert_eq!(o[0].data[1][i], y as f32);
        }
    }
}

#[test]
fn one_pole_is_a_wire_at_the_top() {
    let mut p = OnePole::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut rng = Rng::new(2);
    let (xl, xr) = (noise(&mut rng, QUANTUM), noise(&mut rng, QUANTUM));
    let mut o = [Bus::new(2)];
    render(&mut p, 0, &[bus_from(&[&xl, &xr], 0)], &[0.49 * SR], &pool, &mut ev, &mut o);
    assert_eq!(&o[0].data[0][..], &xl[..]);
    assert_eq!(&o[0].data[1][..], &xr[..]);
}

#[test]
fn one_pole_sweeping_cutoff_tracks_per_sample_gains() {
    // A-rate cutoff sweeping: exact gains every eight samples, lines between.
    let mut p = OnePole::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut rng = Rng::new(3);
    let x = noise(&mut rng, QUANTUM);
    let mut fq = [0.0f32; QUANTUM];
    for (i, f) in fq.iter_mut().enumerate() { *f = 200.0 + 30.0 * i as f32; }
    let blocks = [ParamBlock::Varying(&fq)];
    let inb = [bus_from(&[&x], 0)];
    let mut o = [Bus::new(2)];
    let mut ctx = RenderCtx {
        node: 1, frame: 0, sample_rate: SR, inputs: &inb, connected: &[true], params: &blocks, buffers: &pool, events: &mut ev,
    };
    p.render(&mut ctx, &mut o);
    let gain = |f: f64| { let g = (std::f64::consts::PI / SR as f64 * f.max(1.0)).tan(); g / (1.0 + g) };
    let mut s = 0.0f64;
    for i in 0..QUANTUM {
        // the interpolation the worklet draws
        let i0 = (i / 8) * 8;
        let i1 = (i0 + 8).min(QUANTUM - 1);
        let g = if i == QUANTUM - 1 { gain(fq[i] as f64) } else {
            let (g0, g1) = (gain(fq[i0] as f64), gain(fq[i1] as f64));
            g0 + (g1 - g0) / (i1 - i0) as f64 * (i - i0) as f64
        };
        let v = (x[i] as f64 - s) * g;
        let y = v + s;
        s = y + v;
        assert!((o[0].data[0][i] as f64 - y).abs() < 1e-6, "sample {i}");
    }
}

#[test]
fn one_pole_holds_its_state_through_silence() {
    let mut p = OnePole::new(&init(1));
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut o = [Bus::new(2)];
    assert_eq!(render(&mut p, 0, &[Bus::new(1)], &[1000.0], &pool, &mut ev, &mut o), Activity::Silent);
    assert!(o[0].silent);
}

// ======================================================================
// Strobe signal
// ======================================================================

fn strobe_msg(at: f64, p: f64, r0: f64, r1: f64, dur: f64, wave: f64, duty: f64, on: f64) -> Vec<u8> {
    let mut b = 1u32.to_le_bytes().to_vec();
    for v in [at, p, r0, r1, dur, wave, duty, on] { b.extend_from_slice(&v.to_le_bytes()); }
    b
}

fn strobe_run(s: &mut StrobeSignal, from: u64, quanta: usize) -> Vec<f32> {
    let pool = BufferPool::default();
    let mut ev = Events::default();
    let mut out = Vec::new();
    for q in 0..quanta {
        let mut o = [Bus::new(1)];
        render(s, from + (q * QUANTUM) as u64, &[], &[], &pool, &mut ev, &mut o);
        out.extend_from_slice(&o[0].data[0]);
    }
    out
}

#[test]
fn strobe_signal_starts_held_lit() {
    let mut s = StrobeSignal::new(&init(1));
    assert!(strobe_run(&mut s, 0, 4).iter().all(|v| *v == 1.0));
}

#[test]
fn strobe_signal_runs_the_formula() {
    let mut s = StrobeSignal::new(&init(1));
    let mut ev = Events::default();
    // A 10 Hz square, half lit, flicker showing, anchored at frame 0.
    s.message(&strobe_msg(0.0, 0.0, 10.0, 10.0, 0.0, 2.0, 0.5, 1.0), 1, &mut ev);
    let out = strobe_run(&mut s, 0, 3 * 375); // 3 × 1 s / 128 … 1 s
    // Once the 50 ms hold has eased off, the lit half reads +1, the dark −1.
    let at = |t: f64| out[(t * SR as f64) as usize];
    assert!((at(0.725) - 1.0).abs() < 1e-3, "lit {}", at(0.725));
    assert!((at(0.775) + 1.0).abs() < 1e-3, "dark {}", at(0.775));
}

#[test]
fn strobe_signal_law() {
    use heart::nodes::strobe_signal as sig;
    let _ = sig::StrobeSignal::new(&init(1));
    // The shapes, and the ramp integrating to the quadratic then holding.
    let probe = |wave: f64, duty: f64, p: f64| {
        let mut s = StrobeSignal::new(&init(1));
        let mut ev = Events::default();
        // phase p held still: rate 0, flicker on, read after the smoothers settle
        s.message(&strobe_msg(0.0, p, 0.0, 0.0, 0.0, wave, duty, 1.0), 1, &mut ev);
        let o = strobe_run(&mut s, 0, 400);
        (*o.last().unwrap() as f64 + 1.0) / 2.0
    };
    assert!((probe(2.0, 0.3, 0.29) - 1.0).abs() < 1e-5);
    assert!(probe(2.0, 0.3, 0.31).abs() < 1e-5);
    assert!((probe(1.0, 0.5, 0.25) - 0.5).abs() < 1e-5);
    assert!((probe(1.0, 0.5, 0.75) - 0.5).abs() < 1e-5);
    assert!((probe(0.0, 0.5, 0.5) - 1.0).abs() < 1e-5);
    assert!((probe(0.0, 0.5, 0.25) - 0.5).abs() < 1e-5);
}

#[test]
fn strobe_signal_replicas_agree_on_future_anchors() {
    // Two replicas, one told of each change a quantum earlier than the
    // other (as stages rendering at different depths would be): every
    // anchor lies ahead of both, so their outputs are identical.
    let msgs = [
        strobe_msg(1000.5, 0.6, 7.5, 7.5, 0.0, 2.0, 0.5, 1.0),
        strobe_msg(9000.0, 0.3, 7.5, 12.0, 0.4, 0.0, 0.5, 1.0),
        strobe_msg(30000.0, 0.1, 12.0, 12.0, 0.0, 1.0, 0.5, 0.0),
    ];
    let mut a = StrobeSignal::new(&init(1));
    let mut b = StrobeSignal::new(&init(2));
    let mut ev = Events::default();
    let pool = BufferPool::default();
    let (mut oa, mut ob) = (Vec::new(), Vec::new());
    let send_at = [0u64, 6000, 25000];
    for q in 0..400u64 {
        let f = q * QUANTUM as u64;
        for (k, m) in msgs.iter().enumerate() {
            if send_at[k] >= f && send_at[k] < f + 128 { a.message(m, 1, &mut ev); }
            if send_at[k] + 500 >= f && send_at[k] + 500 < f + 128 { b.message(m, 1, &mut ev); }
        }
        let mut o = [Bus::new(1)];
        render(&mut a, f, &[], &[], &pool, &mut ev, &mut o);
        oa.extend_from_slice(&o[0].data[0]);
        render(&mut b, f, &[], &[], &pool, &mut ev, &mut o);
        ob.extend_from_slice(&o[0].data[0]);
    }
    assert_eq!(oa, ob);
    // And the first change (into the dark half) lands on its own frame, not
    // its quantum's start.
    assert_eq!(oa[1000], 1.0);
    assert!(oa[1001] < 1.0);
}

// ======================================================================
// Genus
// ======================================================================

#[test]
fn genus_flash_align() {
    assert_eq!(flash_align(2, 0.5), Align { pip: 0.0, peak: 0.25 });
    assert_eq!(flash_align(2, 0.3), Align { pip: 0.0, peak: 0.15 });
    assert_eq!(flash_align(0, 0.3), Align { pip: 0.5, peak: 0.5 });
    assert_eq!(flash_align(1, 0.3), Align { pip: 0.5, peak: 0.5 });
}

#[test]
fn genus_bilateral_law() {
    // No depth: both ears full.
    assert_eq!(bilateral(0.0, 1.0, 0.2), (1.0, 1.0));
    // The hard switch: left for the first half, right for the second.
    let (l, r) = bilateral(1.0, 1.0, 0.2);
    assert!((l - 1.0).abs() < 1e-12 && r.abs() < 1e-12);
    let (l, r) = bilateral(1.0, 1.0, 0.7);
    assert!(l.abs() < 1e-12 && (r - 1.0).abs() < 1e-12);
    // Any blend, any depth: equal power, l² + r² = 1.
    for &(d, h, p) in &[(0.5, 0.0, 0.1), (1.0, 0.0, 0.25), (0.7, 0.4, 0.6), (0.3, 1.0, 0.9)] {
        let (l, r) = bilateral(d, h, p);
        assert!((l * l + r * r - 1.0).abs() < 1e-12);
    }
    // The sine sweep at its quarter: fully right.
    let (l, r) = bilateral(1.0, 0.0, 0.25);
    assert!(l.abs() < 1e-7 && (r - 1.0).abs() < 1e-12);
    // Half and half blend at ph 0.25: raw = 0.5·(−1) + 0.5·1 = 0, centred.
    let (l, r) = bilateral(1.0, 0.5, 0.25);
    assert!((l - r).abs() < 1e-12);
}

#[test]
fn genus_pip_shape() {
    let sr = SR as f64;
    let pip_sec = 0.005;
    let samples = pip_sec * sr;
    let decay = 3.5 / pip_sec;
    // Starts on the carrier's sine at full height, decays by e^−3.5 over its
    // length, and is nothing after.
    assert_eq!(pip(0.0, 0.25, samples, decay, sr), 1.0);
    let end = pip(samples - 1.0, 0.25, samples, decay, sr);
    assert!((end - (-3.5f64 * (samples - 1.0) / samples).exp()).abs() < 1e-12);
    assert_eq!(pip(samples, 0.25, samples, decay, sr), 0.0);
    assert!((pip(10.0, 0.1, samples, decay, sr) - (std::f64::consts::TAU * 0.1).sin() * (-(10.0 / sr) * decay).exp()).abs() < 1e-15);
}

#[test]
fn genus_harmonic_amplitudes() {
    let mut g = Genus::new(&init(1));
    // Six whole partials at (k+2)^−bright, normalised to unity.
    let top = g.harm_amps(6.0, 1.2);
    assert_eq!(top, 6);
    let raw: Vec<f64> = (0..6).map(|k| (k as f64 + 2.0).powf(-1.2)).collect();
    let sum: f64 = raw.iter().sum();
    let a = *g.amps();
    for k in 0..6 { assert!((a[k] as f64 - raw[k] / sum).abs() < 1e-7); }
    assert!(a[6..].iter().all(|v| *v == 0.0));
    // 6.4: a seventh at 0.4 weight, the stack still at unity.
    let top = g.harm_amps(6.4, 1.2);
    assert_eq!(top, 7);
    let a = *g.amps();
    let mut raw: Vec<f64> = (0..7).map(|k| (k as f64 + 2.0).powf(-1.2)).collect();
    raw[6] *= 6.4 - 6.0;
    let sum: f64 = raw.iter().sum();
    for k in 0..7 { assert!((a[k] as f64 - raw[k] / sum).abs() < 1e-6, "partial {k}"); }
    let total: f64 = a.iter().map(|v| *v as f64).sum();
    assert!((total - 1.0).abs() < 1e-6);
    // Clamped to 1..16.
    assert_eq!(g.harm_amps(0.2, 1.0), 1);
    assert_eq!(g.harm_amps(40.0, 1.0), 16);
}

fn genus_msg(ty: u32, fields: &[f64]) -> Vec<u8> {
    let mut b = ty.to_le_bytes().to_vec();
    for v in fields { b.extend_from_slice(&v.to_le_bytes()); }
    b
}

fn genus_run(g: &mut Genus, params: &[f32], from: u64, quanta: usize, ev: &mut Events) -> [Vec<f32>; 5] {
    let pool = BufferPool::default();
    let mut out: [Vec<f32>; 5] = Default::default();
    for q in 0..quanta {
        let mut o = [Bus::new(2), Bus::new(2), Bus::new(1)];
        render(g, from + (q * QUANTUM) as u64, &[], params, &pool, ev, &mut o);
        out[0].extend_from_slice(&o[0].data[0]);
        out[1].extend_from_slice(&o[0].data[1]);
        out[2].extend_from_slice(&o[1].data[0]);
        out[3].extend_from_slice(&o[1].data[1]);
        out[4].extend_from_slice(&o[2].data[0]);
    }
    out
}

#[test]
fn genus_idle_is_silent_and_meters_report_on_their_clock() {
    let mut g = Genus::new(&init(1));
    let p = defaults(&g);
    let mut ev = Events::default();
    let pool = BufferPool::default();
    let mut o = [Bus::new(2), Bus::new(2), Bus::new(1)];
    assert_eq!(render(&mut g, 0, &[], &p, &pool, &mut ev, &mut o), Activity::Silent);
    assert!(o.iter().all(|b| b.silent));
    // 48000 / 50 = 960 frames: the eighth quantum reports.
    for q in 1..8 { render(&mut g, q * 128, &[], &p, &pool, &mut ev, &mut o); }
    // port event: u16 103, u16 len 28, u32 node, u32 16, then 101 and three f32
    assert_eq!(ev.pending().len(), 28);
    assert_eq!(u16::from_le_bytes([ev.pending()[0], ev.pending()[1]]), 103);
    assert_eq!(u32::from_le_bytes(ev.pending()[12..16].try_into().unwrap()), 101);
    // Meters off: nothing.
    ev.hand_over();
    g.message(&genus_msg(2, &[0.0]), 7, &mut ev);
    for q in 8..24 { render(&mut g, q * 128, &[], &p, &pool, &mut ev, &mut o); }
    assert!(ev.pending().is_empty());
}

#[test]
fn genus_tone_is_the_carrier() {
    let mut g = Genus::new(&init(1));
    let mut p = defaults(&g);
    p[4] = 1.0; // toneLevel
    p[1] = 0.0; // amDepth: a steady tone
    let mut ev = Events::default();
    let out = genus_run(&mut g, &p, 0, 4, &mut ev);
    for i in 0..512 {
        let want = (std::f64::consts::TAU * (200.0 / SR as f64 * i as f64)).sin();
        assert!((out[0][i] as f64 - want).abs() < 1e-6 && out[0][i] == out[1][i], "sample {i}");
    }
    // Full depth: 0.75 + 0.25 cos of the pulse phase, peaking with the pip.
    let mut g = Genus::new(&init(1));
    p[1] = 1.0;
    p[0] = 40.0;
    let out = genus_run(&mut g, &p, 0, 8, &mut ev);
    let mut phase = 0.0f64;
    let mut cph = 0.0f64;
    for i in 0..1024 {
        let env = 1.0 - 0.25 * (1.0 - (std::f64::consts::TAU * phase).cos());
        let want = env * (std::f64::consts::TAU * cph).sin();
        assert!((out[0][i] as f64 - want).abs() < 1e-6, "sample {i}");
        phase += 40.0 / SR as f64;
        if phase >= 1.0 { phase -= 1.0; }
        cph += 200.0 / SR as f64;
        if cph >= 1.0 { cph -= 1.0; }
    }
}

#[test]
fn genus_click_pips_fire_once_a_cycle_and_ride_the_bilateral() {
    let mut g = Genus::new(&init(1));
    let mut p = defaults(&g);
    p[5] = 1.0; // clickLevel
    p[11] = 1.0; // biDepth
    p[12] = 1.0; // biRate 1 Hz, hard switch
    let mut ev = Events::default();
    let out = genus_run(&mut g, &p, 0, 375, &mut ev); // 1 s
    // 40 Hz: a pip at every 1200th sample, its first sample the carrier's
    // sine at the start of the cycle (0 at cycle 0).
    let sr = SR as f64;
    let pip_samples = 0.005 * sr;
    let decay = 3.5 / 0.005;
    for i in 0..1200 {
        let want = pip(i as f64, 200.0 / sr * i as f64 % 1.0, pip_samples, decay, sr);
        // first half second: left only
        assert!((out[0][i] as f64 - want).abs() < 1e-5, "sample {i}");
        assert!(out[1][i].abs() < 1e-6);
    }
    // second half: right only
    let j = 24000 + 10;
    assert!(out[0][j].abs() < 1e-6 && out[1][j].abs() > 1e-3);
    // the send is silent at clickSend 0
    assert!(out[4].iter().all(|v| *v == 0.0));
}

#[test]
fn genus_chirp_table_is_acked_and_crossfaded() {
    let mut g = Genus::new(&init(1));
    let mut p = defaults(&g);
    p[7] = 1.0; // chirpLevel
    let mut ev = Events::default();
    let table: Vec<f32> = (0..200).map(|i| (i as f32 * 0.01).min(1.0)).collect();
    let mut m = genus_msg(4, &[17.0, 0.0]);
    m.extend_from_slice(&(table.len() as u32).to_le_bytes());
    for v in &table { m.extend_from_slice(&v.to_le_bytes()); }
    g.message(&m, 7, &mut ev);
    // chirpAck: port event carrying u32 103 and the f64 signature
    assert_eq!(ev.pending().len(), 8 + 4 + 12);
    assert_eq!(u32::from_le_bytes(ev.pending()[12..16].try_into().unwrap()), 103);
    assert_eq!(f64::from_le_bytes(ev.pending()[16..24].try_into().unwrap()), 17.0);
    ev.hand_over();
    // xf 0 means 30 ms: 1440 frames from the click fallback to the table.
    let out = genus_run(&mut g, &p, 0, 30, &mut ev);
    let sr = SR as f64;
    let pc0 = pip(100.0, 200.0 / sr * 100.0 % 1.0, 0.005 * sr, 700.0, sr);
    let want = table[100] as f64 + (pc0 - table[100] as f64) * ((1440.0 - 100.0) / 1440.0);
    assert!((out[0][100] as f64 - want).abs() < 1e-5);
    // after the fade, the cycle starting at 1200·2 = 2400 plays the table alone
    assert!((out[0][2400 + 50] as f64 - table[50] as f64).abs() < 1e-6);
}

#[test]
fn genus_dip_reports_when_watched() {
    let mut g = Genus::new(&init(1));
    let mut p = defaults(&g);
    p[5] = 1.0;
    p[9] = 0.5; // clickModDepth
    let mut ev = Events::default();
    g.message(&genus_msg(3, &[1.0]), 7, &mut ev);
    g.message(&genus_msg(2, &[0.0]), 7, &mut ev);
    genus_run(&mut g, &p, 0, 8, &mut ev);
    assert_eq!(ev.pending().len(), 8 + 4 + 8);
    assert_eq!(u32::from_le_bytes(ev.pending()[12..16].try_into().unwrap()), 102);
    let dip = f32::from_le_bytes(ev.pending()[16..20].try_into().unwrap()) as f64;
    // 1024 frames at 0.1 Hz
    let ph = 0.1 / SR as f64 * 1024.0;
    let want = 1.0 - 0.5 * 0.5 * (1.0 - (std::f64::consts::TAU * ph).cos());
    assert!((dip - want).abs() < 1e-6);
}

#[test]
fn genus_linked_pips_land_on_the_flash() {
    // Linked to a 10 Hz square anchored at frame 0 with phase 0.3 there:
    // once locked, each pip fires at the flash's onset (flash_align's pip,
    // phase 0), 0.7 of a cycle past the anchor and every 4800 frames after,
    // whatever the free rate says.
    let mut g = Genus::new(&init(1));
    let mut p = defaults(&g);
    p[5] = 1.0;
    p[0] = 13.0; // a free rate far from the flash's
    let mut ev = Events::default();
    g.message(&genus_msg(1, &[0.0, 0.3, 10.0, 10.0, 0.0, 2.0, 0.5, 1.0]), 7, &mut ev);
    let out = genus_run(&mut g, &p, 0, 3 * 375, &mut ev);
    // a pip starts where the silence between pips (exact zeros) ends
    let onsets: Vec<usize> = (96000..143999)
        .filter(|&i| out[0][i - 8..i].iter().all(|v| *v == 0.0) && out[0][i + 1].abs() > 1e-3)
        .collect();
    assert!(!onsets.is_empty());
    for &i in &onsets {
        let off = (i as i64 - 3360) % 4800;
        let near = off.min(4800 - off);
        assert!(near <= 2, "pip at {i}, {near} frames off the flash");
    }
}

#[test]
fn genus_seeded_alike_renders_alike() {
    let mut p = vec![0.0f32; 27];
    for (i, s) in Genus::new(&init(1)).param_specs().iter().enumerate() { p[i] = s.default; }
    p[14] = 0.8; // harmLevel
    p[19] = 0.5; // shimDepth
    let mut ev = Events::default();
    let a = genus_run(&mut Genus::new(&init(99)), &p, 0, 20, &mut ev);
    let b = genus_run(&mut Genus::new(&init(99)), &p, 0, 20, &mut ev);
    let c = genus_run(&mut Genus::new(&init(100)), &p, 0, 20, &mut ev);
    assert_eq!(a, b);
    assert_ne!(a[2], c[2]);
    assert!(a[2].iter().any(|v| v.abs() > 1e-3));
}
