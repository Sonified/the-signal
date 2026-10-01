//! The AudioParam timeline against hand-worked spec values: every event
//! type, the moves between them, cancelling in the middle of each, events
//! set in the past, equal times, and both rates. Times are frames, and the
//! sample rate is 1000 so a time constant or duration in seconds reads
//! straight as frames (0.1 s is 100 frames).

use heart::node::{QUANTUM, Rate};
use heart::param::{Fill, Timeline};

const SR: f32 = 1000.0;
const BIG: f32 = f32::MAX;

fn a_rate(default: f32) -> Timeline { Timeline::new(default, -BIG, BIG, Rate::A, SR) }
fn k_rate(default: f32) -> Timeline { Timeline::new(default, -BIG, BIG, Rate::K, SR) }

/// Renders whole quanta from `from`, a value per frame.
fn render(t: &mut Timeline, from: u64, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut block = [0.0; QUANTUM];
    for q in 0..frames / QUANTUM {
        match t.fill(&mut block, from + (q * QUANTUM) as u64) {
            Fill::Const(v) => out.extend([v; QUANTUM]),
            Fill::Varying => out.extend_from_slice(&block),
        }
    }
    out
}

/// k-rate: one value per quantum.
fn render_k(t: &mut Timeline, quanta: usize) -> Vec<f32> {
    let mut block = [0.0; QUANTUM];
    (0..quanta).map(|q| match t.fill(&mut block, (q * QUANTUM) as u64) {
        Fill::Const(v) => v,
        Fill::Varying => panic!("a k-rate param is one value a quantum"),
    }).collect()
}

#[track_caller]
fn near(got: f32, want: f64, tol: f64) {
    let err = (got as f64 - want).abs();
    assert!(err <= tol * want.abs().max(1.0), "got {got}, want {want} (error {err})");
}

#[track_caller]
fn all(values: &[f32], want: f32) {
    for (i, v) in values.iter().enumerate() { assert_eq!(*v, want, "frame {i} of the run"); }
}

// ---------- setValueAtTime ----------

#[test]
fn default_with_no_events_is_constant() {
    let mut t = a_rate(0.7);
    let mut block = [9.0; QUANTUM];
    assert_eq!(t.fill(&mut block, 0), Fill::Const(0.7));
    assert_eq!(block, [9.0; QUANTUM], "the block is not written on the fast path");
    assert_eq!(t.value(), 0.7);
}

#[test]
fn set_value_lands_on_its_frame() {
    let mut t = a_rate(0.0);
    t.set_value(100.0, 2.0, 0.0);
    let v = render(&mut t, 0, 256);
    all(&v[..100], 0.0);
    all(&v[100..], 2.0);
}

#[test]
fn set_value_between_frames_lands_on_the_next() {
    let mut t = a_rate(0.0);
    t.set_value(100.5, 2.0, 0.0);
    let v = render(&mut t, 0, 256);
    all(&v[..101], 0.0);
    all(&v[101..], 2.0);
}

#[test]
fn equal_times_keep_insertion_order() {
    let mut t = a_rate(0.0);
    t.set_value(100.0, 1.0, 0.0);
    t.set_value(100.0, 2.0, 0.0);
    all(&render(&mut t, 0, 256)[100..], 2.0);

    let mut t = a_rate(0.0);
    t.linear_ramp(100.0, 1.0, 0.0);
    t.set_value(100.0, 3.0, 0.0);
    all(&render(&mut t, 0, 256)[100..], 3.0);

    // The ramp starts from the later of two events at the same time.
    let mut t = a_rate(0.0);
    t.set_value(100.0, 5.0, 0.0);
    t.linear_ramp(200.0, 1.0, 0.0);
    t.set_value(100.0, 7.0, 0.0);
    let v = render(&mut t, 0, 256);
    near(v[150], 4.0, 1e-6);
}

// ---------- linearRampToValueAtTime ----------

