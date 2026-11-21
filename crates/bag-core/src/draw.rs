//! Lays out pattern pieces on a sheet as simple drawing primitives.
//! SVG and PDF both render from this, so they always match.
//! Sheet coordinates: centimetres, origin top-left, y down.

use crate::geom::*;
use crate::pattern::{Pattern, Piece};

pub enum Prim {
    Path { pts: Vec<V2>, closed: bool, width: f64, dash: Option<Vec<f64>>, gray: f64 },
    Text { at: V2, size: f64, text: String, center: bool, vertical: bool, gray: f64 },
}

pub struct Drawing {
    pub w: f64,
    pub h: f64,
    pub title: String,
    pub prims: Vec<Prim>,
}

fn path(pts: Vec<V2>, closed: bool, width: f64, dash: Option<Vec<f64>>, gray: f64) -> Prim {
    Prim::Path { pts, closed, width, dash, gray }
}

fn text(at: V2, size: f64, s: &str, center: bool, vertical: bool) -> Prim {
    Prim::Text { at, size, text: s.into(), center, vertical, gray: 0.0 }
}

fn bbox(p: &[V2]) -> (f64, f64, f64, f64) {
    p.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, q| {
        (b.0.min(q.x), b.1.min(q.y), b.2.max(q.x), b.3.max(q.y))
    })
}

pub fn layout(pat: &Pattern) -> Drawing {
    let m = 1.5;
    let gap = 2.0;
    let title = format!("{} ({})", pat.name, pat.style);
    let mut prims = vec![
        text(v2(m, m + 0.8), 0.9, &format!("{title} - sewing pattern"), false, false),
        text(
            v2(m, m + 1.6),
            0.42,
            "All units cm. Seam allowance included: solid = cut, dashed = sew, dash-dot = fold. Print at 100% / actual size.",
            false,
            false,
        ),
    ];
    let sq = m + 2.4;
    prims.push(path(rect_pts(m, sq, m + 10.0, sq + 10.0), true, 0.05, None, 0.0));
    prims.push(text(v2(m + 5.0, sq + 4.8), 0.7, "10 x 10 cm", true, false));
    prims.push(text(v2(m + 5.0, sq + 5.8), 0.4, "measure to check scale", true, false));
    let mut ly = sq + 0.6;
    prims.push(text(v2(m + 12.0, ly), 0.6, "Cut list", false, false));
    for pc in &pat.pieces {
        ly += 0.8;
        prims.push(text(v2(m + 12.0, ly), 0.45, &format!("{} - {}", pc.name, pc.cut), false, false));
    }
    ly += 1.4;
    prims.push(text(v2(m + 12.0, ly), 0.6, "Sewing order", false, false));
    for s in &pat.steps {
        ly += 0.75;
        prims.push(text(v2(m + 12.0, ly), 0.42, s, false, false));
    }
    if !pat.supplies.is_empty() {
        ly += 1.4;
        prims.push(text(v2(m + 12.0, ly), 0.6, "Supplies", false, false));
        for s in &pat.supplies {
            ly += 0.75;
            prims.push(text(v2(m + 12.0, ly), 0.42, &format!("- {s}"), false, false));
        }
    }
    ly += 0.6;
    prims.push(text(
        v2(m + 12.0, ly),
        0.38,
        "Short lines on the cut edge = notches (match them). Fine lines at corners = clips (cut after sewing, never past the stitch line).",
        false,
        false,
    ));
    let header_h = (sq + 10.0).max(ly + 0.5);

    let boxes: Vec<(f64, f64, f64, f64)> = pat
        .pieces
        .iter()
        .map(|pc| {
            let b = bbox(&pc.cut_line);
            (b.0 - 0.5, b.1 - 0.5, b.2 + 0.5, b.3 + 0.5)
        })
        .collect();
    let text_w = pat.steps.iter().map(|s| s.chars().count() as f64 * 0.42 * 0.52).fold(0.0, f64::max) + m + 13.0;
    let sheet_w = boxes.iter().map(|b| b.2 - b.0 + 2.0 * m).fold(90.0f64.max(text_w), f64::max);
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|a, b| (boxes[*b].3 - boxes[*b].1).total_cmp(&(boxes[*a].3 - boxes[*a].1)));
    let (mut x, mut y, mut row_h) = (m, header_h + gap, 0.0f64);
    for i in order {
        let b = boxes[i];
        let (w, h) = (b.2 - b.0, b.3 - b.1);
        if x + w > sheet_w - m && x > m {
            x = m;
            y += row_h + gap;
            row_h = 0.0;
        }
        draw_piece(&pat.pieces[i], b, x, y, &mut prims);
        x += w + gap;
        row_h = row_h.max(h);
    }
    Drawing { w: sheet_w, h: y + row_h + m, title, prims }
}

