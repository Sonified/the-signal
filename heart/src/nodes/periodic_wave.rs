//! The band-limited wavetables behind every oscillator: a port of Chromium's
//! PeriodicWave (third_party/blink/renderer/modules/webaudio/periodic_wave.cc).
//!
//! A naive sawtooth at 3 kHz has partials far past Nyquist, and they fold
//! back down as audible aliases. Chrome avoids that by keeping one table per
//! pitch range, three ranges to the octave, each with the partials culled so
//! that none of them can pass Nyquist anywhere in its range. An oscillator
//! looks up the two tables either side of its pitch and crossfades between
//! them, so the partials fade out smoothly as the pitch climbs instead of
//! switching off with a click.
//!
//! The browser chooses the table size, the range count and the culling rule,
//! and the null test compares our sound against Chrome's, so everything here
//! follows periodic_wave.cc step by step, down to which sums are done in f32.
//!
//! The tables for each basic shape at each sample rate are built once and
//! shared by every oscillator in the process, as Chrome shares them per
//! context: a 4096-sample table set is about 590 KB, and there may be dozens
//! of oscillators.

use std::sync::{Arc, Mutex};

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;

/// The four built-in shapes, numbered as protocol.json's oscillator_type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Sine = 0,
    Square = 1,
    Sawtooth = 2,
    Triangle = 3,
}

impl Shape {
    /// The shape for a wire value; anything unknown is a sine, the spec's
    /// default type.
    pub fn from_wire(v: f64) -> Shape {
        match v as i64 {
            1 => Shape::Square,
            2 => Shape::Sawtooth,
            3 => Shape::Triangle,
            _ => Shape::Sine,
        }
    }

    /// The coefficient of sin(n·x) in this shape's Fourier series, for
    /// n ≥ 1. Every basic shape is an odd function rising through zero at
    /// x = 0, so the cosine terms are all zero. The overall level does not
    /// matter here; the tables are normalised to a peak of one afterwards.
    pub fn sine_coefficient(self, n: usize) -> f32 {
        // Chrome: computed in f32, as GenerateBasicWaveform does, so that the
        // tables carry the same rounding.
        let pi_factor = 2.0 / (n as f32 * std::f32::consts::PI);
        let odd = n & 1 == 1;
        match self {
            Shape::Sine => if n == 1 { 1.0 } else { 0.0 },
            // b_n = 2/(nπ)·(1 − (−1)^n): 4/(nπ) on the odd partials.
            Shape::Square => if odd { 2.0 * pi_factor } else { 0.0 },
            // b_n = (−1)^(n+1)·2/(nπ).
            Shape::Sawtooth => if odd { pi_factor } else { -pi_factor },
            // b_n = 8·sin(nπ/2)/(πn)²: odd partials only, alternating in sign.
            Shape::Triangle => {
                if !odd { return 0.0; }
                let sign = if (n - 1) >> 1 & 1 == 1 { -1.0 } else { 1.0 };
                2.0 * (pi_factor * pi_factor) * sign
            }
        }
    }
}

/// Three ranges to the octave, so each range spans 400 cents.
const BANDS_PER_OCTAVE: f32 = 3.0;
const CENTS_PER_RANGE: f32 = 1200.0 / BANDS_PER_OCTAVE;

/// One shape's tables at one sample rate.
pub struct PeriodicWave {
    shape: Shape,
    sample_rate: f32,
    size: usize,
    ranges: usize,
    /// All the ranges' tables end to end, range 0 (every partial) first.
    tables: Vec<f32>,
    /// The pitch at which range 0's top partial sits exactly on Nyquist.
    lowest_fundamental: f32,
    /// Table samples advanced per output frame, per hertz.
    rate_scale: f32,
}

/// Every PeriodicWave built so far in this process, shared by shape and rate.
static BUILT: Mutex<Vec<Arc<PeriodicWave>>> = Mutex::new(Vec::new());

impl PeriodicWave {
    /// The shared tables for `shape` at `sample_rate`, built on first use.
    /// Building takes a few milliseconds (one inverse FFT per range), so it
    /// happens when an oscillator is made or changes type, never in render.
    pub fn basic(shape: Shape, sample_rate: f32) -> Arc<PeriodicWave> {
        let mut built = BUILT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = built.iter().find(|w| w.shape == shape && w.sample_rate == sample_rate) {
            return Arc::clone(w);
        }
        let wave = Arc::new(PeriodicWave::build(shape, sample_rate));
        built.push(Arc::clone(&wave));
        wave
    }

    /// The table length for a sample rate. Chrome keeps 4096 around 44.1 and
    /// 48 kHz for backward compatibility, and goes shorter or longer only
    /// well away from them.
    pub fn size_for_rate(sample_rate: f32) -> usize {
        if sample_rate <= 24000.0 { 2048 } else if sample_rate <= 88200.0 { 4096 } else { 16384 }
    }

