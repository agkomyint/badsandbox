//! Tote bag: two body panels (front/back), a U-shaped gusset (side-bottom-side),
//! two handles and optional extras: patch pocket, angled zip pocket, zip-top lid,
//! contrast base, top binding, stripe band, handle tabs with D-rings, shoulder strap.
//!
//! The pattern is the source of truth. The gusset length is the exact length of the
//! panel's side+bottom outline, and the 3D model is built from the same outline,
//! so the pattern and the 3D view always agree.

use crate::geom::*;
use crate::hardware::*;
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
    /// Gusset depth at the top opening. 0 = same as `depth` (straight gusset);
    /// smaller tapers the gusset: wide, stable base, slimmer top.
    pub top_depth: f64,
    /// Bottom corner radius on the body panels.
    pub corner_radius: f64,
    /// How much the panels puff out in 3D (visual only, cm).
    pub softness: f64,
    /// Visible handle loop length.
    pub strap_length: f64,
    pub strap_width: f64,
    /// Distance between the two ends of one handle (centre to centre).
    pub strap_spacing: f64,
    /// How far each handle end (or handle tab) is sewn down onto the panel.
    pub strap_attach: f64,
    /// Top handles at all. Off = no handles (e.g. shoulder strap only, or a clutch).
    pub handles: bool,
    /// Handles hang from D-rings on tabs instead of being sewn flat to the panel.
    pub handle_tabs: bool,
    pub pocket: bool,
    pub pocket_width: f64,
    pub pocket_height: f64,
    pub pocket_from_top: f64,

    /// Zip-top lid across the opening.
    pub zip_top: bool,
    /// "coil", "metal" or "molded".
    pub zip_type: String,
    /// Zipper size: 3, 5, 8 or 10.
    pub zip_gauge: f64,
    /// Puller: "tab", "ring" or "tassel".
    pub zip_pull: String,
    /// Zipper end finish: "slim" (narrow wrapped tab), "square" (wide box tab)
    /// or "none" (ends tucked into the side seams, no tab).
    pub zip_ends: String,
    /// Exposed zip pocket set into the front panel.
    pub zip_pocket: bool,
    /// Zipper opening length.
    pub zip_pocket_length: f64,
    /// Degrees, positive rises to the right.
    pub zip_pocket_angle: f64,
    /// Zip centre, from the panel's centre line.
    pub zip_pocket_x: f64,
    pub zip_pocket_from_top: f64,
    /// Depth of the pocket bag hanging behind the zip.
    pub zip_pocket_depth: f64,

    /// Contrast base panel height (0 = none).
    pub base_height: f64,
    /// Finished width of a binding over the top edge (0 = none).
    pub binding: f64,
    /// Stripe band down the front panel.
    pub stripe: bool,
    pub stripe_width: f64,
    pub stripe_x: f64,
    /// Degrees from vertical.
    pub stripe_angle: f64,

    pub shoulder_strap: bool,
    pub shoulder_length: f64,
    pub shoulder_width: f64,

    pub lining: bool,
    /// Top hem depth (used when there is no lining and no binding).
    pub hem: f64,
    pub seam_allowance: f64,
    /// Fabric thickness. Sets the turn-of-cloth on folded straps and the lining ease.
    pub thickness: f64,
}

