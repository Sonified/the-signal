//! Events going back to JS (protocol.json "events"), as wire records: u16 op,
//! u16 byteLength, u32 node, then the fields.
//!
//! Nodes and the graph append to one buffer while they run. `hand_over`
//! gives JS everything appended since the last hand-over and keeps it, in a
//! second buffer, untouched until the next call, so the bytes JS was pointed
//! at stay put while it copies them out (heart_events, spec 5). The two
//! buffers swap roles each time and keep their capacity, so a running stage
//! allocates nothing for its events.

use crate::protocol_gen::event;

#[derive(Default)]
pub struct Events {
    bytes: Vec<u8>,
    handed: Vec<u8>,
}

impl Events {
    fn head(&mut self, op: u16, len: usize, node: u32) {
        self.bytes.extend_from_slice(&op.to_le_bytes());
        self.bytes.extend_from_slice(&(len as u16).to_le_bytes());
        self.bytes.extend_from_slice(&node.to_le_bytes());
    }

    /// A source has played to its end.
    pub fn ended(&mut self, node: u32) { self.head(event::ENDED, 8, node); }

    /// An analyser's answer to peak_request.
    pub fn peak(&mut self, node: u32, value: f32) {
        self.head(event::PEAK, 12, node);
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    /// A processor's port message, in its own encoding. A record's length is
    /// a u16, so a payload that cannot fit one is not sent at all rather than
    /// sent with a length that lies.
    pub fn port(&mut self, node: u32, payload: &[u8]) {
        let pad = (4 - payload.len() % 4) % 4;
        let len = 12 + payload.len() + pad;
        if len > u16::MAX as usize { return; }
        self.head(event::PORT, len, node);
        self.bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        self.bytes.extend_from_slice(payload);
        self.bytes.extend(std::iter::repeat_n(0u8, pad));
    }

    /// Something the page should hear about (protocol.json enums.log_code),
    /// which JS says in the console.
    pub fn log(&mut self, node: u32, code: u32, value: u32) {
        self.head(event::LOG, 16, node);
        self.bytes.extend_from_slice(&code.to_le_bytes());
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    /// Everything appended since the last hand-over. It stays valid, and
    /// unchanged, until the next one.
    pub fn hand_over(&mut self) -> &[u8] {
        std::mem::swap(&mut self.bytes, &mut self.handed);
        self.bytes.clear();
        &self.handed
    }

    /// The events not yet handed over (the node tests read them here).
    pub fn pending(&self) -> &[u8] { &self.bytes }
}