    /// Enough 400-cent ranges to cover every pitch from the lowest
    /// fundamental up to Nyquist: 36 at a table size of 4096.
    pub fn ranges_for_size(size: usize) -> usize {
        (0.5 + BANDS_PER_OCTAVE * (size as f32).log2()) as usize
    }

    /// Builds the tables, following Chrome's CreateBandLimitedTables.
    pub fn build(shape: Shape, sample_rate: f32) -> PeriodicWave {
        let size = Self::size_for_rate(sample_rate);
        let half = size / 2;
        let ranges = Self::ranges_for_size(size);
        let nyquist = (0.5 * sample_rate as f64) as f32;
        let mut wave = PeriodicWave {
            shape,
            sample_rate,
            size,
            ranges,
            tables: vec![0.0; ranges * size],
            lowest_fundamental: nyquist / half as f32,
            rate_scale: size as f32 / sample_rate,
        };

        let coefficients: Vec<f32> = (0..half).map(|n| if n == 0 { 0.0 } else { shape.sine_coefficient(n) }).collect();

        let mut planner = RealFftPlanner::<f64>::new();
        let inverse = planner.plan_fft_inverse(size);
        let mut spectrum = inverse.make_input_vec();
        let mut time = inverse.make_output_vec();
        let mut scratch = inverse.make_scratch_vec();

        // Every range is scaled by the same factor, the one that brings the
        // full-band table's peak to exactly one. The culled tables then sit a
        // little below one, which is what keeps the level steady as partials
        // fade out with rising pitch.
        let mut normalisation = 1.0f32;
        for range in 0..ranges {
            let partials = wave.partials_for_range(range);
            // A sine coefficient b at bin n becomes the complex bin −i·b: its
            // inverse transform, with the conjugate half that a real signal
            // implies, is 2b·sin(2πnt/size). DC and the Nyquist bin stay clear,
            // and every bin past this range's last partial is culled.
            spectrum.fill(Complex::new(0.0, 0.0));
            for n in 1..half.min(partials + 1) {
                spectrum[n] = Complex::new(0.0, -(coefficients[n] as f64));
            }
            // realfft wants the DC and Nyquist bins purely real, which they are.
            inverse
                .process_with_scratch(&mut spectrum, &mut time, &mut scratch)
                .expect("an inverse FFT of the table size");

            if range == 0 {
                let peak = time.iter().fold(0.0f64, |m, v| m.max(v.abs())) as f32;
                if peak > 0.0 { normalisation = 1.0 / peak; }
            }
            let table = &mut wave.tables[range * size..(range + 1) * size];
            for (out, v) in table.iter_mut().zip(time.iter()) {
                *out = *v as f32 * normalisation;
            }
        }
        wave
    }

    pub fn shape(&self) -> Shape { self.shape }
    pub fn size(&self) -> usize { self.size }
    pub fn ranges(&self) -> usize { self.ranges }
    pub fn rate_scale(&self) -> f32 { self.rate_scale }
    pub fn lowest_fundamental(&self) -> f32 { self.lowest_fundamental }

    /// The table for one range.
    pub fn table(&self, range: usize) -> &[f32] {
        &self.tables[range * self.size..(range + 1) * self.size]
    }

    /// How many partials range `range` keeps: range r sits r·400 cents
    /// above the lowest fundamental, so it keeps 2^(−r/3) of the most a
    /// table can hold (size/2).
    pub fn partials_for_range(&self, range: usize) -> usize {
        // Chrome: cents in f32, pow in f64, the product in f32, truncated.
        let cents_to_cull = range as f32 * CENTS_PER_RANGE;
        let culling_scale = 2f64.powf((-cents_to_cull / 1200.0) as f64) as f32;
        (culling_scale * (self.size / 2) as f32) as usize
    }

    /// The two tables to play a fundamental from, and how far to crossfade
    /// from the first (more partials) to the second (fewer), following
    /// Chrome's WaveDataForFundamentalFrequency.
    ///
    /// The range index is one more than the pitch's own range, so the table
    /// switch happens just before a partial would reach Nyquist, never after.
    #[inline]
    pub fn tables_for(&self, fundamental: f32) -> (&[f32], &[f32], f32) {
        // Negative frequencies play the same tables as their positive twins.
        let f = fundamental.abs();
        let ratio = if f > 0.0 { f / self.lowest_fundamental } else { 0.5 };
        let cents_above_lowest = ratio.log2() * 1200.0;
        let last = (self.ranges - 1) as f32;
        let pitch_range = (1.0 + cents_above_lowest / CENTS_PER_RANGE).max(0.0).min(last);
        let higher = pitch_range as usize;
        let lower = if higher < self.ranges - 1 { higher + 1 } else { higher };
        (self.table(higher), self.table(lower), pitch_range - higher as f32)
    }
}
