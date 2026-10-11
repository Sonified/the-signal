//! DynamicsCompressorNode, as Chrome makes it: Blink's DynamicsCompressor
//! (third_party/blink/renderer/platform/audio/dynamics_compressor.cc, once
//! dynamics_compressor_kernel.cc), ported line for line, f32 where it
//! works in float and f64 where it reaches for double, so a null test
//! against Chrome measures the libm and nothing else.
//!
//! What it does, in the order a frame meets it:
//!
//!   lookahead   each channel goes through a fixed pre-delay of 6 ms
//!               (floor(0.006·sr) frames, 288 at 48 kHz), and the gain is
//!               worked out from the undelayed input, so the gain is already
//!               moving by the time a loud frame reaches the output. Chrome
//!               reports it as the node's latency.
//!   detector    the louder channel's |x| (stereo-linked) through the static
//!               curve: linear to the threshold, an exponential knee
//!               (1st-derivative matched, its sharpness k found by bisection
//!               so the curve's slope at the knee's end is 1/ratio), then
//!               the ratio in dB. attenuation = curve(x) / x, smoothed by a
//!               detector that falls at once and rises at a rate set by how
//!               deep it is (kSatReleaseTime).
//!   envelope    every 32 frames the compressor's gain picks a rate towards
//!               the detector: an attack whose speed comes from `attack` and
//!               the deepest gap seen while attacking, or an adaptive
//!               release, a 4th-order polynomial through four release zones
//!               scaled by `release`, faster the deeper the compression.
//!               The gain is pre-warped by asin and warped back by sin, which
//!               rounds off the corners of the exponential approach.
//!   makeup      the spec's fixed makeup gain, (1 / curve(1))^0.6, whatever
//!               the input (core/heartbeat.js's LIM_TRIM takes it back off).
//!   reduction   the metered gain in dB: it falls with the gain at once and
//!               recovers with a 0.325 s time constant; read with
//!               request_peak, answered as a peak event (the app's one
//!               readback path), and set once a quantum as Chrome sets it.
//!
//! The output is always two channels (Chrome's kernel is stereo only); a
//! mono input is duplicated into both. Input rules are clamped-max 2.
//! threshold, knee, ratio, attack and release are k-rate: read once a
//! quantum, at its first frame (Chrome's FinalValue).
//!
//! The tail is Chrome's: five metering time constants (1.625 s) plus the
//! pre-delay, during which the node keeps rendering silence in, so the
//! envelope, the detector and the meter all run on through it exactly as
//! Chrome's do, and a sound arriving inside it finds them where Chrome's
//! would be. Once its pre-delay holds only silence the output is flagged
//! silent (it is zeros either way), so what follows it costs nothing.

use std::f32::consts::FRAC_PI_2;

use crate::events::Events;
use crate::node::{Activity, Bus, ChannelConfig, CountMode, Node, NodeInit, ParamSpec, QUANTUM, Rate, RenderCtx};

/// The spec's params, in the order the protocol lists them.
static PARAMS: [ParamSpec; 5] = [
    ParamSpec { name: "threshold", default: -24.0, min: -100.0, max: 0.0, rate: Rate::K },
    ParamSpec { name: "knee", default: 30.0, min: 0.0, max: 40.0, rate: Rate::K },
    ParamSpec { name: "ratio", default: 12.0, min: 1.0, max: 20.0, rate: Rate::K },
    ParamSpec { name: "attack", default: 0.003, min: 0.0, max: 1.0, rate: Rate::K },
    ParamSpec { name: "release", default: 0.25, min: 0.0, max: 1.0, rate: Rate::K },
];

// ---------- Chrome's constants ----------
/// Metering hits peaks instantly, but releases this fast (seconds).
const METERING_RELEASE_TIME_CONSTANT: f32 = 0.325;
const UNINITIALIZED: f32 = -1.0;
/// The lookahead, seconds.
const PRE_DELAY: f32 = 0.006;
const MAX_PRE_DELAY_FRAMES: usize = 1024;
const MAX_PRE_DELAY_FRAMES_MASK: usize = MAX_PRE_DELAY_FRAMES - 1;
/// Where the ring starts before the first quantum sets the real pre-delay.
const DEFAULT_PRE_DELAY_FRAMES: usize = 256;