#[test]
fn linear_ramp_from_the_previous_event() {
    let mut t = a_rate(9.0);
    t.set_value(200.0, 0.5, 0.0);
    t.linear_ramp(600.0, 1.5, 0.0);
    let v = render(&mut t, 0, 768);
    all(&v[..200], 9.0);
    for k in 200..600 { near(v[k], 0.5 + (k - 200) as f64 / 400.0, 1e-6); }
    all(&v[600..], 1.5);
}

#[test]
fn linear_ramp_with_nothing_before_starts_from_now() {
    let mut t = a_rate(0.5);
    t.linear_ramp(1000.0, 1.0, 0.0);
    let v = render(&mut t, 0, 1024);
    for k in (0..1000).step_by(37) { near(v[k], 0.5 + 0.5 * k as f64 / 1000.0, 1e-6); }
    all(&v[1000..], 1.0);
}

#[test]
fn ramps_chain_end_to_end() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(100.0, 1.0, 0.0);
    t.linear_ramp(200.0, 0.0, 0.0);
    let v = render(&mut t, 0, 256);
    near(v[50], 0.5, 1e-6);
    near(v[100], 1.0, 1e-6);
    near(v[150], 0.5, 1e-6);
    all(&v[200..], 0.0);
}

// ---------- exponentialRampToValueAtTime ----------

#[test]
fn exponential_ramp() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.01, 0.0);
    t.exponential_ramp(1000.0, 1.0, 0.0);
    let v = render(&mut t, 0, 1152);
    for k in (0..1000).step_by(13) { near(v[k], 0.01 * 100f64.powf(k as f64 / 1000.0), 1e-5); }
    all(&v[1000..], 1.0);
}

#[test]
fn exponential_ramp_between_negatives() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, -1.0, 0.0);
    t.exponential_ramp(100.0, -4.0, 0.0);
    let v = render(&mut t, 0, 128);
    near(v[50], -2.0, 1e-5);
    all(&v[100..], -4.0);
}

#[test]
fn exponential_ramp_across_zero_holds_its_start() {
    // Opposite signs: v1 holds through the ramp, and at its end time the
    // value is its own, as the spec has it and Chrome plays it (the bench's
    // ramp from 0 to 5000 on a biquad's frequency jumps there).
    let mut t = a_rate(0.0);
    t.set_value(0.0, -1.0, 0.0);
    t.exponential_ramp(100.0, 1.0, 0.0);
    let v = render(&mut t, 0, 384);
    all(&v[..100], -1.0);
    all(&v[100..], 1.0);
    // From zero: the same.
    let mut t = a_rate(5.0);
    t.set_value(0.0, 0.0, 0.0);
    t.exponential_ramp(100.0, 5000.0, 0.0);
    let v = render(&mut t, 0, 384);
    all(&v[..100], 0.0);
    all(&v[100..], 5000.0);
}

#[test]
fn what_follows_a_held_exponential_ramp_in_its_quantum_runs_behind() {
    // Chrome fills the frames of an exponential ramp across zero without
    // counting them, so a linear ramp after it in the same quantum is
    // computed from a frame as many frames back as the hold lasted (here
    // the 50 frames from 10 to 60), and the next quantum starts true.
    let mut t = a_rate(0.0);
    t.set_value(10.0, -0.5, 0.0);
    t.exponential_ramp(60.0, 0.5, 0.0);
    t.linear_ramp(300.0, 0.2, 0.0);
    let v = render(&mut t, 0, 256);
    all(&v[..10], 0.0);
    all(&v[10..60], -0.5);
    // Frame 60 is worked out at Chrome's frame 10: x = (10 − 60)/240.
    let lagged = |k: usize| 0.5 + (0.2 - 0.5) * ((k as f64 - 50.0) - 60.0) / 240.0;
    let truly = |k: usize| 0.5 + (0.2 - 0.5) * (k as f64 - 60.0) / 240.0;
    for k in [60, 61, 100, 127] { near(v[k], lagged(k), 1e-6); }
    for k in [128, 129, 200, 255] { near(v[k], truly(k), 1e-6); }

    // A ramp ending in the same quantum is drawn behind, and what follows
    // its end holds its value exactly.
    let mut t = a_rate(0.0);
    t.set_value(10.0, -0.5, 0.0);
    t.exponential_ramp(60.0, 0.5, 0.0);
    t.linear_ramp(110.0, 0.2, 0.0);
    let v = render(&mut t, 0, 128);
    near(v[60], 0.8, 1e-6);
    near(v[109], 0.5 + 0.3 * 0.02, 1e-5);
    all(&v[110..], 0.2);
}

