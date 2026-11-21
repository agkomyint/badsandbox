//! Fabric solver (XPBD, small steps). Particles, distance constraints (stretch +
//! long-range bending that remembers the sewn shape), zipper links, floor friction and
//! self collision. The page builds the particle graph from the 3D mesh and drives the
//! substep loop (so rigid items can push on the cloth in between); positions are read
//! straight out of WASM memory, no copying.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Cloth {
    n: usize,
    x: Vec<f32>,
    p: Vec<f32>,
    v: Vec<f32>,
    w: Vec<f32>,
    x0: Vec<f32>,
    group: Vec<u8>, // 0 = body fabric, 1 = handle
    ci: Vec<u32>,
    rest: Vec<f32>,
    alpha: Vec<f32>,
    bq: Vec<u32>,
    bphi: Vec<f32>,
    balpha: Vec<f32>,
    za: Vec<u32>,
    zb: Vec<u32>,
    zrest: Vec<f32>,
    zx: Vec<f32>,
    zip_open: f32,
    gape: f32,
    gravity: f32,
    damping: f32,
    strap_damping: f32,
    floor: f32,
    slide: f32,
    bend_iters: u32,
    bend_relax: f32,
    self_r: f32,
    grab: i32,
    gt: [f32; 3],
    pairs: Vec<u32>,
    head: Vec<i32>,
    next: Vec<i32>,
}

#[wasm_bindgen]
impl Cloth {
    #[wasm_bindgen(constructor)]
    pub fn new(x0: &[f32]) -> Cloth {
        let n = x0.len() / 3;
        Cloth {
            n,
            x: x0.to_vec(),
            p: x0.to_vec(),
            v: vec![0.0; n * 3],
            w: vec![1.0; n],
            x0: x0.to_vec(),
            group: vec![0; n],
            ci: vec![],
            rest: vec![],
            alpha: vec![],
            bq: vec![],
            bphi: vec![],
            balpha: vec![],
            za: vec![],
            zb: vec![],
            zrest: vec![],
            zx: vec![],
            zip_open: f32::INFINITY,
            gape: 6.0,
            gravity: -981.0,
            damping: 4.0,
            strap_damping: 6.0,
            floor: 0.0,
            slide: 0.2,
            bend_iters: 4,
            bend_relax: 0.5,
            self_r: 0.8,
            grab: -1,
            gt: [0.0; 3],
            pairs: vec![],
            head: vec![-1; 1 << 16],
            next: vec![-1; n],
        }
    }

    pub fn set_constraints(&mut self, pairs: &[u32], rest: &[f32], alpha: &[f32]) {
        self.ci = pairs.to_vec();
        self.rest = rest.to_vec();
        self.alpha = alpha.to_vec();
    }
    /// Dihedral bending: quads (a,b = shared edge, c,d = opposite corners) with per-quad compliance.
    /// The rest angle is read from the rest shape, so a sewn curve is what the fabric returns to.
    pub fn set_bends(&mut self, quads: &[u32], alpha: &[f32]) {
        self.bq = quads.to_vec();
        self.balpha = alpha.to_vec();
        self.bphi = (0..alpha.len())
            .map(|k| {
                let q = [quads[k * 4] as usize, quads[k * 4 + 1] as usize, quads[k * 4 + 2] as usize, quads[k * 4 + 3] as usize];
                dihedral(&self.x0, q).map(|(d, _)| d.clamp(-1.0, 1.0).acos()).unwrap_or(f32::NAN)
            })
            .collect();
    }
    pub fn set_zip(&mut self, a: &[u32], b: &[u32], rest: &[f32], x: &[f32]) {
        self.za = a.to_vec();
        self.zb = b.to_vec();
        self.zrest = rest.to_vec();
        self.zx = x.to_vec();
    }
    pub fn set_groups(&mut self, g: &[u8]) {
        self.group = g.to_vec();
    }
    /// gravity cm/s², damping 1/s (body, handles), floor height, sliding kept per floor contact, self radius, zip gape.
    /// Bend solver: iterations per substep and how much of each correction to apply.
    pub fn set_bend(&mut self, iters: u32, relax: f32) {
        self.bend_iters = iters.max(1);
        self.bend_relax = relax;
    }

