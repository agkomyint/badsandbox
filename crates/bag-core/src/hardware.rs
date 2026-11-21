//! Zippers and rings: real-size hardware geometry plus the numbers a maker needs
//! to buy it (chain width, tape width, length).

use crate::mesh::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZipKind {
    Coil,
    Metal,
    Molded,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PullKind {
    Tab,
    Ring,
    Tassel,
}

#[derive(Clone, Copy, Debug)]
pub struct ZipSpec {
    pub kind: ZipKind,
    pub pull: PullKind,
    /// Zipper size number: 3, 5, 8 or 10.
    pub gauge: f64,
}

pub const GAUGES: [f64; 4] = [3.0, 5.0, 8.0, 10.0];

impl ZipKind {
    pub fn parse(s: &str) -> Option<ZipKind> {
        match s {
            "coil" | "nylon" => Some(ZipKind::Coil),
            "metal" => Some(ZipKind::Metal),
            "molded" | "plastic" | "vislon" => Some(ZipKind::Molded),
            _ => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            ZipKind::Coil => "nylon coil",
            ZipKind::Metal => "metal",
            ZipKind::Molded => "molded plastic",
        }
    }
}

impl PullKind {
    pub fn parse(s: &str) -> Option<PullKind> {
        match s {
            "tab" => Some(PullKind::Tab),
            "ring" => Some(PullKind::Ring),
            "tassel" => Some(PullKind::Tassel),
            _ => None,
        }
    }
}

impl ZipSpec {
    /// Width of the interlocked teeth (cm).
    pub fn chain_w(&self) -> f64 {
        0.1 * self.gauge + 0.1
    }
    /// Full tape width, both sides (cm).
    pub fn tape_w(&self) -> f64 {
        2.0 + 0.2 * self.gauge
    }
    fn pitch(&self) -> f64 {
        let p = 0.12 + 0.035 * self.gauge;
        if self.kind == ZipKind::Coil { p * 0.7 } else { p }
    }
    fn tooth_h(&self) -> f64 {
        0.1 + 0.03 * self.gauge
    }
    /// Shopping line, e.g. "#5 metal zipper, at least 44 cm".
    pub fn buy(&self, open_len: f64) -> String {
        let l = open_len + 4.0;
        format!(
            "#{:.0} {} zipper, at least {:.0} cm ({:.0} in) - or continuous zipper + 1 slider",
            self.gauge,
            self.kind.label(),
            l.ceil(),
            (l / 2.54).ceil()
        )
    }
}

/// Builds a zipper along `pts` (dense centreline), with per-point face normals `nrm`.
/// `tape_vis` is how much tape shows; `slider_at` (0..1) places the slider;
/// `hang` is the direction gravity pulls the puller.
pub fn zipper(name: &str, pts: &[V3], nrm: &[V3], spec: &ZipSpec, tape_vis: f64, slider_at: f64, hang: V3) -> Vec<Part> {
    let n = pts.len();
    let mut cum = vec![0.0];
    for w in pts.windows(2) {
        let l = *cum.last().unwrap();
        cum.push(l + (w[1] - w[0]).len());
    }
    let total = *cum.last().unwrap();
    let dir_at = |i: usize| (pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)]).norm();
    let sample = |s: f64| -> (V3, V3, V3) {
        let s = s.clamp(0.0, total);
        let mut i = 0;
        while i + 2 < n && cum[i + 1] < s {
            i += 1;
        }
        let seg = (cum[i + 1] - cum[i]).max(1e-9);
        let t = ((s - cum[i]) / seg).clamp(0.0, 1.0);
        let p = pts[i] + (pts[i + 1] - pts[i]) * t;
        let nn = (nrm[i] * (1.0 - t) + nrm[i + 1] * t).norm();
        (p, nn, dir_at(i))
    };

    let cw = spec.chain_w();
    let th = spec.tooth_h();
    let mut out = Vec::new();

    // Tape: two halves meeting at the chain (a hair-thin split in the middle, hidden
    // under the teeth) so each side can separate when the zipper is opened.
    out.push(Part::grid(
        &format!("{name}_tape"),
        "zip_tape",
        n,
        4,
        |i, j| {
            let d = dir_at(i);
            let across = nrm[i].cross(d).norm();
            let o = [-tape_vis / 2.0, -0.01, 0.01, tape_vis / 2.0][j];
            (pts[i] + across * o + nrm[i] * 0.02, [cum[i], o])
        },
        |i, _, _| nrm[i],
    ));

    // Teeth, interlocking from both sides.
    let teeth_mat = if spec.kind == ZipKind::Metal { "metal" } else { "zip_teeth" };
    let mut teeth = Part::new(&format!("{name}_teeth"), teeth_mat);
    let pitch = spec.pitch();
    let along_he = match spec.kind {
        ZipKind::Coil => pitch * 0.24,
        ZipKind::Metal => pitch * 0.3,
        ZipKind::Molded => pitch * 0.34,
    };
    let mut s = 0.4;
    let mut k = 0;
    while s < total - 0.4 {
        let (p, nn, d) = sample(s);
        let across = nn.cross(d).norm();
        let side = if k % 2 == 0 { 1.0 } else { -1.0 };
        let c = p + across * (side * cw * 0.22) + nn * (th / 2.0 + 0.02);
        teeth.push_box(c, [d, across, nn], [along_he, cw * 0.3, th / 2.0]);
        s += pitch / 2.0;
        k += 1;
    }
    out.push(teeth);

    // Slider and puller.
    let mut metal = Part::new(&format!("{name}_slider"), "metal");
    let (p, nn, d) = sample(slider_at * total);
    let across = nn.cross(d).norm();
    let sl = 0.7 + spec.gauge * 0.04;
    let body = p + nn * (th + 0.12);
    metal.push_box(body, [d, across, nn], [sl, cw / 2.0 + 0.18, 0.12]);
    metal.push_box(body + nn * 0.16 - d * (sl * 0.2), [d, across, nn], [sl * 0.55, cw / 2.0 * 0.6, 0.06]);

    let mut h = hang - nn * hang.dot(nn);
    if h.len() < 0.2 {
        h = -d;
    }
    let h = h.norm();
    let side = nn.cross(h).norm();
    let anchor = body + nn * 0.2 + h * (sl * 0.6);
    match spec.pull {
        PullKind::Tab => {
            let ln = 1.0 + spec.gauge * 0.08;
            metal.push_box(anchor + h * ln + nn * 0.05, [h, side, nn], [ln, 0.32 + spec.gauge * 0.02, 0.06]);
            out.push(metal);
        }
        PullKind::Ring => {
            out.push(metal);
            let r = 0.55 + spec.gauge * 0.03;
            let c = anchor + h * r + nn * 0.08;
            let ring: Vec<V3> = (0..=28)
                .map(|i| {
                    let a = 2.0 * std::f64::consts::PI * i as f64 / 28.0;
                    c + h * (r * a.cos()) + side * (r * a.sin())
                })
                .collect();
            out.push(Part::tube(&format!("{name}_ring"), "metal", &ring, 0.09, 8));
        }
        PullKind::Tassel => {
            metal.push_box(anchor + h * 0.45, [h, side, nn], [0.45, 0.22, 0.14]);
            out.push(metal);
            for (i, sg) in [-1.0, 1.0].into_iter().enumerate() {
                let len = 8.0 + i as f64 * 1.2;
                let c: Vec<V3> = (0..=24)
                    .map(|j| {
                        let t = j as f64 / 24.0;
                        anchor + h * (0.8 + len * t) + side * (sg * (0.12 + 0.35 * t)) + nn * (0.08 + 0.15 * t * (1.0 - t))
                    })
                    .collect();
                let m = c.len();
                out.push(Part::strap(
                    &format!("{name}_tassel{i}"),
                    "trim",
                    &c,
                    &vec![side; m],
                    &vec![nn; m],
                    0.42,
                    0.12,
                ));
            }
        }
    }
    out
}

/// D-ring: a straight bar `w` wide at `c` plus a half-loop, in the plane of `up`/`across`.
pub fn d_ring(name: &str, c: V3, across: V3, up: V3, w: f64, r: f64) -> Part {
    let mut pts = Vec::new();
    let hw = w / 2.0;
    for i in 0..=8 {
        pts.push(c + across * (-hw + w * i as f64 / 8.0));
    }
    for i in 1..24 {
        let a = std::f64::consts::PI * i as f64 / 24.0;
        pts.push(c + across * (hw * a.cos()) + up * (hw * 1.15 * a.sin()));
    }
    pts.push(pts[0]);
    Part::tube(name, "metal", &pts, r, 8)
}
