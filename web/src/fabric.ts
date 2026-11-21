// Cloth simulation for the bag's fabric (XPBD, "small steps" variant).
//
//  - The panels, gusset and straps become one particle system. Coincident seam
//    vertices are welded, so the bag behaves as a single sewn object.
//  - Stretch constraints on every triangle edge (near-inextensible), plus bending
//    constraints across every shared edge, softness set by the fabric.
//  - Separate pieces (handles, pocket) are stitched onto the body with short links.
//  - Floor contact with friction, cheap self-collision, mouse grab.
//  - Everything else (hardware, zipper, stitches, piping, lining) follows the
//    nearest fabric particle, so it rides along with the cloth.
// All work is in the bag's local space (centimetres), driven by Studio.
import * as THREE from 'three';
import type { Finish } from './engine';

const SIM_PARTS = /^(front|back|gusset|strap_front|strap_back|shoulder_strap|pocket|lid|zip_panel)/;
/** Zip-top tape + teeth: they ride on the lid edges (each half on its own side). */
const ZIP_PARTS = /^zip_top_(tape|teeth)/;
/** The slider + puller: slides along the zip line as you drag it. */
const SLIDER_PARTS = /^zip_top_(slider|ring|tassel)/;
const CLUSTER = 1.5; // cm: physics resolution (render mesh is skinned onto it)
const K = 4; // particles each render vertex follows
const G = -981; // cm/s²
const SUBSTEPS = 12;
/** How far (cm) an opened zip top gapes. */
const ZIP_GAPE = 6;
const SELF_R =1.0; // cm: self-collision radius

/** Bending compliance per finish: lower = stiffer. */
const BEND: Record<Finish, number> = { leather: 2e-8, canvas: 6e-8, denim: 1e-7, suede: 4e-7, nylon: 2e-6 };
/**
 * Body "structure" (lining + interfacing + seams holding the shape), as shape-matching
 * strength: 0 = collapses like a sack, 1 = rigid. Rotation-invariant, so the bag
 * still tips, swings and dents; it just wants to return to its sewn shape.
 */
const STRUCTURE: Record<Finish, number> = { leather: 0.5, canvas: 0.3, denim: 0.25, suede: 0.2, nylon: 0.06 };
const BODY_PARTS = /^(front|back|gusset|lid|zip_panel|pocket)/;

const _m = new THREE.Matrix3();
const _c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _r = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _t = new THREE.Vector3();
const _dq = new THREE.Quaternion();
/**
 * Rotation part of a 3x3 matrix (column-major array), warm-started from `q`
 * (Müller et al., "A Robust Method to Extract the Rotational Part of Deformations").
 */
function extractRotation(a: number[], q: THREE.Quaternion, iters = 10): THREE.Matrix3 {
  _c[0].set(a[0], a[1], a[2]); _c[1].set(a[3], a[4], a[5]); _c[2].set(a[6], a[7], a[8]);
  for (let it = 0; it < iters; it++) {
    _m.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    const e = _m.elements;
    _r[0].set(e[0], e[1], e[2]); _r[1].set(e[3], e[4], e[5]); _r[2].set(e[6], e[7], e[8]);
    const omega = _t.set(0, 0, 0);
    for (let k = 0; k < 3; k++) omega.add(_r[k].clone().cross(_c[k]));
    const denom = Math.abs(_r[0].dot(_c[0]) + _r[1].dot(_c[1]) + _r[2].dot(_c[2])) + 1e-9;
    omega.multiplyScalar(1 / denom);
    const angle = omega.length();
    if (angle < 1e-9) break;
    _dq.setFromAxisAngle(omega.multiplyScalar(1 / angle), angle);
    q.premultiply(_dq).normalize();
  }
  return _m.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
}

type Bound = {
  mesh: THREE.Mesh; orig: Float32Array; origN: Float32Array | null;
  idx: Int32Array; wt: Float32Array; off: Float32Array; fabric: boolean;
  slider?: boolean; origIndex?: THREE.BufferAttribute | null;
};

/** Things that can collide with the cloth (see items.ts). */
export interface ClothCollider {
  collide(x: Float32Array, w: Float32Array, n: number, dt: number): void;
}

export class ClothSim {
  n = 0;
  private x!: Float32Array; // position
  private p!: Float32Array; // previous position
  private v!: Float32Array; // velocity
  private w!: Float32Array; // inverse mass
  private x0!: Float32Array; // rest position
  private ci!: Int32Array; // constraint particle pairs
  private rest!: Float32Array;
  private comp!: Float32Array;
  private bound: Bound[] = [];
  private grabbed = -1;
  private grabW = 0;
  private grabTarget = new THREE.Vector3();
  private calm = 0;
  private hashHead!: Int32Array;
  private hashNext!: Int32Array;

  private body!: Int32Array; // particles that keep the bag's shape (not straps)
  private structure: number;
  private q = new THREE.Quaternion();
  private smw!: Float32Array; // per-particle shape-matching weight

