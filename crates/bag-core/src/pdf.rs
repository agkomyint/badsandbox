//! Minimal dependency-free PDF writer for the pattern drawing.
//! The drawing is stored once as a Form XObject and placed on each page,
//! either one full-size page or tiled onto A4 / Letter.

use crate::draw::{Drawing, Prim};

const K: f64 = 72.0 / 2.54; // points per cm

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paper {
    A4,
    Letter,
    Full,
}

impl Paper {
    pub fn parse(s: &str) -> Result<Paper, String> {
        match s.to_ascii_lowercase().as_str() {
            "a4" => Ok(Paper::A4),
            "letter" => Ok(Paper::Letter),
            "full" | "fullsize" | "full-size" => Ok(Paper::Full),
            o => Err(format!("unknown paper '{o}' (use a4, letter or full)")),
        }
    }
    fn size(self) -> (f64, f64) {
        match self {
            Paper::A4 => (21.0, 29.7),
            Paper::Letter => (21.59, 27.94),
            Paper::Full => (0.0, 0.0),
        }
    }
}

fn f(v: f64) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.into() }
}

fn esc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\\' => "\\\\".into(),
            '(' => "\\(".into(),
            ')' => "\\)".into(),
            c if c.is_ascii() && !c.is_ascii_control() => c.to_string(),
            _ => "?".into(),
        })
        .collect()
}

fn approx_width(s: &str, size: f64) -> f64 {
    s.chars().count() as f64 * size * 0.52
}

fn form_ops(d: &Drawing) -> String {
    let mut o = String::from("1 J 1 j\n");
    for p in &d.prims {
        match p {
            Prim::Path { pts, closed, width, dash, gray } => {
                if pts.len() < 2 {
                    continue;
                }
                o += &format!("{} G {} w ", f(*gray), f(*width));
                match dash {
                    Some(ds) => {
                        o += &format!("[{}] 0 d ", ds.iter().map(|x| f(*x)).collect::<Vec<_>>().join(" "))
                    }
                    None => o += "[] 0 d ",
                }
                o += &format!("{} {} m ", f(pts[0].x), f(pts[0].y));
                for q in &pts[1..] {
                    o += &format!("{} {} l ", f(q.x), f(q.y));
                }
                o += if *closed { "h S\n" } else { "S\n" };
            }
            Prim::Text { at, size, text, center, vertical, gray } => {
                let w = approx_width(text, *size);
                let (x, y) = match (center, vertical) {
                    (true, false) => (at.x - w / 2.0, at.y),
                    (true, true) => (at.x, at.y + w / 2.0),
                    _ => (at.x, at.y),
                };
                // The form space is y-down, so the text matrix flips y back.
                let m = if *vertical {
                    format!("0 {} {} 0", f(-size), f(-size))
                } else {
                    format!("{} 0 0 {}", f(*size), f(-size))
                };
                o += &format!("BT {} g /F1 1 Tf {} {} {} Tm ({}) Tj ET\n", f(*gray), m, f(x), f(y), esc(text));
            }
        }
    }
    o
}

fn stream(dict: &str, body: &str) -> String {
    format!("<< {dict} /Length {} >>\nstream\n{body}\nendstream", body.len())
}