// The release zones, 0 -> 1, and the polynomial's coefficients through them
// (a 4th-order fit through the zones at x = 0, 1, 2, 3), in f32 as Chrome's
// constexpr floats are.
const RELEASE_ZONE1: f32 = 0.09;
const RELEASE_ZONE2: f32 = 0.16;
const RELEASE_ZONE3: f32 = 0.42;
const RELEASE_ZONE4: f32 = 0.98;
const A_BASE: f32 = 0.9999999999999998 * RELEASE_ZONE1 + 1.8432219684323923e-16 * RELEASE_ZONE2
    - 1.9373394351676423e-16 * RELEASE_ZONE3 + 8.824516011816245e-18 * RELEASE_ZONE4;
const B_BASE: f32 = -1.5788320352845888 * RELEASE_ZONE1 + 2.3305837032074286 * RELEASE_ZONE2
    - 0.9141194204840429 * RELEASE_ZONE3 + 0.1623677525612032 * RELEASE_ZONE4;
const C_BASE: f32 = 0.5334142869106424 * RELEASE_ZONE1 - 1.272736789213631 * RELEASE_ZONE2
    + 0.9258856042207512 * RELEASE_ZONE3 - 0.18656310191776226 * RELEASE_ZONE4;
const D_BASE: f32 = 0.08783463138207234 * RELEASE_ZONE1 - 0.1694162967925622 * RELEASE_ZONE2
    + 0.08588057951595272 * RELEASE_ZONE3 - 0.00429891410546283 * RELEASE_ZONE4;
const E_BASE: f32 = -0.042416883008123074 * RELEASE_ZONE1 + 0.1115693827987602 * RELEASE_ZONE2
    - 0.09764676325265872 * RELEASE_ZONE3 + 0.028494263462021576 * RELEASE_ZONE4;

/// The detector's release time, seconds.
const SAT_RELEASE_TIME: f32 = 0.0025;
/// The envelope's rate is chosen once per this many frames.
const DIVISION_FRAMES: usize = 32;

// ---------- audio_utilities ----------
#[inline]
fn decibels_to_linear(db: f32) -> f32 { 10f32.powf(0.05 * db) }
#[inline]
fn linear_to_decibels(linear: f32) -> f32 { 20.0 * linear.log10() }
#[inline]
fn ensure_finite(x: f32, default: f32) -> f32 { if x.is_finite() { x } else { default } }
#[inline]
fn flush_denormal(x: f32) -> f32 { if x.abs() < f32::MIN_POSITIVE { 0.0 } else { x } }

pub struct DynamicsCompressor {
    sample_rate: f32,
    detector_average: f32,
    compressor_gain: f32,
    metering_release_k: f32,
    metering_gain: f32,
    /// The reduction readback, dB: the meter as the last quantum left it.
    reduction: f32,

    // The lookahead.
    last_pre_delay_frames: usize,
    pre_delay: [Vec<f32>; 2],
    read: usize,
    write: usize,
    /// Frames of silence taken in since the last sound, to know when the
    /// ring holds only zeros.
    quiet: usize,

    db_max_attack_compression_diff: f32,

    // The static curve, cached against the threshold, knee and ratio it was
    // worked out for.
    ratio: f32,
    slope: f32,
    linear_threshold: f32,
    db_threshold: f32,
    db_knee: f32,
    knee_threshold: f32,
    db_knee_threshold: f32,
    db_yknee_threshold: f32,
    knee: f32,
}