  items: ClothCollider | null = null;

  // Zipper: the lid halves are held together only by these links, each at a rest x.
  private side!: Int8Array; // -1 back half, +1 front half, 0 elsewhere
  private zip: { x0: number; x1: number; yMin: number } | null = null;
  private zipA = new Int32Array(0);
  private zipB = new Int32Array(0);
  private zipRest = new Float32Array(0);
  private zipX = new Float32Array(0);
  private zipLine: { a: number; b: number; x: number }[] = []; // sorted, for the slider
  private lidIds = new Int32Array(0);
  private zipS = 1; // slider position 0 (fully open) .. 1 (closed)
  private zipTarget = 1;
  private zipping = false;
  private sliderRestX = 0;

  constructor(private bag: THREE.Object3D, private floor: number, finish: Finish) {
    this.structure = STRUCTURE[finish] ?? STRUCTURE.canvas;
    this.build(BEND[finish] ?? BEND.canvas);
  }

  private build(bendCompliance: number) {
    const sim: THREE.Mesh[] = [], other: THREE.Mesh[] = [];
    this.bag.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      if (m.userData.item) return;
      (SIM_PARTS.test(m.name) ? sim : other).push(m);
    });

    // 1. Cluster sim vertices into coarse particles (voxel grid). The render mesh is
    //    far denser than the physics needs; seams fall into shared voxels and weld.
    const sum: number[] = [], cnt: number[] = [];
    const cell = new Map<string, number>();
    const vmap: Int32Array[] = [];
    for (const m of sim) {
      const a = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const map = new Int32Array(a.count);
      for (let i = 0; i < a.count; i++) {
        const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
        const k = `${Math.floor(x / CLUSTER)},${Math.floor(y / CLUSTER)},${Math.floor(z / CLUSTER)}`;
        let id = cell.get(k);
        if (id === undefined) {
          id = cnt.length;
          cell.set(k, id);
          sum.push(0, 0, 0);
          cnt.push(0);
        }
        sum[id * 3] += x; sum[id * 3 + 1] += y; sum[id * 3 + 2] += z;
        cnt[id]++;
        map[i] = id;
      }
      vmap.push(map);
    }
    const pos = sum.map((s, i) => s / cnt[Math.floor(i / 3)]);
    const n = (this.n = cnt.length);
    const isBody = new Uint8Array(n);
    sim.forEach((m, mi) => { if (BODY_PARTS.test(m.name)) for (const id of vmap[mi]) isBody[id] = 1; });
    this.body = Int32Array.from({ length: n }, (_, i) => i).filter((i) => isBody[i]);
    this.x = Float32Array.from(pos);
    this.x0 = this.x.slice();
    this.p = this.x.slice();
    this.v = new Float32Array(n * 3);
    this.w = new Float32Array(n).fill(1);
    this.smw = new Float32Array(n).fill(1);

    // Zipper halves: lid particles take the side of the zip line they sit on. The zip
    // runs along x at z = 0, which is also a voxel boundary, so no particle straddles it.
    this.side = new Int8Array(n);
    const teeth = other.find((m) => /^zip_top_teeth/.test(m.name));
    const lids = new Set<number>();
    sim.forEach((m, mi) => { if (/^lid/.test(m.name)) for (const id of vmap[mi]) lids.add(id); });
    if (teeth && lids.size) {
      teeth.geometry.computeBoundingBox();
      const bb = teeth.geometry.boundingBox!;
      this.zip = { x0: bb.min.x, x1: bb.max.x, yMin: bb.min.y - 3 };
      this.lidIds = Int32Array.from(lids);
      for (const id of lids) this.side[id] = pos[id * 3 + 2] >= 0 ? 1 : -1;
      const slider = other.find((m) => /^zip_top_slider/.test(m.name));
      if (slider) {
        slider.geometry.computeBoundingBox();
        this.sliderRestX = (slider.geometry.boundingBox!.min.x + slider.geometry.boundingBox!.max.x) / 2;
      }
    }

    // 2. Constraints: stretch on edges, bending across shared edges.
    const edges = new Map<number, number>(); // edge key -> opposite vertex of first tri
    const pairs: number[] = [], comp: number[] = [];
    const seen = new Set<number>();
    const add = (a: number, b: number, c: number) => {
      if (a === b) return;
      const k = a < b ? a * n + b : b * n + a;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push(a, b);
      comp.push(c);
    };
    // Union-find for connected pieces (used for stitching pieces together).
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    sim.forEach((m, mi) => {
      const map = vmap[mi];
      const bend = ZIP_PARTS.test(m.name) ? 0 : bendCompliance; // zipper: rigid in length and bend
      const index = m.geometry.getIndex();
      if (!index) return;
      for (let t = 0; t + 2 < index.count; t += 3) {
        const tri = [map[index.getX(t)], map[index.getX(t + 1)], map[index.getX(t + 2)]];
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
        for (let e = 0; e < 3; e++) {
          const a = tri[e], b = tri[(e + 1) % 3], o = tri[(e + 2) % 3];
          add(a, b, 0);
          parent[find(a)] = find(b);
          const k = a < b ? a * n + b : b * n + a;
          const prev = edges.get(k);
          if (prev === undefined) edges.set(k, o);
          else if (prev !== o) add(prev, o, bend);
        }
      }
    });

    // 3. Stitch separate pieces (handles, pocket...) to the rest: link their closest
    //    vertices to other pieces, widening the search until something is found.
    const roots = new Map<number, number[]>();
    for (let i = 0; i < n; i++) (roots.get(find(i)) ?? roots.set(find(i), []).get(find(i))!).push(i);
    if (roots.size > 1) {
      const comps = [...roots.values()].sort((a, b) => b.length - a.length);
      const body = new Set(comps[0]);
      const bodyIds = comps[0];
      for (const c of comps.slice(1)) {
        for (const reach of [0.8, 1.6, 3.2, 6.4]) {
          let links = 0;
          for (const i of c) {
            let best = -1, bd = reach * reach;
            for (const j of bodyIds) {
              if (this.side[i] * this.side[j] < 0) continue; // never sew across the zipper
              const d = this.d2(i, j);
              if (d < bd) { bd = d; best = j; }
            }
            if (best >= 0) { add(i, best, 0); links++; }
          }
          if (links >= 2) break;
        }
        for (const i of c) body.add(i);
        bodyIds.push(...c);
      }
    }
    // 3b. Teeth links across the zip line, and stiff "spine" links along each edge so
    //     the zipper keeps its length (a zipper never stretches).
    if (this.zip) {
      const { x0, x1 } = this.zip;
      const edge = (s: number) => [...this.lidIds]
        .filter((id) => this.side[id] === s && Math.abs(pos[id * 3 + 2]) < CLUSTER)
        .sort((a, b) => pos[a * 3] - pos[b * 3]);
      const ef = edge(1), eb = edge(-1);
      const za: number[] = [], zb: number[] = [], zr: number[] = [], zx: number[] = [];
      for (const a of ef) {
        let best = -1, bd = (CLUSTER * 2.5) ** 2;
        for (const b of eb) { const d = this.d2(a, b); if (d < bd) { bd = d; best = b; } }
        if (best < 0) continue;
        const mx = (pos[a * 3] + pos[best * 3]) / 2;
        const inside = mx > x0 && mx < x1;
        za.push(a); zb.push(best); zr.push(Math.sqrt(bd));
        zx.push(inside ? mx : -1e9); // past the teeth the tape ends are sewn shut
        if (inside) this.zipLine.push({ a, b: best, x: mx });
      }
      this.zipA = Int32Array.from(za); this.zipB = Int32Array.from(zb);
      this.zipRest = Float32Array.from(zr); this.zipX = Float32Array.from(zx);
      for (const e of [ef, eb]) for (let i = 0; i < e.length; i++) for (const s of [2, 3, 5]) if (i + s < e.length) add(e[i], e[i + s], 0);
    }

    const m = comp.length;
    this.ci = Int32Array.from(pairs);
    this.comp = Float32Array.from(comp);
    this.rest = new Float32Array(m);
    for (let k = 0; k < m; k++) this.rest[k] = Math.sqrt(this.d2(this.ci[k * 2], this.ci[k * 2 + 1]));

    // 4. Skin every render vertex to its own cluster + nearby particles (inverse-distance
    //    weights), keeping the exact rest offset so the undeformed bag is unchanged.
    this.buildHash(this.x0, CLUSTER);
    sim.forEach((mesh, mi) => this.bound.push(this.bindMesh(mesh, vmap[mi], true)));
    for (const mesh of other) {
      if (this.zip && SLIDER_PARTS.test(mesh.name)) {
        const a = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        a.setUsage(THREE.DynamicDrawUsage);
        const e = new Int32Array(0), f = new Float32Array(0);
        this.bound.push({ mesh, orig: (a.array as Float32Array).slice(), origN: null, idx: e, wt: f, off: f, fabric: false, slider: true });
      } else this.bound.push(this.bindMesh(mesh, null, false));
    }
  }

  /** Which zipper half each vertex belongs to (0 = not near the zip). */
  private vertexSides(mesh: THREE.Mesh, own: Int32Array | null): Int8Array | null {
    if (!this.zip) return null;
    const a = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = new Int8Array(a.count);
    if (own) {
      for (let i = 0; i < a.count; i++) out[i] = this.side[own[i]];
      return out;
    }
    const { x0, x1, yMin } = this.zip;
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      if (x > x0 - 3 && x < x1 + 3 && y > yMin && Math.abs(z) > 0.005) out[i] = z > 0 ? 1 : -1;
    }
    // Teeth: each tooth is its own little box, it goes wholly to the side its centre is on.
    const index = mesh.geometry.getIndex();
    if (/^zip_top_teeth/.test(mesh.name) && index) {
      const par = Int32Array.from({ length: a.count }, (_, i) => i);
      const find = (i: number): number => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
      for (let t = 0; t < index.count; t += 3) {
        const r = find(index.getX(t));
        par[find(index.getX(t + 1))] = r; par[find(index.getX(t + 2))] = r;
      }
      const zs = new Map<number, number>();
      for (let i = 0; i < a.count; i++) { const r = find(i); zs.set(r, (zs.get(r) ?? 0) + a.getZ(i)); }
      for (let i = 0; i < a.count; i++) out[i] = zs.get(find(i))! >= 0 ? 1 : -1;
    }
    return out;
  }

  private bindMesh(mesh: THREE.Mesh, own: Int32Array | null, fabric: boolean): Bound {
    const g = mesh.geometry;
    const a = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    a.setUsage(THREE.DynamicDrawUsage);
    const cnt = a.count;
    const idx = new Int32Array(cnt * K), wt = new Float32Array(cnt * K), off = new Float32Array(cnt * 3);
    const cand: number[] = [], cd: number[] = [];
    const vs = this.vertexSides(mesh, own);
    // Triangles spanning both halves (the tape's hairline split) would stretch across
    // an open zipper: leave them out while simulating.
    let origIndex: THREE.BufferAttribute | null | undefined;
    const index = g.getIndex();
    if (vs && index && vs.some((s) => s !== 0)) {
      const keep: number[] = [];
      for (let t = 0; t < index.count; t += 3) {
        const s0 = vs[index.getX(t)], s1 = vs[index.getX(t + 1)], s2 = vs[index.getX(t + 2)];
        if (s0 * s1 < 0 || s1 * s2 < 0 || s0 * s2 < 0) continue;
        keep.push(index.getX(t), index.getX(t + 1), index.getX(t + 2));
      }
      if (keep.length < index.count) { origIndex = index; g.setIndex(keep); }
    }
    for (let i = 0; i < cnt; i++) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      this.kNearest(x, y, z, cand, cd, vs ? vs[i] : 0);
      if (own) {
        // Always include the vertex's own cluster (stops panels skinning to the opposite side).
        const o = own[i], at = cand.indexOf(o);
        if (at >= 0) { cand.splice(at, 1); cd.splice(at, 1); }
        cand.unshift(o);
        cd.unshift(Math.sqrt(this.d2p(o, x, y, z)));
      }
      let tw = 0, rx = 0, ry = 0, rz = 0;
      for (let k = 0; k < K; k++) {
        const j = cand[Math.min(k, cand.length - 1)];
        const wk = 1 / (cd[Math.min(k, cd.length - 1)] + 0.25) ** 2;
        idx[i * K + k] = j;
        wt[i * K + k] = wk;
        tw += wk;
      }
      for (let k = 0; k < K; k++) {
        const j = idx[i * K + k], wk = (wt[i * K + k] /= tw);
        rx += this.x0[j * 3] * wk; ry += this.x0[j * 3 + 1] * wk; rz += this.x0[j * 3 + 2] * wk;
      }
      off[i * 3] = x - rx; off[i * 3 + 1] = y - ry; off[i * 3 + 2] = z - rz;
    }
    return { mesh, orig: (a.array as Float32Array).slice(), origN: nrm ? (nrm.array as Float32Array).slice() : null, idx, wt, off, fabric, origIndex };
  }

  private d2p(j: number, x: number, y: number, z: number) {
    const dx = this.x0[j * 3] - x, dy = this.x0[j * 3 + 1] - y, dz = this.x0[j * 3 + 2] - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** The K nearest rest particles to a point (sorted), via the rest-pose hash. */
  private kNearest(x: number, y: number, z: number, out: number[], dist: number[], vside = 0) {
    out.length = dist.length = 0;
    const s = this.cellSize;
    const cx = Math.floor(x / s), cy = Math.floor(y / s), cz = Math.floor(z / s);
    for (let r = 1; r <= 8 && out.length < K; r *= 2) {
      out.length = dist.length = 0;
      const seen = new Set<number>();
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++)
        for (let q = this.hashHead[this.hash(cx + i, cy + j, cz + k)]; q >= 0; q = this.hashNext[q]) {
          if (seen.has(q)) continue;
          seen.add(q);
          if (vside && this.side[q] && this.side[q] !== vside) continue; // other zipper half
          const d = Math.sqrt(this.d2p(q, x, y, z));
          let at = dist.length;
          while (at > 0 && dist[at - 1] > d) at--;
          if (at >= K) continue;
          dist.splice(at, 0, d);
          out.splice(at, 0, q);
          if (dist.length > K) { dist.length = K; out.length = K; }
        }
    }
    if (!out.length) { out.push(this.nearest(x, y, z)); dist.push(Math.sqrt(this.d2p(out[0], x, y, z))); }
  }

  private d2(i: number, j: number, x = this.x) {
    const dx = x[i * 3] - x[j * 3], dy = x[i * 3 + 1] - x[j * 3 + 1], dz = x[i * 3 + 2] - x[j * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  // ── Spatial hash (binding + self-collision) ────────────────────────────────
  private cellSize = 1;
  private buildHash(x: Float32Array, size: number) {
    this.cellSize = size;
    this.hashHead ??= new Int32Array(1 << 16);
    this.hashNext ??= new Int32Array(this.n);
    if (this.hashNext.length < this.n) this.hashNext = new Int32Array(this.n);
    this.hashHead.fill(-1);
    for (let i = 0; i < this.n; i++) {
      const h = this.hash(Math.floor(x[i * 3] / size), Math.floor(x[i * 3 + 1] / size), Math.floor(x[i * 3 + 2] / size));
      this.hashNext[i] = this.hashHead[h];
      this.hashHead[h] = i;
    }
  }
  private hash(ix: number, iy: number, iz: number) {
    return (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481)) & 0xffff;
  }
  private nearest(x: number, y: number, z: number) {
    const s = this.cellSize;
    const cx = Math.floor(x / s), cy = Math.floor(y / s), cz = Math.floor(z / s);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 8 && best < 0; r *= 2)
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++)
        for (let q = this.hashHead[this.hash(cx + i, cy + j, cz + k)]; q >= 0; q = this.hashNext[q]) {
          const dx = this.x0[q * 3] - x, dy = this.x0[q * 3 + 1] - y, dz = this.x0[q * 3 + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = q; }
        }
    if (best < 0) for (let q = 0; q < this.n; q++) {
      const dx = this.x0[q * 3] - x, dy = this.x0[q * 3 + 1] - y, dz = this.x0[q * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // ── Interaction ────────────────────────────────────────────────────────────
  /** True if the bag has a zip top that can be opened. */
  /** Zip extent along x and the height of the teeth (bag-local cm), or null. */
  /** Highest fabric (particle centres) below `yMax` in the column x0..x1 around depth `zc`: the inside floor. */
  floorUnder(x0: number, x1: number, zc: number, yMax: number) {
    const { x, n } = this;
    let top = -Infinity;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3, y = x[i3 + 1];
      if (y < yMax && y > top && x[i3] > x0 && x[i3] < x1 && Math.abs(x[i3 + 2] - zc) < 3) top = y;
    }
    return top;
  }
  /** Front-to-back extent [zMin, zMax] of the sewn body at mid height (rest shape, so the strap and slump don't count). */
  bodyDepth(y0: number, y1: number): [number, number] {
    const r = this.x0;
    let lo = Infinity, hi = -Infinity;
    for (const i of this.body) {
      const i3 = i * 3, y = r[i3 + 1];
      if (y < y0 || y > y1 || Math.abs(r[i3]) > 4) continue;
      lo = Math.min(lo, r[i3 + 2]); hi = Math.max(hi, r[i3 + 2]);
    }
    return lo < hi ? [lo, hi] : [-4, 4];
  }
  // Best-fit pose of the body (from shape matching): current = q·(rest − fitC0) + fitC.
  private fitC = new THREE.Vector3();
  private fitC0 = new THREE.Vector3();
  get fitQ() { return this.q; }
  /** Map a rest-shape point to where that spot of the bag is now (in place). */
  toCurrent(p: THREE.Vector3) {
    return p.sub(this.fitC0).applyQuaternion(this.q).add(this.fitC);
  }
  /** Rest-shape bounds of the sewn body (no straps): [minX, minY, minZ, maxX, maxY, maxZ]. */
  bodyBox() {
    const r = this.x0, out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const id of this.body) for (let k = 0; k < 3; k++) {
      out[k] = Math.min(out[k], r[id * 3 + k]); out[k + 3] = Math.max(out[k + 3], r[id * 3 + k]);
    }
    return out;
  }
  get zipSpan() {
    return this.zip && { x0: this.zip.x0, x1: this.zip.x1, y: this.zip.yMin + 3 };
  }
  get hasZip() {
    return !!this.zip && this.zipLine.length > 1;
  }
  /** Slider position: 0 = fully open, 1 = closed. */
  /** Where the slider is headed (0 open .. 1 closed); it glides there over a few frames. */
  get zipper() {
    return this.zipTarget;
  }
  set zipper(s: number) {
    this.zipTarget = Math.max(0, Math.min(1, s));
    this.calm = 0;
  }
  /** x (bag-local) of the slider for a position s. */
  private sliderX(s: number) {
    const { x0, x1 } = this.zip!;
    return x0 + 1 + (x1 - x0 - 2) * s;
  }
  /** Links at rest x beyond this are open. */
  private get openFrom() {
    return this.zipS >= 0.999 ? Infinity : this.sliderX(this.zipS) + 1;
  }

  /** Grab the particle nearest to a bag-local point, or the zipper pull if `part` is it. */
  grab(local: THREE.Vector3, part = '') {
    if (this.hasZip && SLIDER_PARTS.test(part)) {
      this.release();
      this.zipping = true;
      return;
    }
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i * 3] - local.x, dy = this.x[i * 3 + 1] - local.y, dz = this.x[i * 3 + 2] - local.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    this.release();
    this.grabbed = best;
    this.grabW = this.w[best];
    this.w[best] = 0;
    this.grabTarget.set(this.x[best * 3], this.x[best * 3 + 1], this.x[best * 3 + 2]);
  }
  drag(local: THREE.Vector3) {
    if (this.zipping) {
      const { x0, x1 } = this.zip!;
      this.zipper = (local.x - x0 - 1) / (x1 - x0 - 2);
      return;
    }
    this.grabTarget.copy(local);
    this.grabTarget.y = Math.max(this.grabTarget.y, this.floor + 0.5);
  }
  release() {
    if (this.grabbed >= 0) this.w[this.grabbed] = this.grabW;
    this.grabbed = -1;
    this.zipping = false;
  }
  get holding() {
    return this.grabbed >= 0 || this.zipping;
  }

  // ── Solver ─────────────────────────────────────────────────────────────────
  /** Advance one frame. Returns true while the cloth is still moving. */
  step(frameDt: number): boolean {
    const dt = Math.min(frameDt, 1 / 30) / SUBSTEPS;
    const { x, p, v, w, ci, rest, comp, n } = this;
    const m = rest.length;
    const fy = this.floor + 0.12;
    const g = this.grabbed;

    // Zipper: the slider glides toward where it's pulled; lid fabric behind an open
    // zipper stops holding its sewn shape and is free to flop open.
    const zipMoving = Math.abs(this.zipTarget - this.zipS) > 1e-4;
    if (this.zip) {
      this.zipS += (this.zipTarget - this.zipS) * Math.min(1, frameDt * 14);
      const from = this.openFrom;
      for (const id of this.lidIds) this.smw[id] = Math.max(0, Math.min(1, (from - this.x0[id * 3]) / 3));
    }
    const { zipA, zipB, zipRest, zipX } = this;
    const zl = zipA.length, open = this.openFrom;

    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
        if (w[i] === 0) continue;
        v[i3 + 1] += G * dt;
        x[i3] += v[i3] * dt; x[i3 + 1] += v[i3 + 1] * dt; x[i3 + 2] += v[i3 + 2] * dt;
      }
      if (g >= 0) {
        // Ease the held point toward the cursor so fast flicks don't explode the cloth.
        const t = this.grabTarget, k = 0.35;
        x[g * 3] += (t.x - x[g * 3]) * k; x[g * 3 + 1] += (t.y - x[g * 3 + 1]) * k; x[g * 3 + 2] += (t.z - x[g * 3 + 2]) * k;
      }
      const dt2 = dt * dt;
      for (let k = 0; k < m; k++) {
        const a = ci[k * 2], b = ci[k * 2 + 1];
        const wa = w[a], wb = w[b];
        const ws = wa + wb + comp[k] / dt2;
        if (ws === 0) continue;
        const a3 = a * 3, b3 = b * 3;
        const dx = x[a3] - x[b3], dy = x[a3 + 1] - x[b3 + 1], dz = x[a3 + 2] - x[b3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const corr = (len - rest[k]) / (len * ws);
        x[a3] -= dx * corr * wa; x[a3 + 1] -= dy * corr * wa; x[a3 + 2] -= dz * corr * wa;
        x[b3] += dx * corr * wb; x[b3 + 1] += dy * corr * wb; x[b3 + 2] += dz * corr * wb;
      }
      // Closed teeth: rigid links across the zip line.
      // Open teeth: the two halves spring apart (a real zip top gapes once opened),
      // most strongly a few cm behind the slider.
      for (let k = 0; k < zl; k++) {
        const a = zipA[k], b = zipB[k], wa = w[a], wb = w[b], ws = wa + wb;
        if (!ws) continue;
        const a3 = a * 3, b3 = b * 3;
        const dx = x[a3] - x[b3], dy = x[a3 + 1] - x[b3 + 1], dz = x[a3 + 2] - x[b3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        let corr: number;
        if (zipX[k] >= open) {
          if (zipX[k] > 1e8) continue;
          const gape = zipRest[k] + ZIP_GAPE * Math.min(1, (zipX[k] - open) / 4);
          if (len >= gape) continue;
          corr = ((len - gape) / (len * ws)) * 0.08; // soft: the fabric, not a rod
        } else corr = (len - zipRest[k]) / (len * ws);
        x[a3] -= dx * corr * wa; x[a3 + 1] -= dy * corr * wa; x[a3 + 2] -= dz * corr * wa;
        x[b3] += dx * corr * wb; x[b3 + 1] += dy * corr * wb; x[b3 + 2] += dz * corr * wb;
      }
      this.items?.collide(x, w, n, dt);
      // Floor with friction: a particle that touches down loses most of its sliding.
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        if (x[i3 + 1] < fy) {
          x[i3 + 1] = fy;
          x[i3] = p[i3] + (x[i3] - p[i3]) * 0.2;
          x[i3 + 2] = p[i3 + 2] + (x[i3 + 2] - p[i3 + 2]) * 0.2;
        }
      }
      this.shapeMatch(1 - Math.pow(1 - this.structure, 1 / SUBSTEPS) * 1);
      if (s % 6 === 0) this.findSelfPairs();
      this.selfCollide();
      const damp = 1 - 0.6 * dt;
      for (let i = 0; i < n * 3; i++) v[i] = ((x[i] - p[i]) / dt) * damp;
    }
    // Normals are the costly part of the mesh update; every other frame is invisible to the eye.
    this.frameNo++;
    this.writeMeshes(this.frameNo % 2 === 0);

    let maxV = 0;
    for (let i = 0; i < n * 3; i++) maxV = Math.max(maxV, Math.abs(v[i]));
    this.calm = maxV < 2 ? this.calm + frameDt : 0; // < 2 cm/s for a while = settled
    return g >= 0 || zipMoving || this.calm < 0.4;
  }

  /** Zip line midpoint at rest x `px`, from the current (or rest) particle positions. */
  private zipMid(px: number, x: Float32Array, out: THREE.Vector3) {
    const L = this.zipLine;
    let i = 0;
    while (i < L.length - 2 && L[i + 1].x < px) i++;
    const A = L[i], B = L[i + 1];
    const t = Math.max(0, Math.min(1, (px - A.x) / (B.x - A.x || 1)));
    const m = (l: { a: number; b: number }, c: number) => (x[l.a * 3 + c] + x[l.b * 3 + c]) / 2;
    return out.set(
      m(A, 0) + (m(B, 0) - m(A, 0)) * t,
      m(A, 1) + (m(B, 1) - m(A, 1)) * t,
      m(A, 2) + (m(B, 2) - m(A, 2)) * t,
    );
  }

  /**
   * Shape matching (Müller et al. 2005): find the best rotation + translation of the
   * rest shape onto the current body particles, and pull each one toward it by `k`.
   */
  private shapeMatch(k: number) {
    const ids = this.body;
    if (k <= 0 || ids.length < 4) return;
    const { x, x0, w, smw } = this;
    // Weighted by smw: fabric that has been let go (an opened lid) must not steer
    // the body's best-fit rotation, or a gaping lid tips the whole bag over.
    let cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0, m = 0;
    for (const i of ids) {
      const s = smw[i];
      cx += x[i * 3] * s; cy += x[i * 3 + 1] * s; cz += x[i * 3 + 2] * s;
      rx += x0[i * 3] * s; ry += x0[i * 3 + 1] * s; rz += x0[i * 3 + 2] * s; m += s;
    }
    if (m < 1) return;
    cx /= m; cy /= m; cz /= m; rx /= m; ry /= m; rz /= m;
    this.fitC.set(cx, cy, cz); this.fitC0.set(rx, ry, rz);
    // A = Σ s (x - c)(x0 - c0)^T, column-major in a Matrix3.
    const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const i of ids) {
      const s = smw[i];
      if (!s) continue;
      const px = (x[i * 3] - cx) * s, py = (x[i * 3 + 1] - cy) * s, pz = (x[i * 3 + 2] - cz) * s;
      const qx = x0[i * 3] - rx, qy = x0[i * 3 + 1] - ry, qz = x0[i * 3 + 2] - rz;
      a[0] += px * qx; a[3] += px * qy; a[6] += px * qz;
      a[1] += py * qx; a[4] += py * qy; a[7] += py * qz;
      a[2] += pz * qx; a[5] += pz * qy; a[8] += pz * qz;
    }
    const R = extractRotation(a, this.q);
    const e = R.elements;
    for (const i of ids) {
      if (w[i] === 0 || smw[i] === 0) continue;
      const ki = k * smw[i];
      const qx = x0[i * 3] - rx, qy = x0[i * 3 + 1] - ry, qz = x0[i * 3 + 2] - rz;
      const gx = e[0] * qx + e[3] * qy + e[6] * qz + cx;
      const gy = e[1] * qx + e[4] * qy + e[7] * qz + cy;
      const gz = e[2] * qx + e[5] * qy + e[8] * qz + cz;
      x[i * 3] += (gx - x[i * 3]) * ki; x[i * 3 + 1] += (gy - x[i * 3 + 1]) * ki; x[i * 3 + 2] += (gz - x[i * 3 + 2]) * ki;
    }
  }

  /** Candidate self-collision pairs (flat i,j list), refreshed every few substeps. */
  private selfPairs = new Int32Array(1024);
  private selfCount = 0;

  /**
   * Find particle pairs that are near each other now but weren't neighbours in the
   * rest shape. The spatial hash is the costly part, so this runs every few substeps
   * with a generous search radius; `selfCollide` then resolves the pairs every substep.
   * (Resolving only every few substeps made the cloth buzz: each catch-up push
   * became a velocity spike.)
   */
  private findSelfPairs() {
    const { x, x0, n } = this;
    const reach = SELF_R * 2.5, reach2 = reach * reach, rest2 = (SELF_R * 2.5) ** 2;
    this.buildHash(x, reach);
    const s = this.cellSize;
    let cnt = 0, pairs = this.selfPairs;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const cx = Math.floor(x[i3] / s), cy = Math.floor(x[i3 + 1] / s), cz = Math.floor(x[i3 + 2] / s);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++)
        for (let j = this.hashHead[this.hash(cx + a, cy + b, cz + c)]; j >= 0; j = this.hashNext[j]) {
          if (j <= i) continue;
          const j3 = j * 3;
          const dx = x[i3] - x[j3], dy = x[i3 + 1] - x[j3 + 1], dz = x[i3 + 2] - x[j3 + 2];
          if (dx * dx + dy * dy + dz * dz >= reach2) continue;
          const ex = x0[i3] - x0[j3], ey = x0[i3 + 1] - x0[j3 + 1], ez = x0[i3 + 2] - x0[j3 + 2];
          if (ex * ex + ey * ey + ez * ez < rest2) continue; // neighbours in the rest shape
          if (cnt + 2 > pairs.length) { const g = new Int32Array(pairs.length * 2); g.set(pairs); pairs = this.selfPairs = g; }
          pairs[cnt++] = i; pairs[cnt++] = j;
        }
    }
    this.selfCount = cnt;
  }

  /** Push apart candidate pairs that got closer than SELF_R. */
  private selfCollide() {
    const { x, w, selfPairs: pairs, selfCount: cnt } = this;
    const r = SELF_R, r2 = r * r;
    for (let k = 0; k < cnt; k += 2) {
      const i = pairs[k], j = pairs[k + 1], i3 = i * 3, j3 = j * 3;
      const dx = x[i3] - x[j3], dy = x[i3 + 1] - x[j3 + 1], dz = x[i3 + 2] - x[j3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2 || d2 < 1e-12) continue;
      const ws = w[i] + w[j];
      if (!ws) continue;
      const d = Math.sqrt(d2), corr = (r - d) / (d * ws);
      x[i3] += dx * corr * w[i]; x[i3 + 1] += dy * corr * w[i]; x[i3 + 2] += dz * corr * w[i];
      x[j3] -= dx * corr * w[j]; x[j3 + 1] -= dy * corr * w[j]; x[j3 + 2] -= dz * corr * w[j];
    }
  }

  private frameNo = 0;
  private _cur = new THREE.Vector3();
  private _rest = new THREE.Vector3();
  private writeMeshes(normals = true) {
    const x = this.x;
    for (const b of this.bound) {
      const g = b.mesh.geometry;
      const a = g.getAttribute('position') as THREE.BufferAttribute;
      const arr = a.array as Float32Array;
      if (b.slider) {
        // Rigid slider: carried along the zip line to where it has been pulled.
        const d = this.zipMid(this.sliderX(this.zipS), x, this._cur).sub(this.zipMid(this.sliderRestX, this.x0, this._rest));
        const o = b.orig;
        for (let i = 0; i < o.length; i += 3) { arr[i] = o[i] + d.x; arr[i + 1] = o[i + 1] + d.y; arr[i + 2] = o[i + 2] + d.z; }
        a.needsUpdate = true;
        g.computeBoundingSphere();
        continue;
      }
      const { idx, wt, off } = b;
      const cnt = off.length / 3;
      for (let i = 0; i < cnt; i++) {
        const i3 = i * 3;
        let px = off[i3], py = off[i3 + 1], pz = off[i3 + 2];
        for (let k = i * K, e = k + K; k < e; k++) {
          const j3 = idx[k] * 3, wk = wt[k];
          px += x[j3] * wk; py += x[j3 + 1] * wk; pz += x[j3 + 2] * wk;
        }
        arr[i3] = px; arr[i3 + 1] = py; arr[i3 + 2] = pz;
      }
      a.needsUpdate = true;
      if (b.fabric && normals) g.computeVertexNormals(); // fabric bends; small rigid bits keep their normals
      g.computeBoundingSphere();
    }
  }

  /** Put every mesh back exactly as the engine made it. */
  restore() {
    for (const b of this.bound) {
      const g = b.mesh.geometry;
      const a = g.getAttribute('position') as THREE.BufferAttribute;
      (a.array as Float32Array).set(b.orig);
      a.needsUpdate = true;
      const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      if (nrm && b.origN) { (nrm.array as Float32Array).set(b.origN); nrm.needsUpdate = true; }
      if (b.origIndex) g.setIndex(b.origIndex);
      g.computeBoundingSphere();
    }
  }
}
