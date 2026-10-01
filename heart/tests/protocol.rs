//! The wire: records laid out as protocol.json says, decoded into commands,
//! bad bytes refused without a panic, and a whole stage driven through
//! bytes alone, as JS drives it.

use heart::Engine;
use heart::protocol::for_each_command;
use heart::protocol_gen::{Command, kind, op};

/// A field as the protocol lays it out.
enum F<'a> { U(u32), S(f32), D(f64), Opts([f64; 8]), Floats(&'a [f32]), Bytes(&'a [u8]) }

/// Appends one record: head, fields, and the length filled in.
fn rec(batch: &mut Vec<u8>, op: u16, node: u32, fields: &[F]) {
    let start = batch.len();
    batch.extend_from_slice(&op.to_le_bytes());
    batch.extend_from_slice(&[0, 0]);
    batch.extend_from_slice(&node.to_le_bytes());
    for f in fields {
        match f {
            F::U(v) => batch.extend_from_slice(&v.to_le_bytes()),
            F::S(v) => batch.extend_from_slice(&v.to_le_bytes()),
            F::D(v) => batch.extend_from_slice(&v.to_le_bytes()),
            F::Opts(o) => for v in o { batch.extend_from_slice(&v.to_le_bytes()) },
            F::Floats(vs) => {
                batch.extend_from_slice(&(vs.len() as u32).to_le_bytes());
                for v in *vs { batch.extend_from_slice(&v.to_le_bytes()); }
            }
            F::Bytes(b) => {
                batch.extend_from_slice(&(b.len() as u32).to_le_bytes());
                batch.extend_from_slice(b);
                batch.resize(batch.len() + (4 - b.len() % 4) % 4, 0);
            }
        }
    }
    let len = (batch.len() - start) as u16;
    batch[start + 2..start + 4].copy_from_slice(&len.to_le_bytes());
}

fn decode_all(batch: &[u8]) -> (Vec<(u32, String)>, u32) {
    let mut out = Vec::new();
    let rejected = for_each_command(batch, |node, c| out.push((node, format!("{c:?}"))));
    (out, rejected)
}

#[test]
fn every_command_decodes() {
    let mut b = Vec::new();
    let mut opts = [0.0; 8];
    opts[0] = 2.5;
    rec(&mut b, op::CREATE, 1, &[F::U(4), F::U(3), F::Opts(opts)]);
    rec(&mut b, op::DESTROY, 2, &[]);
    rec(&mut b, op::CONNECT, 3, &[F::U(0), F::U(9), F::U(1)]);
    rec(&mut b, op::CONNECT_PARAM, 3, &[F::U(0), F::U(9), F::U(2)]);
    rec(&mut b, op::DISCONNECT_ALL, 3, &[]);
    rec(&mut b, op::DISCONNECT_NODE, 3, &[F::U(9)]);
    rec(&mut b, op::DISCONNECT_OUTPUT, 3, &[F::U(1)]);
    rec(&mut b, op::DISCONNECT_PARAM, 3, &[F::U(9), F::U(2)]);
    rec(&mut b, op::PARAM_SET, 4, &[F::U(0), F::D(128.5), F::S(0.25)]);
    rec(&mut b, op::PARAM_LINEAR, 4, &[F::U(0), F::D(256.0), F::S(1.0)]);
    rec(&mut b, op::PARAM_EXP, 4, &[F::U(0), F::D(512.0), F::S(2.0)]);
    rec(&mut b, op::PARAM_TARGET, 4, &[F::U(1), F::D(64.0), F::S(0.5), F::D(0.03)]);
    rec(&mut b, op::PARAM_CURVE, 4, &[F::U(0), F::D(10.0), F::D(0.5), F::Floats(&[0.0, 1.0, 0.5])]);
    rec(&mut b, op::PARAM_CANCEL, 4, &[F::U(0), F::D(1.0)]);
    rec(&mut b, op::PARAM_CANCEL_HOLD, 4, &[F::U(0), F::D(2.0)]);
    rec(&mut b, op::ATTR, 5, &[F::U(5), F::D(-1.0)]);
    rec(&mut b, op::CHANNELS, 5, &[F::U(1), F::U(1), F::U(0)]);
    rec(&mut b, op::START, 6, &[F::D(100.0), F::D(0.5), F::D(-1.0)]);
    rec(&mut b, op::STOP, 6, &[F::D(200.0)]);
    rec(&mut b, op::MESSAGE, 7, &[F::Bytes(&[1, 2, 3, 4, 5])]);
    rec(&mut b, op::PEAK_REQUEST, 8, &[]);
    let (cmds, rejected) = decode_all(&b);
    assert_eq!(rejected, 0);
    let want = [
        (1, Command::Create { kind: 4, island: 3, opts }),
        (2, Command::Destroy),
        (3, Command::Connect { output: 0, target: 9, input: 1 }),
        (3, Command::ConnectParam { output: 0, target: 9, param: 2 }),
        (3, Command::DisconnectAll),
        (3, Command::DisconnectNode { target: 9 }),
        (3, Command::DisconnectOutput { output: 1 }),
        (3, Command::DisconnectParam { target: 9, param: 2 }),
        (4, Command::ParamSet { param: 0, time: 128.5, value: 0.25 }),
        (4, Command::ParamLinear { param: 0, time: 256.0, value: 1.0 }),
        (4, Command::ParamExp { param: 0, time: 512.0, value: 2.0 }),
        (4, Command::ParamTarget { param: 1, time: 64.0, value: 0.5, tau: 0.03 }),
        (4, Command::ParamCurve { param: 0, time: 10.0, duration: 0.5, values: vec![0.0, 1.0, 0.5] }),
        (4, Command::ParamCancel { param: 0, time: 1.0 }),
        (4, Command::ParamCancelHold { param: 0, time: 2.0 }),
        (5, Command::Attr { attr: 5, value: -1.0 }),
        (5, Command::Channels { count: 1, mode: 1, interpretation: 0 }),
        (6, Command::Start { time: 100.0, offset: 0.5, duration: -1.0 }),
        (6, Command::Stop { time: 200.0 }),
        (7, Command::Message { bytes: &[1, 2, 3, 4, 5] }),
        (8, Command::PeakRequest),
    ];
    let want: Vec<(u32, String)> = want.iter().map(|(n, c)| (*n, format!("{c:?}"))).collect();
    assert_eq!(cmds, want);
}

#[test]
fn bad_records_are_refused_and_the_rest_still_apply() {
    let mut b = Vec::new();
    rec(&mut b, 999, 1, &[F::U(0)]);                       // unknown op: skipped
    rec(&mut b, op::CONNECT, 1, &[F::U(0)]);               // fields cut short: skipped
    rec(&mut b, op::DESTROY, 2, &[]);                      // fine
    let (cmds, rejected) = decode_all(&b);
    assert_eq!((cmds.len(), rejected), (1, 2));

    // A length running past the batch ends it.
    let mut b = Vec::new();
    rec(&mut b, op::DESTROY, 2, &[]);
    rec(&mut b, op::DESTROY, 3, &[]);
    b[10] = 200;
    assert_eq!(decode_all(&b).1, 1);
    // So does one shorter than its own head, and a stray tail of bytes.
    let mut b = vec![2, 0, 4, 0, 0, 0, 0, 0];
    assert_eq!(decode_all(&b).1, 1);
    b = Vec::new();
    rec(&mut b, op::DESTROY, 2, &[]);
    b.extend_from_slice(&[1, 2, 3]);
    assert_eq!(decode_all(&b), (vec![(2, "Destroy".to_string())], 1));
}

#[test]
fn a_stage_driven_through_bytes() {
    let mut e = Engine::new(48000.0, 0, 7).expect("an engine");
    let mut b = Vec::new();
    let opts = [0.0; 8];
    rec(&mut b, op::CREATE, 1, &[F::U(kind::CONSTANT_SOURCE), F::U(1), F::Opts(opts)]);
    rec(&mut b, op::CREATE, 2, &[F::U(kind::GAIN), F::U(1), F::Opts(opts)]);
    rec(&mut b, op::CREATE, 3, &[F::U(kind::MASTER), F::U(0), F::Opts(opts)]);
    rec(&mut b, op::CONNECT, 1, &[F::U(0), F::U(2), F::U(0)]);
    rec(&mut b, op::CONNECT, 2, &[F::U(0), F::U(3), F::U(0)]);
    rec(&mut b, op::PARAM_SET, 2, &[F::U(0), F::D(0.0), F::S(0.25)]);
    rec(&mut b, op::START, 1, &[F::D(0.0), F::D(0.0), F::D(-1.0)]);
    rec(&mut b, op::STOP, 1, &[F::D(384.0)]);
    e.commands(&b);
    assert_eq!(e.render(512), 512);
    let m = e.port(2, 0).expect("the master").to_vec();
    assert!(m[..384].iter().all(|v| *v == 0.25) && m[384..512].iter().all(|v| *v == 0.0));
    assert!(m[512..512 + 384].iter().all(|v| *v == 0.25), "right follows left at the render's frame count");
    // ended, for node 1
    assert_eq!(e.events(), &[101, 0, 8, 0, 1, 0, 0, 0]);
    assert!(e.events().is_empty());
    assert_eq!(e.frame(), 512);
    assert!(e.port(0, 0).is_none() && e.port(7, 0).is_none());
    assert_eq!(e.param_value(2, 0, 0.0), 0.25);
    // nodes 3, rejected 0
    assert_eq!(e.stats()[0], 3);
    e.commands(&[1, 2, 3]);
    assert_eq!(e.stats()[4], 1);
}

#[test]
fn engines_refuse_nonsense() {
    assert!(Engine::new(0.0, 0, 0).is_none());
    assert!(Engine::new(f32::NAN, 0, 0).is_none());
    assert!(Engine::new(48000.0, 4, 0).is_none());
    let mut shadow = Engine::new(48000.0, 3, 0).expect("a shadow");
    assert_eq!(shadow.render(512), 0);
    assert!(shadow.buffer_alloc(1, 2, 16, 48000.0).is_none());
}