#[test]
fn exponential_ramp_to_zero_is_refused() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 1.0, 0.0);
    t.exponential_ramp(100.0, 0.0, 0.0);
    all(&render(&mut t, 0, 256), 1.0);
}

#[test]
fn a_linear_ramp_after_an_exponential_starts_from_its_end() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 1.0, 0.0);
    t.exponential_ramp(100.0, 4.0, 0.0);
    t.linear_ramp(200.0, 0.0, 0.0);
    let v = render(&mut t, 0, 256);
    near(v[150], 2.0, 1e-6);
}

// ---------- setTargetAtTime ----------

#[test]
fn set_target_approaches_exponentially() {
    // τ = 0.1 s = 100 frames, from 1 towards 0, starting mid-frame.
    let mut t = a_rate(1.0);
    t.set_target(10.5, 0.0, 0.1, 0.0);
    let v = render(&mut t, 0, 640);
    all(&v[..11], 1.0);
    // The first frame from the closed form, the rest by Chrome's recurrence.
    near(v[11], (-0.5f64 / 100.0).exp(), 1e-7);
    for k in (11..640).step_by(17) { near(v[k], (-(k as f64 - 10.5) / 100.0).exp(), 2e-6); }
}

#[test]
fn set_target_snaps_once_converged() {
    // τ = 10 frames: Chrome settles once ten time constants have passed, and
    // looks at the start of each run of frames, so from the second quantum.
    let mut t = a_rate(1.0);
    t.set_target(0.0, 0.0, 0.01, 0.0);
    let mut block = [0.0; QUANTUM];
    assert_eq!(t.fill(&mut block, 0), Fill::Varying);
    for k in (0..128).step_by(9) { near(block[k], (-(k as f64) / 10.0).exp(), 1e-5); }
    assert_eq!(t.fill(&mut block, 128), Fill::Const(0.0));
    assert_eq!(t.fill(&mut block, 256), Fill::Const(0.0));

    // A target that is not zero settles by its relative threshold.
    let mut t = a_rate(0.0);
    t.set_target(0.0, 1.0, 0.01, 0.0);
    assert_eq!(t.fill(&mut block, 0), Fill::Varying);
    assert_eq!(t.fill(&mut block, 128), Fill::Const(1.0));
}

#[test]
fn set_target_to_zero_snaps_under_the_same_threshold() {
    // Chrome's one threshold, e^−10, serves a target of zero too, outright:
    // from 0.1 with τ = 100 frames the value passes 4.54e−5 at frame 770,
    // so the first quantum to start below it (896) is all zeros, long
    // before ten time constants (frame 1000) would settle it.
    let mut t = a_rate(0.1);
    t.set_target(0.0, 0.0, 0.1, 0.0);
    let v = render(&mut t, 0, 1024);
    near(v[895], 0.1 * (-8.95f64).exp(), 1e-4);
    assert!(v[895] > 0.0);
    all(&v[896..], 0.0);
}

#[test]
fn set_target_with_no_time_constant_jumps() {
    let mut t = a_rate(0.0);
    t.set_target(100.0, 5.0, 0.0, 0.0);
    let v = render(&mut t, 0, 256);
    all(&v[..100], 0.0);
    all(&v[100..], 5.0);
}