pub fn render(d: &Drawing, paper: Paper) -> Vec<u8> {
    let form = form_ops(d);
    let mut pages: Vec<(f64, f64, String)> = Vec::new();
    let m = 1.0;
    match paper {
        Paper::Full => {
            let (pw, ph) = (d.w + 2.0 * m, d.h + 2.0 * m);
            let c = format!("q {} 0 0 {} {} {} cm /Fm1 Do Q\n", f(K), f(-K), f(m * K), f((ph - m) * K));
            pages.push((pw * K, ph * K, c));
        }
        _ => {
            let (pw, ph) = paper.size();
            let foot = 0.8;
            let (tw, th) = (pw - 2.0 * m, ph - 2.0 * m - foot);
            // Pages overlap by `ov` so they can be glued with a margin for error.
            let ov = 1.0;
            let (sx, sy) = (tw - ov, th - ov);
            let cols = ((d.w - ov) / sx).ceil().max(1.0) as usize;
            let rows = ((d.h - ov) / sy).ceil().max(1.0) as usize;
            let name = |r: usize, c: usize| format!("{}{}", (b'A' + (r % 26) as u8) as char, c + 1);
            for r in 0..rows {
                for c in 0..cols {
                    let (x0, y0) = (m * K, (ph - m - th) * K);
                    let (w, h) = (tw * K, th * K);
                    let mut s = format!(
                        "q {} {} {} {} re W n {} 0 0 {} {} {} cm /Fm1 Do Q\n",
                        f(x0), f(y0), f(w), f(h), f(K), f(-K),
                        f((m - c as f64 * sx) * K),
                        f((ph - m + r as f64 * sy) * K)
                    );
                    s += &format!("0.6 G 0.4 w [] 0 d {} {} {} {} re S\n", f(x0), f(y0), f(w), f(h));
                    let o = ov * K;
                    let cross = |s: &mut String, x: f64, y: f64| {
                        *s += &format!("0 G 0.5 w [] 0 d {} {} m {} {} l S {} {} m {} {} l S\n", f(x - 6.0), f(y), f(x + 6.0), f(y), f(x), f(y - 6.0), f(x), f(y + 6.0));
                    };
                    if c + 1 < cols {
                        let x = x0 + w - o;
                        s += &format!("0.3 G 0.4 w [3 2] 0 d {} {} m {} {} l S\n", f(x), f(y0), f(x), f(y0 + h));
                        for k in [0.25, 0.75] {
                            cross(&mut s, x0 + w - o / 2.0, y0 + h * k);
                        }
                    }
                    if c > 0 {
                        for k in [0.25, 0.75] {
                            cross(&mut s, x0 + o / 2.0, y0 + h * k);
                        }
                    }
                    if r + 1 < rows {
                        let y = y0 + o;
                        s += &format!("0.3 G 0.4 w [3 2] 0 d {} {} m {} {} l S\n", f(x0), f(y), f(x0 + w), f(y));
                        for k in [0.25, 0.75] {
                            cross(&mut s, x0 + w * k, y0 + o / 2.0);
                        }
                    }
                    if r > 0 {
                        for k in [0.25, 0.75] {
                            cross(&mut s, x0 + w * k, y0 + h - o / 2.0);
                        }
                    }
                    let label = format!(
                        "Page {} (row {}, col {}) of {}x{} | {} | print at 100% | trim this page's left/top border, lay it on the dashed line of the page before, match the + marks, tape",
                        name(r, c), r + 1, c + 1, rows, cols, d.title
                    );
                    s += &format!("BT 0 g /F1 7 Tf {} {} Td ({}) Tj ET\n", f(m * K), f(0.45 * K), esc(&label));
                    let mut edge = |txt: String, x: f64, y: f64| {
                        s += &format!("BT 0.4 g /F1 7 Tf {} {} Td ({}) Tj ET\n", f(x), f(y), esc(&txt));
                    };
                    if c + 1 < cols {
                        edge(format!("{} >", name(r, c + 1)), x0 + w - 24.0, y0 + h / 2.0);
                    }
                    if c > 0 {
                        edge(format!("< {}", name(r, c - 1)), x0 + 3.0, y0 + h / 2.0);
                    }
                    if r > 0 {
                        edge(format!("^ {}", name(r - 1, c)), x0 + w / 2.0, y0 + h - 9.0);
                    }
                    if r + 1 < rows {
                        edge(format!("v {}", name(r + 1, c)), x0 + w / 2.0, y0 + 3.0);
                    }
                    pages.push((pw * K, ph * K, s));
                }
            }
        }
    }

    let n = pages.len();
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 5 + 2 * i)).collect();
    let mut objs: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        format!("<< /Type /Pages /Kids [{}] /Count {n} >>", kids.join(" ")),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
        stream(
            &format!(
                "/Type /XObject /Subtype /Form /BBox [-5 -5 {} {}] /Resources << /Font << /F1 3 0 R >> >>",
                f(d.w + 5.0),
                f(d.h + 5.0)
            ),
            &form,
        ),
    ];
    for (i, (w, h, c)) in pages.iter().enumerate() {
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /Font << /F1 3 0 R >> /XObject << /Fm1 4 0 R >> >> /Contents {} 0 R >>",
            f(*w), f(*h), 6 + 2 * i
        ));
        objs.push(stream("", c));
    }

    let mut out: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
    for off in offsets {
        out.extend(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes(),
    );
    out
}
