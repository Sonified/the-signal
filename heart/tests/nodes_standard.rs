//! Tests for the standard Web Audio nodes (gain, constant source, stereo
//! panner, delay, biquad, oscillator, buffer source, analyser), driven
//! straight through the Node trait with a RenderCtx built by hand, and
//! checked against values worked out here from the spec's own formulas.

use std::f64::consts::PI;

use heart::buffers::{AudioData, BufferPool};
use heart::events::Events;
use heart::node::{Activity, Bus, Node, NodeInit, ParamBlock, QUANTUM, RenderCtx};
use heart::nodes::analyser::Analyser;
use heart::nodes::biquad::{Biquad, Coefficients, FilterType};
use heart::nodes::buffer_source::BufferSource;
use heart::nodes::constant_source::ConstantSource;
use heart::nodes::delay::Delay;
use heart::nodes::gain::Gain;
use heart::nodes::oscillator::Oscillator;
use heart::nodes::periodic_wave::{PeriodicWave, Shape};
use heart::nodes::stereo_panner::StereoPanner;
use realfft::RealFftPlanner;

const SR: f32 = 48000.0;

fn init(opt: f64) -> NodeInit {
    let mut opts = [0.0; 8];
    opts[0] = opt;
    NodeInit { sample_rate: SR, seed: 1, opts }
}

/// A param for `drive`: held, or a function of the engine frame (which
/// makes it a Varying block, as automation would).
enum P {
    C(f32),
    F(Box<dyn Fn(u64) -> f32>),
}

/// A bus holding frames [at, at + 128) of planar `signal`, flagged silent
/// when they are all zero.
fn bus_at(signal: &[Vec<f32>], at: usize) -> Bus {
    let mut b = Bus::new(signal.len());
    for (c, ch) in signal.iter().enumerate() {
        for i in 0..QUANTUM { b.data[c][i] = ch.get(at + i).copied().unwrap_or(0.0); }
    }
    b.silent = b.data[..b.channels].iter().all(|c| c.iter().all(|&x| x == 0.0));
    b
}

/// Renders `quanta` quanta through `node` from frame 0, returning each
/// output channel end to end and each quantum's Activity.
fn drive(node: &mut dyn Node, input: Option<&[Vec<f32>]>, params: &[P], quanta: usize, pool: &BufferPool)
    -> (Vec<Vec<f32>>, Vec<Activity>)
{
    let mut events = Events::default();
    let mut outs: Vec<Vec<f32>> = Vec::new();
    let mut activity = Vec::new();
    for q in 0..quanta {
        let frame = (q * QUANTUM) as u64;
        let inputs: Vec<Bus> = input.map(|s| vec![bus_at(s, q * QUANTUM)]).unwrap_or_default();
        let blocks: Vec<[f32; QUANTUM]> = params.iter().map(|p| match p {
            P::C(v) => [*v; QUANTUM],
            P::F(f) => std::array::from_fn(|i| f(frame + i as u64)),
        }).collect();
        let pblocks: Vec<ParamBlock> = params.iter().zip(&blocks).map(|(p, b)| match p {
            P::C(v) => ParamBlock::Const(*v),
            P::F(_) => ParamBlock::Varying(b),
        }).collect();
        let in_channels: Vec<usize> = inputs.iter().map(|b| b.channels).collect();
        let connected = vec![true; inputs.len()];
        let mut out = [Bus::new(node.output_channels(0, &in_channels))];
        let mut ctx = RenderCtx {
            node: 1, frame, sample_rate: SR, inputs: &inputs, connected: &connected, params: &pblocks, buffers: pool,
            events: &mut events,
        };
        activity.push(node.render(&mut ctx, &mut out));
        let out = &out[0];
        if outs.len() < out.channels { outs.resize(out.channels, vec![0.0; q * QUANTUM]); }
        for (c, o) in outs.iter_mut().enumerate() {
            o.extend_from_slice(&out.data[c.min(out.channels - 1)]);
        }
    }
    (outs, activity)
}

fn assert_close(got: &[f32], want: &[f64], tolerance: f64, what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((*g as f64 - w).abs() <= tolerance, "{what}: frame {i}: got {g}, want {w}");
    }
}

/// One channel, as the planar signal `drive` takes.
fn mono(x: &Vec<f32>) -> &[Vec<f32>] { std::slice::from_ref(x) }

fn ramp(frames: usize, f: impl Fn(usize) -> f32) -> Vec<f32> { (0..frames).map(f).collect() }

// ---------------------------------------------------------------- gain