#[test]
fn set_target_after_a_ramp_starts_from_its_end() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(100.0, 1.0, 0.0);
    t.set_target(100.0, 0.0, 0.1, 0.0);
    let v = render(&mut t, 0, 384);
    for k in (100..384).step_by(11) { near(v[k], (-(k as f64 - 100.0) / 100.0).exp(), 2e-6); }
}

#[test]
fn a_ramp_after_a_running_target_starts_where_it_has_got_to() {
    // Chrome's ProcessSetTargetFollowedByRamp: the ramp is set at frame 256,
    // and starts there, from the approach's value there.
    let mut t = a_rate(1.0);
    t.set_target(0.0, 0.0, 0.1, 0.0);
    let v = render(&mut t, 0, 256);
    near(v[255], (-2.55f64).exp(), 2e-6);
    t.linear_ramp(1256.0, 1.0, 256.0);
    let v = render(&mut t, 256, 1024);
    let start = (-2.56f64).exp();
    near(v[0], start, 2e-6);
    near(v[500], (start + 1.0) / 2.0, 2e-6);
}

#[test]
fn a_ramp_after_a_future_target_starts_at_the_targets_time() {
    let mut t = a_rate(0.2);
    t.set_target(100.0, 0.0, 0.1, 0.0);
    t.linear_ramp(1100.0, 1.2, 0.0);
    let v = render(&mut t, 0, 1152);
    all(&v[..100], 0.2);
    near(v[600], 0.7, 1e-6);
    all(&v[1100..], 1.2);
}

// ---------- setValueCurveAtTime ----------

#[test]
fn value_curve_by_the_spec_index() {
    let mut t = a_rate(9.0);
    t.set_curve(100.0, 0.2, vec![0.0, 1.0, 0.0], 0.0);
    let v = render(&mut t, 0, 384);
    all(&v[..100], 9.0);
    near(v[100], 0.0, 1e-7);
    near(v[150], 0.5, 1e-6);
    near(v[200], 1.0, 1e-6);
    near(v[250], 0.5, 1e-6);
    near(v[299], 0.01, 1e-5);
    all(&v[300..], 0.0);
}

#[test]
fn after_a_curve_ramps_start_from_its_last_value() {
    let mut t = a_rate(0.0);
    t.set_curve(0.0, 0.1, vec![0.0, 2.0], 0.0);
    t.linear_ramp(200.0, 0.0, 0.0);
    let v = render(&mut t, 0, 256);
    near(v[50], 1.0, 1e-6);
    near(v[150], 1.0, 1e-6);
    all(&v[200..], 0.0);
}

#[test]
fn curves_refuse_to_overlap() {
    let mut t = a_rate(0.0);
    t.set_curve(100.0, 0.1, vec![1.0, 1.0], 0.0);
    t.set_value(150.0, 5.0, 0.0);                  // inside the curve
    t.set_curve(50.0, 0.1, vec![3.0, 3.0], 0.0);   // over its start
    t.set_curve(150.0, 0.1, vec![4.0, 4.0], 0.0);  // starting inside it
    t.set_value(200.0, 2.0, 0.0);                  // at its end: fine
    let v = render(&mut t, 0, 256);
    all(&v[..100], 0.0);
    all(&v[100..200], 1.0);
    all(&v[200..], 2.0);
}

// ---------- cancelScheduledValues ----------

#[test]
fn cancel_drops_events_from_its_time() {
    let mut t = a_rate(0.0);
    t.set_value(100.0, 1.0, 0.0);
    t.set_value(300.0, 2.0, 0.0);
    t.set_value(500.0, 3.0, 0.0);
    t.cancel(300.0, 0.0);
    let v = render(&mut t, 0, 640);
    all(&v[100..], 1.0);
}