impl Default for ToteParams {
    fn default() -> Self {
        ToteParams {
            width: 36.0,
            top_width: 42.0,
            height: 38.0,
            depth: 12.0,
            top_depth: 0.0,
            corner_radius: 4.0,
            softness: 1.6,
            strap_length: 56.0,
            strap_width: 3.0,
            strap_spacing: 14.0,
            strap_attach: 5.0,
            handles: true,
            handle_tabs: false,
            pocket: true,
            pocket_width: 18.0,
            pocket_height: 14.0,
            pocket_from_top: 9.0,
            zip_top: false,
            zip_type: "coil".into(),
            zip_gauge: 5.0,
            zip_pull: "tab".into(),
            zip_ends: "slim".into(),
            zip_pocket: false,
            zip_pocket_length: 18.0,
            zip_pocket_angle: 0.0,
            zip_pocket_x: 0.0,
            zip_pocket_from_top: 8.0,
            zip_pocket_depth: 16.0,
            base_height: 0.0,
            binding: 0.0,
            stripe: false,
            stripe_width: 4.0,
            stripe_x: 0.0,
            stripe_angle: 0.0,
            shoulder_strap: false,
            shoulder_length: 115.0,
            shoulder_width: 3.0,
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
/// Strap length used to wrap a D-ring and sew down.
pub const RING_WRAP: f64 = 3.0;

pub fn sanitize(p: &mut ToteParams) -> Vec<String> {
    let mut w = Vec::new();
    let mut extra: Vec<String> = Vec::new();
    let mut clamp = |v: &mut f64, lo: f64, hi: f64, what: &str| {
        let hi = hi.max(lo);
        if *v < lo || *v > hi || !v.is_finite() {
            let nv = if v.is_finite() { v.clamp(lo, hi) } else { lo };
            w.push(format!("{what} adjusted from {:.1} to {:.1} cm", *v, nv));
            *v = nv;
        }
    };
    if !p.handles {
        p.handle_tabs = false;
    }
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
    clamp(&mut p.binding, 0.0, (p.height / 8.0).min(4.0), "Binding");
    if p.base_height > 0.0 {
        clamp(&mut p.base_height, 2.0, p.height * 0.6, "Base height");
    } else {
        p.base_height = 0.0;
    }
    if p.pocket {
        clamp(&mut p.pocket_width, 4.0, p.width - 4.0, "Pocket width");
        clamp(&mut p.pocket_from_top, p.strap_attach + 1.0, p.height - 6.0, "Pocket position");
        clamp(&mut p.pocket_height, 4.0, p.height - p.pocket_from_top - 2.0, "Pocket height");
    }

    if ZipKind::parse(&p.zip_type).is_none() {
        extra.push(format!("Unknown zipper type '{}', using coil", p.zip_type));
        p.zip_type = "coil".into();
    }
    if PullKind::parse(&p.zip_pull).is_none() {
        extra.push(format!("Unknown zipper pull '{}', using tab", p.zip_pull));
        p.zip_pull = "tab".into();
    }
    if !matches!(p.zip_ends.as_str(), "slim" | "square" | "none") {
        extra.push(format!("Unknown zipper end '{}', using slim", p.zip_ends));
        p.zip_ends = "slim".into();
    }
    let g = GAUGES.iter().copied().min_by(|a, b| (a - p.zip_gauge).abs().total_cmp(&(b - p.zip_gauge).abs())).unwrap();
    p.zip_gauge = g;
    let cw = zip_spec(p).chain_w();
    if p.top_depth > 0.0 {
        if p.top_depth >= p.depth {
            p.top_depth = 0.0;
        } else {
            clamp(&mut p.top_depth, 2.0, p.depth, "Top depth");
        }
    } else {
        p.top_depth = 0.0;
    }
    if p.zip_top {
        if p.top_depth > 0.0 {
            clamp(&mut p.top_depth, cw + 2.5, p.depth, "Top depth (zip top needs room for the zip panels)");
        } else {
            clamp(&mut p.depth, cw + 2.5, 50.0, "Depth (zip top needs room for the zip panels)");
        }
    }
    if p.zip_pocket {
        clamp(&mut p.zip_pocket_angle, -60.0, 60.0, "Zip pocket angle");
        clamp(&mut p.zip_pocket_length, 6.0, p.width * 0.85, "Zip pocket length");
        clamp(&mut p.zip_pocket_from_top, 3.0 + p.binding, p.height - 5.0 - p.base_height, "Zip pocket position");
        let xm = (p.width / 2.0 - 3.0).max(0.0);
        clamp(&mut p.zip_pocket_x, -xm, xm, "Zip pocket x");
        clamp(&mut p.zip_pocket_depth, 6.0, p.height * 0.9, "Zip pocket depth");
    }
    if p.stripe {
        clamp(&mut p.stripe_width, 1.0, p.width / 3.0, "Stripe width");
        let xm = p.width / 2.0 - p.stripe_width;
        clamp(&mut p.stripe_x, -xm, xm, "Stripe position");
        clamp(&mut p.stripe_angle, -45.0, 45.0, "Stripe angle");
    }
    if p.shoulder_strap {
        clamp(&mut p.shoulder_width, 1.5, 6.0, "Shoulder strap width");
        clamp(&mut p.shoulder_length, 50.0, 170.0, "Shoulder strap length");
    }
    w.extend(extra);
    w
}

pub fn zip_spec(p: &ToteParams) -> ZipSpec {
    ZipSpec {
        kind: ZipKind::parse(&p.zip_type).unwrap_or(ZipKind::Coil),
        pull: PullKind::parse(&p.zip_pull).unwrap_or(PullKind::Tab),
        gauge: p.zip_gauge,
    }
}

/// Effective gusset depth at the top opening.
pub fn top_depth(p: &ToteParams) -> f64 {
    if p.top_depth > 0.0 { p.top_depth.min(p.depth) } else { p.depth }
}

pub fn is_tapered(p: &ToteParams) -> bool {
    p.depth - top_depth(p) > 1e-6
}

/// Finished gusset width at panel height `y` (linear from base depth to top depth).
pub fn gusset_w_at(p: &ToteParams, y: f64) -> f64 {
    let td = top_depth(p);
    p.depth + (td - p.depth) * (y / p.height).clamp(0.0, 1.0)
}

/// Flat layout of a gusset strip over outline arc lengths `s0..s1`. For a tapered
/// gusset the strip's long axis is shortened so each slanted edge is exactly as long
/// as the panel edge it is sewn to.
struct Strip {
    s: Vec<f64>,
    y: Vec<f64>,
    w: Vec<f64>,
}

impl Strip {
    fn new(p: &ToteParams, path: &[V2], s0: f64, s1: f64) -> Strip {
        let n = (((s1 - s0) / 0.5).ceil() as usize).max(2);
        let s: Vec<f64> = (0..=n).map(|i| s0 + (s1 - s0) * i as f64 / n as f64).collect();
        let w: Vec<f64> = s.iter().map(|&si| gusset_w_at(p, point_at(path, si).0.y)).collect();
        let mut y = vec![0.0];
        for i in 1..=n {
            let ds = s[i] - s[i - 1];
            let dw = (w[i] - w[i - 1]) / 2.0;
            y.push(y[i - 1] + (ds * ds - dw * dw).max(0.0).sqrt());
        }
        Strip { s, y, w }
    }
    fn len(&self) -> f64 {
        *self.y.last().unwrap()
    }
    /// (y on the strip, finished width) at outline arc length `s`.
    fn at(&self, s: f64) -> (f64, f64) {
        let i = self.s.partition_point(|&x| x < s).clamp(1, self.s.len() - 1);
        let t = ((s - self.s[i - 1]) / (self.s[i] - self.s[i - 1])).clamp(0.0, 1.0);
        (self.y[i - 1] + (self.y[i] - self.y[i - 1]) * t, self.w[i - 1] + (self.w[i] - self.w[i - 1]) * t)
    }
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

/// How far each handle end is turned under before it is sewn down (hides the raw end).
pub const STRAP_TURN: f64 = 1.5;
/// Turning gap left open in the lining.
const GAP_MAX: f64 = 15.0;

/// How the top edge is finished.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Top {
    /// Lined: outer and lining sewn right sides together, turned through a gap.
    Bagged,
    /// Unlined: double-turned hem.
    Hem,
    /// Raw edges wrapped in a binding strip.
    Bound,
}

pub fn top_finish(p: &ToteParams) -> Top {
    if p.binding > 0.0 {
        Top::Bound
    } else if p.lining {
        Top::Bagged
    } else {
        Top::Hem
    }
}

fn top_allow(p: &ToteParams, top: Top) -> f64 {
    match top {
        Top::Bagged => p.seam_allowance,
        Top::Hem => p.hem + 1.0,
        Top::Bound => 0.0,
    }
}

/// Lining is cut this much smaller so it sits flat inside the bag instead of bagging.
pub fn lining_ease(p: &ToteParams) -> f64 {
    (p.thickness * 2.0).clamp(0.3, 0.6)
}

/// The lining's own (slightly smaller) dimensions.
pub fn lining_params(p: &ToteParams) -> ToteParams {
    let e = lining_ease(p);
    let mut l = p.clone();
    l.width -= e;
    l.top_width -= e;
    l.height -= e;
    l.depth -= e;
    if l.top_depth > 0.0 {
        l.top_depth -= e;
    }
    l.corner_radius = (p.corner_radius - e / 2.0).max(0.0);
    l
}

/// Leftmost (`right = false`) or rightmost x where closed polygon `poly` crosses height `y`.
fn x_at(poly: &[V2], y: f64, right: bool) -> f64 {
    let n = poly.len();
    let mut best: Option<f64> = None;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a.y - y) * (b.y - y) > 0.0 || (a.y - b.y).abs() < 1e-12 {
            continue;
        }
        let x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
        best = Some(match best {
            None => x,
            Some(v) if right => v.max(x),
            Some(v) => v.min(x),
        });
    }
    best.unwrap_or(0.0)
}

/// Arc length along the outline where it first drops to height `y` (left side).
fn s_at_height(path: &[V2], y: f64) -> f64 {
    let mut acc = 0.0;
    for w in path.windows(2) {
        let l = (w[1] - w[0]).len();
        if w[0].y >= y && w[1].y <= y {
            let t = if (w[0].y - w[1].y).abs() < 1e-12 { 0.0 } else { (w[0].y - y) / (w[0].y - w[1].y) };
            return acc + l * t;
        }
        acc += l;
    }
    acc
}

/// Splits the outline at height `y` into the upper chain (tl..L, R..tr) and the
/// lower chain (L..R).
fn split_path(path: &[V2], y: f64) -> (Vec<V2>, Vec<V2>) {
    let gl = polyline_length(path);
    let s1 = s_at_height(path, y);
    let (l, r) = (point_at(path, s1).0, point_at(path, gl - s1).0);
    let mut upper = Vec::new();
    let mut lower = vec![l];
    let mut acc = 0.0;
    upper.push(path[0]);
    for w in path.windows(2) {
        acc += (w[1] - w[0]).len();
        let q = w[1];
        if acc < s1 - 1e-9 {
            upper.push(q);
        } else if acc < gl - s1 - 1e-9 {
            lower.push(q);
        }
    }
    upper.push(l);
    upper.push(r);
    lower.push(r);
    let mut acc = 0.0;
    for w in path.windows(2) {
        acc += (w[1] - w[0]).len();
        if acc > gl - s1 + 1e-9 {
            upper.push(w[1]);
        }
    }
    (dedupe(upper), dedupe(lower))
}

/// Arc-length positions on the outline where notches go (side midpoints + bottom centre).
fn notch_positions(p: &ToteParams, path: &[V2]) -> Vec<f64> {
    let l = polyline_length(path);
    let side = (v2(-p.top_width / 2.0, p.height) - v2(-p.width / 2.0, 0.0)).len();
    vec![side / 2.0, l / 2.0, l - side / 2.0]
}

/// Where the gusset wraps the panel's bottom corners, as arc-length ranges along the
/// outline. A sharp corner gives an empty range (a single pivot point).
fn corner_ranges(p: &ToteParams, path: &[V2]) -> [(f64, f64); 2] {
    let gl = polyline_length(path);
    let tl = v2(-p.top_width / 2.0, p.height);
    let bl = v2(-p.width / 2.0, 0.0);
    let br = v2(p.width / 2.0, 0.0);
    let arc = fillet(tl, bl, br, p.corner_radius, 14);
    let start = (arc[0] - tl).len();
    let len = polyline_length(&arc);
    [(start, start + len), (gl - start - len, gl - start)]
}

/// Range of `t` along the line `o + dir*t` that lies inside closed `poly` and between
/// heights `y0`..`y1`.
fn line_range(poly: &[V2], o: V2, dir: V2, y0: f64, y1: f64) -> Option<(f64, f64)> {
    let n = poly.len();
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..n {
        let a = poly[i];
        let e = poly[(i + 1) % n] - a;
        let den = dir.cross(e);
        if den.abs() < 1e-12 {
            continue;
        }
        let t = (a - o).cross(e) / den;
        let u = (a - o).cross(dir) / den;
        if (-1e-9..=1.0 + 1e-9).contains(&u) {
            lo = lo.min(t);
            hi = hi.max(t);
        }
    }
    if dir.y.abs() > 1e-9 {
        let (ta, tb) = ((y0 - o.y) / dir.y, (y1 - o.y) / dir.y);
        lo = lo.max(ta.min(tb));
        hi = hi.min(ta.max(tb));
    }
    (hi > lo + 0.5).then_some((lo, hi))
}

/// The stripe band on the front panel: centre line + the `t` ranges of its two edges.
pub struct Band {
    pub c: V2,
    pub dir: V2,
    pub perp: V2,
    pub w: f64,
}

impl Band {
    fn new(p: &ToteParams) -> Band {
        let a = p.stripe_angle.to_radians();
        let dir = v2(a.sin(), a.cos());
        let y0 = p.base_height;
        let y1 = p.height - p.binding;
        Band { c: v2(p.stripe_x, (y0 + y1) / 2.0), dir, perp: v2(dir.y, -dir.x), w: p.stripe_width }
    }
    fn range(&self, p: &ToteParams, poly: &[V2], o: f64) -> Option<(f64, f64)> {
        line_range(poly, self.c + self.perp * o, self.dir, p.base_height, p.height - p.binding)
    }
    fn at(&self, o: f64, t: f64) -> V2 {
        self.c + self.perp * o + self.dir * t
    }
    fn outline(&self, p: &ToteParams, poly: &[V2]) -> Option<Vec<V2>> {
        let hw = self.w / 2.0;
        let (a0, a1) = self.range(p, poly, -hw)?;
        let (b0, b1) = self.range(p, poly, hw)?;
        Some(vec![self.at(-hw, a0), self.at(hw, b0), self.at(hw, b1), self.at(-hw, a1), self.at(-hw, a0)])
    }
}

/// Zip pocket window on the front panel: centre, direction, half length, window height.
fn zip_window(p: &ToteParams) -> (V2, V2, f64, f64) {
    let a = p.zip_pocket_angle.to_radians();
    let c = v2(p.zip_pocket_x, p.height - p.zip_pocket_from_top);
    (c, v2(a.cos(), a.sin()), p.zip_pocket_length / 2.0 + 0.5, zip_spec(p).chain_w() + 0.6)
}

/// Placement marks for the outer front panel (handles, pockets, stripe).
fn front_marks(p: &ToteParams, poly: &[V2]) -> (Vec<Vec<V2>>, Vec<Label>, Vec<String>) {
    let h = p.height;
    let mut marks = Vec::new();
    let mut labels = Vec::new();
    let mut notes = Vec::new();
    for sx in if p.handles { vec![-1.0, 1.0] } else { vec![] } {
        let x = sx * p.strap_spacing / 2.0;
        let hw = if p.handle_tabs { p.strap_width / 2.0 + 0.5 } else { p.strap_width / 2.0 };
        marks.push(rect(x - hw, h - p.strap_attach, x + hw, h - p.binding));
    }
    if p.pocket {
        let yt = h - p.pocket_from_top;
        marks.push(rect(-p.pocket_width / 2.0, yt - p.pocket_height, p.pocket_width / 2.0, yt));
        notes.push("Patch pocket: front panel only".into());
    }
    if p.zip_pocket {
        let (c, d, hl, wh) = zip_window(p);
        let n = d.perp();
        let k = [c - d * hl - n * (wh / 2.0), c + d * hl - n * (wh / 2.0), c + d * hl + n * (wh / 2.0), c - d * hl + n * (wh / 2.0)];
        marks.push(vec![k[0], k[1], k[2], k[3], k[0]]);
        let (s0, s1) = (c - d * (hl - 1.0), c + d * (hl - 1.0));
        marks.push(vec![k[0], s0, k[3]]);
        marks.push(vec![s0, s1]);
        marks.push(vec![k[1], s1, k[2]]);
        labels.push(Label { at: c + n * (wh / 2.0 + 0.8), text: "ZIP WINDOW - cut on centre line + Y".into(), vertical: false });
        notes.push("Zip window: front panel only".into());
    }
    if p.stripe {
        if let Some(o) = Band::new(p).outline(p, poly) {
            marks.push(o);
            notes.push("Stripe: front panel only".into());
        }
    }
    (marks, labels, notes)
}

/// A body panel piece. `sew` is an open chain whose closing edge (last -> first) is
/// either the bag's top edge (`top = Some`) or a seam.
#[allow(clippy::too_many_arguments)]
fn panel_piece(
    p: &ToteParams,
    id: &str,
    name: &str,
    cut: &str,
    sew: Vec<V2>,
    top: Option<Top>,
    notches: Vec<Notch>,
    marks: Vec<Vec<V2>>,
    labels: Vec<Label>,
    notes: Vec<String>,
    grain: [V2; 2],
) -> Piece {
    let sa = p.seam_allowance;
    let h = p.height;
    let hem = p.hem;
    let n = sew.len();
    let cut_line = if top == Some(Top::Hem) {
        // Hem allowance mirrored about the fold lines, so the turned hem lies exactly
        // on the (tapered) body instead of flaring past the side seams.
        let mut d = vec![sa; n];
        d[n - 1] = 0.0;
        let base = offset_polygon(&sew, &d);
        let xr = |y: f64| x_at(&base, y, true);
        let xl = |y: f64| x_at(&base, y, false);
        let mut c = base.clone();
        c.extend([
            v2(xr(h - hem), h + hem),
            v2(xr(h + 1.0 - hem), h + hem + 1.0),
            v2(xl(h + 1.0 - hem), h + hem + 1.0),
            v2(xl(h - hem), h + hem),
        ]);
        c
    } else {
        let mut d = vec![sa; n];
        d[n - 1] = top.map_or(sa, |t| top_allow(p, t));
        offset_polygon(&sew, &d)
    };
    let mut notches = notches;
    if let Some(t) = top {
        let a = top_allow(p, t);
        if a > 0.0 {
            notches.push(Notch { at: v2(0.0, h + a), dir: v2(0.0, -1.0), depth: notch_depth(sa) });
        }
    }
    let folds = if top == Some(Top::Hem) {
        let span = p.top_width / 2.0 + sa + 1.0;
        vec![[v2(-span, h), v2(span, h)], [v2(-span, h + hem), v2(span, h + hem)]]
    } else {
        vec![]
    };
    Piece {
        id: id.into(),
        name: name.into(),
        cut: cut.into(),
        sew,
        cut_line,
        folds,
        notches,
        clips: vec![],
        grain,
        marks,
        labels,
        notes,
    }
}

/// Outline notches (side midpoints, bottom centre) that fall in `y0..y1`.
fn outline_notches(p: &ToteParams, path: &[V2], y0: f64, y1: f64) -> Vec<Notch> {
    let sa = p.seam_allowance;
    notch_positions(p, path)
        .iter()
        .filter_map(|&s| {
            let (pt, t) = point_at(path, s);
            if pt.y < y0 + 0.5 || pt.y > y1 - 0.5 {
                return None;
            }
            let o = outward(t);
            Some(Notch { at: pt + o * sa, dir: -o, depth: notch_depth(sa) })
        })
        .collect()
}

/// Gusset strip covering outline arc length `s0..s1`. y = arc length - s0.
#[allow(clippy::too_many_arguments)]
fn gusset_piece(p: &ToteParams, path: &[V2], s0: f64, s1: f64, top: Top, lining: bool, id: &str, name: &str, cut: &str) -> Piece {
    let sa = p.seam_allowance;
    let dpt = p.depth;
    let gl = polyline_length(path);
    let len = s1 - s0;
    let top_a = s0 < 1e-9;
    let top_b = s1 > gl - 1e-9;
    let ta = top_allow(p, top);
    let ea = if top_a { ta } else { sa };
    let eb = if top_b { ta } else { sa };
    let taper = is_tapered(p);
    let strip = Strip::new(p, path, s0, s1);
    let xc = dpt / 2.0;
    // (y, left edge x, right edge x) on the strip at outline arc length s.
    let at = |s: f64| -> (f64, f64, f64) {
        if taper {
            let (y, w) = strip.at(s);
            (y, xc - w / 2.0, xc + w / 2.0)
        } else {
            (s - s0, 0.0, dpt)
        }
    };
    let len = if taper { strip.len() } else { len };
    let (sew, cut_line) = if taper {
        let n = strip.s.len() - 1;
        let mut sew = vec![v2(xc - strip.w[0] / 2.0, 0.0)];
        sew.extend((0..=n).map(|i| v2(xc + strip.w[i] / 2.0, strip.y[i])));
        sew.extend((1..=n).rev().map(|i| v2(xc - strip.w[i] / 2.0, strip.y[i])));
        let mut d = vec![ea];
        d.extend(std::iter::repeat(sa).take(n));
        d.push(eb);
        d.extend(std::iter::repeat(sa).take(n));
        let cut = offset_polygon(&sew, &d);
        (sew, cut)
    } else {
        let sew = vec![v2(0.0, 0.0), v2(dpt, 0.0), v2(dpt, len), v2(0.0, len)];
        let cut = offset_polygon(&sew, &[ea, sa, eb, sa]);
        (sew, cut)
    };

    let nd = notch_depth(sa);
    let mut notches = Vec::new();
    for &s in &notch_positions(p, path) {
        if s > s0 + 0.5 && s < s1 - 0.5 {
            let (y, xl, xr) = at(s);
            notches.push(Notch { at: v2(xr + sa, y), dir: v2(-1.0, 0.0), depth: nd });
            notches.push(Notch { at: v2(xl - sa, y), dir: v2(1.0, 0.0), depth: nd });
        }
    }
    if ea > 0.0 {
        notches.push(Notch { at: v2(dpt / 2.0, -ea), dir: v2(0.0, 1.0), depth: nd });
    }
    if eb > 0.0 {
        notches.push(Notch { at: v2(dpt / 2.0, len + eb), dir: v2(0.0, -1.0), depth: nd });
    }

    // Clips where the strip has to turn the panel's bottom corners.
    let cd = clip_depth(sa);
    let mut clips = Vec::new();
    for (a, b) in corner_ranges(p, path) {
        let l = b - a;
        let k = if l < 1e-6 { 1 } else { ((l / 1.2).ceil() as usize).max(2) };
        for i in 0..k {
            let s = if k == 1 { a } else { a + l * (i as f64 + 0.5) / k as f64 };
            if s >= s0 - 1e-9 && s <= s1 + 1e-9 {
                let (y, xl, xr) = at(s);
                clips.push(Notch { at: v2(xr + sa, y), dir: v2(-1.0, 0.0), depth: cd });
                clips.push(Notch { at: v2(xl - sa, y), dir: v2(1.0, 0.0), depth: cd });
            }
        }
    }

    let mut folds = Vec::new();
    if top == Top::Hem {
        let (a, b) = (-sa - 1.0, dpt + sa + 1.0);
        if top_a {
            folds.push([v2(a, 0.0), v2(b, 0.0)]);
            folds.push([v2(a, -p.hem), v2(b, -p.hem)]);
        }
        if top_b {
            folds.push([v2(a, len), v2(b, len)]);
            folds.push([v2(a, len + p.hem), v2(b, len + p.hem)]);
        }
    }

    let mut marks = Vec::new();
    let mut labels = Vec::new();
    let mut notes = if taper {
        let (wt_a, wt_b) = (strip.w[0], *strip.w.last().unwrap());
        vec![format!(
            "{:.1} cm long; tapers {:.1} cm at the ends to {:.1} cm across the base",
            len,
            wt_a.min(wt_b),
            strip.w.iter().cloned().fold(0.0, f64::max)
        )]
    } else {
        vec![format!("{:.1} x {:.1} cm finished", dpt, len)]
    };
    if taper {
        notes.push("Slanted edges match the panel edge exactly; sew without easing".into());
    }
    if top_a && top_b {
        notes.push("Length = panel side + bottom; match notches".into());
    }
    if !clips.is_empty() {
        if p.corner_radius < 1e-6 {
            notes.push("Square corners: clip to the stitch line and pivot".into());
        } else {
            notes.push("Clip at the corner marks after sewing".into());
        }
    }
    if p.shoulder_strap && !lining && (top_a || top_b) {
        marks.push(rect(dpt / 2.0 - p.shoulder_width / 2.0 - 0.5, 0.0, dpt / 2.0 + p.shoulder_width / 2.0 + 0.5, 4.0));
        notes.push("Box = shoulder-strap tab".into());
    }
    if lining && top == Top::Bagged && top_a && top_b {
        // Turning gap on one long seam, centred on the bottom.
        let [(_, a_end), (b_start, _)] = corner_ranges(p, path);
        let g = GAP_MAX.min((b_start - a_end) * 0.6);
        let (g0, g1) = (len / 2.0 - g / 2.0, len / 2.0 + g / 2.0);
        let xl = at((s0 + s1) / 2.0).1;
        marks.push(vec![v2(xl, g0), v2(xl, g1)]);
        for y in [g0, g1] {
            marks.push(vec![v2(xl - sa, y), v2(xl + 0.8, y)]);
        }
        labels.push(Label { at: v2(xl + 1.0, len / 2.0), text: format!("LEAVE {:.0} CM OPEN", g), vertical: true });
        notes.push(format!("Leave {:.0} cm open on one side for turning", g));
    }
    if lining {
        notes.push(format!("Cut {:.1} cm smaller than the outer", lining_ease(p)));
    }

    Piece {
        id: id.into(),
        name: name.into(),
        cut: cut.into(),
        sew,
        cut_line,
        folds,
        notches,
        clips,
        grain: if taper { [v2(xc, len * 0.3), v2(xc, len * 0.7)] } else { [v2(dpt * 0.25, len * 0.3), v2(dpt * 0.25, len * 0.7)] },
        marks,
        labels,
        notes,
    }
}

/// Simple rectangle piece with an allowance per edge (bottom, right, top, left).
#[allow(clippy::too_many_arguments)]
fn rect_piece(id: &str, name: &str, cut: &str, w: f64, l: f64, allow: [f64; 4], folds: Vec<[V2; 2]>, marks: Vec<Vec<V2>>, notes: Vec<String>) -> Piece {
    let sew = vec![v2(0.0, 0.0), v2(w, 0.0), v2(w, l), v2(0.0, l)];
    let cut_line = if allow.iter().all(|a| *a == 0.0) { sew.clone() } else { offset_polygon(&sew, &allow) };
    let grain = if w < l { [v2(w * 0.5, l * 0.3), v2(w * 0.5, l * 0.7)] } else { [v2(w * 0.3, l * 0.5), v2(w * 0.7, l * 0.5)] };
    Piece {
        id: id.into(),
        name: name.into(),
        cut: cut.into(),
        sew,
        cut_line,
        folds,
        notches: vec![],
        clips: vec![],
        grain,
        marks,
        labels: vec![],
        notes,
    }
}

/// A strap folded in quarters lengthwise (edges to centre, then in half).
fn folded_strap(id: &str, name: &str, cut: &str, finished_w: f64, len: f64, t: f64, end_folds: f64, notes: Vec<String>) -> Piece {
    let w4 = finished_w * 4.0 + 3.0 * t;
    let mut folds: Vec<[V2; 2]> = (1..4).map(|i| [v2(w4 * i as f64 / 4.0, 0.0), v2(w4 * i as f64 / 4.0, len)]).collect();
    if end_folds > 0.0 {
        folds.push([v2(0.0, end_folds), v2(w4, end_folds)]);
        folds.push([v2(0.0, len - end_folds), v2(w4, len - end_folds)]);
    }
    rect_piece(id, name, cut, w4, len, [0.0; 4], folds, vec![], notes)
}

pub fn pieces(p: &ToteParams, path: &[V2]) -> Vec<Piece> {
    let sa = p.seam_allowance;
    let h = p.height;
    let top = top_finish(p);
    let gl = polyline_length(path);
    let b = p.base_height;
    let spec = zip_spec(p);
    let mut out = Vec::new();

    // Body.
    let grain = [v2(-p.width * 0.28, h * 0.2), v2(-p.width * 0.28, h * 0.8)];
    let (marks, labels, mut notes) = front_marks(p, path);
    notes.insert(0, format!("Finished {:.1} (bottom) / {:.1} (top) x {:.1} cm", p.width, p.top_width, h));
    if top == Top::Hem {
        notes.push(format!("Top hem: turn 1 cm, then {:.1} cm", p.hem));
    }
    if b > 0.0 {
        let (upper, lower) = split_path(path, b);
        let mut nu = outline_notches(p, path, b, h);
        nu.push(Notch { at: v2(0.0, b - sa), dir: v2(0.0, 1.0), depth: notch_depth(sa) });
        let grain_u = [v2(-p.width * 0.28, b + (h - b) * 0.2), v2(-p.width * 0.28, b + (h - b) * 0.8)];
        out.push(panel_piece(p, "body", "Body panel", "Cut 2 outer", upper, Some(top), nu, marks, labels, notes, grain_u));
        let mut nl = outline_notches(p, path, 0.0, b);
        nl.push(Notch { at: v2(0.0, b + sa), dir: v2(0.0, -1.0), depth: notch_depth(sa) });
        let gb = [v2(-p.width * 0.25, b * 0.25), v2(-p.width * 0.25, b * 0.75)];
        out.push(panel_piece(
            p, "base", "Base panel", "Cut 2 trim", lower, None, nl, vec![], vec![],
            vec![format!("Base {:.1} cm high", b), "Sew to the body panel, press seam down, topstitch".into()], gb,
        ));
        let s1 = s_at_height(path, b);
        out.push(gusset_piece(p, path, 0.0, s1, top, false, "gusset_side", "Gusset side", "Cut 2 outer"));
        out.push(gusset_piece(p, path, s1, gl - s1, top, false, "gusset_base", "Gusset base", "Cut 1 trim"));
    } else {
        let nt = outline_notches(p, path, 0.0, h);
        out.push(panel_piece(p, "body", "Body panel", "Cut 2 outer", path.to_vec(), Some(top), nt, marks, labels, notes, grain));
        out.push(gusset_piece(p, path, 0.0, gl, top, false, "gusset", "Gusset", "Cut 1 outer"));
    }

    // Lining.
    if p.lining {
        let lp = lining_params(p);
        let lpath = outline(&lp);
        let ltop = if top == Top::Bound { Top::Bound } else { Top::Bagged };
        let nt = outline_notches(&lp, &lpath, 0.0, lp.height);
        out.push(panel_piece(
            &lp, "body_lining", "Body lining", "Cut 2 lining", lpath.clone(), Some(ltop), nt, vec![], vec![],
            vec![
                format!("Finished {:.1} / {:.1} x {:.1} cm", lp.width, lp.top_width, lp.height),
                format!("Cut {:.1} cm smaller than the outer so it sits flat", lining_ease(p)),
            ],
            [v2(-lp.width * 0.28, lp.height * 0.2), v2(-lp.width * 0.28, lp.height * 0.8)],
        ));
        let lgl = polyline_length(&lpath);
        out.push(gusset_piece(&lp, &lpath, 0.0, lgl, ltop, true, "gusset_lining", "Gusset lining", "Cut 1 lining"));
    }

    // Handles.
    if p.handles {
        let sw = p.strap_width;
        let a = if p.handle_tabs { RING_WRAP } else { p.strap_attach + STRAP_TURN };
        let len = p.strap_length + 2.0 * a;
        let mut notes = vec![
            format!("Finished {:.1} cm wide, {:.1} cm loop", sw, p.strap_length),
            "Fold edges to centre, fold again, topstitch".into(),
        ];
        let mut s = if p.handle_tabs {
            notes.push(format!("Ends: loop {:.1} cm through the D-ring and stitch", RING_WRAP));
            folded_strap("strap", "Handle", "Cut 2", sw, len, p.thickness, RING_WRAP, notes)
        } else {
            notes.push(format!("Turn ends under {:.1} cm; sew down to the dashed line", STRAP_TURN));
            folded_strap("strap", "Handle", "Cut 2", sw, len, p.thickness, STRAP_TURN, notes)
        };
        if !p.handle_tabs {
            let w4 = s.sew[1].x;
            s.marks = vec![vec![v2(0.0, a), v2(w4, a)], vec![v2(0.0, len - a), v2(w4, len - a)]];
        }
        out.push(s);
        if p.handle_tabs {
            let tw = sw + 1.0;
            let tl = 2.0 * p.strap_attach + 2.0;
            out.push(rect_piece(
                "handle_tab", "Handle tab", "Cut 4 trim", tw, tl, [0.0; 4],
                vec![[v2(0.0, tl / 2.0), v2(tw, tl / 2.0)]],
                vec![],
                vec![format!("Fold around the D-ring bar; stitch {:.1} cm down", p.strap_attach)],
            ));
        }
    }

    if p.shoulder_strap {
        let w = p.shoulder_width;
        out.push(folded_strap(
            "shoulder", "Shoulder strap", "Cut 1", w, p.shoulder_length + 2.0 * RING_WRAP, p.thickness, RING_WRAP,
            vec![
                format!("Finished {:.1} cm wide, {:.0} cm long", w, p.shoulder_length),
                format!("Ends: loop {:.1} cm through the D-rings and stitch", RING_WRAP),
            ],
        ));
        out.push(rect_piece(
            "shoulder_tab", "Strap tab", "Cut 2 trim", w + 1.0, 10.0, [0.0; 4],
            vec![[v2(0.0, 5.0), v2(w + 1.0, 5.0)]],
            vec![],
            vec!["Fold around a D-ring; sew to the gusset top at the box".into()],
        ));
    }

    if p.pocket {
        let (pw, ph) = (p.pocket_width, p.pocket_height);
        out.push(rect_piece(
            "pocket", "Patch pocket", "Cut 1 outer", pw, ph, [sa, sa, p.hem + 1.0, sa],
            vec![
                [v2(-sa - 0.5, ph), v2(pw + sa + 0.5, ph)],
                [v2(-sa - 0.5, ph + p.hem), v2(pw + sa + 0.5, ph + p.hem)],
            ],
            vec![],
            vec![format!("Finished {:.1} x {:.1} cm", pw, ph)],
        ));
    }

    if p.zip_pocket {
        let (_, _, hl, wh) = zip_window(p);
        let w = 2.0 * hl + 3.0;
        let l = 2.0 * p.zip_pocket_depth + wh + 3.0;
        let yc = l - 1.5 - wh / 2.0;
        let win = rect(1.5, yc - wh / 2.0, w - 1.5, yc + wh / 2.0);
        out.push(rect_piece(
            "zip_pocket", "Zip pocket bag", "Cut 1 lining", w, l, [sa; 4],
            vec![],
            vec![win],
            vec![
                format!("{:.0} cm zip, pocket {:.0} cm deep", p.zip_pocket_length, p.zip_pocket_depth),
                "Match window to the panel mark (it is angled there)".into(),
                "Fold bottom up to the top edge, sew sides".into(),
            ],
        ));
    }

    if p.zip_top {
        let cw = spec.chain_w();
        let ws = (top_depth(p) - cw) / 2.0;
        let l = p.top_width;
        let mk = |id: &str, name: &str, cut: &str| {
            let mut pc = rect_piece(
                id, name, cut, l, ws, [sa; 4], vec![], vec![],
                vec![format!("{:.1} x {:.1} cm finished; zip edge on top", l, ws)],
            );
            pc.notches = vec![
                Notch { at: v2(l / 2.0, -sa), dir: v2(0.0, 1.0), depth: notch_depth(sa) },
                Notch { at: v2(l / 2.0, ws + sa), dir: v2(0.0, -1.0), depth: notch_depth(sa) },
            ];
            pc
        };
        out.push(mk("zip_panel", "Zip panel", "Cut 2 outer"));
        if p.lining {
            out.push(mk("zip_panel_lining", "Zip panel lining", "Cut 2 lining"));
        }
        if p.zip_ends != "none" {
            // Slim tabs are cut just wider than the tape; square ones get a generous margin.
            let (tw, tl) = if p.zip_ends == "slim" { (spec.tape_w() + 0.4, 4.0) } else { (spec.tape_w() + 1.0, 6.0) };
            out.push(rect_piece(
                "zip_tab", "Zip end tab", "Cut 2 trim", tw, tl, [0.0; 4],
                vec![[v2(0.0, tl / 2.0), v2(tw, tl / 2.0)]],
                vec![],
                vec!["Fold over each zipper end".into()],
            ));
        }
    }

    if p.stripe {
        let band = Band::new(p);
        let hw = p.stripe_width / 2.0;
        let l = [-hw, hw]
            .iter()
            .filter_map(|o| band.range(p, path, *o))
            .map(|(a, b)| b - a)
            .fold(0.0, f64::max);
        if l > 0.0 {
            let w = p.stripe_width;
            out.push(rect_piece(
                "stripe", "Stripe band", "Cut 1 (or webbing)", w, l, [sa, 1.0, sa, 1.0],
                vec![[v2(0.0, -sa), v2(0.0, l + sa)], [v2(w, -sa), v2(w, l + sa)]],
                vec![vec![v2(w / 3.0, 0.0), v2(w / 3.0, l)], vec![v2(2.0 * w / 3.0, 0.0), v2(2.0 * w / 3.0, l)]],
                vec![
                    format!("{:.1} cm wide, three equal bands", w),
                    "Or use striped webbing; ends go into the seams".into(),
                ],
            ));
        }
    }

    if top == Top::Bound {
        let layers = if p.lining { 2.0 } else { 1.0 };
        let w = 2.0 * p.binding + 2.0 + 2.0 * layers * p.thickness;
        let l = 2.0 * p.top_width + 2.0 * top_depth(p) + 3.0;
        let c = w / 2.0;
        out.push(rect_piece(
            "binding", "Top binding", "Cut 1 trim (bias for fabric)", l, w, [0.0; 4],
            vec![[v2(0.0, 1.0), v2(l, 1.0)], [v2(0.0, c), v2(l, c)], [v2(0.0, w - 1.0), v2(l, w - 1.0)]],
            vec![],
            vec![
                format!("{:.1} cm finished binding", p.binding),
                "Join ends at a side seam (3 cm overlap)".into(),
                "Leather: skip the 1 cm turn-unders".into(),
            ],
        ));
    }
    out
}

/// Things to buy besides fabric.
pub fn supplies(p: &ToteParams) -> Vec<String> {
    let spec = zip_spec(p);
    let mut s = Vec::new();
    if p.zip_top {
        s.push(format!("Top: {}", spec.buy(p.top_width - 3.0)));
    }
    if p.zip_pocket {
        s.push(format!("Pocket: {}", spec.buy(p.zip_pocket_length)));
    }
    if p.handle_tabs {
        s.push(format!("4 D-rings, {:.1} cm inside width", p.strap_width + 0.3));
    }
    if p.shoulder_strap {
        s.push(format!("2 D-rings, {:.1} cm inside width", p.shoulder_width + 0.3));
    }
    if p.stripe {
        s.push(format!("Optional: {:.1} cm striped webbing instead of the stripe band", p.stripe_width));
    }
    s.push("Thread to match (topstitch weight for visible stitching)".into());
    s
}

/// Numbered sewing order, filled in with this design's numbers.
pub fn steps(p: &ToteParams) -> Vec<String> {
    let sa = p.seam_allowance;
    let top = top_finish(p);
    let mut s = Vec::new();
    if p.handles {
        s.push(if p.handle_tabs {
            "Handles: press long edges to the centre, fold in half again, topstitch both edges.".to_string()
        } else {
            format!("Handles: press long edges to the centre, fold in half again, topstitch both edges. Turn each end under {STRAP_TURN:.1} cm.")
        });
    }
    if p.shoulder_strap {
        s.push(if p.handles {
            "Shoulder strap: fold and topstitch the same way.".into()
        } else {
            "Shoulder strap: press long edges to the centre, fold in half again, topstitch both edges.".into()
        });
    }
    if p.base_height > 0.0 {
        s.push(format!(
            "Base: sew a base panel to the bottom of each body panel at {sa:.1} cm, matching the centre notch. Press down, topstitch on the base. Sew the gusset sides to the gusset base."
        ));
    }
    if p.stripe {
        s.push("Stripe: press long edges under 1 cm (skip for webbing). Place on the front panel mark, edgestitch both sides. Ends stay raw - they go into the seams.".into());
    }
    if p.pocket {
        s.push(format!(
            "Patch pocket: turn top 1 cm then {:.1} cm, topstitch. Press other edges under {sa:.1} cm. Topstitch to the front panel at the marked box; backtack the top corners.",
            p.hem
        ));
    }
    if p.zip_pocket {
        s.push("Zip pocket: place the pocket bag right sides together on the front panel, windows matched. Stitch the window box, cut the centre line and Y into the corners, turn the bag through and press.".into());
        s.push("Centre the zipper behind the window, slider at the high end. Edgestitch around the window. Fold the pocket bag up, sew its sides (keep the panel clear).".into());
    }
    if p.handle_tabs {
        s.push(format!(
            "Handle tabs: fold each tab around a D-ring bar, place on the box marks, stitch {:.1} cm down with a box-X.",
            p.strap_attach
        ));
    } else if p.handles && top != Top::Hem {
        s.push("Handles on: place ends on the boxes (turned edge down, loop pointing down), box-X stitch through the outer panel only. Repeat on the back panel.".into());
    }
    if p.shoulder_strap {
        s.push("Strap tabs: fold each around a D-ring, baste to the gusset tops at the box marks.".into());
    }
    let clip = if p.corner_radius < 1e-6 {
        "pivot at the corners, clipping the gusset to the stitch line"
    } else {
        "clip the gusset allowance at the corner marks"
    };
    s.push(format!(
        "Outer: sew gusset to front panel right sides together at {sa:.1} cm, matching notches; {clip}. Repeat for the back.{}",
        if p.lining { " Turn right side out." } else { " Finish the seam allowances (zigzag, overlock or bind)." }
    ));
    if p.zip_top {
        s.push(format!(
            "Zip lid: sandwich each zipper tape between an outer and {} zip panel, sew, press back, topstitch. {}",
            if p.lining { "a lining" } else { "a folded-under" },
            if p.zip_ends == "none" {
                "Fold the zipper tape ends back at 45° and tack them so they disappear into the side seams."
            } else {
                "Fold the end tabs over the zipper ends."
            }
        ));
        s.push("Baste the lid to the top edge of the outer bag, right sides together, matching centre notches.".into());
    }
    match top {
        Top::Bagged => {
            s.push("Lining: sew the same way, leaving the marked gap open in one seam. Leave inside out.".into());
            s.push(format!(
                "Put the outer inside the lining (right sides together{} tucked down between). Match side seams and sew around the top at {sa:.1} cm.",
                match (p.handles, p.zip_top) {
                    (true, true) => ", handles and lid",
                    (true, false) => ", handles",
                    (false, true) => ", lid",
                    (false, false) => "",
                }
            ));
            s.push("Turn out through the gap. Close the gap by edgestitching. Push the lining inside and press the top edge.".into());
            s.push("Topstitch around the top 1.5 cm from the edge.".into());
        }
        Top::Hem => {
            s.push(format!(
                "Top hem: turn 1 cm, then {:.1} cm along the fold lines (the side allowances are shaped to match). Topstitch.",
                p.hem
            ));
            if p.handles && !p.handle_tabs {
                s.push("Handles on: place ends on the boxes inside the bag, box-X stitch through all layers.".into());
            }
        }
        Top::Bound => {
            if p.lining {
                s.push("Lining: sew the same way (no gap needed). Drop it inside the outer, wrong sides together, and baste the top edges.".into());
            }
            s.push(format!(
                "Binding: wrap the strip over the raw top edge ({:.1} cm each side), start at a side seam, overlap the ends 3 cm. Edgestitch through all layers.",
                p.binding
            ));
        }
    }
    if p.handle_tabs {
        s.push(format!("Loop each handle end {RING_WRAP:.1} cm through its D-ring and stitch with a box-X."));
    }
    if p.shoulder_strap {
        s.push(format!("Loop the shoulder strap ends {RING_WRAP:.1} cm through the gusset D-rings and stitch."));
    }
    s.iter().enumerate().map(|(i, t)| format!("{}. {t}", i + 1)).collect()
}

/// The puffed front surface: z depends on how far a point is from the panel centre.
struct Pillow {
    poly: Vec<V2>,
    c: V2,
    amp: f64,
    /// Half the gusset depth at the base and at the top; panels lean in between.
    d2b: f64,
    d2t: f64,
    h: f64,
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
    /// Panel plane offset (half gusset width) at height `y`.
    fn half(&self, y: f64) -> f64 {
        self.d2b + (self.d2t - self.d2b) * (y / self.h).clamp(0.0, 1.0)
    }
    fn z(&self, p: V2) -> f64 {
        let s = self.s(p);
        self.half(p.y) + self.amp * (1.0 - s * s)
    }
    /// Surface normal of the front face at `p`.
    fn n(&self, p: V2) -> V3 {
        let e = 0.05;
        let dx = (self.z(p + v2(e, 0.0)) - self.z(p - v2(e, 0.0))) / (2.0 * e);
        let dy = (self.z(p + v2(0.0, e)) - self.z(p - v2(0.0, e))) / (2.0 * e);
        v3(-dx, -dy, 1.0).norm()
    }
}

fn bezier(a: V2, b: V2, c: V2, d: V2, t: f64) -> V2 {
    let u = 1.0 - t;
    a * (u * u * u) + b * (3.0 * u * u * t) + c * (3.0 * u * t * t) + d * (t * t * t)
}

fn bezier3(a: V3, b: V3, c: V3, d: V3, t: f64) -> V3 {
    let u = 1.0 - t;
    a * (u * u * u) + b * (3.0 * u * u * t) + c * (3.0 * u * t * t) + d * (t * t * t)
}

fn len3(p: &[V3]) -> f64 {
    p.windows(2).map(|w| (w[1] - w[0]).len()).sum()
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

/// Shoulder strap path: up from the left ring, down behind the bag, along the floor,
/// and back up to the right ring. `az` = how far the floor loop reaches back,
/// `yf` = height of the lowest part (floor when the strap is long enough).
/// Returns points and a 0..1 "lying flat" weight per point.
fn shoulder_path(pl: V3, pr: V3, d2: f64, az: f64, yf: f64) -> (Vec<V3>, Vec<f64>) {
    let zb = d2 + 7.0;
    let e = 4.0;
    let fl = v3(pl.x - e, yf, -zb);
    let fr = v3(pr.x + e, yf, -zb);
    let drop = |p: V3, f: V3, sx: f64| -> Vec<V3> {
        let c1 = p + v3(sx * 3.0, 4.0, -1.0);
        let c2 = f + v3(0.0, ((p.y - f.y) * 0.45).max(1.0), 0.0);
        (0..=30).map(|i| bezier3(p, c1, c2, f, i as f64 / 30.0)).collect()
    };
    let a = drop(pl, fl, -1.0);
    let mut b = drop(pr, fr, 1.0);
    b.reverse();
    let mut pts = a.clone();
    let mut wt: Vec<f64> = (0..a.len()).map(|i| (i as f64 / 30.0).powi(2)).collect();
    let (cx, ax) = ((fl.x + fr.x) / 2.0, (fr.x - fl.x) / 2.0);
    for i in 1..40 {
        let th = PI * i as f64 / 40.0;
        pts.push(v3(cx - ax * th.cos(), yf, -zb - az * th.sin()));
        wt.push(1.0);
    }
    let nb = b.len();
    for (i, q) in b.into_iter().enumerate() {
        pts.push(q);
        wt.push((1.0 - i as f64 / (nb - 1) as f64).powi(2));
    }
    (pts, wt)
}

pub fn mesh(p: &ToteParams, path: &[V2]) -> Mesh {
    let d2 = p.depth / 2.0;
    let h = p.height;
    let t = p.thickness;
    let top = top_finish(p);
    let spec = zip_spec(p);
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
    let d2t = top_depth(p) / 2.0;
    let pill = Pillow { c: centroid(&lp), poly: lp.clone(), amp: p.softness, d2b: d2, d2t, h };
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
                (v3(xy.x, xy.y, side * (pill.half(xy.y) + pill.amp * (1.0 - s * s))), [side * xy.x, xy.y])
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
            let hw = pill.half(rp[i].y);
            let z = hw - v * 2.0 * hw;
            let xy = rp[i] + nrm[i] * (gsoft * (PI * v).sin());
            (v3(xy.x, xy.y, z), [cum[i], z])
        },
        |i, _, _| v3(nrm[i].x, nrm[i].y, 0.0),
    );

