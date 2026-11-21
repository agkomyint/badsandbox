// Interactive 2D pattern: pan/zoom, hover/select pieces, layer toggles, dimension lines.
// Rendered from the engine's piece data (cm), not the static export SVG.
import type { Appearance, Piece } from './engine';

type P = { x: number; y: number };
export type Layer = 'cut' | 'sew' | 'notches' | 'grain' | 'marks' | 'labels' | 'dims' | 'grid';
export const LAYERS: { key: Layer; label: string }[] = [
  { key: 'cut', label: 'Cut line' },
  { key: 'sew', label: 'Sew line' },
  { key: 'notches', label: 'Notches' },
  { key: 'grain', label: 'Grain' },
  { key: 'marks', label: 'Marks' },
  { key: 'labels', label: 'Labels' },
  { key: 'dims', label: 'Dims' },
  { key: 'grid', label: 'Grid' },
];

const NS = 'http://www.w3.org/2000/svg';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Which bag meshes (by part name) a pattern piece becomes. */
const RULES: [RegExp, RegExp][] = [
  [/^(body|base)$/, /^(front|back)$/],
  [/^gusset(_side|_base)?$/, /^gusset$/],
  [/^body_lining$/, /^(front|back)_lining$/],
  [/^gusset_lining$/, /^gusset_lining$/],
  [/^strap$/, /^strap_/],
  [/^handle_tab$/, /_tab$/],
  [/^shoulder/, /^shoulder/],
  [/^pocket/, /^pocket/],
  [/^zip_panel$/, /^lid_(front|back)$/],
  [/^zip_panel_lining$/, /^lid_.*_lining$/],
  [/^binding/, /^binding/],
];
export function partsFor(pieceId: string, partNames: string[]): string[] {
  const hit = RULES.filter(([r]) => r.test(pieceId)).flatMap(([, p]) => partNames.filter((n) => p.test(n)));
  if (hit.length) return hit;
  return partNames.filter((n) => n === pieceId || n.startsWith(pieceId + '_') || pieceId.startsWith(n + '_'));
}

const slotOf = (id: string): 'outer' | 'lining' | 'strap' | 'trim' =>
  /lining/.test(id) ? 'lining' : /strap|handle(?!_tab)/.test(id) ? 'strap' : /tab|binding|base/.test(id) ? 'trim' : 'outer';

type Placed = { piece: Piece; dx: number; dy: number; x0: number; y0: number; x1: number; y1: number };
const bbox = (pts: P[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};
const polyLen = (pts: P[]) => pts.reduce((s, p, i) => s + Math.hypot(p.x - pts[(i + 1) % pts.length].x, p.y - pts[(i + 1) % pts.length].y), 0);
const polyArea = (pts: P[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + (p.x * q.y - q.x * p.y); }, 0)) / 2;

/** A draggable dimension handle: sits at `at` (piece coords, cm) and turns a dragged point into a parameter value. */
export type Handle = { key: string; piece: string; at: P; axis: "x" | "y"; label: string; value: (p: P) => number };
export type PatternCallbacks = {
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  /** A handle was dragged: set the parameter. phase 'end' fires on release. */
  onEdit?: (key: string, value: number, phase: "start" | "move" | "end", piece: string) => void;
};

export class PatternView {
  private svg = document.createElementNS(NS, 'svg');
  private placed: Placed[] = [];
  private vb = { x: 0, y: 0, w: 100, h: 100 };
  private content = { x: 0, y: 0, w: 100, h: 100 };
  private hover: string | null = null;
  private selected: string | null = null;
  private layers = new Set<Layer>(['cut', 'sew', 'notches', 'grain', 'marks', 'labels', 'dims', 'grid']);
  private pieces: Piece[] = [];
  private colors: Appearance | null = null;
  private fitted = false;
  private handles: Handle[] = [];
  private hdrag: { h: Handle; pl: Placed } | null = null;

