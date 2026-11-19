//! Tote bag: two body panels (front/back), a U-shaped gusset (side-bottom-side),
//! two handles and an optional patch pocket.
//!
//! The pattern is the source of truth. The gusset length is the exact length of the
//! panel's side+bottom outline, and the 3D model is built from the same outline,
//! so the pattern and the 3D view always agree.

use crate::geom::*;
use crate::mesh::*;
use crate::pattern::*;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ToteParams {
    /// Finished width at the bottom.
    pub width: f64,
    /// Finished width at the top (wider than `width` = tapered tote).
    pub top_width: f64,
    pub height: f64,
    /// Gusset depth (bag thickness).
    pub depth: f64,
    /// Bottom corner radius on the body panels.
    pub corner_radius: f64,
    /// How much the panels puff out in 3D (visual only, cm).
    pub softness: f64,
    /// Visible handle loop length.
    pub strap_length: f64,
    pub strap_width: f64,
    /// Distance between the two ends of one handle (centre to centre).
    pub strap_spacing: f64,
    /// How far each handle end is sewn down onto the panel.
    pub strap_attach: f64,
    pub pocket: bool,
    pub pocket_width: f64,
    pub pocket_height: f64,
    pub pocket_from_top: f64,
    pub lining: bool,
    /// Top hem depth (used when there is no lining).
    pub hem: f64,
    pub seam_allowance: f64,
    /// Fabric thickness (visual only).
    pub thickness: f64,
}

impl Default for ToteParams {
    fn default() -> Self {
        ToteParams {
            width: 36.0,
            top_width: 42.0,
            height: 38.0,
            depth: 12.0,
            corner_radius: 4.0,
            softness: 1.6,
            strap_length: 56.0,
            strap_width: 3.0,
            strap_spacing: 14.0,
            strap_attach: 5.0,
            pocket: true,
            pocket_width: 18.0,
            pocket_height: 14.0,
            pocket_from_top: 9.0,
            lining: true,
            hem: 3.0,
            seam_allowance: 1.0,
            thickness: 0.25,
        }
    }
}

const STRAP_T: f64 = 0.35;
const STITCH_R: f64 = 0.035;
const PIPING_R: f64 = 0.22;

pub fn sanitize(p: &mut ToteParams) -> Vec<String> {
    let mut w = Vec::new();
    let mut clamp = |v: &mut f64, lo: f64, hi: f64, what: &str| {
        let hi = hi.max(lo);
        if *v < lo || *v > hi || !v.is_finite() {
            let nv = if v.is_finite() { v.clamp(lo, hi) } else { lo };
            w.push(format!("{what} adjusted from {:.1} to {:.1} cm", *v, nv));
            *v = nv;
        }
    };
    clamp(&mut p.width, 10.0, 120.0, "Width");
    clamp(&mut p.top_width, 8.0, 140.0, "Top width");
    clamp(&mut p.height, 10.0, 120.0, "Height");
    clamp(&mut p.depth, 2.0, 50.0, "Depth");
    let rmax = p.width.min(p.height) * 0.45;
    clamp(&mut p.corner_radius, 0.0, rmax, "Corner radius");
    clamp(&mut p.softness, 0.0, p.width.min(p.height) * 0.12, "Softness");
    clamp(&mut p.strap_width, 1.0, 10.0, "Strap width");
    let sp_max = p.top_width - p.strap_width - 2.0;
    clamp(&mut p.strap_spacing, p.strap_width + 1.0, sp_max, "Strap spacing");
    clamp(&mut p.strap_length, p.strap_spacing * 1.15, 200.0, "Strap length");
    clamp(&mut p.strap_attach, 1.5, p.height / 3.0, "Strap attach");
    clamp(&mut p.seam_allowance, 0.3, 3.0, "Seam allowance");
    clamp(&mut p.hem, 1.0, p.height / 4.0, "Hem");
    clamp(&mut p.thickness, 0.05, 1.0, "Thickness");
    if p.pocket {
        clamp(&mut p.pocket_width, 4.0, p.width - 4.0, "Pocket width");
        clamp(&mut p.pocket_from_top, p.strap_attach + 1.0, p.height - 6.0, "Pocket position");
        clamp(&mut p.pocket_height, 4.0, p.height - p.pocket_from_top - 2.0, "Pocket height");
    }
    w
}