    // Overlay on a body panel between heights y0..y1, `lift` above the surface.
    let region = |name: &str, mat: &str, side: f64, y0: f64, y1: f64, lift: f64| -> Part {
        let (y0, y1) = (y0.max(0.02), y1.min(h - 0.002));
        let ny = (((y1 - y0) / 0.6).ceil() as usize).max(2);
        let nx = 48;
        Part::grid(
            name,
            mat,
            ny + 1,
            nx + 1,
            |r, c| {
                let y = y0 + (y1 - y0) * r as f64 / ny as f64;
                let (xa, xb) = (x_at(&lp, y, false), x_at(&lp, y, true));
                let x = xa + (xb - xa) * c as f64 / nx as f64;
                (v3(x, y, side * (pill.z(v2(x, y)) + lift)), [side * x, y])
            },
            |_, _, _| v3(0.0, 0.0, side),
        )
    };
    // Overlay on the gusset between outline arc lengths s0..s1.
    let gpt = |s: f64, off: f64, v: f64| -> V3 {
        let (pt, tg) = point_at(path, s.clamp(0.0, gl));
        let xy = pt + outward(tg) * (gsoft * (PI * v).sin() + off);
        let hw = pill.half(pt.y);
        v3(xy.x, xy.y, hw - v * 2.0 * hw)
    };
    let gus_region = |name: &str, mat: &str, s0: f64, s1: f64, lift: f64| -> Part {
        let n = (((s1 - s0) / 0.5).ceil() as usize).max(2);
        let sv = |i: usize| s0 + (s1 - s0) * i as f64 / n as f64;
        Part::grid(
            name,
            mat,
            n + 1,
            gz + 1,
            |i, j| {
                let q = gpt(sv(i), lift, j as f64 / gz as f64);
                (q, [sv(i), q.z])
            },
            |i, _, _| {
                let o = outward(point_at(path, sv(i)).1);
                v3(o.x, o.y, 0.0)
            },
        )
    };
    let stitch3 = |pts: Vec<V3>| Line::new("stitch", STITCH_R, pts);
    let on_panel = |poly: &[V2], side: f64, lift: f64| -> Line {
        let pts = densify(poly, 0.4);
        Line::new("stitch", STITCH_R, pts.iter().map(|q| v3(q.x, q.y, side * (pill.z(*q) + lift))))
    };

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
    if top == Top::Bound {
        rims.material = "trim".into();
    }
    parts.push(rims);