    pub fn set_params(&mut self, gravity: f32, damping: f32, strap_damping: f32, floor: f32, slide: f32, self_r: f32, gape: f32) {
        self.gravity = gravity;
        self.damping = damping;
        self.strap_damping = strap_damping;
        self.floor = floor;
        self.slide = slide;
        self.self_r = self_r;
        self.gape = gape;
    }
    pub fn set_floor(&mut self, floor: f32) {
        self.floor = floor;
    }
    pub fn set_zip_open(&mut self, open_from: f32) {
        self.zip_open = open_from;
    }
    pub fn set_w(&mut self, i: usize, w: f32) {
        self.w[i] = w;
    }
    pub fn get_w(&self, i: usize) -> f32 {
        self.w[i]
    }
    /// Hold particle `i` toward `(x,y,z)` (eased); pass -1 to let go.
    pub fn set_grab(&mut self, i: i32, x: f32, y: f32, z: f32) {
        self.grab = i;
        self.gt = [x, y, z];
    }
    /// [bend quads total, usable at rest]
    pub fn bend_stats(&self) -> Vec<u32> {
        vec![self.bphi.len() as u32, self.bphi.iter().filter(|p| !p.is_nan()).count() as u32]
    }
    pub fn count(&self) -> usize {
        self.n
    }
    /// Live view into WASM memory (re-fetch each frame: memory can move when it grows).
    pub fn positions(&self) -> js_sys::Float32Array {
        unsafe { js_sys::Float32Array::view(&self.x) }
    }
    pub fn weights(&self) -> js_sys::Float32Array {
        unsafe { js_sys::Float32Array::view(&self.w) }
    }
    /// [rms speed, max speed] in cm/s.
    pub fn speeds(&self) -> Vec<f32> {
        let (mut s, mut m) = (0.0f32, 0.0f32);
        for i in 0..self.n {
            let q = self.v[i * 3].powi(2) + self.v[i * 3 + 1].powi(2) + self.v[i * 3 + 2].powi(2);
            s += q;
            m = m.max(q);
        }
        vec![(s / self.n.max(1) as f32).sqrt(), m.sqrt()]
    }

    // Substep pieces: the page calls these in order and lets items collide in between.
    pub fn predict(&mut self, dt: f32) {
        for i in 0..self.n {
            let i3 = i * 3;
            self.p[i3] = self.x[i3];
            self.p[i3 + 1] = self.x[i3 + 1];
            self.p[i3 + 2] = self.x[i3 + 2];
            if self.w[i] == 0.0 {
                continue;
            }
            self.v[i3 + 1] += self.gravity * dt;
            self.x[i3] += self.v[i3] * dt;
            self.x[i3 + 1] += self.v[i3 + 1] * dt;
            self.x[i3 + 2] += self.v[i3 + 2] * dt;
        }
        if self.grab >= 0 {
            let g = self.grab as usize * 3;
            for k in 0..3 {
                self.x[g + k] += (self.gt[k] - self.x[g + k]) * 0.35;
            }
        }
    }

    pub fn solve(&mut self, dt: f32) {
        let dt2 = dt * dt;
        let (x, w) = (&mut self.x, &self.w);
        for k in 0..self.rest.len() {
            let a = self.ci[k * 2] as usize;
            let b = self.ci[k * 2 + 1] as usize;
            let ws = w[a] + w[b] + self.alpha[k] / dt2;
            if ws == 0.0 {
                continue;
            }
            let (a3, b3) = (a * 3, b * 3);
            let dx = x[a3] - x[b3];
            let dy = x[a3 + 1] - x[b3 + 1];
            let dz = x[a3 + 2] - x[b3 + 2];
            let len = (dx * dx + dy * dy + dz * dz).sqrt();
            if len < 1e-9 {
                continue;
            }
            let c = (len - self.rest[k]) / (len * ws);
            x[a3] -= dx * c * w[a];
            x[a3 + 1] -= dy * c * w[a];
            x[a3 + 2] -= dz * c * w[a];
            x[b3] += dx * c * w[b];
            x[b3 + 1] += dy * c * w[b];
            x[b3 + 2] += dz * c * w[b];
        }
        for _it in 0..self.bend_iters {
        for k in 0..self.balpha.len() {
            let q = [self.bq[k * 4] as usize, self.bq[k * 4 + 1] as usize, self.bq[k * 4 + 2] as usize, self.bq[k * 4 + 3] as usize];
            if self.bphi[k].is_nan() {
                continue;
            }
            let Some((d, g)) = dihedral(x, q) else { continue };
            let s = (1.0 - d * d).max(1e-6).sqrt();
            let c = d.clamp(-1.0, 1.0).acos() - self.bphi[k];
            let mut den = self.balpha[k] / dt2;
            for i in 0..4 {
                let gi = [g[i][0] / -s, g[i][1] / -s, g[i][2] / -s];
                den += w[q[i]] * (gi[0] * gi[0] + gi[1] * gi[1] + gi[2] * gi[2]);
            }
            if den < 1e-12 {
                continue;
            }
            let lam = -c / den * self.bend_relax;
            for i in 0..4 {
                let wi = w[q[i]] * lam / s;
                x[q[i] * 3] += wi * g[i][0];
                x[q[i] * 3 + 1] += wi * g[i][1];
                x[q[i] * 3 + 2] += wi * g[i][2];
            }
        }
        }
        // Zipper: closed teeth are rigid links; open ones spring apart a little (a real
        // zip top gapes once opened), strongest just behind the slider.
        for k in 0..self.za.len() {
            let a = self.za[k] as usize;
            let b = self.zb[k] as usize;
            let ws = w[a] + w[b];
            if ws == 0.0 {
                continue;
            }
            let (a3, b3) = (a * 3, b * 3);
            let dx = x[a3] - x[b3];
            let dy = x[a3 + 1] - x[b3 + 1];
            let dz = x[a3 + 2] - x[b3 + 2];
            let len = (dx * dx + dy * dy + dz * dz).sqrt();
            if len < 1e-9 {
                continue;
            }
            let zx = self.zx[k];
            let c;
            if zx >= self.zip_open {
                if zx > 1e8 {
                    continue;
                }
                let gape = self.zrest[k] + self.gape * ((zx - self.zip_open) / 4.0).min(1.0);
                if len >= gape {
                    continue;
                }
                c = (len - gape) / (len * ws) * 0.08;
            } else {
                c = (len - self.zrest[k]) / (len * ws);
            }
            x[a3] -= dx * c * w[a];
            x[a3 + 1] -= dy * c * w[a];
            x[a3 + 2] -= dz * c * w[a];
            x[b3] += dx * c * w[b];
            x[b3 + 1] += dy * c * w[b];
            x[b3 + 2] += dz * c * w[b];
        }
    }