#[test]
fn cancel_mid_ramp_falls_back_to_its_start() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(1000.0, 1.0, 0.0);
    let v = render(&mut t, 0, 512);
    near(v[511], 0.511, 1e-6);
    t.cancel(512.0, 512.0);
    all(&render(&mut t, 512, 256), 0.0);
}

#[test]
fn cancel_mid_curve_restores_the_value_before_it() {
    let mut t = a_rate(0.25);
    t.set_curve(0.0, 1.0, vec![0.0, 1.0], 0.0);
    render(&mut t, 0, 256);
    t.cancel(256.0, 256.0);
    all(&render(&mut t, 256, 256), 0.25);
}

// ---------- cancelAndHoldAtTime ----------

#[test]
fn hold_mid_linear() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(1000.0, 1.0, 0.0);
    t.cancel_and_hold(400.0, 0.0);
    let v = render(&mut t, 0, 640);
    for k in (0..400).step_by(7) { near(v[k], k as f64 / 1000.0, 1e-6); }
    all(&v[400..], 0.4);
}

#[test]
fn hold_mid_exponential() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.01, 0.0);
    t.exponential_ramp(1000.0, 1.0, 0.0);
    t.cancel_and_hold(500.0, 0.0);
    let v = render(&mut t, 0, 768);
    for k in (0..500).step_by(7) { near(v[k], 0.01 * 100f64.powf(k as f64 / 1000.0), 1e-5); }
    for x in &v[500..] { near(*x, 0.1, 1e-6); }
}

#[test]
fn hold_mid_target() {
    let mut t = a_rate(1.0);
    t.set_target(0.0, 0.0, 0.1, 0.0);
    t.cancel_and_hold(200.0, 0.0);
    let v = render(&mut t, 0, 512);
    for k in (0..200).step_by(7) { near(v[k], (-(k as f64) / 100.0).exp(), 2e-6); }
    for x in &v[200..] { near(*x, (-2.0f64).exp(), 2e-6); }
    assert!(v[200..].iter().all(|x| *x == v[200]), "the held value holds");
}

#[test]
fn a_ramp_after_a_hold_mid_target_starts_from_zero() {
    // Chrome: cancelAndHold during a setTarget holds the value reached, but
    // its CancelValues event, whose value nothing sets in that case, is
    // where a ramp after it starts: from 0, not from the held value. The
    // bench's scenario (a gain's setTarget, a hold, a ramp to 0) heard it.
    let mut t = a_rate(0.0);
    t.set_target(100.0, 1.0, 0.3, 0.0);
    t.cancel_and_hold(500.0, 0.0);
    t.linear_ramp(900.0, 0.2, 0.0);
    let v = render(&mut t, 0, 1024);
    near(v[499], 1.0 - (-399.0f64 / 300.0).exp(), 1e-5);
    near(v[500], 0.0, 1e-7);
    near(v[700], 0.1, 1e-6);
    near(v[899], 0.2 * 399.0 / 400.0, 1e-6);
    all(&v[900..], 0.2);

    // With nothing after it, the hold holds where the approach got to.
    let mut t = a_rate(0.0);
    t.set_target(100.0, 1.0, 0.3, 0.0);
    t.cancel_and_hold(500.0, 0.0);
    let v = render(&mut t, 0, 1024);
    near(v[600], 1.0 - (-400.0f64 / 300.0).exp(), 1e-5);
    assert!(v[500..].iter().all(|x| *x == v[500]));
}

#[test]
fn hold_mid_curve() {
    let mut t = a_rate(0.0);
    t.set_curve(0.0, 1.0, vec![0.0, 1.0], 0.0);
    t.cancel_and_hold(250.0, 0.0);
    let v = render(&mut t, 0, 512);
    for k in (0..250).step_by(7) { near(v[k], k as f64 / 1000.0, 1e-6); }
    all(&v[250..], 0.25);
}