#[test]
fn gain_scales_each_sample_exactly() {
    let pool = BufferPool::default();
    let x = ramp(256, |i| (i as f32 * 0.37).sin());
    let mut g = Gain::new(&init(0.0));
    let (out, act) = drive(&mut g, Some(mono(&x)), &[P::C(0.25)], 2, &pool);
    assert_eq!(act, [Activity::Active; 2]);
    for i in 0..256 { assert_eq!(out[0][i], x[i] * 0.25); }

    let (out, _) = drive(&mut g, Some(mono(&x)), &[P::F(Box::new(|f| f as f32 / 100.0))], 2, &pool);
    for i in 0..256 { assert_eq!(out[0][i], x[i] * (i as f32 / 100.0)); }
}

#[test]
fn gain_silence_rules() {
    let pool = BufferPool::default();
    let mut g = Gain::new(&init(0.0));
    let x = ramp(128, |i| i as f32);
    let (out, act) = drive(&mut g, Some(&[x.clone(), x.clone()]), &[P::C(0.0)], 1, &pool);
    assert_eq!(act[0], Activity::Silent, "a constant gain of zero is silent");
    assert!(out[0].iter().all(|&v| v == 0.0));
    let (_, act) = drive(&mut g, Some(&[vec![0.0; 128]]), &[P::C(2.0)], 1, &pool);
    assert_eq!(act[0], Activity::Silent, "a silent input is silent");
}

// ---------------------------------------------------------------- constant source

#[test]
fn constant_source_starts_and_stops_on_the_rounded_up_frames() {
    let pool = BufferPool::default();
    let mut c = ConstantSource::new(&init(0.0));
    c.start(10.5, 0.0, -1.0);
    c.stop(200.2);
    let (out, act) = drive(&mut c, None, &[P::C(0.75)], 3, &pool);
    for (i, v) in out[0].iter().enumerate() {
        let want = if (11..201).contains(&i) { 0.75 } else { 0.0 };
        assert_eq!(*v, want, "frame {i}");
    }
    assert_eq!(act, [Activity::Active, Activity::Active, Activity::Finished]);

    let mut c = ConstantSource::new(&init(0.0));
    c.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut c, None, &[P::F(Box::new(|f| f as f32))], 1, &pool);
    for (i, v) in out[0].iter().enumerate() { assert_eq!(*v, i as f32); }
}

// ---------------------------------------------------------------- stereo panner

#[test]
fn stereo_panner_equal_power_law() {
    let pool = BufferPool::default();
    let x = ramp(128, |i| (i as f32 * 0.1).sin());
    let r = ramp(128, |i| (i as f32 * 0.23).cos());

    // Mono: x = (pan + 1)/2, L = in·cos(xπ/2), R = in·sin(xπ/2).
    let pan = 0.5f32;
    let mut p = StereoPanner::new(&init(0.0));
    let (out, _) = drive(&mut p, Some(mono(&x)), &[P::C(pan)], 1, &pool);
    let a = (pan as f64 + 1.0) / 2.0 * PI / 2.0;
    let want_l: Vec<f64> = x.iter().map(|&v| ((v as f64) * a.cos()) as f32 as f64).collect();
    let want_r: Vec<f64> = x.iter().map(|&v| ((v as f64) * a.sin()) as f32 as f64).collect();
    assert_close(&out[0], &want_l, 0.0, "mono L");
    assert_close(&out[1], &want_r, 0.0, "mono R");

    // Stereo, pan ≤ 0: x = pan + 1, L = inL + inR·cos(xπ/2), R = inR·sin(xπ/2).
    let (out, _) = drive(&mut p, Some(&[x.clone(), r.clone()]), &[P::C(-0.5)], 1, &pool);
    let a = 0.5 * PI / 2.0;
    let want_l: Vec<f64> = (0..128).map(|i| (x[i] as f64 + r[i] as f64 * a.cos()) as f32 as f64).collect();
    let want_r: Vec<f64> = (0..128).map(|i| (r[i] as f64 * a.sin()) as f32 as f64).collect();
    assert_close(&out[0], &want_l, 0.0, "stereo left L");
    assert_close(&out[1], &want_r, 0.0, "stereo left R");

    // Stereo, pan > 0: x = pan, L = inL·cos(xπ/2), R = inR + inL·sin(xπ/2).
    let (out, _) = drive(&mut p, Some(&[x.clone(), r.clone()]), &[P::C(0.25)], 1, &pool);
    let a = 0.25 * PI / 2.0;
    let want_l: Vec<f64> = (0..128).map(|i| (x[i] as f64 * a.cos()) as f32 as f64).collect();
    let want_r: Vec<f64> = (0..128).map(|i| (r[i] as f64 + x[i] as f64 * a.sin()) as f32 as f64).collect();
    assert_close(&out[0], &want_l, 0.0, "stereo right L");
    assert_close(&out[1], &want_r, 0.0, "stereo right R");

    // At the centre a stereo input passes through, but for cos(π/2)'s
    // rounding in f64.
    let (out, _) = drive(&mut p, Some(&[x.clone(), r.clone()]), &[P::C(0.0)], 1, &pool);
    assert_close(&out[0], &x.iter().map(|&v| v as f64).collect::<Vec<_>>(), 1e-15, "centre L");
    assert_close(&out[1], &r.iter().map(|&v| v as f64).collect::<Vec<_>>(), 0.0, "centre R");
}

