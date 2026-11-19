//! Flat pattern pieces. Piece coordinates are centimetres, y up.

use crate::geom::V2;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Notch {
    /// Point on the cut line.
    pub at: V2,
    /// Unit direction pointing into the piece.
    pub dir: V2,
}

#[derive(Serialize, Clone, Debug)]
pub struct Piece {
    pub id: String,
    pub name: String,
    /// Cutting instruction, e.g. "Cut 2 outer + 2 lining".
    pub cut: String,
    /// Sewing line (net shape), closed CCW polygon.
    pub sew: Vec<V2>,
    /// Cutting line (sewing line + allowances), closed polygon.
    pub cut_line: Vec<V2>,
    pub folds: Vec<[V2; 2]>,
    pub notches: Vec<Notch>,
    pub grain: [V2; 2],
    /// Placement marks (open polylines), e.g. where straps or pockets go.
    pub marks: Vec<Vec<V2>>,
    pub notes: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Pattern {
    pub style: String,
    pub name: String,
    pub pieces: Vec<Piece>,
    pub warnings: Vec<String>,
}