impl DynamicsCompressor {
    pub fn new(init: &NodeInit) -> Self {
        let sr = init.sample_rate;
        DynamicsCompressor {
            sample_rate: sr,
            // Reset()
            detector_average: 0.0,
            compressor_gain: 1.0,
            metering_gain: 1.0,
            metering_release_k: (1.0 - (-1.0 / (sr as f64 * METERING_RELEASE_TIME_CONSTANT as f64)).exp()) as f32,
            reduction: 0.0,
            last_pre_delay_frames: DEFAULT_PRE_DELAY_FRAMES,
            pre_delay: [vec![0.0; MAX_PRE_DELAY_FRAMES], vec![0.0; MAX_PRE_DELAY_FRAMES]],
            read: 0,
            write: DEFAULT_PRE_DELAY_FRAMES,
            quiet: MAX_PRE_DELAY_FRAMES,
            db_max_attack_compression_diff: -1.0,
            ratio: UNINITIALIZED,
            slope: UNINITIALIZED,
            linear_threshold: UNINITIALIZED,
            db_threshold: UNINITIALIZED,
            db_knee: UNINITIALIZED,
            knee_threshold: UNINITIALIZED,
            db_knee_threshold: UNINITIALIZED,
            db_yknee_threshold: UNINITIALIZED,
            knee: UNINITIALIZED,
        }
    }

    /// The lookahead in frames: floor(0.006·sr) in f32, at most 1023.
    pub fn pre_delay_frames(&self) -> usize {
        ((PRE_DELAY * self.sample_rate) as usize).min(MAX_PRE_DELAY_FRAMES - 1)
    }

    /// The reduction readback, dB (0 or less once it has run).
    pub fn reduction(&self) -> f32 { self.reduction }

    fn set_pre_delay_time(&mut self) {
        let frames = self.pre_delay_frames();
        if self.last_pre_delay_frames != frames {
            self.last_pre_delay_frames = frames;
            for line in self.pre_delay.iter_mut() { line.fill(0.0); }
            self.read = 0;
            self.write = frames;
        }
    }

    /// The knee: linear up to the threshold, then an exponential that is
    /// 1st-derivative matched there and approaches threshold + 1/k.
    fn knee_curve(&self, x: f32, k: f32) -> f32 {
        if x < self.linear_threshold { return x; }
        self.linear_threshold + (1.0 - ((-k * (x - self.linear_threshold)) as f64).exp() as f32) / k
    }

    /// The whole static curve: the knee, then a constant ratio in dB.
    fn saturate(&self, x: f32, k: f32) -> f32 {
        if x < self.knee_threshold { return self.knee_curve(x, k); }
        let db_x = linear_to_decibels(x);
        let db_y = self.db_yknee_threshold + self.slope * (db_x - self.db_knee_threshold);
        decibels_to_linear(db_y)
    }

    /// The knee's k whose slope, in dB, at the knee's end is `desired_slope`:
    /// fifteen steps of bisection on the geometric mean.
    fn k_at_slope(&self, desired_slope: f32) -> f32 {
        let db_x = self.db_threshold + self.db_knee;
        let x = decibels_to_linear(db_x);
        let mut x2: f32 = 1.0;
        let mut db_x2: f32 = 0.0;
        if !(x < self.linear_threshold) {
            // float times a double literal, kept as Chrome's `x * 1.001`
            x2 = (x as f64 * 1.001) as f32;
            db_x2 = linear_to_decibels(x2);
        }
        let mut min_k: f32 = 0.1;
        let mut max_k: f32 = 10000.0;
        let mut k: f32 = 5.0;
        let mut slope: f32 = 1.0;
        for _ in 0..15 {
            if !(x < self.linear_threshold) {
                let db_y = linear_to_decibels(self.knee_curve(x, k));
                let db_y2 = linear_to_decibels(self.knee_curve(x2, k));
                slope = (db_y2 - db_y) / (db_x2 - db_x);
            }
            if slope < desired_slope { max_k = k; } else { min_k = k; }
            k = (min_k * max_k).sqrt();
        }
        k
    }

