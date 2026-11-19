//! bag-core: parametric bag engine.
//!
//! design JSON -> pattern pieces (exact) -> 3D mesh + SVG/PDF pattern.

pub mod draw;
pub mod geom;
pub mod mesh;
pub mod pattern;
pub mod pdf;
pub mod svg;
pub mod tote;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use pdf::Paper;

/// Styles the engine can build. More coming: box, bucket, flap.
pub const STYLES: &[&str] = &["tote"];

/// A saved design. `params` depends on `style`; `appearance` is for renderers and
/// is passed through untouched.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Design {
    pub style: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub appearance: Value,
}

#[derive(Serialize)]
pub struct Output {
    pub pattern: pattern::Pattern,
    pub mesh: mesh::Mesh,
    /// Params after defaults and clamping.
    pub params: Value,
}

pub fn default_appearance() -> Value {
    json!({
        "outer":  { "finish": "canvas",  "color": "#cdbb9f" },
        "lining": { "finish": "canvas",  "color": "#7d2c26" },
        "strap":  { "finish": "leather", "color": "#6a3a1e" },
        "thread": "#f1e7d4",
        "piping": true
    })
}

pub fn default_design(style: &str) -> Result<Design, String> {
    match style {
        "tote" => Ok(Design {
            style: "tote".into(),
            name: "Untitled tote".into(),
            params: serde_json::to_value(tote::ToteParams::default()).unwrap(),
            appearance: default_appearance(),
        }),
        o => Err(format!("unknown style '{o}' (available: {})", STYLES.join(", "))),
    }
}

pub fn parse(json: &str) -> Result<Design, String> {
    serde_json::from_str(json).map_err(|e| format!("invalid design JSON: {e}"))
}

pub fn generate(d: &Design) -> Result<Output, String> {
    let params = if d.params.is_null() { json!({}) } else { d.params.clone() };
    match d.style.as_str() {
        "tote" => {
            let mut p: tote::ToteParams =
                serde_json::from_value(params).map_err(|e| format!("invalid tote params: {e}"))?;
            let warnings = tote::sanitize(&mut p);
            let path = tote::outline(&p);
            let pieces = tote::pieces(&p, &path);
            let mesh = tote::mesh(&p, &path);
            let name = if d.name.is_empty() { "Tote".to_string() } else { d.name.clone() };
            Ok(Output {
                pattern: pattern::Pattern { style: "tote".into(), name, pieces, warnings },
                mesh,
                params: serde_json::to_value(p).unwrap(),
            })
        }
        o => Err(format!("unknown style '{o}' (available: {})", STYLES.join(", "))),
    }
}

pub fn pattern_svg(out: &Output) -> String {
    svg::render(&draw::layout(&out.pattern))
}

pub fn pattern_pdf(out: &Output, paper: Paper) -> Vec<u8> {
    pdf::render(&draw::layout(&out.pattern), paper)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_to_end() {
        let d = default_design("tote").unwrap();
        let out = generate(&d).unwrap();
        assert!(out.pattern.warnings.is_empty(), "{:?}", out.pattern.warnings);
        assert_eq!(out.pattern.pieces.len(), 4);
        assert!(!out.mesh.parts.is_empty());
        let pdf = pattern_pdf(&out, Paper::A4);
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pattern_svg(&out).contains("<svg"));
    }
}
