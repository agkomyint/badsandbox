//! 2D geometry helpers. Units are centimetres, y points up.

use serde::Serialize;
use std::f64::consts::PI;
use std::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Default)]
pub struct V2 {
    pub x: f64,
    pub y: f64,
}

pub const fn v2(x: f64, y: f64) -> V2 {
    V2 { x, y }
}

impl V2 {
    pub fn len(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub fn norm(self) -> V2 {
        let l = self.len();
        if l < 1e-12 {
            V2::default()
        } else {
            v2(self.x / l, self.y / l)
        }
    }
    pub fn dot(self, o: V2) -> f64 {
        self.x * o.x + self.y * o.y
    }
    pub fn cross(self, o: V2) -> f64 {
        self.x * o.y - self.y * o.x
    }
    /// Rotate 90 degrees counter-clockwise.
    pub fn perp(self) -> V2 {
        v2(-self.y, self.x)
    }
    pub fn lerp(self, o: V2, t: f64) -> V2 {
        self + (o - self) * t
    }
}

impl Add for V2 {
    type Output = V2;
    fn add(self, o: V2) -> V2 {
        v2(self.x + o.x, self.y + o.y)
    }
}
impl Sub for V2 {
    type Output = V2;
    fn sub(self, o: V2) -> V2 {
        v2(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for V2 {
    type Output = V2;
    fn mul(self, s: f64) -> V2 {
        v2(self.x * s, self.y * s)
    }
}
impl Neg for V2 {
    type Output = V2;
    fn neg(self) -> V2 {
        v2(-self.x, -self.y)
    }
}

pub fn polyline_length(p: &[V2]) -> f64 {
    p.windows(2).map(|w| (w[1] - w[0]).len()).sum()
}

/// Point and unit tangent at arc length `s` along an open polyline.
pub fn point_at(p: &[V2], s: f64) -> (V2, V2) {
    let mut acc = 0.0;
    for w in p.windows(2) {
        let l = (w[1] - w[0]).len();
        if l < 1e-12 {
            continue;
        }
        if acc + l >= s {
            let t = ((s - acc) / l).clamp(0.0, 1.0);
            return (w[0].lerp(w[1], t), (w[1] - w[0]).norm());
        }
        acc += l;
    }
    let n = p.len();
    (p[n - 1], (p[n - 1] - p[n - 2]).norm())
}

/// `n` points spaced evenly by arc length along an open polyline.
pub fn resample(p: &[V2], n: usize) -> Vec<V2> {
    let l = polyline_length(p);
    (0..n)
        .map(|i| point_at(p, l * i as f64 / (n - 1) as f64).0)
        .collect()
}

/// Insert points so no segment is longer than `step`.
pub fn densify(p: &[V2], step: f64) -> Vec<V2> {
    let mut out = vec![p[0]];
    for w in p.windows(2) {
        let n = ((w[1] - w[0]).len() / step).ceil().max(1.0) as usize;
        for i in 1..=n {
            out.push(w[0].lerp(w[1], i as f64 / n as f64));
        }
    }
    out
}

pub fn dedupe(p: Vec<V2>) -> Vec<V2> {
    let mut out: Vec<V2> = Vec::with_capacity(p.len());
    for q in p {
        if out.last().map_or(true, |l| (*l - q).len() > 1e-6) {
            out.push(q);
        }
    }
    out
}

/// Round the corner at `b` (between `a` and `c`) with radius `r`.
/// Returns the arc points from the tangent point on BA to the tangent point on BC.
pub fn fillet(a: V2, b: V2, c: V2, r: f64, segs: usize) -> Vec<V2> {
    let u1 = (a - b).norm();
    let u2 = (c - b).norm();
    let ang = u1.dot(u2).clamp(-1.0, 1.0).acos();
    if r <= 1e-9 || ang > PI - 1e-6 || ang < 1e-6 {
        return vec![b];
    }
    let half = ang / 2.0;
    let t = (r / half.tan())
        .min((a - b).len() * 0.499)
        .min((c - b).len() * 0.499);
    let r = t * half.tan();
    let p1 = b + u1 * t;
    let p2 = b + u2 * t;
    let center = b + (u1 + u2).norm() * (r / half.sin());
    let a1 = (p1.y - center.y).atan2(p1.x - center.x);
    let a2 = (p2.y - center.y).atan2(p2.x - center.x);
    let mut d = a2 - a1;
    while d > PI {
        d -= 2.0 * PI;
    }
    while d < -PI {
        d += 2.0 * PI;
    }
    (0..=segs)
        .map(|i| {
            let a = a1 + d * i as f64 / segs as f64;
            center + v2(a.cos(), a.sin()) * r
        })
        .collect()
}

/// Signed area (positive = counter-clockwise).
pub fn area(p: &[V2]) -> f64 {
    let n = p.len();
    (0..n).map(|i| p[i].cross(p[(i + 1) % n])).sum::<f64>() / 2.0
}

pub fn centroid(p: &[V2]) -> V2 {
    let a = area(p);
    let n = p.len();
    if a.abs() < 1e-9 {
        let s = p.iter().fold(V2::default(), |acc, q| acc + *q);
        return s * (1.0 / n as f64);
    }
    let mut c = V2::default();
    for i in 0..n {
        let (p0, p1) = (p[i], p[(i + 1) % n]);
        let k = p0.cross(p1);
        c = c + (p0 + p1) * k;
    }
    c * (1.0 / (6.0 * a))
}

/// Distance from `c` along unit `dir` to the boundary of closed polygon `poly`.
pub fn ray_to_boundary(poly: &[V2], c: V2, dir: V2) -> f64 {
    let n = poly.len();
    let mut best = f64::INFINITY;
    for i in 0..n {
        let a = poly[i];
        let e = poly[(i + 1) % n] - a;
        let den = dir.cross(e);
        if den.abs() < 1e-12 {
            continue;
        }
        let t = (a - c).cross(e) / den;
        let u = (a - c).cross(dir) / den;
        if t >= 0.0 && (-1e-9..=1.0 + 1e-9).contains(&u) {
            best = best.min(t);
        }
    }
    best
}

/// Offset a closed CCW polygon outward. `d[i]` is the distance for edge `p[i] -> p[i+1]`.
pub fn offset_polygon(p: &[V2], d: &[f64]) -> Vec<V2> {
    let n = p.len();
    let mut out = Vec::with_capacity(n + 4);
    for i in 0..n {
        let j = (i + n - 1) % n;
        let e1 = (p[i] - p[j]).norm();
        let e2 = (p[(i + 1) % n] - p[i]).norm();
        let n1 = v2(e1.y, -e1.x);
        let n2 = v2(e2.y, -e2.x);
        let q1 = p[i] + n1 * d[j];
        let q2 = p[i] + n2 * d[i];
        let c = e1.cross(e2);
        if c.abs() < 1e-9 {
            out.push(q1);
            if (q1 - q2).len() > 1e-9 {
                out.push(q2);
            }
            continue;
        }
        let t = (q2 - q1).cross(e2) / c;
        let x = q1 + e1 * t;
        let lim = 4.0 * d[j].max(d[i]).max(1e-9);
        if (x - p[i]).len() > lim {
            out.push(q1);
            out.push(q2);
        } else {
            out.push(x);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_square() {
        let sq = vec![v2(0., 0.), v2(10., 0.), v2(10., 10.), v2(0., 10.)];
        let o = offset_polygon(&sq, &[1.0; 4]);
        assert!((area(&o) - 144.0).abs() < 1e-9);
    }

    #[test]
    fn fillet_quarter() {
        let pts = fillet(v2(0., 10.), v2(0., 0.), v2(10., 0.), 2.0, 16);
        let l = polyline_length(&pts);
        assert!((l - PI).abs() < 0.01, "{l}");
    }
}
