//! The small modules: the four-lane helpers against plain loops, the mixing
//! rules, the event buffer's hand-over, the sample buffers, and the seeds.

use heart::buffers::BufferPool;
use heart::events::Events;
use heart::mixing::mix_into;
use heart::node::Bus;
use heart::rng::{Rng, node_seed};
use heart::simd;

/// Every length up to a few lanes past a quantum's worth of remainders.
fn cases() -> impl Iterator<Item = (Vec<f32>, Vec<f32>)> {
    let mut rng = Rng::new(42);
    let mut v = move |n: usize| (0..n).map(|_| rng.next_f64() as f32 * 2.0 - 1.0).collect::<Vec<f32>>();
    (0..40).chain([128, 131]).map(move |n| (v(n), v(n)))
}

#[test]
fn lanes_match_plain_loops() {
    for (a, b) in cases() {
        let n = a.len();
        let run = |f: &dyn Fn(&mut [f32])| { let mut d = a.clone(); f(&mut d); d };
        assert_eq!(run(&|d| simd::add_into(d, &b)), (0..n).map(|i| a[i] + b[i]).collect::<Vec<_>>());
        assert_eq!(run(&|d| simd::mul_into(d, &b)), (0..n).map(|i| a[i] * b[i]).collect::<Vec<_>>());
        assert_eq!(run(&|d| simd::mul_add(d, &b, 0.3)), (0..n).map(|i| a[i] + b[i] * 0.3).collect::<Vec<_>>());
        assert_eq!(run(&|d| simd::scale(d, -1.5)), (0..n).map(|i| a[i] * -1.5).collect::<Vec<_>>());
        assert_eq!(run(&|d| simd::scale_from(d, &b, 0.5)), (0..n).map(|i| b[i] * 0.5).collect::<Vec<_>>());
        assert_eq!(run(&|d| simd::copy(d, &b)), b);
        let max = a.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert_eq!(simd::max_abs(&a), max);
        let sum: f64 = a.iter().map(|x| (*x as f64) * (*x as f64)).sum();
        assert!((simd::sum_squares(&a) as f64 - sum).abs() <= 1e-5 * sum.max(1.0), "n = {n}");
    }
}

fn bus(channels: &[f32]) -> Bus {
    let mut b = Bus::new(channels.len());
    for (c, v) in channels.iter().enumerate() { b.data[c] = [*v; 128]; }
    b.silent = false;
    b
}

#[test]
fn speakers_up_and_down() {
    // mono → stereo copies; stereo → mono is ½(L + R); the second adds.
    let mut d = Bus::new(2);
    mix_into(&mut d, &bus(&[0.5]), true);
    assert_eq!((d.data[0][7], d.data[1][7], d.silent), (0.5, 0.5, false));
    mix_into(&mut d, &bus(&[0.1, 0.3]), true);
    assert_eq!((d.data[0][7], d.data[1][7]), (0.6, 0.8));
    let mut d = Bus::new(1);
    mix_into(&mut d, &bus(&[1.0, 0.0]), true);
    mix_into(&mut d, &bus(&[0.25, 0.75]), true);
    assert_eq!(d.data[0][100], 1.0);
}

#[test]
fn discrete_and_silence() {
    let mut d = Bus::new(2);
    d.data[1] = [9.0; 128];
    mix_into(&mut d, &bus(&[0.5]), false);
    assert_eq!((d.data[0][0], d.data[1][0]), (0.5, 0.0), "discrete leaves the rest silent");
    let mut d = Bus::new(1);
    mix_into(&mut d, &bus(&[0.5, 0.7]), false);
    assert_eq!(d.data[0][0], 0.5, "and drops what does not fit");
    let mut d = Bus::new(2);
    mix_into(&mut d, &Bus::new(2), true);
    assert!(d.silent, "a silent source adds nothing");
}

#[test]
fn events_stay_put_until_the_next_hand_over() {
    let mut e = Events::default();
    e.ended(3);
    e.peak(4, 0.5);
    e.port(5, &[1, 2, 3]);
    let first = e.hand_over().to_vec();
    assert_eq!(first.len(), 8 + 12 + 16);
    assert_eq!(&first[20..], &[103, 0, 16, 0, 5, 0, 0, 0, 3, 0, 0, 0, 1, 2, 3, 0]);
    e.ended(6);
    assert_eq!(e.hand_over(), &[101, 0, 8, 0, 6, 0, 0, 0]);
    assert!(e.hand_over().is_empty());
    // A payload too long for a record's u16 length is not sent at all.
    e.port(1, &vec![0; 70_000]);
    assert!(e.hand_over().is_empty());
}

#[test]
fn buffers_stage_commit_hold_and_free() {
    let mut pool = BufferPool::default();
    assert!(pool.stage(1, 0, 10, 48000.0).is_none());
    assert!(pool.stage(1, 2, 3, 0.0).is_none());
    pool.stage(2, 2, 3, 44100.0).expect("room").copy_from_slice(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    assert!(pool.get(2).is_none(), "nothing until the commit");
    pool.commit();
    let b = pool.get(2).expect("committed");
    assert_eq!((b.sample_rate, b.frames()), (44100.0, 3));
    assert_eq!(b.channels, vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]]);
    pool.hold(2);
    pool.hold(2);
    pool.free(2);
    pool.release(2);
    assert!(pool.get(2).is_some());
    pool.release(2);
    assert!(pool.get(2).is_none());
    // Freed with no holder: gone at once, staged or not.
    pool.stage(3, 1, 1, 48000.0);
    pool.free(3);
    assert!(pool.get(3).is_none());
}

#[test]
fn seeds_are_per_node_and_repeatable() {
    assert_eq!(node_seed(7, 12), node_seed(7, 12));
    assert_ne!(node_seed(7, 12), node_seed(7, 13));
    assert_ne!(node_seed(7, 12), node_seed(8, 12));
    let (mut a, mut b) = (Rng::new(node_seed(1, 2)), Rng::new(node_seed(1, 2)));
    for _ in 0..100 { assert_eq!(a.next_u32(), b.next_u32()); }
    let x = Rng::new(0).next_f64();
    assert!((0.0..1.0).contains(&x));
}
