import { ITEMS } from './items';

/** The numbers a fit check needs from the bag design (all cm). */
export type FitParams = { width: number; top_width: number; height: number; depth: number; top_depth: number };
export type Thing = { key: string; label: string; dims: [number, number, number]; color: string };
export type Verdict = 'ok' | 'tight' | 'sticks' | 'no';
export type Row = { thing: Thing; n: number; verdict: Verdict; note: string };
export type Box = { c: [number, number, number]; size: [number, number, number]; color: string; ok: boolean };
export type FitResult = { rows: Row[]; boxes: Box[]; fill: number; inner: [number, number, number]; opening: [number, number] };

/** Seam allowance + lining + padding that the inside loses against the outside, per side. */
const M = 1.3;

/** Overall size of a catalogue item, cm (box: width/height/thickness; capsule: diameter/length). */
export function catalogue(): Thing[] {
  return Object.entries(ITEMS).map(([key, s]) => {
    const [a, b, c] = s.size;
    const dims: [number, number, number] = s.kind === 'box' ? [2 * a, 2 * b, 2 * c] : [2 * a, 2 * (a + b), 2 * a];
    return { key, label: s.label, dims, color: s.color };
  });
}

/**
 * Does it fit, and where would it sit? Geometry, not physics: the opening has to be big
 * enough to pass the item's two smallest sides, the inside has to hold it (standing, or
 * lying flat if it's too tall), and everything is shelf-packed on the floor of the bag.
 */
export function checkFit(p: FitParams, things: { thing: Thing; n: number }[], bottomY = 0): FitResult {
  const iw = p.width - 2 * M, id = p.depth - 2 * M, ih = p.height - 2 * M;
  const ow = p.top_width - 2 * M, od = (p.top_depth > 0 ? p.top_depth : p.depth) - 2 * M;
  const rows: Row[] = [];
  const queue: { thing: Thing; fx: number; fz: number; h: number; ok: boolean }[] = [];
  for (const { thing, n } of things) {
    if (n <= 0) continue;
    const [s1, s2, s3] = [...thing.dims].sort((a, b) => a - b);
    let verdict: Verdict = 'ok', note = '';
    let fx = s2, fz = s1, h = s3; // standing
    if (s1 > od || s2 > ow) {
      verdict = 'no';
      note = s1 > od ? `won't go through the opening (${s1.toFixed(1)} cm thick, opening is ${od.toFixed(1)} cm deep)` : `too wide for the opening (${s2.toFixed(1)} vs ${ow.toFixed(1)} cm)`;
    } else if (s3 <= ih && s2 <= iw && s1 <= id) {
      note = s3 > ih - 2 ? 'fits, snug' : 'stands inside';
      if (s3 > ih - 2) verdict = 'tight';
    } else if (s3 <= iw && s2 <= id) {
      fx = s3; fz = s2; h = s1; note = 'fits lying flat'; // too tall to stand
    } else if (s3 > ih && s3 - ih <= s3 * 0.45 && s2 <= iw && s1 <= id) {
      verdict = 'sticks'; note = `sticks out ${(s3 - ih).toFixed(1)} cm above the opening`;
    } else {
      verdict = 'no'; note = s3 > Math.max(ih, iw) ? 'too long for this bag' : "won't fit inside";
    }
    rows.push({ thing, n, verdict, note });
    for (let k = 0; k < n; k++) queue.push({ thing, fx, fz, h, ok: verdict !== 'no' });
  }
  // Shelf packing: biggest footprint first, rows along the width, then a second layer.
  const boxes: Box[] = [];
  let used = 0;
  const placeable = queue.filter((q) => q.ok).sort((a, b) => b.fx * b.fz - a.fx * a.fz);
  const layers: { y: number; x: number; z: number; rowD: number }[] = [{ y: 0, x: 0, z: 0, rowD: 0 }];
  const layerTop = [0];
  for (const q of placeable) {
    let placed = false;
    for (let li = 0; li < layers.length && !placed; li++) {
      const L = layers[li];
      if (L.x + q.fx > iw) { L.x = 0; L.z += L.rowD; L.rowD = 0; }
      if (L.z + q.fz <= id && L.y + q.h <= ih + 0.45 * q.h) {
        boxes.push({ c: [-iw / 2 + L.x + q.fx / 2, bottomY + M + L.y + q.h / 2, -id / 2 + L.z + q.fz / 2], size: [q.fx, q.h, q.fz], color: q.thing.color, ok: true });
        L.x += q.fx; L.rowD = Math.max(L.rowD, q.fz);
        layerTop[li] = Math.max(layerTop[li], q.h);
        used += q.fx * q.fz * q.h;
        placed = true;
      }
    }
    if (!placed) {
      const y = layerTop.reduce((a, b) => a + b * 0.55, 0);
      if (layers.length < 3 && y + q.h <= ih) {
        layers.push({ y, x: 0, z: 0, rowD: 0 }); layerTop.push(0);
        const L = layers[layers.length - 1];
        boxes.push({ c: [-iw / 2 + q.fx / 2, bottomY + M + L.y + q.h / 2, -id / 2 + q.fz / 2], size: [q.fx, q.h, q.fz], color: q.thing.color, ok: true });
        L.x = q.fx; L.rowD = q.fz; layerTop[layers.length - 1] = q.h; used += q.fx * q.fz * q.h;
      } else {
        // No room: show it hovering beside the bag in red.
        const side = p.top_width / 2 + q.fx / 2 + 4;
        boxes.push({ c: [side, bottomY + q.h / 2 + 2, 0], size: [q.fx, q.h, q.fz], color: '#d6453a', ok: false });
        const r = rows.find((r) => r.thing === q.thing);
        if (r && r.verdict !== 'no') { r.verdict = 'no'; r.note = 'no room left in the bag'; }
      }
    }
  }
  for (const q of queue.filter((q) => !q.ok)) {
    const side = p.top_width / 2 + q.fx / 2 + 4;
    boxes.push({ c: [side, bottomY + q.h / 2 + 2, 0], size: [q.fx, q.h, q.fz], color: '#d6453a', ok: false });
  }
  const vol = ((iw + ow) / 2) * ((id + od) / 2) * ih;
  return { rows, boxes, fill: vol > 0 ? used / vol : 0, inner: [iw, id, ih], opening: [ow, od] };
}

