//! Flat pattern pieces. Piece coordinates are centimetres, y up.

use crate::geom::V2;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Notch {
    /// Point on the cut line.
    pub at: V2,
    /// Unit direction pointing into the piece.
    pub dir: V2,
    /// How far to snip. Always stops short of the sewing line.
    pub depth: f64,
}

/// Text printed on the piece itself (e.g. "LEAVE OPEN").
#[derive(Serialize, Clone, Debug)]
pub struct Label {
    pub at: V2,
    pub text: String,
    pub vertical: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Piece {
    pub id: String,
    pub name: String,
    /// Cutting instruction, e.g. "Cut 2 outer".
    pub cut: String,
    /// Sewing line (net shape), closed CCW polygon.
    pub sew: Vec<V2>,
    /// Cutting line (sewing line + allowances), closed polygon.
    pub cut_line: Vec<V2>,
    pub folds: Vec<[V2; 2]>,
    /// Match points between pieces.
    pub notches: Vec<Notch>,
    /// Clips into the seam allowance so it can turn a curve or corner.
    pub clips: Vec<Notch>,
    pub grain: [V2; 2],
    /// Placement marks (open polylines), e.g. where straps or pockets go.
    pub marks: Vec<Vec<V2>>,
    pub labels: Vec<Label>,
    pub notes: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Pattern {
    pub style: String,
    pub name: String,
    pub pieces: Vec<Piece>,
    /// Numbered sewing order.
    pub steps: Vec<String>,
    /// Shopping list besides fabric (zippers, rings, webbing).
    pub supplies: Vec<String>,
    pub warnings: Vec<String>,
}

/// Snip depth for a notch or clip: half the allowance, never more than 0.5 cm,
/// so it can never reach the sewing line.
pub fn notch_depth(seam_allowance: f64) -> f64 {
    (seam_allowance * 0.5).min(0.5)
}

/// Clips go deeper than notches but still stop 0.2 cm (or 30%) short of the seam.
pub fn clip_depth(seam_allowance: f64) -> f64 {
    (seam_allowance - 0.2).min(seam_allowance * 0.7).max(0.0)
}
