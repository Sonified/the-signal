//! Command batches off the wire. A batch is records laid end to end, each
//! `u16 op, u16 byteLength, u32 node`, then its fields (protocol.json); the
//! generated `protocol_gen::decode` knows every op's fields, and this file
//! knows how to walk a batch and read a field.
//!
//! Nothing here trusts the bytes. A record that runs past the end of the
//! batch, or claims to be shorter than its own head, ends the batch; a
//! record whose op is unknown or whose fields fall short is skipped and
//! counted. Neither ever panics, since a panic would take the whole stage
//! down with it.

use crate::protocol_gen::{Command, decode};

const HEAD: usize = 8;

/// Reads little-endian fields from a record, front to back. Every read
/// returns None once the bytes run out.
pub struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Reader<'a> { Reader { bytes } }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.bytes.split_first_chunk::<N>()?;
        self.bytes = rest;
        Some(*head)
    }

    pub fn u32(&mut self) -> Option<u32> { self.take().map(u32::from_le_bytes) }
    pub fn f32(&mut self) -> Option<f32> { self.take().map(f32::from_le_bytes) }
    pub fn f64(&mut self) -> Option<f64> { self.take().map(f64::from_le_bytes) }

    pub fn f64x8(&mut self) -> Option<[f64; 8]> {
        let mut out = [0.0; 8];
        for v in out.iter_mut() { *v = self.f64()?; }
        Some(out)
    }

    /// An f32[] field: a u32 count, then the values.
    pub fn f32s(&mut self) -> Option<Vec<f32>> {
        let n = self.u32()? as usize;
        let (bytes, rest) = self.bytes.split_at_checked(n.checked_mul(4)?)?;
        self.bytes = rest;
        Some(bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
    }

    /// A u8[] field: a u32 count, then the bytes (the padding after them is
    /// the record's, and is left alone).
    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        let (bytes, rest) = self.bytes.split_at_checked(n)?;
        self.bytes = rest;
        Some(bytes)
    }
}

/// Calls `apply(node, command)` for each record of a batch, strictly in
/// order. Returns how many records could not be decoded.
pub fn for_each_command<'a>(batch: &'a [u8], mut apply: impl FnMut(u32, Command<'a>)) -> u32 {
    let mut rejected = 0;
    let mut at = 0;
    while let Some(head) = batch.get(at..at + HEAD) {
        let op = u16::from_le_bytes([head[0], head[1]]);
        let len = u16::from_le_bytes([head[2], head[3]]) as usize;
        let node = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
        let Some(record) = batch.get(at..at + len).filter(|_| len >= HEAD) else {
            return rejected + 1;
        };
        match decode(op, &record[HEAD..]) {
            Some(command) => apply(node, command),
            None => rejected += 1,
        }
        at += len;
    }
    // A few stray bytes after the last whole record are a record cut short.
    rejected + (at < batch.len()) as u32
}