    fn update_static_curve(&mut self, db_threshold: f32, db_knee: f32, ratio: f32) -> f32 {
        if db_threshold != self.db_threshold || db_knee != self.db_knee || ratio != self.ratio {
            self.db_threshold = db_threshold;
            self.linear_threshold = decibels_to_linear(db_threshold);
            self.db_knee = db_knee;
            self.ratio = ratio;
            self.slope = 1.0 / ratio;
            let k = self.k_at_slope(1.0 / ratio);
            self.db_knee_threshold = db_threshold + db_knee;
            self.knee_threshold = decibels_to_linear(self.db_knee_threshold);
            self.db_yknee_threshold = linear_to_decibels(self.knee_curve(self.knee_threshold, k));
            self.knee = k;
        }
        self.knee
    }

    /// One quantum: Chrome's DynamicsCompressor::Process, for two output
    /// channels and `channels` input channels (zeros when `silent`).
    fn process(&mut self, input: &Bus, params: [f32; 5], out: &mut Bus) {
        let [db_threshold, db_knee, ratio, attack_time, release_time] = params;
        let sample_rate = self.sample_rate;
        let k = self.update_static_curve(db_threshold, db_knee, ratio);

        // Makeup gain with empirical/perceptual tuning.
        let linear_post_gain = (1.0 / self.saturate(1.0, k)).powf(0.6);
        let attack_frames = attack_time.max(0.001) * sample_rate;
        let release_frames = sample_rate * release_time;
        let sat_release_frames = SAT_RELEASE_TIME * sample_rate;

        // The adaptive release: y = a + bx + cx² + dx³ + ex⁴, x from 0 to 3
        // for -15 to 0 dB of compression.
        let a = release_frames * A_BASE;
        let b = release_frames * B_BASE;
        let c = release_frames * C_BASE;
        let d = release_frames * D_BASE;
        let e = release_frames * E_BASE;

        self.set_pre_delay_time();

        let in_channels = if input.silent { 0 } else { input.channels };
        let mut frame = 0;
        while frame < QUANTUM {
            // The rate towards the gain the detector wants.
            self.detector_average = ensure_finite(self.detector_average, 1.0);
            let desired_gain = self.detector_average;
            // Pre-warped, so the sin warp below lands on desired_gain.
            let scaled_desired_gain = desired_gain.asin() / FRAC_PI_2;
            let is_releasing = scaled_desired_gain > self.compressor_gain;
            let mut db_compression_diff = if scaled_desired_gain == 0.0 {
                if is_releasing { -1.0 } else { 1.0 }
            } else {
                linear_to_decibels(self.compressor_gain / scaled_desired_gain)
            };

            let envelope_rate = if is_releasing {
                self.db_max_attack_compression_diff = -1.0;
                db_compression_diff = ensure_finite(db_compression_diff, -1.0);
                // -12 -> 0 dB, scaled to 0 -> 3
                let x = 0.25 * (db_compression_diff.clamp(-12.0, 0.0) + 12.0);
                let x2 = x * x;
                let x3 = x2 * x;
                let x4 = x2 * x2;
                let calc_release_frames = a + b * x + c * x2 + d * x3 + e * x4;
                const DB_SPACING: f32 = 5.0;
                decibels_to_linear(DB_SPACING / calc_release_frames)
            } else {
                db_compression_diff = ensure_finite(db_compression_diff, 1.0);
                // While attacking, the rate follows the largest gap so far.
                if self.db_max_attack_compression_diff == -1.0
                    || self.db_max_attack_compression_diff < db_compression_diff
                {
                    self.db_max_attack_compression_diff = db_compression_diff;
                }
                let db_eff_atten_diff = self.db_max_attack_compression_diff.max(0.5);
                let x = 0.25 / db_eff_atten_diff;
                1.0 - x.powf(1.0 / attack_frames)
            };

            let mut read = self.read;
            let mut write = self.write;
            let mut detector_average = self.detector_average;
            let mut compressor_gain = self.compressor_gain;

            for _ in 0..DIVISION_FRAMES.min(QUANTUM - frame) {
                // The pre-delay, and the louder channel's undelayed |x|.
                let mut compressor_input: f32 = 0.0;
                for j in 0..2 {
                    let undelayed = if in_channels == 0 { 0.0 } else { input.data[j.min(in_channels - 1)][frame] };
                    self.pre_delay[j][write] = undelayed;
                    let abs = if undelayed > 0.0 { undelayed } else { -undelayed };
                    if compressor_input < abs { compressor_input = abs; }
                }

                // The static curve's attenuation, and the detector.
                let abs_input = compressor_input;
                let shaped_input = self.saturate(abs_input, k);
                let attenuation = if abs_input <= 0.0001 { 1.0 } else { shaped_input / abs_input };
                let db_attenuation = (-linear_to_decibels(attenuation)).max(2.0);
                let db_per_frame = db_attenuation / sat_release_frames;
                let sat_release_rate = decibels_to_linear(db_per_frame) - 1.0;
                let rate = if attenuation > detector_average { sat_release_rate } else { 1.0 };
                detector_average += (attenuation - detector_average) * rate;
                detector_average = detector_average.min(1.0);
                detector_average = ensure_finite(detector_average, 1.0);

                // The envelope: an exponential approach on attack, a growth
                // back to 1 on release.
                if envelope_rate < 1.0 {
                    compressor_gain += (scaled_desired_gain - compressor_gain) * envelope_rate;
                } else {
                    compressor_gain *= envelope_rate;
                    compressor_gain = compressor_gain.min(1.0);
                }

                let post_warp_compressor_gain = ((FRAC_PI_2 * compressor_gain) as f64).sin() as f32;
                let total_gain = linear_post_gain * post_warp_compressor_gain;

                // The meter.
                let db_real_gain = linear_to_decibels(post_warp_compressor_gain);
                if db_real_gain < self.metering_gain {
                    self.metering_gain = db_real_gain;
                } else {
                    self.metering_gain += (db_real_gain - self.metering_gain) * self.metering_release_k;
                }

                for j in 0..2 { out.data[j][frame] = self.pre_delay[j][read] * total_gain; }

                frame += 1;
                read = (read + 1) & MAX_PRE_DELAY_FRAMES_MASK;
                write = (write + 1) & MAX_PRE_DELAY_FRAMES_MASK;
            }

            self.read = read;
            self.write = write;
            self.detector_average = flush_denormal(detector_average);
            self.compressor_gain = flush_denormal(compressor_gain);
        }
        self.reduction = self.metering_gain;
    }
}