fn rect_pts(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<V2> {
    vec![v2(x0, y0), v2(x1, y0), v2(x1, y1), v2(x0, y1)]
}

fn draw_piece(pc: &Piece, b: (f64, f64, f64, f64), ox: f64, oy: f64, out: &mut Vec<Prim>) {
    let tf = |q: V2| v2(ox + q.x - b.0, oy + b.3 - q.y);
    let tfa = |pts: &[V2]| pts.iter().map(|q| tf(*q)).collect::<Vec<_>>();
    out.push(path(tfa(&pc.cut_line), true, 0.06, None, 0.0));
    out.push(path(tfa(&pc.sew), true, 0.025, Some(vec![0.4, 0.25]), 0.35));
    for f in &pc.folds {
        out.push(path(tfa(f), false, 0.03, Some(vec![1.0, 0.25, 0.15, 0.25]), 0.2));
        let mid = tf(f[0].lerp(f[1], 0.5));
        out.push(Prim::Text { at: mid + v2(0.0, -0.25), size: 0.4, text: "FOLD".into(), center: true, vertical: false, gray: 0.3 });
    }
    for n in &pc.notches {
        out.push(path(vec![tf(n.at), tf(n.at + n.dir * n.depth)], false, 0.06, None, 0.0));
    }
    for n in &pc.clips {
        out.push(path(vec![tf(n.at), tf(n.at + n.dir * n.depth)], false, 0.02, None, 0.25));
    }
    for mk in &pc.marks {
        out.push(path(tfa(mk), false, 0.025, Some(vec![0.25, 0.2]), 0.4));
    }
    for l in &pc.labels {
        out.push(Prim::Text { at: tf(l.at), size: 0.4, text: l.text.clone(), center: true, vertical: l.vertical, gray: 0.15 });
    }
    let (ga, gb) = (tf(pc.grain[0]), tf(pc.grain[1]));
    let u = (gb - ga).norm();
    let pp = u.perp();
    out.push(path(vec![ga, gb], false, 0.04, None, 0.0));
    for (tip, d) in [(gb, u), (ga, -u)] {
        out.push(path(vec![tip - d * 0.8 + pp * 0.4, tip, tip - d * 0.8 - pp * 0.4], false, 0.04, None, 0.0));
    }

    let (w, h) = (b.2 - b.0, b.3 - b.1);
    let c = v2(ox + w / 2.0, oy + h / 2.0);
    let mut lines: Vec<(String, f64)> = vec![(pc.name.clone(), 0.9), (pc.cut.clone(), 0.55)];
    lines.extend(pc.notes.iter().map(|n| (n.clone(), 0.4)));
    let vertical = w < 16.0;
    let total: f64 = lines.iter().map(|l| l.1 * 1.5).sum();
    let mut off = -total / 2.0;
    for (s, size) in lines {
        off += size * 1.5;
        let at = if vertical { c + v2(off - size * 0.4, 0.0) } else { c + v2(0.0, off - size * 0.4) };
        out.push(text(at, size, &s, true, vertical));
    }
}
