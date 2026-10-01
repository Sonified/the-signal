//! The shadow: param timelines with no audio, answering `value` with the
//! protocol table's defaults and the node's own bounds.

use heart::protocol_gen::{Command, kind};
use heart::shadow::Shadow;

const SR: f32 = 48000.0;

fn create(s: &mut Shadow, id: u32, kind: u32, first_opt: f64) {
    let mut opts = [0.0; 8];
    opts[0] = first_opt;
    s.apply(id, Command::Create { kind, island: 0, opts });
}

#[test]
fn defaults_then_automation() {
    let mut s = Shadow::new(SR);
    create(&mut s, 1, kind::GAIN, 0.0);
    assert_eq!(s.value(1, 0, 0.0), 1.0);
    s.apply(1, Command::ParamSet { param: 0, time: 100.0, value: 0.0 });
    s.apply(1, Command::ParamLinear { param: 0, time: 200.0, value: 1.0 });
    assert_eq!(s.value(1, 0, 50.0), 1.0);
    assert_eq!(s.value(1, 0, 150.0), 0.5);
    assert_eq!(s.value(1, 0, 1000.0), 1.0);
}

#[test]
fn bounds_that_depend_on_the_context_or_the_node() {
    let mut s = Shadow::new(SR);
    // A biquad's frequency stops at Nyquist.
    create(&mut s, 1, kind::BIQUAD, 0.0);
    assert_eq!(s.value(1, 0, 0.0), 350.0);
    s.apply(1, Command::ParamSet { param: 0, time: 0.0, value: 30000.0 });
    assert_eq!(s.value(1, 0, 1.0), 24000.0);
    // A delay's time stops at its maxDelayTime, which defaults to 1 s.
    create(&mut s, 2, kind::DELAY, 2.0);
    create(&mut s, 3, kind::DELAY, 0.0);
    for id in [2, 3] { s.apply(id, Command::ParamSet { param: 0, time: 0.0, value: 5.0 }); }
    assert_eq!(s.value(2, 0, 1.0), 2.0);
    assert_eq!(s.value(3, 0, 1.0), 1.0);
    // An oscillator's frequency is bounded both ways.
    create(&mut s, 4, kind::OSCILLATOR, 0.0);
    s.apply(4, Command::ParamSet { param: 0, time: 0.0, value: -1e9 });
    assert_eq!(s.value(4, 0, 1.0), -24000.0);
}

#[test]
fn its_present_is_the_latest_frame_asked_about() {
    let mut s = Shadow::new(SR);
    create(&mut s, 1, kind::GAIN, 0.0);
    assert_eq!(s.value(1, 0, 1000.0), 1.0);
    // An event set before then moves up to it.
    s.apply(1, Command::ParamSet { param: 0, time: 500.0, value: 0.5 });
    assert_eq!(s.value(1, 0, 1000.0), 0.5);
    s.apply(1, Command::ParamTarget { param: 0, time: 0.0, value: 0.0, tau: 0.01 });
    let want = 0.5 * (-480.0f64 / 480.0).exp();
    assert!((s.value(1, 0, 1480.0) as f64 - want).abs() < 1e-6);
}

#[test]
fn what_it_does_not_know_is_nan() {
    let mut s = Shadow::new(SR);
    assert!(s.value(9, 0, 0.0).is_nan());
    create(&mut s, 1, kind::GAIN, 0.0);
    assert!(s.value(1, 1, 0.0).is_nan());
    s.apply(1, Command::Destroy);
    assert!(s.value(1, 0, 0.0).is_nan());
    s.apply(1, Command::ParamSet { param: 0, time: 0.0, value: 1.0 });
    assert_eq!(s.rejected, 1);
    assert_eq!(s.nodes(), 0);
}

#[test]
fn a_ramp_with_nothing_before_it_starts_at_the_call() {
    // A param nobody has read since frame 0 is ramped at frame 48000. Told
    // the present first, the shadow starts the ramp there, from the value it
    // holds, as Chrome does; untold, it would have started it back at 0.
    let mut s = Shadow::new(SR);
    create(&mut s, 1, kind::GAIN, 0.0);
    assert_eq!(s.value(1, 0, 0.0), 1.0);
    s.advance(48000.0);
    s.apply(1, Command::ParamLinear { param: 0, time: 96000.0, value: 0.0 });
    assert_eq!(s.value(1, 0, 72000.0), 0.5);
}