// ---------------------------------------------------------------- delay

fn impulse(at: usize, frames: usize) -> Vec<f32> {
    let mut v = vec![0.0; frames];
    v[at] = 1.0;
    v
}

#[test]
fn delay_integer_and_fractional() {
    let pool = BufferPool::default();
    let x = impulse(3, 512);

    // 10 frames, and 50 (under a quantum, which works outside a cycle).
    for frames in [10.0, 50.0] {
        let mut d = Delay::new(&init(1.0));
        let (out, _) = drive(&mut d, Some(mono(&x)), &[P::C(frames / SR)], 4, &pool);
        let at = 3 + frames as usize;
        for (i, v) in out[0].iter().enumerate() {
            let want = if i == at { 1.0 } else { 0.0 };
            assert!((*v - want).abs() < 1e-4, "{frames} frames, frame {i}: {v}");
        }
    }

    // 10.25 frames: the impulse lands three quarters on the frame after 10
    // and a quarter on the next.
    let mut d = Delay::new(&init(1.0));
    let (out, _) = drive(&mut d, Some(mono(&x)), &[P::C(10.25 / SR)], 4, &pool);
    assert!((out[0][13] - 0.75).abs() < 1e-4, "{}", out[0][13]);
    assert!((out[0][14] - 0.25).abs() < 1e-4, "{}", out[0][14]);
    assert!(out[0].iter().enumerate().all(|(i, v)| i == 13 || i == 14 || v.abs() < 1e-6));

    // The same delay arriving as an a-rate block reads the same samples.
    let mut d = Delay::new(&init(1.0));
    let (moving, _) = drive(&mut d, Some(mono(&x)), &[P::F(Box::new(|_| 10.25 / SR))], 4, &pool);
    for i in 0..512 { assert!((moving[0][i] - out[0][i]).abs() < 1e-3, "a-rate frame {i}"); }

    // A delay swept by a-rate automation reads each frame at its own delay.
    let mut d = Delay::new(&init(1.0));
    let sine = ramp(1024, |i| (i as f32 * 0.05).sin());
    let (out, _) = drive(&mut d, Some(mono(&sine)), &[P::F(Box::new(|f| (20.0 + f as f32 / 64.0) / SR))], 8, &pool);
    for (n, got) in out[0].iter().enumerate().skip(300) {
        let back = n as f64 - (20.0 + n as f64 / 64.0);
        let i = back.floor() as usize;
        let t = back - i as f64;
        let want = sine[i] as f64 + t * (sine[i + 1] as f64 - sine[i] as f64);
        assert!((*got as f64 - want).abs() < 2e-3, "swept frame {n}");
    }
}

#[test]
fn delay_reads_in_f32_once_automated() {
    // Chrome reads a delayTime that has never been automated once a quantum
    // in f64, and one that has (a `.value` set counts) a frame at a time in
    // f32, even while it holds still. The graph hands the second as a
    // Varying block. Between frames, with a ring of 48128 (one second plus a
    // quantum, whose f32 spacing is 1/256), the two read positions differ:
    // 590.4 frames back is read at a fraction of 0.40234375 (f32) against
    // 0.4 (f64), and the bench heard exactly that difference (−56 dB).
    let pool = BufferPool::default();
    let x = impulse(3, 1024);
    let t = 590.4f32 / SR;
    let mut d = Delay::new(&init(1.0));
    let (k, _) = drive(&mut d, Some(mono(&x)), &[P::C(t)], 8, &pool);
    let mut d = Delay::new(&init(1.0));
    let (a, _) = drive(&mut d, Some(mono(&x)), &[P::F(Box::new(move |_| t))], 8, &pool);
    // Frame 594 reads 591 frames back, the impulse, blended with the frame
    // after it by the read position's fraction: (len − 590.4) + 594 for the
    // f32 lanes, worked out in f32, and len − 590.4 in f64 once a quantum.
    let len = 48128.0f32;
    let p32 = 594.0f32 + (len - t * SR);
    let p64 = len as f64 - t as f64 * SR as f64;
    let want32 = 1.0 - (p32 - p32.floor()) as f64;
    let want64 = 1.0 - p64.fract();
    assert!((k[0][594] as f64 - want64).abs() < 1e-6, "k-rate {} vs {want64}", k[0][594]);
    assert!((a[0][594] as f64 - want32).abs() < 1e-6, "a-rate {} vs {want32}", a[0][594]);
    assert!((k[0][594] - a[0][594]).abs() > 1e-3, "the two paths differ");
    assert!(d.sample_accurate());
}

