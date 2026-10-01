//! The one source of randomness inside the DSP: xoshiro128**, seeded per
//! node from heart_init's seed, so a null test can seed both sides alike.

#[derive(Clone)]
pub struct Rng { s: [u32; 4] }

/// splitmix32's finaliser: one u32 spread evenly over all 32 bits.
fn mix(mut x: u32) -> u32 {
    x = (x ^ (x >> 16)).wrapping_mul(0x85eb_ca6b);
    x = (x ^ (x >> 13)).wrapping_mul(0xc2b2_ae35);
    x ^ (x >> 16)
}

/// A node's own seed: the stage's seed and the node's id, mixed so that
/// neighbouring ids get unrelated streams. It depends on nothing else, so a
/// node seeded on one instance plays the same random choices on any other
/// given the same stage seed (the null tests rely on this).
pub fn node_seed(stage_seed: u32, node: u32) -> u32 {
    mix(stage_seed ^ mix(node.wrapping_add(0x9e37_79b9)))
}

impl Rng {
    /// splitmix32 spreads one seed over the four words, never all zero.
    pub fn new(seed: u32) -> Rng {
        let mut z = seed.wrapping_add(0x9e37_79b9);
        let mut s = [0u32; 4];
        for w in s.iter_mut() {
            z = z.wrapping_add(0x9e37_79b9);
            *w = mix(z);
        }
        if s == [0; 4] { s[0] = 1; }
        Rng { s }
    }
    pub fn next_u32(&mut self) -> u32 {
        let r = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 9;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(11);
        r
    }
    /// Uniform in [0, 1), as Math.random.
    pub fn next_f64(&mut self) -> f64 { (self.next_u32() >> 8) as f64 / (1u32 << 24) as f64 }
}