  constructor(private host: HTMLElement, private cb: PatternCallbacks) {
    this.svg.setAttribute('class', 'pv');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    host.appendChild(this.svg);
    this.wire();
    new ResizeObserver(() => this.syncUnit()).observe(this.svg);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setPattern(pieces: Piece[], colors: Appearance, handles: Handle[] = this.handles) {
    this.pieces = pieces;
    this.colors = colors;
    this.handles = handles;
    this.layout();
    if (this.selected && !pieces.some((p) => p.id === this.selected)) this.selected = null;
    this.render();
    if (!this.fitted) { this.fit(); this.fitted = true; }
  }
  setColors(colors: Appearance) { this.colors = colors; this.render(); }
  setHover(id: string | null) { if (id !== this.hover) { this.hover = id; this.paintState(); } }
  setSelected(id: string | null) { if (id !== this.selected) { this.selected = id; this.render(); } }
  get layerSet() { return this.layers; }
  toggleLayer(l: Layer) { this.layers.has(l) ? this.layers.delete(l) : this.layers.add(l); this.render(); }
  fit() {
    const pad = 4, c = this.content;
    this.vb = { x: c.x - pad, y: c.y - pad, w: c.w + pad * 2, h: c.h + pad * 2 };
    this.applyVB();
  }
  zoomToPiece(id: string) {
    const pl = this.placed.find((p) => p.piece.id === id);
    if (!pl) return;
    const pad = 5, w = pl.x1 - pl.x0 + pad * 2, h = pl.y1 - pl.y0 + pad * 2;
    const r = this.svg.getBoundingClientRect(), ar = r.width / Math.max(1, r.height);
    const vw = Math.max(w, h * ar), vh = vw / ar;
    this.vb = { x: (pl.x0 + pl.x1) / 2 - vw / 2, y: (pl.y0 + pl.y1) / 2 - vh / 2, w: vw, h: vh };
    this.applyVB();
  }
  stats(id: string) {
    const pl = this.placed.find((p) => p.piece.id === id);
    if (!pl) return null;
    const p = pl.piece;
    const cb = bbox(p.cut_line), sb = bbox(p.sew);
    return {
      cutW: cb.x1 - cb.x0, cutH: cb.y1 - cb.y0, sewW: sb.x1 - sb.x0, sewH: sb.y1 - sb.y0,
      area: polyArea(p.sew), perimeter: polyLen(p.sew), cutPerimeter: polyLen(p.cut_line),
    };
  }

  // ── Layout: simple shelf packing, pieces keep their true size ─────────────
  private layout() {
    const gap = 5;
    const items = this.pieces.map((piece) => {
      const b = bbox([...piece.cut_line, ...piece.sew]);
      return { piece, b, w: b.x1 - b.x0, h: b.y1 - b.y0 };
    });
    const widest = Math.max(0, ...items.map((i) => i.w));
    const rowMax = Math.max(widest, Math.sqrt(items.reduce((s, i) => s + (i.w + gap) * (i.h + gap), 0)) * 1.4, 90);
    let x = 0, y = 0, rowH = 0, maxX = 0;
    const prev = this.hdrag ? this.placed : [];
    this.placed = items.map((it) => {
      if (x > 0 && x + it.w > rowMax) { x = 0; y += rowH + gap + 4; rowH = 0; }
      // Flip y so the pattern reads upright (engine y is up, SVG y is down).
      const dx = x - it.b.x0, dy = y + it.b.y1;
      const pl: Placed = { piece: it.piece, dx, dy, x0: x, y0: y, x1: x + it.w, y1: y + it.h };
      // While a handle is being dragged keep every piece where it was, so the handle stays under the cursor.
      const old = prev.find((q) => q.piece.id === it.piece.id);
      if (old) { pl.dx = old.dx; pl.dy = old.dy; pl.x0 = it.b.x0 + old.dx; pl.x1 = pl.x0 + it.w; pl.y1 = old.dy - it.b.y0; pl.y0 = pl.y1 - it.h; }
      x += it.w + gap; rowH = Math.max(rowH, it.h); maxX = Math.max(maxX, x - gap);
      return pl;
    });
    this.content = { x: 0, y: 0, w: Math.max(10, maxX), h: Math.max(10, y + rowH) };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  private render() {
    const L = this.layers;
    const tx = (pl: Placed, p: P) => `${f(p.x + pl.dx)},${f(pl.dy - p.y)}`;
    const path = (pl: Placed, pts: P[], close = true) => pts.length ? `M${pts.map((p) => tx(pl, p)).join('L')}${close ? 'Z' : ''}` : '';
    let o = `<defs>
      <pattern id="g1" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" class="gl"/></pattern>
      <pattern id="g10" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" class="gm"/></pattern>
    </defs>`;
    if (L.has('grid')) {
      const c = this.content, m = 400;
      o += `<g class="grid"><rect x="${c.x - m}" y="${c.y - m}" width="${c.w + 2 * m}" height="${c.h + 2 * m}" fill="url(#g1)"/><rect x="${c.x - m}" y="${c.y - m}" width="${c.w + 2 * m}" height="${c.h + 2 * m}" fill="url(#g10)"/></g>`;
    }
    for (const pl of this.placed) {
      const p = pl.piece;
      const col = this.colors?.[slotOf(p.id)].color ?? '#d9a25f';
      o += `<g class="pc" data-id="${esc(p.id)}" style="--c:${col}">`;
      // Wide invisible hit area so thin pieces are easy to hover.
      o += `<path d="${path(pl, p.cut_line)}" class="fill"/>`;
      if (L.has('cut')) o += `<path d="${path(pl, p.cut_line)}" class="cut"/>`;
      if (L.has('sew')) o += `<path d="${path(pl, p.sew)}" class="sew"/>`;
      for (const fo of p.folds) o += `<path d="M${tx(pl, fo[0])}L${tx(pl, fo[1])}" class="fold"/>`;
      if (L.has('marks')) for (const m of p.marks) o += `<path d="${path(pl, m, false)}" class="mark"/>`;
      if (L.has('notches'))
        for (const n of [...p.notches, ...p.clips]) {
          const a = { x: n.at.x, y: n.at.y }, b = { x: n.at.x + n.dir.x * n.depth, y: n.at.y + n.dir.y * n.depth };
          o += `<path d="M${tx(pl, a)}L${tx(pl, b)}" class="notch"/>`;
        }
      if (L.has('grain')) {
        const [a, b] = p.grain;
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, s = 1.1;
        const head = (q: P, sgn: number) =>
          `M${tx(pl, { x: q.x - sgn * (ux * s) + uy * s * 0.5, y: q.y - sgn * (uy * s) - ux * s * 0.5 })}L${tx(pl, q)}L${tx(pl, { x: q.x - sgn * (ux * s) - uy * s * 0.5, y: q.y - sgn * (uy * s) + ux * s * 0.5 })}`;
        o += `<path d="M${tx(pl, a)}L${tx(pl, b)}${head(b, 1)}${head(a, -1)}" class="grain"/>`;
      }
      if (L.has('labels')) {
        for (const lb of p.labels) {
          const [x, y] = tx(pl, lb.at).split(',');
          o += `<text x="${x}" y="${y}" class="lbl"${lb.vertical ? ` transform="rotate(-90 ${x} ${y})"` : ''}>${esc(lb.text)}</text>`;
        }
        const cx = (pl.x0 + pl.x1) / 2;
        o += `<text x="${f(cx)}" y="${f(pl.y1 + 3.6)}" class="nm" text-anchor="middle">${esc(p.name)} <tspan class="ct">${esc(p.cut)}</tspan></text>`;
      }
      o += `</g>`;
    }
    if (L.has('dims') && this.selected) o += this.dimsFor(this.selected);
    this.handles.forEach((h, i) => {
      const pl = this.placed.find((p) => p.piece.id === h.piece);
      if (!pl) return;
      const [x, y] = tx(pl, h.at).split(',');
      const on = this.hdrag?.h.key === h.key ? ' on' : '';
      o += `<g class="hd${on}" data-h="${i}"><circle class="halo" cx="${x}" cy="${y}"/><circle cx="${x}" cy="${y}"/></g>`;
    });
    this.svg.innerHTML = o;
    this.applyVB();
    this.paintState();
  }

  private dimsFor(id: string) {
    const pl = this.placed.find((p) => p.piece.id === id);
    if (!pl) return '';
    const { x0, y0, x1, y1 } = pl, off = 1.6;
    const w = x1 - x0, h = y1 - y0;
    return `<g class="dims">
      <path d="M${f(x0)} ${f(y1 + off)}H${f(x1)}M${f(x0)} ${f(y1 + off - 0.5)}V${f(y1 + off + 0.5)}M${f(x1)} ${f(y1 + off - 0.5)}V${f(y1 + off + 0.5)}"/>
      <text x="${f((x0 + x1) / 2)}" y="${f(y1 + off - 0.4)}" text-anchor="middle">${f(w)} cm</text>
      <path d="M${f(x1 + off)} ${f(y0)}V${f(y1)}M${f(x1 + off - 0.5)} ${f(y0)}H${f(x1 + off + 0.5)}M${f(x1 + off - 0.5)} ${f(y1)}H${f(x1 + off + 0.5)}"/>
      <text x="${f(x1 + off + 0.6)}" y="${f((y0 + y1) / 2)}" transform="rotate(-90 ${f(x1 + off + 0.6)} ${f((y0 + y1) / 2)})" text-anchor="middle">${f(h)} cm</text>
    </g>`;
  }

  private paintState() {
    for (const g of this.svg.querySelectorAll<SVGGElement>('.pc')) {
      g.classList.toggle('hov', g.dataset.id === this.hover);
      g.classList.toggle('sel', g.dataset.id === this.selected);
    }
    this.svg.classList.toggle('has-sel', !!this.selected);
  }

  // ── View ──────────────────────────────────────────────────────────────────
  private applyVB() {
    const r = this.svg.getBoundingClientRect();
    const ar = r.width / Math.max(1, r.height);
    // Keep the aspect ratio of the box so pan/zoom math maps 1:1 to pixels.
    if (r.width > 0) {
      const cx = this.vb.x + this.vb.w / 2, cy = this.vb.y + this.vb.h / 2;
      if (this.vb.w / this.vb.h < ar) this.vb.w = this.vb.h * ar; else this.vb.h = this.vb.w / ar;
      this.vb.x = cx - this.vb.w / 2; this.vb.y = cy - this.vb.h / 2;
    }
    this.svg.setAttribute('viewBox', `${f(this.vb.x)} ${f(this.vb.y)} ${f(this.vb.w)} ${f(this.vb.h)}`);
    this.syncUnit();
  }
  private syncUnit() {
    const r = this.svg.getBoundingClientRect();
    if (r.width) this.svg.style.setProperty('--u', String(this.vb.w / r.width)); // cm per screen px
  }

  private wire() {
    const svg = this.svg;
    const toCm = (e: { clientX: number; clientY: number }) => {
      const r = svg.getBoundingClientRect();
      return { x: this.vb.x + ((e.clientX - r.left) / r.width) * this.vb.w, y: this.vb.y + ((e.clientY - r.top) / r.height) * this.vb.h };
    };
    const idAt = (t: EventTarget | null) => (t as Element | null)?.closest?.('.pc')?.getAttribute('data-id') ?? null;

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016);
      const c = toCm(e);
      const w = Math.min(Math.max(this.vb.w * k, 4), 1200), s = w / this.vb.w;
      this.vb = { x: c.x - (c.x - this.vb.x) * s, y: c.y - (c.y - this.vb.y) * s, w, h: this.vb.h * s };
      this.applyVB();
    }, { passive: false });