#[test]
fn delay_goes_silent_once_its_ring_has_emptied() {
    let pool = BufferPool::default();
    let mut d = Delay::new(&init(0.01));
    let x = impulse(0, 128);
    let (_, act) = drive(&mut d, Some(&[x]), &[P::C(0.005)], 8, &pool);
    assert_eq!(act[0], Activity::Active);
    assert_eq!(*act.last().unwrap(), Activity::Silent);
}

// ---------------------------------------------------------------- biquad

/// The Audio EQ Cookbook as the Web Audio spec writes it, straight from the
/// spec's text, in f64.
fn cookbook(kind: FilterType, f0: f64, q: f64, gain: f64) -> [f64; 5] {
    let w0 = 2.0 * PI * f0 / SR as f64;
    let a = 10f64.powf(gain / 40.0);
    let alpha_q = w0.sin() / (2.0 * q);
    let alpha_qdb = w0.sin() / (2.0 * 10f64.powf(q / 20.0));
    let alpha_s = w0.sin() / 2.0 * 2f64.sqrt();
    let c = w0.cos();
    let (b0, b1, b2, a0, a1, a2) = match kind {
        FilterType::Lowpass => ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha_qdb, -2.0 * c, 1.0 - alpha_qdb),
        FilterType::Highpass => ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha_qdb, -2.0 * c, 1.0 - alpha_qdb),
        FilterType::Bandpass => (alpha_q, 0.0, -alpha_q, 1.0 + alpha_q, -2.0 * c, 1.0 - alpha_q),
        FilterType::Notch => (1.0, -2.0 * c, 1.0, 1.0 + alpha_q, -2.0 * c, 1.0 - alpha_q),
        FilterType::Allpass => (1.0 - alpha_q, -2.0 * c, 1.0 + alpha_q, 1.0 + alpha_q, -2.0 * c, 1.0 - alpha_q),
        FilterType::Peaking => (1.0 + alpha_q * a, -2.0 * c, 1.0 - alpha_q * a, 1.0 + alpha_q / a, -2.0 * c, 1.0 - alpha_q / a),
        FilterType::Lowshelf => (
            a * ((a + 1.0) - (a - 1.0) * c + 2.0 * alpha_s * a.sqrt()),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - 2.0 * alpha_s * a.sqrt()),
            (a + 1.0) + (a - 1.0) * c + 2.0 * alpha_s * a.sqrt(),
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - 2.0 * alpha_s * a.sqrt(),
        ),
        FilterType::Highshelf => (
            a * ((a + 1.0) + (a - 1.0) * c + 2.0 * alpha_s * a.sqrt()),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - 2.0 * alpha_s * a.sqrt()),
            (a + 1.0) - (a - 1.0) * c + 2.0 * alpha_s * a.sqrt(),
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - 2.0 * alpha_s * a.sqrt(),
        ),
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

const ALL_TYPES: [FilterType; 8] = [
    FilterType::Lowpass, FilterType::Highpass, FilterType::Bandpass, FilterType::Lowshelf,
    FilterType::Highshelf, FilterType::Peaking, FilterType::Notch, FilterType::Allpass,
];

#[test]
fn biquad_coefficients_match_the_cookbook() {
    let nyquist = SR as f64 / 2.0;
    for kind in ALL_TYPES {
        for (f0, q, gain) in [(1000.0, 1.0, 6.0), (350.0, std::f64::consts::FRAC_1_SQRT_2, -12.0), (8000.0, 4.0, 3.0), (60.0, 12.0, 18.0)] {
            let got = Coefficients::compute(kind, f0 / nyquist, q, gain);
            let want = cookbook(kind, f0, q, gain);
            let got = [got.b0, got.b1, got.b2, got.a1, got.a2];
            for k in 0..5 {
                assert!((got[k] - want[k]).abs() < 1e-12, "{kind:?} f0 {f0} Q {q}: coefficient {k}: {} vs {}", got[k], want[k]);
            }
        }
    }
}