    /// Floor with friction: a particle that touches down keeps `slide` of its sliding.
    pub fn floor_contact(&mut self) {
        let fy = self.floor + 0.12;
        for i in 0..self.n {
            let i3 = i * 3;
            if self.x[i3 + 1] < fy {
                self.x[i3 + 1] = fy;
                for k in [0, 2] {
                    let d = (self.x[i3 + k] - self.p[i3 + k]) * self.slide;
                    self.x[i3 + k] = self.p[i3 + k] + d;
                    // resting: bleed off leftover jitter so it can come to rest
                    self.p[i3 + k] = self.x[i3 + k] - d * 0.6;
                }
            }
        }
    }

    fn cell(v: f32, s: f32) -> i32 {
        (v / s).floor() as i32
    }
    fn hash(ix: i32, iy: i32, iz: i32) -> usize {
        ((ix.wrapping_mul(92837111) ^ iy.wrapping_mul(689287499) ^ iz.wrapping_mul(283923481)) & 0xffff) as usize
    }

    fn find_pairs(&mut self) {
        let s = self.self_r * 2.5;
        let s2 = s * s;
        self.head.iter_mut().for_each(|h| *h = -1);
        for i in 0..self.n {
            let h = Self::hash(Self::cell(self.x[i * 3], s), Self::cell(self.x[i * 3 + 1], s), Self::cell(self.x[i * 3 + 2], s));
            self.next[i] = self.head[h];
            self.head[h] = i as i32;
        }
        self.pairs.clear();
        for i in 0..self.n {
            let i3 = i * 3;
            let (cx, cy, cz) = (Self::cell(self.x[i3], s), Self::cell(self.x[i3 + 1], s), Self::cell(self.x[i3 + 2], s));
            for a in -1..=1 {
                for b in -1..=1 {
                    for c in -1..=1 {
                        let mut j = self.head[Self::hash(cx + a, cy + b, cz + c)];
                        while j >= 0 {
                            let ju = j as usize;
                            j = self.next[ju];
                            if ju <= i {
                                continue;
                            }
                            let j3 = ju * 3;
                            let d2 = (self.x[i3] - self.x[j3]).powi(2) + (self.x[i3 + 1] - self.x[j3 + 1]).powi(2) + (self.x[i3 + 2] - self.x[j3 + 2]).powi(2);
                            if d2 >= s2 {
                                continue;
                            }
                            let e2 = (self.x0[i3] - self.x0[j3]).powi(2) + (self.x0[i3 + 1] - self.x0[j3 + 1]).powi(2) + (self.x0[i3 + 2] - self.x0[j3 + 2]).powi(2);
                            if e2 < s2 {
                                continue; // neighbours in the rest shape
                            }
                            self.pairs.push(i as u32);
                            self.pairs.push(ju as u32);
                        }
                    }
                }
            }
        }
    }

