//! 3D mesh output. Units are centimetres, y up, the bag front faces +z.

use serde::Serialize;
use std::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

pub const fn v3(x: f64, y: f64, z: f64) -> V3 {
    V3 { x, y, z }
}

impl V3 {
    pub fn dot(self, o: V3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: V3) -> V3 {
        v3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn len(self) -> f64 {
        self.dot(self).sqrt()
    }
    pub fn norm(self) -> V3 {
        let l = self.len();
        if l < 1e-12 {
            V3::default()
        } else {
            self * (1.0 / l)
        }
    }
    pub fn arr(self) -> [f32; 3] {
        [self.x as f32, self.y as f32, self.z as f32]
    }
}
impl Add for V3 {
    type Output = V3;
    fn add(self, o: V3) -> V3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for V3 {
    type Output = V3;
    fn sub(self, o: V3) -> V3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f64> for V3 {
    type Output = V3;
    fn mul(self, s: f64) -> V3 {
        v3(self.x * s, self.y * s, self.z * s)
    }
}
impl Neg for V3 {
    type Output = V3;
    fn neg(self) -> V3 {
        v3(-self.x, -self.y, -self.z)
    }
}

/// A renderable surface. `material` is a slot name: outer, lining, strap, pocket.
/// UVs are in real centimetres so fabric textures tile at true scale.
#[derive(Serialize, Default, Clone)]
pub struct Part {
    pub name: String,
    pub material: String,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Part {
    pub fn new(name: &str, material: &str) -> Self {
        Part {
            name: name.into(),
            material: material.into(),
            ..Default::default()
        }
    }
    pub fn vcount(&self) -> usize {
        self.positions.len() / 3
    }
    pub fn pos(&self, i: usize) -> V3 {
        let p = &self.positions[i * 3..i * 3 + 3];
        v3(p[0] as f64, p[1] as f64, p[2] as f64)
    }
    pub fn nrm(&self, i: usize) -> V3 {
        let p = &self.normals[i * 3..i * 3 + 3];
        v3(p[0] as f64, p[1] as f64, p[2] as f64)
    }
    fn push_v(&mut self, p: V3, uv: [f64; 2]) {
        self.positions.extend(p.arr());
        self.uvs.extend([uv[0] as f32, uv[1] as f32]);
    }

    /// Build a rows x cols vertex grid. `hint` gives the expected outward direction,
    /// which is used to orient the triangles and to fill in degenerate normals.
    pub fn grid<F, H>(name: &str, material: &str, rows: usize, cols: usize, f: F, hint: H) -> Part
    where
        F: Fn(usize, usize) -> (V3, [f64; 2]),
        H: Fn(usize, usize, V3) -> V3,
    {
        let mut part = Part::new(name, material);
        let mut hints = Vec::with_capacity(rows * cols);
        for r in 0..rows {
            for c in 0..cols {
                let (p, uv) = f(r, c);
                part.push_v(p, uv);
                hints.push(hint(r, c, p));
            }
        }
        for r in 0..rows - 1 {
            for c in 0..cols - 1 {
                let a = (r * cols + c) as u32;
                let b = a + 1;
                let d = a + cols as u32;
                let e = d + 1;
                part.indices.extend([a, d, b, b, d, e]);
            }
        }
        part.compute_normals();
        part.orient(&hints);
        part
    }

    pub fn compute_normals(&mut self) {
        let mut acc = vec![V3::default(); self.vcount()];
        for t in self.indices.chunks(3) {
            let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
            let n = (self.pos(b) - self.pos(a)).cross(self.pos(c) - self.pos(a));
            acc[a] = acc[a] + n;
            acc[b] = acc[b] + n;
            acc[c] = acc[c] + n;
        }
        self.normals = acc.iter().flat_map(|v| v.norm().arr()).collect();
    }

    fn orient(&mut self, hints: &[V3]) {
        let s: f64 = (0..self.vcount()).map(|i| self.nrm(i).dot(hints[i])).sum();
        if s < 0.0 {
            self.flip();
        }
        for (i, h) in hints.iter().enumerate() {
            if self.nrm(i).len() < 0.5 {
                self.normals[i * 3..i * 3 + 3].copy_from_slice(&h.norm().arr());
            }
        }
    }

    pub fn flip(&mut self) {
        for t in self.indices.chunks_mut(3) {
            t.swap(1, 2);
        }
        for n in self.normals.iter_mut() {
            *n = -*n;
        }
    }

    /// Inner surface: the same sheet pushed inward by `t` and facing the other way.
    pub fn shell(&self, name: &str, material: &str, t: f64) -> Part {
        let mut s = self.clone();
        s.name = name.into();
        s.material = material.into();
        for i in 0..self.vcount() {
            let p = self.pos(i) - self.nrm(i) * t;
            s.positions[i * 3..i * 3 + 3].copy_from_slice(&p.arr());
        }
        s.flip();
        s
    }

    pub fn append(&mut self, o: &Part) {
        let base = self.vcount() as u32;
        self.positions.extend(&o.positions);
        self.normals.extend(&o.normals);
        self.uvs.extend(&o.uvs);
        self.indices.extend(o.indices.iter().map(|i| i + base));
    }
}

/// A polyline drawn as geometry: `piping` is a seam bead, `stitch` is dashed thread.
#[derive(Serialize, Clone)]
pub struct Line {
    pub kind: String,
    pub radius: f64,
    pub points: Vec<[f32; 3]>,
}

impl Line {
    pub fn new(kind: &str, radius: f64, pts: impl IntoIterator<Item = V3>) -> Line {
        Line {
            kind: kind.into(),
            radius,
            points: pts.into_iter().map(V3::arr).collect(),
        }
    }
}

#[derive(Serialize, Default, Clone)]
pub struct Mesh {
    pub parts: Vec<Part>,
    pub lines: Vec<Line>,
    /// min x, min y, min z, max x, max y, max z
    pub bounds: [f32; 6],
}

impl Mesh {
    pub fn finish(&mut self) {
        let mut b = [f32::MAX, f32::MAX, f32::MAX, f32::MIN, f32::MIN, f32::MIN];
        for p in &self.parts {
            for v in p.positions.chunks(3) {
                for k in 0..3 {
                    b[k] = b[k].min(v[k]);
                    b[k + 3] = b[k + 3].max(v[k]);
                }
            }
        }
        self.bounds = b;
    }

    /// Wavefront OBJ (centimetres).
    pub fn to_obj(&self) -> String {
        let mut o = String::from("# bag-engine export, units: cm\n");
        let mut base = 1usize;
        for p in &self.parts {
            o += &format!("o {}\nusemtl {}\n", p.name, p.material);
            for v in p.positions.chunks(3) {
                o += &format!("v {} {} {}\n", v[0], v[1], v[2]);
            }
            for v in p.uvs.chunks(2) {
                o += &format!("vt {} {}\n", v[0], v[1]);
            }
            for v in p.normals.chunks(3) {
                o += &format!("vn {} {} {}\n", v[0], v[1], v[2]);
            }
            for t in p.indices.chunks(3) {
                let (a, b, c) = (t[0] as usize + base, t[1] as usize + base, t[2] as usize + base);
                o += &format!("f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}\n");
            }
            base += p.vcount();
        }
        o
    }
}
