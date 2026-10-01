//! Sample data the nodes play (AudioBufferSource) or convolve with
//! (Convolver), by the id JS gave it.
//!
//! Nodes see each buffer as planar channels, one Vec apiece (`get`). JS, on
//! the other side of the wasm boundary, wants one pointer to copy a whole
//! buffer into, channel after channel (heart_buffer_alloc, spec 5). So an
//! upload lands first in a staging block of that shape, and `commit` moves
//! every staged block into the pool, channel by channel, before the next
//! batch of commands or the next render can look for it. A buffer uploaded
//! again under the same id replaces the old one at that commit.
//!
//! JS frees a buffer it has no more use for (a rebuilt reverb's old
//! impulse), but a node may still be holding it. The graph counts the nodes
//! whose `buffer` attribute names each id, and a freed buffer goes only
//! when the last of them lets go.

pub struct AudioData {
    pub sample_rate: f32,
    /// Planar: one Vec per channel, all the same length.
    pub channels: Vec<Vec<f32>>,
}

impl AudioData {
    pub fn frames(&self) -> usize { self.channels.first().map_or(0, |c| c.len()) }
}

#[derive(Default)]
struct Slot {
    data: Option<AudioData>,
    /// Nodes holding this id.
    holds: u32,
    /// JS has freed it; it goes when `holds` reaches 0.
    freed: bool,
}

struct Staged {
    id: u32,
    channels: usize,
    sample_rate: f32,
    data: Vec<f32>,
}

#[derive(Default)]
pub struct BufferPool {
    slots: Vec<Slot>,
    staged: Vec<Staged>,
}

impl BufferPool {
    pub fn get(&self, id: u32) -> Option<&AudioData> {
        self.slots.get(id as usize).and_then(|s| s.data.as_ref())
    }

    fn slot(&mut self, id: u32) -> &mut Slot {
        let i = id as usize;
        if self.slots.len() <= i { self.slots.resize_with(i + 1, Slot::default); }
        &mut self.slots[i]
    }

    pub fn insert(&mut self, id: u32, data: AudioData) {
        let slot = self.slot(id);
        slot.data = Some(data);
        slot.freed = false;
    }

    /// Reserves `channels × frames` zeroed floats, planar, for buffer `id`
    /// and returns them for the caller to fill. None for an empty or
    /// impossible shape.
    pub fn stage(&mut self, id: u32, channels: usize, frames: usize, sample_rate: f32) -> Option<&mut [f32]> {
        let len = channels.checked_mul(frames)?;
        if len == 0 || !(sample_rate > 0.0) { return None; }
        self.staged.push(Staged { id, channels, sample_rate, data: vec![0.0; len] });
        self.staged.last_mut().map(|s| s.data.as_mut_slice())
    }

    /// Moves every staged upload into the pool, in the order they came.
    pub fn commit(&mut self) {
        for s in std::mem::take(&mut self.staged) {
            let frames = s.data.len() / s.channels;
            let channels = s.data.chunks_exact(frames).map(<[f32]>::to_vec).collect();
            self.insert(s.id, AudioData { sample_rate: s.sample_rate, channels });
        }
    }

    /// A node has taken buffer `id` as its own.
    pub fn hold(&mut self, id: u32) { self.slot(id).holds += 1; }

    /// A node has let buffer `id` go (a new buffer, null, or the node freed).
    pub fn release(&mut self, id: u32) {
        let slot = self.slot(id);
        slot.holds = slot.holds.saturating_sub(1);
        if slot.freed && slot.holds == 0 { *slot = Slot::default(); }
    }

    /// JS is done with buffer `id`: it goes now, or when its last holder
    /// lets go.
    pub fn free(&mut self, id: u32) {
        self.commit();
        let slot = self.slot(id);
        if slot.holds == 0 { *slot = Slot::default(); } else { slot.freed = true; }
    }
}