    let mut lines = Vec::new();
    // Seam piping where the panels meet the gusset.
    for side in [1.0, -1.0] {
        lines.push(Line::new("piping", PIPING_R, rp.iter().map(|q| v3(q.x, q.y, side * pill.half(q.y)))));
    }

    // Contrast base.
    let b = p.base_height;
    if b > 0.0 {
        let s1 = s_at_height(path, b);
        for (side, nm) in [(1.0, "base_front"), (-1.0, "base_back")] {
            parts.push(region(nm, "trim", side, 0.0, b, 0.05));
            let (xa, xb) = (x_at(&lp, b - 0.35, false) + 0.6, x_at(&lp, b - 0.35, true) - 0.6);
            lines.push(on_panel(&[v2(xa, b - 0.35), v2(xb, b - 0.35)], side, 0.09));
        }
        parts.push(gus_region("base_gusset", "trim", s1, gl - s1, 0.05));
    }

    // Top binding wraps the raw edge, inside and out.
    if top == Top::Bound {
        let y0 = h - p.binding;
        let sb = s_at_height(path, y0);
        let lift = 0.06;
        let mut bind = region("binding_front", "trim", 1.0, y0, h, lift);
        bind.append(&region("binding_back", "trim", -1.0, y0, h, lift));
        bind.append(&gus_region("binding_l", "trim", 0.0, sb, lift));
        bind.append(&gus_region("binding_r", "trim", gl - sb, gl, lift));
        parts.push(bind.shell("binding_inside", "trim", t + 2.0 * lift));
        bind.name = "binding".into();
        parts.push(bind);
    }

