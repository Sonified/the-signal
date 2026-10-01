//! Where the Rust core meets the node files: every node declares the params
//! the protocol table says it has (the page builds its params from that
//! table, the shadow keeps them, the stage renders the node's own list), in
//! the same order, with the same defaults and rates, and the same bounds
//! wherever the table gives a number.

use heart::node::{Kind, NodeInit};
use heart::nodes;
use heart::protocol_gen::{Bound, kind, params};

#[test]
fn node_params_match_the_protocol() {
    let init = NodeInit { sample_rate: 48000.0, seed: 1, opts: [0.0; 8] };
    for k in kind::GAIN..=kind::GENUS {
        let node = nodes::make(Kind::from_u32(k).expect("a kind"), &init).expect("a node");
        let (specs, rows) = (node.param_specs(), params(k));
        assert_eq!(specs.len(), rows.len(), "kind {k}: param count");
        for (s, r) in specs.iter().zip(rows) {
            let at = format!("kind {k}, {}", r.name);
            assert_eq!(s.name, r.name, "{at}: name");
            assert_eq!(s.default, r.default, "{at}: default");
            assert_eq!(s.rate, r.rate, "{at}: rate");
            if let Bound::Value(v) = r.min { assert_eq!(s.min, v, "{at}: min"); }
            if let Bound::Value(v) = r.max { assert_eq!(s.max, v, "{at}: max"); }
        }
    }
}

#[test]
fn port_kinds_are_the_graphs_own() {
    let init = NodeInit { sample_rate: 48000.0, seed: 1, opts: [0.0; 8] };
    for k in [Kind::Egress, Kind::Ingress, Kind::Master] { assert!(nodes::make(k, &init).is_none()); }
    assert_eq!(Kind::from_u32(kind::MASTER), Some(Kind::Master));
}