#[test]
fn hold_mid_everything_once_under_way() {
    // The same four, with the automation already running when the hold
    // arrives (it governs from the timeline's present, not a pending event).
    let mut lin = a_rate(0.0);
    lin.set_value(0.0, 0.0, 0.0);
    lin.linear_ramp(1000.0, 1.0, 0.0);
    let mut exp = a_rate(0.0);
    exp.set_value(0.0, 0.01, 0.0);
    exp.exponential_ramp(1000.0, 1.0, 0.0);
    let mut target = a_rate(1.0);
    target.set_target(0.0, 0.0, 0.1, 0.0);
    let mut curve = a_rate(0.0);
    curve.set_curve(0.0, 1.0, vec![0.0, 1.0], 0.0);
    let held = [0.3, 0.01 * 100f64.powf(0.3), (-3.0f64).exp(), 0.3];
    for (t, want) in [&mut lin, &mut exp, &mut target, &mut curve].into_iter().zip(held) {
        render(t, 0, 256);
        t.cancel_and_hold(300.0, 256.0);
        let v = render(t, 256, 256);
        for x in &v[44..] { near(*x, want, 3e-6); }
    }
}

#[test]
fn hold_in_the_past_holds_now() {
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(1000.0, 1.0, 0.0);
    render(&mut t, 0, 384);
    t.cancel_and_hold(300.0, 384.0);
    for x in render(&mut t, 384, 256) { near(x, 0.384, 1e-6); }
}

#[test]
fn hold_when_nothing_runs_drops_what_follows() {
    let mut t = a_rate(0.0);
    t.set_value(100.0, 1.0, 0.0);
    t.set_value(300.0, 2.0, 0.0);
    t.cancel_and_hold(200.0, 0.0);
    all(&render(&mut t, 0, 512)[100..], 1.0);
}

// ---------- the past, the present, and Chrome's memory ----------

#[test]
fn a_new_event_moves_up_to_the_quantum_that_first_renders_it() {
    // Chrome renders a source's params only while it plays, and clamps an
    // event set before then to the first quantum it renders: a ramp set
    // from time 0 on a source heard from frame 512 starts there.
    let mut t = a_rate(0.0);
    t.set_value(0.0, 0.2, 0.0);
    t.linear_ramp(1000.0, -0.8, 0.0);
    let v = render(&mut t, 512, 256);
    near(v[0], 0.2, 1e-7);
    near(v[128], 0.2 - 128.0 / 488.0, 1e-6);

    // Only new events move. One already seen by a render keeps its time,
    // however late the next render comes: this setTarget at 130.5 was seen
    // at frame 0, so at 256 its approach takes one step from where it was.
    let mut t = a_rate(0.0);
    t.set_target(130.5, 1.0, 0.1, 0.0);
    render(&mut t, 0, 128);
    let v = render(&mut t, 256, 128);
    near(v[0], 1.0 - (-0.01f64).exp(), 1e-6);
}

#[test]
fn has_values_as_chrome_reports_them() {
    // Untouched, a param has none; a first value still to come after the
    // quantum leaves it so; once anything is set and under way, or a ramp
    // is coming, it has them for good.
    let mut t = a_rate(0.0);
    assert!(!t.has_values(0));
    t.set_value(500.0, 1.0, 0.0);
    assert!(!t.has_values(0));
    assert!(t.has_values(384));
    render(&mut t, 0, 1024);
    assert!(t.has_values(1024));
    assert!(t.has_values(1_000_000));
    let mut t = a_rate(0.0);
    t.linear_ramp(500.0, 1.0, 0.0);
    assert!(t.has_values(0));
}

#[test]
fn events_in_the_past_move_up_to_now() {
    let mut t = a_rate(0.0);
    render(&mut t, 0, 256);
    t.set_value(100.0, 5.0, 256.0);
    all(&render(&mut t, 256, 128), 5.0);

    // A ramp whose end has passed lands at once.
    let mut t = a_rate(0.0);
    render(&mut t, 0, 256);
    t.linear_ramp(128.0, 1.0, 256.0);
    all(&render(&mut t, 256, 128), 1.0);
}