/// Direct Form I written out plainly: f64 sums, each output rounded to f32
/// and fed back as it was rounded.
fn reference_df1(x: &[f32], coefficients: impl Fn(usize) -> [f64; 5]) -> Vec<f64> {
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    x.iter().enumerate().map(|(n, &xn)| {
        let [b0, b1, b2, a1, a2] = coefficients(n);
        let y = (b0 * xn as f64 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) as f32;
        x2 = x1; x1 = xn as f64; y2 = y1; y1 = y as f64;
        y as f64
    }).collect()
}

#[test]
fn biquad_impulse_response_matches_reference_df1() {
    let pool = BufferPool::default();
    let x = impulse(0, 1024);
    for kind in ALL_TYPES {
        let mut b = Biquad::new(&init(kind as u8 as f64));
        let (out, _) = drive(&mut b, Some(mono(&x)), &[P::C(1200.0), P::C(0.0), P::C(3.0), P::C(-6.0)], 8, &pool);
        let want = reference_df1(&x, |_| cookbook(kind, 1200.0, 3.0, -6.0));
        assert_close(&out[0], &want, 1e-6, &format!("{kind:?} impulse"));
    }

    // Detune multiplies the frequency: 600 Hz up an octave is 1200 Hz.
    let mut b = Biquad::new(&init(0.0));
    let (out, _) = drive(&mut b, Some(mono(&x)), &[P::C(600.0), P::C(1200.0), P::C(3.0), P::C(0.0)], 8, &pool);
    let want = reference_df1(&x, |_| cookbook(FilterType::Lowpass, 1200.0, 3.0, 0.0));
    assert_close(&out[0], &want, 1e-6, "detuned lowpass");
}

#[test]
fn biquad_coefficients_follow_a_moving_param_per_sample() {
    let pool = BufferPool::default();
    let x = ramp(512, |i| ((i * 7919) % 101) as f32 / 50.0 - 1.0);
    let sweep = |f: u64| 200.0 + 20.0 * f as f32;
    let mut b = Biquad::new(&init(0.0));
    let (out, _) = drive(&mut b, Some(mono(&x)), &[P::F(Box::new(sweep)), P::C(0.0), P::C(1.0), P::C(0.0)], 4, &pool);
    let want = reference_df1(&x, |n| cookbook(FilterType::Lowpass, sweep(n as u64) as f64, 1.0, 0.0));
    assert_close(&out[0], &want, 1e-5, "swept lowpass");
}

#[test]
fn biquad_tail_and_silence() {
    let pool = BufferPool::default();
    let mut b = Biquad::new(&init(0.0));
    let x = impulse(0, 128);
    let (_, act) = drive(&mut b, Some(&[x]), &[P::C(1000.0), P::C(0.0), P::C(0.0), P::C(0.0)], 40, &pool);
    assert_eq!(act[0], Activity::Active);
    assert_eq!(*act.last().unwrap(), Activity::Silent, "the ring dies away to an exactly zero state");
    // The tail is the first frame by which the slowest pole has fallen 90 dB.
    let c = Coefficients::compute(FilterType::Lowpass, 1000.0 / 24000.0, 0.0, 0.0);
    let r = c.a2.sqrt();
    let tail = c.tail_frames(SR);
    assert!(r.powf(tail) <= 1.0 / 32768.0 && r.powf(tail - 1.0) > 1.0 / 32768.0, "tail {tail}");
}

// ---------------------------------------------------------------- oscillator

#[test]
fn periodic_wave_sizes_by_sample_rate() {
    assert_eq!(PeriodicWave::size_for_rate(22050.0), 2048);
    assert_eq!(PeriodicWave::size_for_rate(48000.0), 4096);
    assert_eq!(PeriodicWave::size_for_rate(88200.0), 4096);
    assert_eq!(PeriodicWave::size_for_rate(96000.0), 16384);
    assert_eq!(PeriodicWave::ranges_for_size(4096), 36);
    assert_eq!(PeriodicWave::ranges_for_size(2048), 33);
}