    // Top-edge topstitching.
    let ys = match top {
        Top::Bagged => h - 1.5,
        Top::Hem => h - p.hem + 0.4,
        Top::Bound => h - p.binding + 0.3,
    };
    let lift_top = if top == Top::Bound { 0.09 } else { 0.03 };
    let xs = x_at(&lp, ys, true) - 0.6;
    for side in [1.0, -1.0] {
        lines.push(on_panel(&[v2(-xs, ys), v2(xs, ys)], side, lift_top));
    }
    let sy = s_at_height(path, ys);
    for s in [sy, gl - sy] {
        lines.push(stitch3((1..gz).map(|j| gpt(s, lift_top, j as f64 / gz as f64)).collect()));
    }

    // Stripe band: three sub-bands on the front panel.
    if p.stripe {
        let band = Band::new(p);
        let hw = p.stripe_width / 2.0;
        let lift = 0.07;
        let subs = [(-hw, -hw / 3.0, "stripe_edge"), (-hw / 3.0, hw / 3.0, "stripe_mid"), (hw / 3.0, hw, "stripe_edge")];
        for (k, (o0, o1, mat)) in subs.into_iter().enumerate() {
            let nc = 3;
            let nr = 60;
            let rg: Vec<Option<(f64, f64)>> =
                (0..=nc).map(|c| band.range(p, &lp, o0 + (o1 - o0) * c as f64 / nc as f64)).collect();
            if rg.iter().any(|r| r.is_none()) {
                continue;
            }
            parts.push(Part::grid(
                &format!("stripe{k}"),
                mat,
                nr + 1,
                nc + 1,
                |r, c| {
                    let (a, bb) = rg[c].unwrap();
                    let o = o0 + (o1 - o0) * c as f64 / nc as f64;
                    let q = band.at(o, a + (bb - a) * r as f64 / nr as f64);
                    (v3(q.x, q.y, pill.z(q) + lift), [o, q.y])
                },
                |_, _, _| v3(0.0, 0.0, 1.0),
            ));
        }
        for o in [-(hw - 0.2), hw - 0.2] {
            if let Some((a, bb)) = band.range(p, &lp, o) {
                lines.push(on_panel(&[band.at(o, a + 0.3), band.at(o, bb - 0.3)], 1.0, lift + 0.03));
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
        lines.push(on_panel(
            &[v2(-pw / 2.0 + i, yt), v2(-pw / 2.0 + i, yt - ph + i), v2(pw / 2.0 - i, yt - ph + i), v2(pw / 2.0 - i, yt)],
            1.0,
            lift + 0.03,
        ));
        lines.push(on_panel(&[v2(-pw / 2.0 + i, yt - 1.5), v2(pw / 2.0 - i, yt - 1.5)], 1.0, lift + 0.03));
    }

    // Exposed zip pocket on the front panel.
    if p.zip_pocket {
        let (c, d, hl, wh) = zip_window(p);
        let l = p.zip_pocket_length;
        let n = ((l / 0.25).ceil() as usize).max(8);
        let lift = 0.06;
        let mut pts = Vec::new();
        let mut nr = Vec::new();
        for i in 0..=n {
            let q = c + d * (-l / 2.0 + l * i as f64 / n as f64);
            pts.push(v3(q.x, q.y, pill.z(q) + lift));
            nr.push(pill.n(q));
        }
        let slider = if p.zip_pocket_angle >= 0.0 { 0.92 } else { 0.08 };
        parts.extend(zipper("zip_pocket", &pts, &nr, &spec, wh, slider, v3(0.0, -1.0, 0.0)));
        let nn = d.perp();
        let (a, e) = (hl + 0.25, wh / 2.0 + 0.25);
        let k = [c - d * a - nn * e, c + d * a - nn * e, c + d * a + nn * e, c - d * a + nn * e];
        lines.push(on_panel(&[k[0], k[1], k[2], k[3], k[0]], 1.0, lift + 0.05));
    }

    // Zip-top lid.
    if p.zip_top {
        let cw = spec.chain_w();
        let w = p.top_width;
        let sag = (2.0 * d2t * 0.06).min(0.8);
        let yl = |x: f64| h - sag * (1.0 - (2.0 * x / w).powi(2));
        for (side, name) in [(1.0, "lid_front"), (-1.0, "lid_back")] {
            let (nx, nz) = (48, 6);
            let lid = Part::grid(
                name,
                "outer",
                nx + 1,
                nz + 1,
                |i, j| {
                    let x = -w / 2.0 + w * i as f64 / nx as f64;
                    let z = side * (cw / 2.0 + (d2t - cw / 2.0) * j as f64 / nz as f64);
                    (v3(x, yl(x), z), [x, z])
                },
                |_, _, _| v3(0.0, 1.0, 0.0),
            );
            parts.push(lid.shell(&format!("{name}_lining"), if p.lining { "lining" } else { "outer" }, t));
            parts.push(lid);
            let zs = side * (cw / 2.0 + 0.45);
            lines.push(stitch3(
                densify(&[v2(-w / 2.0 + 1.0, 0.0), v2(w / 2.0 - 1.0, 0.0)], 0.4)
                    .iter()
                    .map(|q| v3(q.x, yl(q.x) + 0.03, zs))
                    .collect(),
            ));
        }
        let za = w / 2.0 - 1.5;
        let n = ((2.0 * za / 0.25).ceil() as usize).max(8);
        let pts: Vec<V3> = (0..=n)
            .map(|i| {
                let x = -za + 2.0 * za * i as f64 / n as f64;
                v3(x, yl(x), 0.0)
            })
            .collect();
        let up = vec![v3(0.0, 1.0, 0.0); pts.len()];
        parts.extend(zipper("zip_top", &pts, &up, &spec, cw + 0.8, 0.85, v3(0.0, 0.0, 1.0)));
        if p.zip_ends != "none" {
            let mut tabs = Part::new("zip_tabs", "trim");
            let ax = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];
            // (half length along the zip, half thickness, extra width beyond the tape)
            let (hl, ht, ew) = if p.zip_ends == "slim" { (0.55, 0.09, 0.08) } else { (1.2, 0.18, 0.4) };
            for sx in [-1.0, 1.0] {
                let x = sx * (za + hl - 0.9);
                tabs.push_box(v3(x, yl(x) + ht + 0.02, 0.0), ax, [hl, ht, spec.tape_w() / 2.0 + ew]);
            }
            parts.push(tabs);
        }
    }

    // Handles, optionally hanging from D-rings on tabs.
    let sw = p.strap_width;
    let (x1, x2) = (-p.strap_spacing / 2.0, p.strap_spacing / 2.0);
    let ring_y = h + 0.5;
    let rw = sw + 0.3;
    let zring = d2t + 0.25;
    let y_top = if p.handle_tabs { ring_y + rw / 2.0 * 1.15 } else { h };
    let k = solve_handle(p.strap_spacing, p.strap_length, y_top);
    let handle_sides = if p.handles { vec![(1.0, "strap_front"), (-1.0, "strap_back")] } else { vec![] };
    for (side, name) in handle_sides {
        let mut cl: Vec<V2> = Vec::new();
        let drop = if p.handle_tabs { 1.0 } else { p.strap_attach };
        let na = ((drop / 0.5).ceil() as usize).max(2);
        for i in 0..na {
            cl.push(v2(x1, y_top - drop + drop * i as f64 / na as f64));
        }
        let (a, bq) = (v2(x1, y_top), v2(x2, y_top));
        for i in 0..=64 {
            cl.push(bezier(a, a + v2(0.0, k), bq + v2(0.0, k), bq, i as f64 / 64.0));
        }
        for i in 1..=na {
            cl.push(v2(x2, y_top - drop * i as f64 / na as f64));
        }
        let zc = |q: V2| {
            let base = if p.handle_tabs { zring } else if q.y <= h + 1e-9 { pill.z(q) } else { d2t };
            base + STRAP_T / 2.0 + 0.02
        };
        let c3: Vec<V3> = cl.iter().map(|q| v3(q.x, q.y, side * zc(*q))).collect();
        let n = cl.len();
        let wdir: Vec<V3> = (0..n)
            .map(|i| {
                let tg = (cl[(i + 1).min(n - 1)] - cl[i.saturating_sub(1)]).norm();
                v3(tg.y, -tg.x, 0.0)
            })
            .collect();
        let tdir = vec![v3(0.0, 0.0, side); n];
        parts.push(Part::strap(name, "strap", &c3, &wdir, &tdir, sw, STRAP_T));
        for sg in [-1.0, 1.0] {
            lines.push(stitch3(
                (0..n).map(|i| c3[i] + wdir[i] * (sg * (sw / 2.0 - 0.35)) + tdir[i] * (STRAP_T / 2.0 + 0.015)).collect(),
            ));
        }
        let (tab_t, box_lift) = (0.25, if p.handle_tabs { 0.29 } else { STRAP_T + 0.04 });
        for x in [x1, x2] {
            if p.handle_tabs {
                let tw = sw + 1.0;
                let tc: Vec<V3> = (0..=16)
                    .map(|i| {
                        let y = h - p.strap_attach + (ring_y - h + p.strap_attach) * i as f64 / 16.0;
                        let q = v2(x, y);
                        let z = if y <= h { pill.z(q) } else { d2t + 0.05 };
                        v3(x, y, side * (z + 0.13))
                    })
                    .collect();
                let m = tc.len();
                parts.push(Part::strap(
                    &format!("{name}_tab"),
                    "trim",
                    &tc,
                    &vec![v3(1.0, 0.0, 0.0); m],
                    &vec![v3(0.0, 0.0, side); m],
                    tw,
                    tab_t,
                ));
                parts.push(d_ring(&format!("{name}_ring"), v3(x, ring_y, side * zring), v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), rw, 0.13));
            }
            // Box-X stitch where each end (or tab) is sewn down.
            let hw = if p.handle_tabs { sw / 2.0 + 0.15 } else { sw / 2.0 - 0.35 };
            let (y0, y1) = (h - p.strap_attach + 0.5, h - 0.6 - p.binding);
            let (xa, xb) = (x - hw, x + hw);
            for poly in [rect(xa, y0, xb, y1), vec![v2(xa, y0), v2(xb, y1)], vec![v2(xb, y0), v2(xa, y1)]] {
                lines.push(on_panel(&poly, side, box_lift));
            }
        }
    }