#[test]
fn a_forgotten_history_starts_ramps_from_now() {
    // Chrome drops events a quantum and a half behind, so the ramp starts
    // at its call (frame 512), not at the old setValueAtTime (frame 0).
    let mut t = a_rate(1.0);
    t.set_value(0.0, 0.0, 0.0);
    render(&mut t, 0, 512);
    t.linear_ramp(1512.0, 1.0, 512.0);
    let v = render(&mut t, 512, 1024);
    near(v[500], 0.5, 1e-6);
}

#[test]
fn a_remembered_history_starts_ramps_from_the_event() {
    // Within that quantum and a half, the ramp starts at the event, as the
    // spec draws it.
    let mut t = a_rate(1.0);
    t.set_value(100.0, 0.0, 0.0);
    render(&mut t, 0, 128);
    t.linear_ramp(1100.0, 1.0, 128.0);
    let v = render(&mut t, 128, 512);
    near(v[600 - 128], 0.5, 1e-6);
}

#[test]
fn values_are_clamped_and_so_is_the_kept_value() {
    let mut t = Timeline::new(0.0, 0.0, 1.0, Rate::A, SR);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(100.0, 2.0, 0.0);
    let v = render(&mut t, 0, 128);
    near(v[25], 0.5, 1e-6);
    all(&v[50..], 1.0);
    assert_eq!(t.value(), 1.0);
}

#[test]
fn bad_arguments_are_dropped() {
    let mut t = a_rate(1.0);
    t.set_value(f64::NAN, 2.0, 0.0);
    t.set_value(10.0, f32::INFINITY, 0.0);
    t.set_target(10.0, 2.0, -1.0, 0.0);
    t.set_curve(10.0, 0.1, vec![2.0], 0.0);
    t.set_curve(10.0, 0.0, vec![2.0, 3.0], 0.0);
    t.set_curve(10.0, 0.1, vec![2.0, f32::NAN], 0.0);
    all(&render(&mut t, 0, 256), 1.0);
}

// ---------- fill's report ----------

#[test]
fn fill_says_const_whenever_nothing_moves() {
    let mut t = a_rate(0.0);
    t.set_value(300.0, 1.0, 0.0);
    t.linear_ramp(1000.0, 1.0, 0.0);   // from 1 to 1: flat
    let mut block = [0.0; QUANTUM];
    assert_eq!(t.fill(&mut block, 0), Fill::Const(0.0));
    assert_eq!(t.fill(&mut block, 128), Fill::Const(0.0));
    assert_eq!(t.fill(&mut block, 256), Fill::Varying);
    assert_eq!(t.fill(&mut block, 384), Fill::Const(1.0));
    t.linear_ramp(2000.0, 2.0, 512.0);
    assert_eq!(t.fill(&mut block, 1024), Fill::Varying);
}

// ---------- k-rate ----------

#[test]
fn k_rate_takes_the_quantums_first_frame() {
    let mut t = k_rate(0.0);
    t.set_value(100.0, 1.0, 0.0);
    assert_eq!(render_k(&mut t, 3), vec![0.0, 1.0, 1.0]);

    let mut t = k_rate(0.0);
    t.set_value(0.0, 0.0, 0.0);
    t.linear_ramp(1280.0, 1.0, 0.0);
    let v = render_k(&mut t, 12);
    for (q, x) in v.iter().enumerate().take(10) { near(*x, q as f64 / 10.0, 1e-6); }
    assert_eq!(&v[10..], &[1.0, 1.0]);
}

#[test]
fn k_rate_target_steps_once_a_quantum() {
    let mut t = k_rate(1.0);
    t.set_target(0.0, 0.0, 1.28, 0.0);
    for (q, x) in render_k(&mut t, 20).into_iter().enumerate() { near(x, (-0.1 * q as f64).exp(), 1e-6); }
}

// ---------- the reader agrees with the renderer ----------