    // Pan on drag; a press that barely moves is a click.
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; id: string | null } | null = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      svg.setPointerCapture(e.pointerId);
      const hg = (e.target as Element).closest?.(".hd");
      if (hg && e.button === 0) {
        const h = this.handles[Number(hg.getAttribute("data-h"))];
        const pl = h && this.placed.find((p) => p.piece.id === h.piece);
        if (pl) { this.hdrag = { h, pl }; this.cb.onEdit?.(h.key, NaN, "start", h.piece); this.render(); svg.style.cursor = "grabbing"; return; }
      }
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false, id: idAt(e.target) };
    });
    svg.addEventListener('pointermove', (e) => {
      if (this.hdrag) {
        const { h, pl } = this.hdrag, c = toCm(e);
        this.cb.onEdit?.(h.key, h.value({ x: c.x - pl.dx, y: pl.dy - c.y }), "move", h.piece);
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; svg.classList.add('panning'); }
        if (drag.moved) {
          const r = svg.getBoundingClientRect();
          this.vb.x = drag.vx - (dx / r.width) * this.vb.w;
          this.vb.y = drag.vy - (dy / r.height) * this.vb.h;
          this.applyVB();
          return;
        }
      }
      const id = idAt(document.elementFromPoint(e.clientX, e.clientY));
      if (id !== this.hover) { this.hover = id; this.paintState(); this.cb.onHover(id); }
    });
    svg.addEventListener('pointerup', (e) => {
      if (this.hdrag) {
        const h = this.hdrag.h; this.hdrag = null; drag = null; svg.style.cursor = "";
        this.cb.onEdit?.(h.key, NaN, "end", h.piece);
        this.layout(); this.render();
        return;
      }
      const d = drag; drag = null;
      svg.classList.remove('panning');
      if (!d || d.moved) return;
      const id = idAt(document.elementFromPoint(e.clientX, e.clientY));
      const next = id && id === this.selected ? null : id;
      this.selected = next; this.render(); this.cb.onSelect(next);
    });
    svg.addEventListener('pointerleave', () => {
      if (this.hover !== null) { this.hover = null; this.paintState(); this.cb.onHover(null); }
    });
    svg.addEventListener('dblclick', (e) => {
      const id = idAt(e.target);
      id ? this.zoomToPiece(id) : this.fit();
    });
  }
}