impl Node for DynamicsCompressor {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 2 }

    fn channel_config(&self) -> ChannelConfig {
        ChannelConfig { count: 2, mode: CountMode::ClampedMax, speakers: true }
    }

    /// Chrome's TailTime (five metering time constants) plus its latency
    /// (the pre-delay).
    fn tail_frames(&self) -> f64 {
        5.0 * METERING_RELEASE_TIME_CONSTANT as f64 * self.sample_rate as f64 + self.pre_delay_frames() as f64
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let input = &ctx.inputs[0];
        let p = ctx.params;
        let params = [p[0].first(), p[1].first(), p[2].first(), p[3].first(), p[4].first()];
        let out = &mut out[0];
        out.channels = 2;
        self.process(input, params, out);
        if input.silent {
            self.quiet = self.quiet.saturating_add(QUANTUM);
        } else {
            self.quiet = 0;
        }
        // Silence in for longer than the lookahead: what comes out is zeros.
        if self.quiet >= QUANTUM + self.last_pre_delay_frames {
            out.zero();
            return Activity::Silent;
        }
        out.silent = false;
        Activity::Active
    }

    /// The reduction, answered as an analyser answers for its peak.
    fn request_peak(&mut self, node: u32, events: &mut Events) {
        events.peak(node, self.reduction);
    }
}