/// Side+bottom sewing line of the body panel, from top-left to top-right (CCW).
pub fn outline(p: &ToteParams) -> Vec<V2> {
    let tl = v2(-p.top_width / 2.0, p.height);
    let bl = v2(-p.width / 2.0, 0.0);
    let br = v2(p.width / 2.0, 0.0);
    let tr = v2(p.top_width / 2.0, p.height);
    let mut path = vec![tl];
    path.extend(fillet(tl, bl, br, p.corner_radius, 14));
    path.extend(fillet(bl, br, tr, p.corner_radius, 14));
    path.push(tr);
    dedupe(path)
}

fn outward(t: V2) -> V2 {
    v2(t.y, -t.x)
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<V2> {
    vec![v2(x0, y0), v2(x1, y0), v2(x1, y1), v2(x0, y1), v2(x0, y0)]
}

/// Arc-length positions on the outline where notches go (side midpoints + bottom centre).
fn notch_positions(p: &ToteParams, path: &[V2]) -> Vec<f64> {
    let l = polyline_length(path);
    let side = (v2(-p.top_width / 2.0, p.height) - v2(-p.width / 2.0, 0.0)).len();
    vec![side / 2.0, l / 2.0, l - side / 2.0]
}

pub fn pieces(p: &ToteParams, path: &[V2]) -> Vec<Piece> {
    let sa = p.seam_allowance;
    let top_allow = if p.lining { sa } else { p.hem + 1.0 };
    let h = p.height;
    let gl = polyline_length(path);
    let marks_s = notch_positions(p, path);
    let mut out = Vec::new();

    // Body panel
    {
        let sew = path.to_vec();
        let n = sew.len();
        let mut d = vec![sa; n];
        d[n - 1] = top_allow;
        let cut_line = offset_polygon(&sew, &d);
        let mut notches: Vec<Notch> = marks_s
            .iter()
            .map(|&s| {
                let (pt, t) = point_at(path, s);
                let o = outward(t);
                Notch { at: pt + o * sa, dir: -o }
            })
            .collect();
        notches.push(Notch { at: v2(0.0, h + top_allow), dir: v2(0.0, -1.0) });
        let span = p.top_width / 2.0 + sa + 1.0;
        let folds = if p.lining {
            vec![]
        } else {
            vec![[v2(-span, h), v2(span, h)], [v2(-span, h + p.hem), v2(span, h + p.hem)]]
        };
        let mut marks = Vec::new();
        for sx in [-1.0, 1.0] {
            let x = sx * p.strap_spacing / 2.0;
            marks.push(rect(x - p.strap_width / 2.0, h - p.strap_attach, x + p.strap_width / 2.0, h));
        }
        if p.pocket {
            let yt = h - p.pocket_from_top;
            marks.push(rect(-p.pocket_width / 2.0, yt - p.pocket_height, p.pocket_width / 2.0, yt));
        }
        let mut notes = vec![format!(
            "Finished {:.1} (bottom) / {:.1} (top) x {:.1} cm",
            p.width, p.top_width, h
        )];
        if p.pocket {
            notes.push("Pocket placement: front panel only".into());
        }
        if !p.lining {
            notes.push(format!("Top hem: turn 1 cm, then {:.1} cm", p.hem));
        }
        out.push(Piece {
            id: "body".into(),
            name: "Body panel".into(),
            cut: if p.lining { "Cut 2 outer + 2 lining".into() } else { "Cut 2 outer".into() },
            sew,
            cut_line,
            folds,
            notches,
            grain: [v2(-p.width * 0.28, h * 0.2), v2(-p.width * 0.28, h * 0.8)],
            marks,
            notes,
        });
    }

    // Gusset: one strip, side - bottom - side. y = arc length along the outline.
    {
        let dpt = p.depth;
        let sew = vec![v2(0.0, 0.0), v2(dpt, 0.0), v2(dpt, gl), v2(0.0, gl)];
        let cut_line = offset_polygon(&sew, &[top_allow, sa, top_allow, sa]);
        let mut notches = Vec::new();
        for &s in &marks_s {
            notches.push(Notch { at: v2(dpt + sa, s), dir: v2(-1.0, 0.0) });
            notches.push(Notch { at: v2(-sa, s), dir: v2(1.0, 0.0) });
        }
        let folds = if p.lining {
            vec![]
        } else {
            let (a, b) = (-sa - 1.0, dpt + sa + 1.0);
            vec![
                [v2(a, 0.0), v2(b, 0.0)],
                [v2(a, -p.hem), v2(b, -p.hem)],
                [v2(a, gl), v2(b, gl)],
                [v2(a, gl + p.hem), v2(b, gl + p.hem)],
            ]
        };
        out.push(Piece {
            id: "gusset".into(),
            name: "Gusset".into(),
            cut: if p.lining { "Cut 1 outer + 1 lining".into() } else { "Cut 1 outer".into() },
            sew,
            cut_line,
            folds,
            notches,
            grain: [v2(dpt * 0.25, gl * 0.3), v2(dpt * 0.25, gl * 0.7)],
            marks: vec![],
            notes: vec![
                format!("{:.1} x {:.1} cm finished", dpt, gl),
                "Length = panel side + bottom; match notches".into(),
            ],
        });
    }

    // Strap: folded in quarters, so no seam allowance.
    {
        let sw = p.strap_width;
        let w4 = sw * 4.0;
        let len = p.strap_length + 2.0 * p.strap_attach;
        let sew = vec![v2(0.0, 0.0), v2(w4, 0.0), v2(w4, len), v2(0.0, len)];
        out.push(Piece {
            id: "strap".into(),
            name: "Handle".into(),
            cut: "Cut 2".into(),
            cut_line: sew.clone(),
            sew,
            folds: (1..4).map(|i| [v2(sw * i as f64, 0.0), v2(sw * i as f64, len)]).collect(),
            notches: vec![],
            grain: [v2(sw * 0.5, len * 0.3), v2(sw * 0.5, len * 0.7)],
            marks: vec![
                vec![v2(0.0, p.strap_attach), v2(w4, p.strap_attach)],
                vec![v2(0.0, len - p.strap_attach), v2(w4, len - p.strap_attach)],
            ],
            notes: vec![
                format!("Finished {:.1} x {:.1} cm", sw, len),
                "Fold edges to centre, fold again, topstitch".into(),
            ],
        });
    }

    if p.pocket {
        let (pw, ph) = (p.pocket_width, p.pocket_height);
        let sew = vec![v2(0.0, 0.0), v2(pw, 0.0), v2(pw, ph), v2(0.0, ph)];
        let cut_line = offset_polygon(&sew, &[sa, sa, p.hem + 1.0, sa]);
        out.push(Piece {
            id: "pocket".into(),
            name: "Patch pocket".into(),
            cut: "Cut 1 outer".into(),
            sew,
            cut_line,
            folds: vec![
                [v2(-sa - 0.5, ph), v2(pw + sa + 0.5, ph)],
                [v2(-sa - 0.5, ph + p.hem), v2(pw + sa + 0.5, ph + p.hem)],
            ],
            notches: vec![],
            grain: [v2(pw * 0.2, ph * 0.25), v2(pw * 0.2, ph * 0.75)],
            marks: vec![],
            notes: vec![format!("Finished {:.1} x {:.1} cm", pw, ph)],
        });
    }
    out
}

/// The puffed front surface: z depends on how far a point is from the panel centre.
struct Pillow {
    poly: Vec<V2>,
    c: V2,
    amp: f64,
    d2: f64,
}

impl Pillow {
    fn s(&self, p: V2) -> f64 {
        let v = p - self.c;
        let l = v.len();
        if l < 1e-9 {
            return 0.0;
        }
        let r = ray_to_boundary(&self.poly, self.c, v * (1.0 / l));
        (l / r).min(1.0)
    }
    fn z_s(&self, s: f64) -> f64 {
        self.d2 + self.amp * (1.0 - s * s)
    }
    fn z(&self, p: V2) -> f64 {
        self.z_s(self.s(p))
    }
}

fn bezier(a: V2, b: V2, c: V2, d: V2, t: f64) -> V2 {
    let u = 1.0 - t;
    a * (u * u * u) + b * (3.0 * u * u * t) + c * (3.0 * u * t * t) + d * (t * t * t)
}

/// Height of the handle's control points so the loop has the requested length.
fn solve_handle(spacing: f64, length: f64, h: f64) -> f64 {
    let len = |k: f64| {
        let (a, b) = (v2(-spacing / 2.0, h), v2(spacing / 2.0, h));
        let pts: Vec<V2> = (0..=96)
            .map(|i| bezier(a, a + v2(0.0, k), b + v2(0.0, k), b, i as f64 / 96.0))
            .collect();
        polyline_length(&pts)
    };
    let (mut lo, mut hi) = (0.0, length);
    for _ in 0..50 {
        let mid = (lo + hi) / 2.0;
        if len(mid) < length {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

fn spow(v: f64, e: f64) -> f64 {
    v.signum() * v.abs().powf(e)
}

fn rim(src: &Part, idx: &[usize], t: f64) -> Part {
    let pts: Vec<(V3, V3)> = idx.iter().map(|&i| (src.pos(i), src.nrm(i))).collect();
    let mut us = vec![0.0];
    for w in pts.windows(2) {
        let last = *us.last().unwrap();
        us.push(last + (w[1].0 - w[0].0).len());
    }
    Part::grid(
        "rim",
        "outer",
        2,
        pts.len(),
        |r, c| {
            let (p, n) = pts[c];
            (if r == 0 { p } else { p - n * t }, [us[c], r as f64 * t])
        },
        |_, _, _| v3(0.0, 1.0, 0.0),
    )
}

pub fn mesh(p: &ToteParams, path: &[V2]) -> Mesh {
    let d2 = p.depth / 2.0;
    let h = p.height;
    let t = p.thickness;
    let gl = polyline_length(path);
    let n_path = (gl.ceil() as usize).clamp(90, 400);
    let rp = resample(path, n_path);
    let tl = rp[0];
    let tr = *rp.last().unwrap();
    let n_top = (p.top_width.ceil() as usize).clamp(24, 200);
    let mut lp = rp.clone();
    for k in 1..n_top {
        lp.push(tr.lerp(tl, k as f64 / n_top as f64));
    }
    let pill = Pillow { c: centroid(&lp), poly: lp.clone(), amp: p.softness, d2 };
    let m = lp.len();
    let cols = m + 1;
    let rings = 28;

    let panel = |name: &str, side: f64| {
        Part::grid(
            name,
            "outer",
            rings + 1,
            cols,
            |r, k| {
                let s = r as f64 / rings as f64;
                let xy = pill.c.lerp(lp[k % m], s);
                (v3(xy.x, xy.y, side * pill.z_s(s)), [side * xy.x, xy.y])
            },
            |_, _, _| v3(0.0, 0.0, side),
        )
    };
    let front = panel("front", 1.0);
    let back = panel("back", -1.0);

    let tang: Vec<V2> = (0..rp.len())
        .map(|i| (rp[(i + 1).min(rp.len() - 1)] - rp[i.saturating_sub(1)]).norm())
        .collect();
    let nrm: Vec<V2> = tang.iter().map(|t| outward(*t)).collect();
    let mut cum = vec![0.0];
    for w in rp.windows(2) {
        let last = *cum.last().unwrap();
        cum.push(last + (w[1] - w[0]).len());
    }
    let gz = 14;
    let gsoft = p.softness * 0.35;
    let gusset = Part::grid(
        "gusset",
        "outer",
        rp.len(),
        gz + 1,
        |i, j| {
            let v = j as f64 / gz as f64;
            let z = d2 - v * p.depth;
            let xy = rp[i] + nrm[i] * (gsoft * (PI * v).sin());
            (v3(xy.x, xy.y, z), [cum[i], z])
        },
        |i, _, _| v3(nrm[i].x, nrm[i].y, 0.0),
    );

    let mut parts = vec![
        front.shell("front_lining", "lining", t),
        back.shell("back_lining", "lining", t),
        gusset.shell("gusset_lining", "lining", t),
    ];
    let top_idx: Vec<usize> = ((rp.len() - 1)..=m).map(|k| rings * cols + k).collect();
    let mut rims = rim(&front, &top_idx, t);
    rims.append(&rim(&back, &top_idx, t));
    let gc = gz + 1;
    rims.append(&rim(&gusset, &(0..gc).collect::<Vec<_>>(), t));
    rims.append(&rim(&gusset, &((rp.len() - 1) * gc..rp.len() * gc).collect::<Vec<_>>(), t));
    parts.push(rims);

    let mut lines = Vec::new();
    // Seam piping where the panels meet the gusset.
    for side in [1.0, -1.0] {
        lines.push(Line::new(
            "piping",
            PIPING_R,
            rp.iter().map(|q| v3(q.x, q.y, side * d2)),
        ));
    }
    // Top hem topstitching.
    let ys = h - 1.5;
    let xs = p.width / 2.0 + (p.top_width - p.width) / 2.0 * ys / h - 0.6;
    for side in [1.0, -1.0] {
        let pts = densify(&[v2(-xs, ys), v2(xs, ys)], 0.5);
        lines.push(Line::new(
            "stitch",
            STITCH_R,
            pts.iter().map(|q| v3(q.x, q.y, side * (pill.z(*q) + 0.03))),
        ));
    }
    for s in [1.5, gl - 1.5] {
        let (pt, tg) = point_at(path, s);
        let o = outward(tg);
        lines.push(Line::new(
            "stitch",
            STITCH_R,
            (1..gz).map(|j| {
                let v = j as f64 / gz as f64;
                let xy = pt + o * (gsoft * (PI * v).sin() + 0.03);
                v3(xy.x, xy.y, d2 - v * p.depth)
            }),
        ));
    }

    // Handles.
    let k = solve_handle(p.strap_spacing, p.strap_length, h);
    let (x1, x2) = (-p.strap_spacing / 2.0, p.strap_spacing / 2.0);
    let sw = p.strap_width;
    for (side, name) in [(1.0, "strap_front"), (-1.0, "strap_back")] {
        let mut cl: Vec<V2> = Vec::new();
        let na = ((p.strap_attach / 0.5).ceil() as usize).max(2);
        for i in 0..na {
            cl.push(v2(x1, h - p.strap_attach + p.strap_attach * i as f64 / na as f64));
        }
        let (a, b) = (v2(x1, h), v2(x2, h));
        for i in 0..=64 {
            cl.push(bezier(a, a + v2(0.0, k), b + v2(0.0, k), b, i as f64 / 64.0));
        }
        for i in 1..=na {
            cl.push(v2(x2, h - p.strap_attach * i as f64 / na as f64));
        }
        let zc = |q: V2| if q.y <= h + 1e-9 { pill.z(q) } else { d2 } + STRAP_T / 2.0 + 0.02;
        let c3: Vec<V3> = cl.iter().map(|q| v3(q.x, q.y, side * zc(*q))).collect();
        let n = cl.len();
        let wdir: Vec<V3> = (0..n)
            .map(|i| {
                let tg = (cl[(i + 1).min(n - 1)] - cl[i.saturating_sub(1)]).norm();
                v3(tg.y, -tg.x, 0.0)
            })
            .collect();
        let tdir = v3(0.0, 0.0, side);
        let mut sc = vec![0.0];
        for w in cl.windows(2) {
            let last = *sc.last().unwrap();
            sc.push(last + (w[1] - w[0]).len());
        }
        let prof = 18;
        parts.push(Part::grid(
            name,
            "strap",
            n,
            prof + 1,
            |i, j| {
                let th = 2.0 * PI * j as f64 / prof as f64;
                let px = spow(th.cos(), 0.34) * sw / 2.0;
                let py = spow(th.sin(), 0.34) * STRAP_T / 2.0;
                (c3[i] + wdir[i] * px + tdir * py, [sc[i], px])
            },
            |i, _, pos| pos - c3[i],
        ));
        for sg in [-1.0, 1.0] {
            lines.push(Line::new(
                "stitch",
                STITCH_R,
                (0..n).map(|i| c3[i] + wdir[i] * (sg * (sw / 2.0 - 0.35)) + tdir * (STRAP_T / 2.0 + 0.015)),
            ));
        }
        // Box-X stitch where each end is sewn down.
        for x in [x1, x2] {
            let (y0, y1) = (h - p.strap_attach + 0.5, h - 0.6);
            let (xa, xb) = (x - (sw / 2.0 - 0.35), x + (sw / 2.0 - 0.35));
            for poly in [
                rect(xa, y0, xb, y1),
                vec![v2(xa, y0), v2(xb, y1)],
                vec![v2(xb, y0), v2(xa, y1)],
            ] {
                let pts = densify(&poly, 0.4);
                lines.push(Line::new(
                    "stitch",
                    STITCH_R,
                    pts.iter().map(|q| v3(q.x, q.y, side * (pill.z(*q) + STRAP_T + 0.04))),
                ));
            }
        }
    }

    if p.pocket {
        let (pw, ph) = (p.pocket_width, p.pocket_height);
        let yt = h - p.pocket_from_top;
        let (n, mrow) = (20, 16);
        let lift = 0.12;
        parts.push(Part::grid(
            "pocket",
            "pocket",
            mrow + 1,
            n + 1,
            |r, c| {
                let q = v2(-pw / 2.0 + pw * c as f64 / n as f64, yt - ph + ph * r as f64 / mrow as f64);
                (v3(q.x, q.y, pill.z(q) + lift), [q.x, q.y])
            },
            |_, _, _| v3(0.0, 0.0, 1.0),
        ));
        let i = 0.35;
        for poly in [
            vec![
                v2(-pw / 2.0 + i, yt),
                v2(-pw / 2.0 + i, yt - ph + i),
                v2(pw / 2.0 - i, yt - ph + i),
                v2(pw / 2.0 - i, yt),
            ],
            vec![v2(-pw / 2.0 + i, yt - 1.5), v2(pw / 2.0 - i, yt - 1.5)],
        ] {
            let pts = densify(&poly, 0.4);
            lines.push(Line::new(
                "stitch",
                STITCH_R,
                pts.iter().map(|q| v3(q.x, q.y, pill.z(*q) + lift + 0.03)),
            ));
        }
    }

    parts.insert(0, gusset);
    parts.insert(0, back);
    parts.insert(0, front);
    let mut mesh = Mesh { parts, lines, bounds: [0.0; 6] };
    mesh.finish();
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gusset_matches_panel_seam() {
        let p = ToteParams::default();
        let path = outline(&p);
        let pcs = pieces(&p, &path);
        let g = pcs.iter().find(|x| x.id == "gusset").unwrap();
        let glen = g.sew[2].y - g.sew[1].y;
        assert!((glen - polyline_length(&path)).abs() < 1e-9);
    }

    #[test]
    fn cut_line_contains_sew_line() {
        let p = ToteParams::default();
        let path = outline(&p);
        for pc in pieces(&p, &path) {
            assert!(area(&pc.cut_line) >= area(&pc.sew) - 1e-6, "{}", pc.id);
        }
    }

    #[test]
    fn handle_length_solved() {
        let k = solve_handle(14.0, 56.0, 38.0);
        let (a, b) = (v2(-7.0, 38.0), v2(7.0, 38.0));
        let pts: Vec<V2> = (0..=400)
            .map(|i| bezier(a, a + v2(0.0, k), b + v2(0.0, k), b, i as f64 / 400.0))
            .collect();
        assert!((polyline_length(&pts) - 56.0).abs() < 0.1);
    }
}