/// Builds the same automation on a renderer and a reader, renders one, and
/// asks the other about frames along the way. They agree to within Chrome's
/// one-frame lag where one setTarget hands over to the next (the renderer
/// starts the second from the first's value a frame earlier).
#[test]
fn the_reader_reads_what_the_renderer_renders() {
    type Build = fn(&mut Timeline);
    let scenarios: &[(&str, f32, Build)] = &[
        ("linear", 0.0, |t| { t.set_value(10.0, 0.0, 0.0); t.linear_ramp(900.0, 1.0, 0.0); }),
        ("exponential", 0.0, |t| { t.set_value(0.0, 0.01, 0.0); t.exponential_ramp(1000.0, 1.0, 0.0); }),
        ("target", 1.0, |t| t.set_target(40.0, 0.0, 0.2, 0.0)),
        ("target chain", 0.0, |t| { t.set_target(0.0, 1.0, 0.05, 0.0); t.set_target(300.0, 0.2, 0.1, 0.0); }),
        ("curve", 0.5, |t| t.set_curve(100.0, 0.7, vec![0.0, 1.0, 0.25, 0.5], 0.0)),
        ("ramp after target", 0.2, |t| { t.set_target(100.0, 0.0, 0.1, 0.0); t.linear_ramp(1100.0, 1.2, 0.0); }),
        ("hold mid linear", 0.0, |t| { t.set_value(0.0, 0.0, 0.0); t.linear_ramp(1000.0, 1.0, 0.0); t.cancel_and_hold(400.0, 0.0); }),
        ("hold mid exponential", 0.0, |t| { t.set_value(0.0, 0.01, 0.0); t.exponential_ramp(1000.0, 1.0, 0.0); t.cancel_and_hold(500.0, 0.0); }),
        ("hold mid target", 1.0, |t| { t.set_target(0.0, 0.0, 0.1, 0.0); t.cancel_and_hold(200.0, 0.0); }),
        ("ramp after a hold mid target", 0.0, |t| {
            t.set_target(100.0, 1.0, 0.3, 0.0);
            t.cancel_and_hold(500.0, 0.0);
            t.linear_ramp(900.0, 0.2, 0.0);
        }),
        ("hold mid curve", 0.0, |t| { t.set_curve(0.0, 1.0, vec![0.0, 1.0], 0.0); t.cancel_and_hold(250.0, 0.0); }),
        ("triangle", 0.0, |t| { t.set_value(0.0, 0.0, 0.0); t.linear_ramp(100.0, 1.0, 0.0); t.linear_ramp(200.0, 0.0, 0.0); }),
        ("across zero", 0.0, |t| { t.set_value(0.0, -1.0, 0.0); t.exponential_ramp(100.0, 1.0, 0.0); }),
    ];
    for (name, default, build) in scenarios {
        let mut renderer = a_rate(*default);
        let mut reader = Timeline::reader(*default, -BIG, BIG, Rate::A, SR);
        build(&mut renderer);
        build(&mut reader);
        let v = render(&mut renderer, 0, 1536);
        for f in (0..1536).step_by(7) {
            let got = reader.value_at(f as f64);
            let err = (got - v[f]).abs();
            assert!(err <= 2e-4 * v[f].abs().max(1.0), "{name}: frame {f}: reader {got}, renderer {}", v[f]);
        }
    }
}

#[test]
fn the_reader_lets_go_of_the_past_even_unread() {
    // Ten automation calls a second for an hour on a param never read,
    // while the shadow's present moves on with reads elsewhere.
    let mut t = Timeline::reader(0.0, -BIG, BIG, Rate::A, SR);
    for k in 0..36_000u32 {
        let now = k as f64 * 100.0;
        t.set_target(now, (k % 7) as f32, 0.05, now);
        t.set_value(now + 300.0, 1.0, now);
    }
    assert!(t.pending() <= 8, "{} events kept", t.pending());
}
