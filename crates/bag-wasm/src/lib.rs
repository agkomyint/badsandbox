//! Browser bindings. Everything goes in and out as JSON strings (PDF as bytes).

use bag_core::{Paper, Output};
use wasm_bindgen::prelude::*;

fn build(design_json: &str) -> Result<Output, JsError> {
    let d = bag_core::parse(design_json).map_err(|e| JsError::new(&e))?;
    bag_core::generate(&d).map_err(|e| JsError::new(&e))
}

/// Returns `{ pattern, mesh, params, svg }` as JSON.
#[wasm_bindgen]
pub fn generate(design_json: &str) -> Result<String, JsError> {
    let out = build(design_json)?;
    let svg = bag_core::pattern_svg(&out);
    let mut v = serde_json::to_value(&out).map_err(|e| JsError::new(&e.to_string()))?;
    v["svg"] = serde_json::Value::String(svg);
    Ok(v.to_string())
}

fn set(o: &js_sys::Object, k: &str, v: &JsValue) {
    js_sys::Reflect::set(o, &JsValue::from_str(k), v).unwrap();
}

/// Fast path for the viewer: small JSON `meta` plus geometry as typed arrays
/// (`parts[i].{positions,normals,uvs,indices}`, `lines[i]` = flat xyz points).
/// Each array is a fresh JS buffer, so a worker can transfer it without copying.
#[wasm_bindgen]
pub fn generate_packed(design_json: &str) -> Result<JsValue, JsError> {
    use js_sys::{Array, Float32Array, Object, Uint32Array};
    let out = build(design_json)?;
    let m = &out.mesh;
    let meta = serde_json::json!({
        "pattern": out.pattern,
        "params": out.params,
        "svg": bag_core::pattern_svg(&out),
        "bounds": m.bounds,
        "parts": m.parts.iter().map(|p| serde_json::json!({ "name": p.name, "material": p.material })).collect::<Vec<_>>(),
        "lines": m.lines.iter().map(|l| serde_json::json!({ "kind": l.kind, "radius": l.radius })).collect::<Vec<_>>(),
    });
    let res = Object::new();
    set(&res, "meta", &JsValue::from_str(&meta.to_string()));
    let parts = Array::new();
    for p in &m.parts {
        let o = Object::new();
        set(&o, "positions", &Float32Array::from(&p.positions[..]).into());
        set(&o, "normals", &Float32Array::from(&p.normals[..]).into());
        set(&o, "uvs", &Float32Array::from(&p.uvs[..]).into());
        set(&o, "indices", &Uint32Array::from(&p.indices[..]).into());
        parts.push(&o);
    }
    set(&res, "parts", &parts);
    let lines = Array::new();
    for l in &m.lines {
        let flat: Vec<f32> = l.points.iter().flatten().copied().collect();
        lines.push(&Float32Array::from(&flat[..]));
    }
    set(&res, "lines", &lines);
    Ok(res.into())
}

#[wasm_bindgen]
pub fn pattern_pdf(design_json: &str, paper: &str) -> Result<Vec<u8>, JsError> {
    let out = build(design_json)?;
    let paper = Paper::parse(paper).map_err(|e| JsError::new(&e))?;
    Ok(bag_core::pattern_pdf(&out, paper))
}

#[wasm_bindgen]
pub fn pattern_svg(design_json: &str) -> Result<String, JsError> {
    Ok(bag_core::pattern_svg(&build(design_json)?))
}

#[wasm_bindgen]
pub fn mesh_obj(design_json: &str) -> Result<String, JsError> {
    Ok(build(design_json)?.mesh.to_obj())
}

#[wasm_bindgen]
pub fn default_design(style: &str) -> Result<String, JsError> {
    let d = bag_core::default_design(style).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::to_string_pretty(&d).unwrap())
}
