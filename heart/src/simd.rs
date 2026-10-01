//! The inner loops, four samples at a time. Each helper walks its slices in
//! lanes of four through a tiny `Lanes` type, then finishes any remainder
//! one sample at a time. On wasm built with simd128, `Lanes` is a v128 and
//! every lane step is one instruction; everywhere else it is a plain
//! `[f32; 4]` doing the same steps in the same order. That twin is what the
//! native tests run against straightforward scalar loops, so the lane logic
//! (the strides, the remainders, the order a sum is taken in) is proven on
//! the machine the tests run on, and the wasm build only swaps the four
//! arithmetic primitives underneath it.
//!
//! The helpers take slices of any equal length; the graph's are always a
//! quantum, so in practice the remainder is never used.

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod lanes {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct Lanes(v128);

    impl Lanes {
        #[inline(always)]
        pub fn load(s: &[f32; 4]) -> Lanes {
            // SAFETY: the array is four floats, sixteen bytes; v128.load
            // takes any alignment.
            Lanes(unsafe { v128_load(s.as_ptr() as *const v128) })
        }
        #[inline(always)]
        pub fn store(self, d: &mut [f32; 4]) {
            // SAFETY: as in load.
            unsafe { v128_store(d.as_mut_ptr() as *mut v128, self.0) }
        }
        #[inline(always)]
        pub fn splat(x: f32) -> Lanes { Lanes(f32x4_splat(x)) }
        #[inline(always)]
        pub fn add(self, o: Lanes) -> Lanes { Lanes(f32x4_add(self.0, o.0)) }
        #[inline(always)]
        pub fn mul(self, o: Lanes) -> Lanes { Lanes(f32x4_mul(self.0, o.0)) }
        #[inline(always)]
        pub fn abs(self) -> Lanes { Lanes(f32x4_abs(self.0)) }
        #[inline(always)]
        pub fn max(self, o: Lanes) -> Lanes { Lanes(f32x4_pmax(self.0, o.0)) }
        #[inline(always)]
        pub fn lanes(self) -> [f32; 4] {
            [f32x4_extract_lane::<0>(self.0), f32x4_extract_lane::<1>(self.0),
             f32x4_extract_lane::<2>(self.0), f32x4_extract_lane::<3>(self.0)]
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod lanes {
    #[derive(Clone, Copy)]
    pub struct Lanes([f32; 4]);

    impl Lanes {
        #[inline(always)]
        pub fn load(s: &[f32; 4]) -> Lanes { Lanes(*s) }
        #[inline(always)]
        pub fn store(self, d: &mut [f32; 4]) { *d = self.0 }
        #[inline(always)]
        pub fn splat(x: f32) -> Lanes { Lanes([x; 4]) }
        #[inline(always)]
        pub fn add(self, o: Lanes) -> Lanes { Lanes(std::array::from_fn(|i| self.0[i] + o.0[i])) }
        #[inline(always)]
        pub fn mul(self, o: Lanes) -> Lanes { Lanes(std::array::from_fn(|i| self.0[i] * o.0[i])) }
        #[inline(always)]
        pub fn abs(self) -> Lanes { Lanes(self.0.map(f32::abs)) }
        /// f32x4.pmax's rule, `if a < b { b } else { a }`, so NaN behaves alike.
        #[inline(always)]
        pub fn max(self, o: Lanes) -> Lanes {
            Lanes(std::array::from_fn(|i| if self.0[i] < o.0[i] { o.0[i] } else { self.0[i] }))
        }
        #[inline(always)]
        pub fn lanes(self) -> [f32; 4] { self.0 }
    }
}

use lanes::Lanes;

/// Runs `step` over matching lanes of `dst` and `src`, then `tail` over the
/// last few samples, those past the last whole lane.
#[inline(always)]
fn zip4(dst: &mut [f32], src: &[f32], step: impl Fn(Lanes, Lanes) -> Lanes, tail: impl Fn(f32, f32) -> f32) {
    let n = dst.len().min(src.len());
    let (dst, dst_rest) = dst[..n].as_chunks_mut::<4>();
    let (src, src_rest) = src[..n].as_chunks::<4>();
    for (d, s) in dst.iter_mut().zip(src) { step(Lanes::load(d), Lanes::load(s)).store(d); }
    for (d, s) in dst_rest.iter_mut().zip(src_rest) { *d = tail(*d, *s); }
}

/// dst += src
#[inline]
pub fn add_into(dst: &mut [f32], src: &[f32]) {
    zip4(dst, src, |d, s| d.add(s), |d, s| d + s);
}

/// dst *= src
#[inline]
pub fn mul_into(dst: &mut [f32], src: &[f32]) {
    zip4(dst, src, |d, s| d.mul(s), |d, s| d * s);
}

/// dst += src · k
#[inline]
pub fn mul_add(dst: &mut [f32], src: &[f32], k: f32) {
    let kk = Lanes::splat(k);
    zip4(dst, src, |d, s| d.add(s.mul(kk)), |d, s| d + s * k);
}

/// dst = src · k
#[inline]
pub fn scale_from(dst: &mut [f32], src: &[f32], k: f32) {
    let kk = Lanes::splat(k);
    zip4(dst, src, |_, s| s.mul(kk), |_, s| s * k);
}

/// dst *= k
#[inline]
pub fn scale(dst: &mut [f32], k: f32) {
    let kk = Lanes::splat(k);
    let (lanes, rest) = dst.as_chunks_mut::<4>();
    for d in lanes { Lanes::load(d).mul(kk).store(d); }
    for d in rest { *d *= k; }
}

/// dst = src
#[inline]
pub fn copy(dst: &mut [f32], src: &[f32]) {
    let n = dst.len().min(src.len());
    dst[..n].copy_from_slice(&src[..n]);
}

/// Σ x², summed in four running lanes and then across them (so the order of
/// the additions is the same on both builds).
#[inline]
pub fn sum_squares(src: &[f32]) -> f32 {
    let (lanes, rest) = src.as_chunks::<4>();
    let mut acc = Lanes::splat(0.0);
    for s in lanes {
        let v = Lanes::load(s);
        acc = acc.add(v.mul(v));
    }
    let [a, b, c, d] = acc.lanes();
    rest.iter().fold((a + b) + (c + d), |sum, x| sum + x * x)
}

/// max |x|, 0 for an empty slice.
#[inline]
pub fn max_abs(src: &[f32]) -> f32 {
    let (lanes, rest) = src.as_chunks::<4>();
    let mut acc = Lanes::splat(0.0);
    for s in lanes { acc = acc.max(Lanes::load(s).abs()); }
    let [a, b, c, d] = acc.lanes();
    rest.iter().fold(a.max(b).max(c.max(d)), |m, x| m.max(x.abs()))
}
