//! Every node type Heart can make, and the one place that makes them. Each
//! module holds one node type, written against node.rs and the Web Audio
//! spec; the ports between stages (egress, ingress, master) are the graph's
//! own and live in graph.rs.
//!
//! This file is a fixed contract shared by every Heart agent (see
//! documents/heart-audio-engine.md). Each node module exports a struct of the
//! name below with `pub fn new(init: &NodeInit) -> Self`.

use crate::node::{Kind, Node, NodeInit};

pub mod gain;
pub mod constant_source;
pub mod stereo_panner;
pub mod delay;
pub mod biquad;
pub mod oscillator;
pub mod periodic_wave;
pub mod buffer_source;
pub mod analyser;
pub mod convolver;
pub mod fdn;
pub mod one_pole;
pub mod strobe_signal;
pub mod genus;

/// A new node of `kind`, or None for the graph's own port kinds (which
/// graph.rs makes) and anything unknown.
pub fn make(kind: Kind, init: &NodeInit) -> Option<Box<dyn Node>> {
    Some(match kind {
        Kind::Gain => Box::new(gain::Gain::new(init)),
        Kind::ConstantSource => Box::new(constant_source::ConstantSource::new(init)),
        Kind::StereoPanner => Box::new(stereo_panner::StereoPanner::new(init)),
        Kind::Delay => Box::new(delay::Delay::new(init)),
        Kind::Biquad => Box::new(biquad::Biquad::new(init)),
        Kind::Oscillator => Box::new(oscillator::Oscillator::new(init)),
        Kind::BufferSource => Box::new(buffer_source::BufferSource::new(init)),
        Kind::Analyser => Box::new(analyser::Analyser::new(init)),
        Kind::Convolver => Box::new(convolver::Convolver::new(init)),
        Kind::Fdn => Box::new(fdn::Fdn::new(init)),
        Kind::OnePole => Box::new(one_pole::OnePole::new(init)),
        Kind::StrobeSignal => Box::new(strobe_signal::StrobeSignal::new(init)),
        Kind::Genus => Box::new(genus::Genus::new(init)),
        Kind::Egress | Kind::Ingress | Kind::Master => return None,
    })
}
