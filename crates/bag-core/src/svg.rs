use crate::draw::{Drawing, Prim};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn gray(g: f64) -> String {
    let v = (g.clamp(0.0, 1.0) * 255.0) as u8;
    format!("rgb({v},{v},{v})")
}

/// Full-scale SVG (width/height in cm).
pub fn render(d: &Drawing) -> String {
    let mut o = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.2}cm\" height=\"{h:.2}cm\" viewBox=\"0 0 {w:.3} {h:.3}\">\n<rect width=\"{w:.3}\" height=\"{h:.3}\" fill=\"white\"/>\n",
        w = d.w,
        h = d.h
    );
    for p in &d.prims {
        match p {
            Prim::Path { pts, closed, width, dash, gray: g } => {
                if pts.len() < 2 {
                    continue;
                }
                let mut dstr = format!("M{:.3} {:.3}", pts[0].x, pts[0].y);
                for q in &pts[1..] {
                    dstr += &format!(" L{:.3} {:.3}", q.x, q.y);
                }
                if *closed {
                    dstr += " Z";
                }
                let dash = dash
                    .as_ref()
                    .map(|ds| {
                        format!(
                            " stroke-dasharray=\"{}\"",
                            ds.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" ")
                        )
                    })
                    .unwrap_or_default();
                o += &format!(
                    "<path d=\"{dstr}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{width}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"{dash}/>\n",
                    gray(*g)
                );
            }
            Prim::Text { at, size, text, center, vertical, gray: g } => {
                let anchor = if *center { " text-anchor=\"middle\"" } else { "" };
                let rot = if *vertical {
                    format!(" transform=\"rotate(-90 {:.3} {:.3})\"", at.x, at.y)
                } else {
                    String::new()
                };
                o += &format!(
                    "<text x=\"{:.3}\" y=\"{:.3}\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"{size}\" fill=\"{}\"{anchor}{rot}>{}</text>\n",
                    at.x,
                    at.y,
                    gray(*g),
                    esc(text)
                );
            }
        }
    }
    o + "</svg>\n"
}