    // Shoulder strap on D-rings at the gusset tops.
    if p.shoulder_strap {
        let w = p.shoulder_width;
        let rw = w + 0.3;
        let mut ends = Vec::new();
        for (sx, s_top) in [(-1.0, 0.0), (1.0, gl)] {
            let tc: Vec<V3> = (0..=12)
                .map(|i| {
                    let s = 4.0 * (1.0 - i as f64 / 12.0);
                    gpt(if sx < 0.0 { s } else { gl - s }, 0.13, 0.5)
                })
                .chain((1..=3).map(|i| gpt(s_top, 0.13, 0.5) + v3(0.0, 0.5 * i as f64 / 3.0, 0.0)))
                .collect();
            let o = outward(point_at(path, if sx < 0.0 { 0.01 } else { gl - 0.01 }).1);
            let mtc = tc.len();
            parts.push(Part::strap(
                &format!("shoulder_tab{}", if sx < 0.0 { "_l" } else { "_r" }),
                "trim",
                &tc,
                &vec![v3(0.0, 0.0, 1.0); mtc],
                &vec![v3(o.x, o.y, 0.0); mtc],
                w + 1.0,
                0.25,
            ));
            let c = gpt(s_top, 0.25, 0.5) + v3(0.0, 0.5, 0.0);
            parts.push(d_ring(
                &format!("shoulder_ring{}", if sx < 0.0 { "_l" } else { "_r" }),
                c,
                v3(0.0, 0.0, 1.0),
                v3(0.0, 1.0, 0.0),
                rw,
                0.13,
            ));
            ends.push(c + v3(0.0, rw / 2.0 * 1.15, 0.0));
        }
        let (pl, pr) = (ends[0], ends[1]);
        let target = p.shoulder_length;
        let floor = STRAP_T / 2.0;
        let len_at = |az: f64, yf: f64| len3(&shoulder_path(pl, pr, d2, az, yf).0);
        let (az, yf) = if len_at(0.0, floor) < target {
            let (mut lo, mut hi) = (0.0, 300.0);
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if len_at(mid, floor) < target { lo = mid } else { hi = mid }
            }
            (lo, floor)
        } else {
            let (mut lo, mut hi) = (floor, pl.y.min(pr.y) - 1.0);
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if len_at(0.0, mid) > target { lo = mid } else { hi = mid }
            }
            (0.0, lo)
        };
        let (pts, wt) = shoulder_path(pl, pr, d2, az, yf);
        let n = pts.len();
        let mut wdir = Vec::with_capacity(n);
        let mut tdir = Vec::with_capacity(n);
        for i in 0..n {
            let tg = (pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)]).norm();
            let sx = if i < n / 2 { -1.0 } else { 1.0 };
            let r = v3(sx, 0.0, 0.0) * (1.0 - wt[i]) + v3(0.0, 1.0, 0.0) * wt[i];
            let td = (r - tg * r.dot(tg)).norm();
            tdir.push(td);
            wdir.push(tg.cross(td).norm());
        }
        parts.push(Part::strap("shoulder_strap", "strap", &pts, &wdir, &tdir, w, STRAP_T));
        for sg in [-1.0, 1.0] {
            lines.push(stitch3(
                (0..n).map(|i| pts[i] + wdir[i] * (sg * (w / 2.0 - 0.3)) + tdir[i] * (STRAP_T / 2.0 + 0.015)).collect(),
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

    fn all_features() -> ToteParams {
        ToteParams {
            zip_top: true,
            zip_type: "metal".into(),
            zip_pull: "tassel".into(),
            zip_pocket: true,
            zip_pocket_angle: 25.0,
            base_height: 8.0,
            binding: 1.5,
            stripe: true,
            stripe_angle: 10.0,
            handle_tabs: true,
            shoulder_strap: true,
            ..Default::default()
        }
    }

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
        for p in [ToteParams::default(), all_features(), ToteParams { lining: false, ..all_features() }] {
            let path = outline(&p);
            for pc in pieces(&p, &path) {
                assert!(area(&pc.cut_line).abs() >= area(&pc.sew).abs() - 1e-6, "{}", pc.id);
            }
        }
    }

    #[test]
    fn lining_gusset_matches_lining_panel() {
        let p = ToteParams::default();
        let path = outline(&p);
        let pcs = pieces(&p, &path);
        let body = pcs.iter().find(|x| x.id == "body_lining").unwrap();
        let g = pcs.iter().find(|x| x.id == "gusset_lining").unwrap();
        let panel_seam = polyline_length(&body.sew);
        assert!((g.sew[2].y - panel_seam).abs() < 1e-9);
        assert!(panel_seam < polyline_length(&path));
    }

    #[test]
    fn notches_and_clips_never_reach_the_seam() {
        for sa in [0.3, 0.5, 1.0, 2.5] {
            for r in [0.0, 4.0] {
                for base in [0.0, 8.0] {
                    let mut p = ToteParams { seam_allowance: sa, corner_radius: r, base_height: base, ..Default::default() };
                    assert!(sanitize(&mut p).is_empty());
                    let path = outline(&p);
                    for pc in pieces(&p, &path) {
                        for n in pc.notches.iter().chain(&pc.clips) {
                            assert!(n.depth < sa, "{} sa={sa} depth={}", pc.id, n.depth);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn gusset_has_clips_at_both_corners() {
        for r in [0.0, 4.0] {
            let p = ToteParams { corner_radius: r, ..Default::default() };
            let path = outline(&p);
            let g = pieces(&p, &path).into_iter().find(|x| x.id == "gusset").unwrap();
            let gl = polyline_length(&path);
            assert!(g.clips.iter().any(|c| c.at.y < gl / 2.0));
            assert!(g.clips.iter().any(|c| c.at.y > gl / 2.0));
        }
    }

    #[test]
    fn unlined_hem_is_mirrored() {
        let p = ToteParams { lining: false, width: 30.0, top_width: 44.0, hem: 4.0, ..Default::default() };
        let path = outline(&p);
        let body = pieces(&p, &path).into_iter().find(|x| x.id == "body").unwrap();
        for s in [0.5, 2.0, 3.9] {
            let above = x_at(&body.cut_line, p.height + s, true);
            let below = x_at(&body.cut_line, p.height - s, true);
            assert!((above - below).abs() < 1e-6, "s={s}: {above} vs {below}");
        }
    }

    #[test]
    fn strap_includes_turn_unders_and_turn_of_cloth() {
        let p = ToteParams::default();
        let path = outline(&p);
        let s = pieces(&p, &path).into_iter().find(|x| x.id == "strap").unwrap();
        let (w, l) = (s.sew[1].x, s.sew[2].y);
        assert!((l - (p.strap_length + 2.0 * (p.strap_attach + STRAP_TURN))).abs() < 1e-9);
        assert!(w > p.strap_width * 4.0);
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

    #[test]
    fn base_split_adds_up() {
        let mut p = all_features();
        assert!(sanitize(&mut p).is_empty(), "{:?}", sanitize(&mut p));
        let path = outline(&p);
        let pcs = pieces(&p, &path);
        let len = |id: &str| {
            let g = pcs.iter().find(|x| x.id == id).unwrap();
            g.sew[2].y - g.sew[1].y
        };
        let gl = polyline_length(&path);
        assert!((2.0 * len("gusset_side") + len("gusset_base") - gl).abs() < 1e-6);
        // The body/base seam is the same length on both pieces.
        let body = pcs.iter().find(|x| x.id == "body").unwrap();
        let base = pcs.iter().find(|x| x.id == "base").unwrap();
        let seam = |pc: &Piece| {
            let n = pc.sew.len();
            (0..n)
                .map(|i| (pc.sew[i], pc.sew[(i + 1) % n]))
                .filter(|(a, b)| (a.y - p.base_height).abs() < 1e-6 && (b.y - p.base_height).abs() < 1e-6)
                .map(|(a, b)| (b - a).len())
                .sum::<f64>()
        };
        assert!(seam(body) > 1.0);
        assert!((seam(body) - seam(base)).abs() < 1e-6);
    }

    #[test]
    fn handles_can_be_removed() {
        let mut p = ToteParams { handles: false, handle_tabs: true, shoulder_strap: true, ..Default::default() };
        sanitize(&mut p);
        let path = outline(&p);
        let pcs = pieces(&p, &path);
        assert!(!pcs.iter().any(|x| x.id == "strap" || x.id == "handle_tab"));
        assert!(pcs.iter().any(|x| x.id == "shoulder"));
        assert!(!steps(&p).iter().any(|s| s.contains("Handle")));
        assert!(!supplies(&p).iter().any(|s| s.starts_with("4 D-rings")));
        let m = mesh(&p, &path);
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("strap_front"));
    }

    #[test]
    fn tapered_gusset_edges_match_panel() {
        // Right edge of a tapered strip: sew[1..=n+1] where sew.len() = 2n + 2.
        let edge = |pc: &Piece| {
            let n = (pc.sew.len() - 2) / 2;
            polyline_length(&pc.sew[1..=n + 1])
        };
        for base in [0.0, 8.0] {
            for r in [0.0, 4.0] {
                let mut p = ToteParams { depth: 16.0, top_depth: 7.0, base_height: base, corner_radius: r, ..Default::default() };
                assert!(sanitize(&mut p).is_empty());
                let path = outline(&p);
                let pcs = pieces(&p, &path);
                let get = |id: &str| pcs.iter().find(|x| x.id == id).unwrap();
                let total = if base > 0.0 { 2.0 * edge(get("gusset_side")) + edge(get("gusset_base")) } else { edge(get("gusset")) };
                assert!((total - polyline_length(&path)).abs() < 1e-6, "base={base} r={r}: {total}");
                // Width: top depth at the opening, full depth across the bottom.
                let g = get(if base > 0.0 { "gusset_side" } else { "gusset" });
                assert!(((g.sew[1].x - g.sew[0].x) - p.depth).abs() > 1.0 || base > 0.0);
                let lp = lining_params(&p);
                let body = get("body_lining");
                assert!((edge(get("gusset_lining")) - polyline_length(&body.sew)).abs() < 1e-6);
                assert!(top_depth(&lp) < lp.depth);
            }
        }
        let mut p = ToteParams { depth: 16.0, top_depth: 7.0, ..Default::default() };
        sanitize(&mut p);
        let path = outline(&p);
        let g = pieces(&p, &path).into_iter().find(|x| x.id == "gusset").unwrap();
        let n = (g.sew.len() - 2) / 2;
        let top_w = g.sew[n + 1].x - g.sew[n + 2].x;
        let mid_w = g.sew[n / 2 + 1].x - g.sew[g.sew.len() - n / 2].x;
        assert!((top_w - 7.0).abs() < 1e-6, "{top_w}");
        assert!((mid_w - 16.0).abs() < 1e-6, "{mid_w}");
        // A top depth >= depth means "straight".
        let mut q = ToteParams { top_depth: 30.0, ..Default::default() };
        sanitize(&mut q);
        assert_eq!(q.top_depth, 0.0);
    }

    #[test]
    fn zip_lid_closes_the_top() {
        let mut p = all_features();
        sanitize(&mut p);
        let path = outline(&p);
        let pcs = pieces(&p, &path);
        let z = pcs.iter().find(|x| x.id == "zip_panel").unwrap();
        let cw = zip_spec(&p).chain_w();
        assert!((2.0 * z.sew[2].y + cw - p.depth).abs() < 1e-9);
        assert!((z.sew[1].x - p.top_width).abs() < 1e-9);
    }

    #[test]
    fn stripe_stays_on_the_panel() {
        let mut p = all_features();
        p.stripe_x = 8.0;
        p.stripe_angle = 30.0;
        sanitize(&mut p);
        let path = outline(&p);
        let o = Band::new(&p).outline(&p, &path).unwrap();
        for q in o {
            assert!(q.y >= p.base_height - 1e-6 && q.y <= p.height - p.binding + 1e-6);
            assert!(q.x >= x_at(&path, q.y, false) - 1e-6 && q.x <= x_at(&path, q.y, true) + 1e-6);
        }
    }

    #[test]
    fn zip_end_styles() {
        for (ends, has_tab) in [("slim", true), ("square", true), ("none", false)] {
            let mut p = ToteParams { zip_ends: ends.into(), ..all_features() };
            sanitize(&mut p);
            let path = outline(&p);
            assert_eq!(pieces(&p, &path).iter().any(|x| x.id == "zip_tab"), has_tab, "{ends}");
            let m = mesh(&p, &path);
            assert_eq!(m.parts.iter().any(|x| x.name == "zip_tabs"), has_tab, "{ends}");
        }
    }

    #[test]
    fn bad_strings_fall_back() {
        let mut p = ToteParams { zip_type: "gold".into(), zip_pull: "bow".into(), zip_gauge: 6.0, ..Default::default() };
        let w = sanitize(&mut p);
        assert_eq!(w.len(), 2);
        assert_eq!(p.zip_type, "coil");
        assert_eq!(p.zip_pull, "tab");
        assert_eq!(p.zip_gauge, 5.0);
    }

    #[test]
    fn everything_builds() {
        for pull in ["tab", "ring", "tassel"] {
            for kind in ["coil", "metal", "molded"] {
                let mut p = ToteParams { zip_pull: pull.into(), zip_type: kind.into(), ..all_features() };
                sanitize(&mut p);
                let path = outline(&p);
                let m = mesh(&p, &path);
                assert!(m.parts.iter().any(|x| x.name == "shoulder_strap"));
                assert!(m.parts.iter().all(|x| x.positions.iter().all(|v| v.is_finite())));
                let ss = supplies(&p);
                assert!(ss.iter().any(|s| s.contains("zipper")));
            }
        }
    }
}