#[test]
fn periodic_wave_tables_are_band_limited_and_normalised() {
    let mut planner = RealFftPlanner::<f64>::new();
    for shape in [Shape::Sine, Shape::Square, Shape::Sawtooth, Shape::Triangle] {
        let wave = PeriodicWave::basic(shape, SR);
        let size = wave.size();
        let fft = planner.plan_fft_forward(size);
        let mut spectrum = fft.make_output_vec();
        let peak0 = wave.table(0).iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak0 - 1.0).abs() < 1e-6, "{shape:?}: full-band peak {peak0}");
        let mut fundamental = 0.0;
        for range in 0..wave.ranges() {
            let table = wave.table(range);
            let mut time: Vec<f64> = table.iter().map(|&v| v as f64).collect();
            fft.process(&mut time, &mut spectrum).unwrap();
            let partials = wave.partials_for_range(range);
            // Each bin's amplitude, as a sine of that partial in the table.
            let amplitude = |n: usize| spectrum[n].norm() * 2.0 / size as f64;
            for n in (partials + 1)..=size / 2 {
                assert!(amplitude(n) < 1e-5, "{shape:?} range {range}: partial {n} of {partials} at {}", amplitude(n));
            }
            assert!(amplitude(0) < 1e-6, "{shape:?} range {range}: DC");
            // Every range shares range 0's scale, so a partial a range keeps
            // has the same amplitude in it as in the full table.
            if range == 0 { fundamental = amplitude(1); }
            if partials >= 1 {
                assert!((amplitude(1) - fundamental).abs() < 1e-6, "{shape:?} range {range}: fundamental {}", amplitude(1));
            }
            // The partials kept follow the shape's series, at range 0's scale.
            if range == 0 && shape != Shape::Sine {
                let ratio = amplitude(3) / amplitude(1);
                let want = (shape.sine_coefficient(3) / shape.sine_coefficient(1)).abs() as f64;
                assert!((ratio - want).abs() < 1e-5, "{shape:?}: third partial {ratio} vs {want}");
            }
        }
        // For any pitch, the table with more partials (the one fully heard
        // at the bottom of the crossfade) keeps every one below Nyquist.
        let nyquist = SR as f64 / 2.0;
        let mut f = 20.0f32;
        while f < 20000.0 {
            let (higher, _, _) = wave.tables_for(f);
            let range = (0..wave.ranges()).find(|&r| std::ptr::eq(wave.table(r).as_ptr(), higher.as_ptr())).unwrap();
            let top = wave.partials_for_range(range) as f64 * f as f64;
            assert!(top < nyquist, "{shape:?} at {f} Hz: top partial {top}");
            f *= 1.01;
        }
    }
}

#[test]
fn oscillator_sine_is_a_sine_from_phase_zero() {
    let pool = BufferPool::default();
    let mut o = Oscillator::new(&init(Shape::Sine as u8 as f64));
    o.start(0.0, 0.0, -1.0);
    let (out, act) = drive(&mut o, None, &[P::C(440.0), P::C(0.0)], 8, &pool);
    assert!(act.iter().all(|a| *a == Activity::Active));
    // The table advances by the f32 step Chrome computes, 440 · 4096/48000;
    // the reference does too, so only the reading of the table is tested.
    // The k-rate path also holds its read positions in f32 across a
    // quantum, as Chrome's SIMD loop does, which costs a few millionths.
    let step = 440.0f32 * (4096.0f32 / SR);
    let want: Vec<f64> = (0..1024).map(|n| (2.0 * PI * n as f64 * step as f64 / 4096.0).sin()).collect();
    assert_close(&out[0], &want, 1e-5, "440 Hz sine");

    // Detune: 220 Hz up 1200 cents is the same 440.
    let mut o = Oscillator::new(&init(Shape::Sine as u8 as f64));
    o.start(0.0, 0.0, -1.0);
    let (detuned, _) = drive(&mut o, None, &[P::C(220.0), P::C(1200.0)], 8, &pool);
    assert_eq!(detuned[0], out[0], "detuned sine");

    // The same frequency as an a-rate block: an f64 read position, so only
    // the table's own linear interpolation is left between it and a sine.
    let mut o = Oscillator::new(&init(Shape::Sine as u8 as f64));
    o.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut o, None, &[P::F(Box::new(|_| 440.0)), P::C(0.0)], 8, &pool);
    assert_close(&out[0], &want, 5e-7, "a-rate sine");

    // A slow LFO (5-point Lagrange) is a clean sine too.
    let mut o = Oscillator::new(&init(Shape::Sine as u8 as f64));
    o.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut o, None, &[P::C(1.0), P::C(0.0)], 8, &pool);
    let want: Vec<f64> = (0..1024).map(|n| (2.0 * PI * n as f64 / SR as f64).sin()).collect();
    assert_close(&out[0], &want, 1e-6, "1 Hz sine");
}