    /// Keep non-neighbouring fabric apart. `refresh` rebuilds the candidate list.
    pub fn self_collide(&mut self, refresh: bool) {
        if refresh {
            self.find_pairs();
        }
        let r = self.self_r;
        let r2 = r * r;
        let (x, w) = (&mut self.x, &self.w);
        let mut k = 0;
        while k < self.pairs.len() {
            let i = self.pairs[k] as usize;
            let j = self.pairs[k + 1] as usize;
            k += 2;
            let (i3, j3) = (i * 3, j * 3);
            let dx = x[i3] - x[j3];
            let dy = x[i3 + 1] - x[j3 + 1];
            let dz = x[i3 + 2] - x[j3 + 2];
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 >= r2 || d2 < 1e-12 {
                continue;
            }
            let ws = w[i] + w[j];
            if ws == 0.0 {
                continue;
            }
            let d = d2.sqrt();
            let c = (r - d) / (d * ws);
            x[i3] += dx * c * w[i];
            x[i3 + 1] += dy * c * w[i];
            x[i3 + 2] += dz * c * w[i];
            x[j3] -= dx * c * w[j];
            x[j3 + 1] -= dy * c * w[j];
            x[j3 + 2] -= dz * c * w[j];
        }
    }

    /// Handles against the bag: every strap particle is kept `r` away from every body
    /// particle (except the ones it is sewn next to), so a strap lies on the outside of
    /// the panels instead of sliding through the gaps between coarse particles.
    pub fn strap_collide(&mut self, r: f32) {
        let r2 = r * r;
        let n = self.n;
        for i in 0..n {
            if self.group[i] != 1 {
                continue;
            }
            let i3 = i * 3;
            for j in 0..n {
                if self.group[j] != 0 {
                    continue;
                }
                let j3 = j * 3;
                let rx = self.x0[i3] - self.x0[j3];
                let ry = self.x0[i3 + 1] - self.x0[j3 + 1];
                let rz = self.x0[i3 + 2] - self.x0[j3 + 2];
                if rx * rx + ry * ry + rz * rz < r2 * 1.5 {
                    continue; // sewn together at rest
                }
                let dx = self.x[i3] - self.x[j3];
                let dy = self.x[i3 + 1] - self.x[j3 + 1];
                let dz = self.x[i3 + 2] - self.x[j3 + 2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 >= r2 || d2 < 1e-12 {
                    continue;
                }
                let ws = self.w[i] + self.w[j];
                if ws == 0.0 {
                    continue;
                }
                let d = d2.sqrt();
                let c = (r - d) / (d * ws);
                let (wi, wj) = (self.w[i], self.w[j]);
                self.x[i3] += dx * c * wi;
                self.x[i3 + 1] += dy * c * wi;
                self.x[i3 + 2] += dz * c * wi;
                self.x[j3] -= dx * c * wj;
                self.x[j3 + 1] -= dy * c * wj;
                self.x[j3 + 2] -= dz * c * wj;
            }
        }
    }

    pub fn finish(&mut self, dt: f32) {
        let body = (1.0 - self.damping * dt).max(0.0);
        let strap = (1.0 - self.strap_damping * dt).max(0.0);
        for i in 0..self.n {
            let d = if self.group[i] == 1 { strap } else { body };
            for k in 0..3 {
                self.v[i * 3 + k] = (self.x[i * 3 + k] - self.p[i * 3 + k]) / dt * d;
            }
        }
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn scale(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// cos of the angle between the two triangle normals (shared edge p1-p2, corners p3, p4) and
/// the gradient terms q1..q4 of Mueller et al. 2007 (dC/dp_i = -q_i / sqrt(1 - d^2)).
fn dihedral(x: &[f32], q: [usize; 4]) -> Option<(f32, [[f32; 3]; 4])> {
    let p = |i: usize| [x[q[i] * 3], x[q[i] * 3 + 1], x[q[i] * 3 + 2]];
    let p1 = p(0);
    let p2 = sub(p(1), p1);
    let p3 = sub(p(2), p1);
    let p4 = sub(p(3), p1);
    let c23 = cross(p2, p3);
    let c24 = cross(p2, p4);
    let l23 = dot(c23, c23).sqrt();
    let l24 = dot(c24, c24).sqrt();
    let le = dot(p2, p2).sqrt();
    // sliver triangles (welded vertices nearly in line) have huge, meaningless gradients
    if le < 0.3 || l23 < 0.25 * le * le.max(1.0) || l24 < 0.25 * le * le.max(1.0) {
        return None;
    }
    let n1 = scale(c23, 1.0 / l23);
    let n2 = scale(c24, 1.0 / l24);
    let d = dot(n1, n2);
    let q3 = scale(add3(cross(p2, n2), scale(cross(n1, p2), d)), 1.0 / l23);
    let q4 = scale(add3(cross(p2, n1), scale(cross(n2, p2), d)), 1.0 / l24);
    let q2a = scale(add3(cross(p3, n2), scale(cross(n1, p3), d)), -1.0 / l23);
    let q2b = scale(add3(cross(p4, n1), scale(cross(n2, p4), d)), -1.0 / l24);
    let q2 = add3(q2a, q2b);
    let q1 = scale(add3(add3(q2, q3), q4), -1.0);
    Some((d, [q1, q2, q3, q4]))
}