/** Seam + lining + padding lost between the outside of the fabric and the usable inside. */
export const WALL = M;

type V3 = [number, number, number];
export type Slot = { lo: V3; hi: V3; mass: number };

/**
 * Where does the next item go? Pure, deterministic packing (no dropping, no luck): scan every
 * spot of the bag's inside on a 1 cm grid in every orientation the caller allows and take the
 * lowest one that is clear and supported, filling the floor row by row (back-left first)
 * before stacking. Heavy things avoid sitting on light ones. Boxes are axis-aligned in the
 * bag's rest frame (cm). Returns null when nothing fits.
 */
export function packSlot(vol: { lo: V3; hi: V3 }, placed: Slot[], exts: V3[], mass: number, gap = 0.25) {
  let best = null as { oi: number; lo: V3; hi: V3 } | null, bs = Infinity;
  exts.forEach(([ex, ey, ez], oi) => {
    if (ex > vol.hi[0] - vol.lo[0] + 1e-6 || ez > vol.hi[2] - vol.lo[2] + 1e-6) return;
    for (let x = vol.lo[0]; x <= vol.hi[0] - ex + 1e-6; x += 1) {
      for (let z = vol.lo[2]; z <= vol.hi[2] - ez + 1e-6; z += 1) {
        let y = vol.lo[1], sup = -1;
        for (let k = 0; k < placed.length; k++) {
          const p = placed[k];
          if (p.hi[0] + gap > x && p.lo[0] - gap < x + ex && p.hi[2] + gap > z && p.lo[2] - gap < z + ez) {
            const t = p.hi[1] + gap;
            if (t > y) { y = t; sup = k; }
          }
        }
        if (y + ey > vol.hi[1] + 1e-6) continue;
        let score = y * 1000 + ey * 10 + z + x * 0.02;
        if (sup >= 0 && placed[sup].mass < mass * 0.4) score += 5000; // light things don't carry heavy ones
        if (score < bs) { bs = score; best = { oi, lo: [x, y, z], hi: [x + ex, y + ey, z + ez] }; }
      }
    }
  });
  return best;
}