#[test]
fn oscillator_square_level_and_start_stop() {
    let pool = BufferPool::default();
    let mut o = Oscillator::new(&init(Shape::Square as u8 as f64));
    o.start(64.0, 0.0, -1.0);
    o.stop(4874.0);
    let (out, act) = drive(&mut o, None, &[P::C(100.0), P::C(0.0)], 40, &pool);
    assert!(out[0][..64].iter().all(|&v| v == 0.0));
    assert!(out[0][4874..].iter().all(|&v| v == 0.0));
    assert!(out[0][4873] != 0.0);
    // Normalised by its Gibbs peak (1.179 of the flat level), a band-limited
    // square sits at about ±0.848 between its edges.
    let mid = out[0][64 + 120];
    assert!((mid - 0.848).abs() < 0.01, "first half-cycle {mid}");
    let mid = out[0][64 + 360];
    assert!((mid + 0.848).abs() < 0.01, "second half-cycle {mid}");
    assert_eq!(act[38], Activity::Active);
    assert_eq!(act[39], Activity::Finished);
}

// ---------------------------------------------------------------- buffer source

fn buffer_pool(channels: Vec<Vec<f32>>) -> BufferPool {
    let mut pool = BufferPool::default();
    pool.insert(3, AudioData { sample_rate: SR, channels });
    pool
}

/// The playback the spec describes, plainly: a playhead stepping by `rate`
/// and a linear read between the two frames either side.
fn reference_play(src: &[f32], start: f64, rate: f64, frames: usize) -> Vec<f64> {
    let mut pos = start;
    (0..frames).map(|_| {
        let i = pos as usize;
        let v = if i + 1 < src.len() {
            let t = pos - i as f64;
            ((1.0 - t) * src[i] as f64 + t * src[i + 1] as f64) as f32 as f64
        } else if i < src.len() { src[i] as f64 } else { 0.0 };
        pos += rate;
        v
    }).collect()
}

#[test]
fn buffer_source_rates() {
    let src = ramp(2000, |i| (i as f32 * 0.031).sin() * 0.8);
    let pool = buffer_pool(vec![src.clone(), src.iter().map(|v| -v).collect()]);
    for rate in [1.0f32, 0.5, 1.37] {
        let mut s = BufferSource::new(&init(0.0));
        s.set_attr(5, 3.0);
        s.start(0.0, 0.0, -1.0);
        let (out, _) = drive(&mut s, None, &[P::C(rate), P::C(0.0)], 8, &pool);
        assert_eq!(out.len(), 2, "stereo buffer, stereo out");
        let want = reference_play(&src, 0.0, rate as f64, 1024);
        assert_close(&out[0], &want, 1e-7, &format!("rate {rate}"));
        assert_close(&out[1], &want.iter().map(|v| -v).collect::<Vec<_>>(), 1e-7, &format!("rate {rate} R"));
        if rate == 1.0 { assert_eq!(out[0][..1024], src[..1024], "rate 1 is bit exact"); }
    }

    // Detune is a rate too: 1200 cents doubles it.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut s, None, &[P::C(0.5), P::C(1200.0)], 4, &pool);
    assert_eq!(out[0][..512], src[..512]);
}

#[test]
fn buffer_source_plays_out_and_finishes() {
    let src = ramp(300, |i| 1.0 + i as f32);
    let pool = buffer_pool(vec![src.clone()]);
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.start(10.0, 0.0, -1.0);
    let (out, act) = drive(&mut s, None, &[P::C(1.0), P::C(0.0)], 5, &pool);
    assert!(out[0][..10].iter().all(|&v| v == 0.0));
    assert_eq!(out[0][10..310], src[..]);
    assert!(out[0][310..].iter().all(|&v| v == 0.0));
    assert_eq!(act[..4], [Activity::Active, Activity::Active, Activity::Active, Activity::Finished]);

    // A start between frames: the first played frame is the next whole one,
    // already half a frame into the buffer.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.start(10.5, 0.0, -1.0);
    let (out, _) = drive(&mut s, None, &[P::C(1.0), P::C(0.0)], 1, &pool);
    assert_eq!(out[0][10], 0.0);
    assert!((out[0][11] - 1.5).abs() < 1e-6, "{}", out[0][11]);

    // An offset and a duration play just that grain of the buffer.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.start(0.0, 100.0 / SR as f64, 50.0 / SR as f64);
    let (out, _) = drive(&mut s, None, &[P::C(1.0), P::C(0.0)], 1, &pool);
    assert_eq!(out[0][..50], src[100..150]);
    assert!(out[0][50..].iter().all(|&v| v == 0.0));
}

#[test]
fn buffer_source_extrapolates_past_its_last_frame() {
    // Chrome: a read between the last frame and the end carries on the line
    // through the last two frames (the bench's rate 1.37 at 48 kHz ends so).
    // Frames hold i², and at 1.37 the eighth read is at 9.59.
    let src = ramp(10, |i| (i * i) as f32);
    let pool = buffer_pool(vec![src]);
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut s, None, &[P::C(1.37), P::C(0.0)], 1, &pool);
    let t = 7.0 * 1.37f32 as f64 - 9.0;
    assert!((out[0][7] as f64 - (81.0 + t * 17.0)).abs() < 1e-4, "{}", out[0][7]);
    assert!(out[0][8..].iter().all(|&v| v == 0.0));
}

#[test]
fn buffer_source_loop_wrap() {
    let src = ramp(100, |i| i as f32);
    let pool = buffer_pool(vec![src.clone()]);

    // The whole buffer, at rate 1: frame n plays sample n mod 100.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.set_attr(2, 1.0);
    s.start(0.0, 0.0, -1.0);
    let (out, act) = drive(&mut s, None, &[P::C(1.0), P::C(0.0)], 4, &pool);
    for (n, v) in out[0].iter().enumerate() { assert_eq!(*v, (n % 100) as f32, "frame {n}"); }
    assert!(act.iter().all(|a| *a == Activity::Active));

    // loopStart 20, loopEnd 60 frames: 0..60 once, then 20..60 for ever.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.set_attr(2, 1.0);
    s.set_attr(3, 20.0 / SR as f64);
    s.set_attr(4, 60.0 / SR as f64);
    s.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut s, None, &[P::C(1.0), P::C(0.0)], 2, &pool);
    for (n, v) in out[0].iter().enumerate() {
        let want = if n < 60 { n } else { 20 + (n - 60) % 40 };
        assert_eq!(*v, want as f32, "frame {n}");
    }

    // At a non-integer rate the wrap keeps the sub-sample position.
    let mut s = BufferSource::new(&init(0.0));
    s.set_attr(5, 3.0);
    s.set_attr(2, 1.0);
    s.set_attr(3, 20.0 / SR as f64);
    s.set_attr(4, 60.0 / SR as f64);
    s.start(0.0, 0.0, -1.0);
    let (out, _) = drive(&mut s, None, &[P::C(1.37), P::C(0.0)], 2, &pool);
    let mut pos = 0.0f64;
    for (n, v) in out[0].iter().enumerate() {
        // A linear ramp interpolates to the position itself, except within
        // the loop's last frame, where (Chrome) the frame after it is the
        // loop's start: 59 blends towards 20.
        let t = pos.fract();
        let want = if pos >= 59.0 { 59.0 * (1.0 - t) + 20.0 * t } else { pos };
        assert!((*v as f64 - want).abs() < 1e-4, "frame {n}: {v} vs {want}");
        pos += 1.37;
        if pos >= 60.0 { pos -= 40.0; }
    }
}

// ---------------------------------------------------------------- analyser

fn peak_of(a: &mut Analyser) -> f32 {
    let mut events = Events::default();
    a.request_peak(9, &mut events);
    let bytes = events.pending();
    assert_eq!(bytes.len(), 12);
    assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 102, "a peak event");
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 9);
    f32::from_le_bytes(bytes[8..12].try_into().unwrap())
}

#[test]
fn analyser_passes_through_and_peaks_over_its_window() {
    let pool = BufferPool::default();
    let mut a = Analyser::new(&init(1024.0));
    let l = ramp(256, |i| if i == 77 { -0.7 } else { 0.1 });
    let r = ramp(256, |i| if i == 77 { -0.3 } else { 0.1 });
    let (out, _) = drive(&mut a, Some(&[l.clone(), r.clone()]), &[], 2, &pool);
    assert_eq!(out[0], l);
    assert_eq!(out[1], r);
    // The mono down-mix: ½(−0.7 − 0.3).
    assert_eq!(peak_of(&mut a), 0.5);

    // Silence fills the window; once it has passed the peak falls to zero.
    let (_, act) = drive(&mut a, Some(&[vec![0.0; 128]]), &[], 7, &pool);
    assert_eq!(act[0], Activity::Silent);
    assert_eq!(peak_of(&mut a), 0.1, "the window still holds 128 loud frames");
    let (_, _) = drive(&mut a, Some(&[vec![0.0; 128]]), &[], 1, &pool);
    assert_eq!(peak_of(&mut a), 0.0);
    assert_eq!(a.tail_frames(), 1024.0);
}
