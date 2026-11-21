import { catalogue, checkFit, type Thing } from './fit';
import { shallow } from 'zustand/vanilla/shallow';
import { Engine, type Design } from './engine';
import { Studio } from './scene';
import { createAppStore, type State } from './store';
import { buildControls, rangeOf } from './ui';
import { LAYERS, PatternView, partsFor, type Handle } from './pattern2d';
import type { EditHandle } from './scene';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bag';

async function main() {
  const status = $('status');
  const studio = new Studio($('viewport'));
  if (import.meta.env.DEV) (window as any).studio = studio;
  const engine = new Engine();
  const store = createAppStore(await engine.defaultDesign('tote'));
  const act = () => store.getState();
  const design = () => store.getState().design;
  const watch = <T,>(sel: (s: State) => T, fn: (v: T, prev: T) => void, equalityFn?: (a: T, b: T) => boolean) =>
    store.subscribe(sel, fn, { fireImmediately: true, equalityFn });
  if (import.meta.env.DEV) Object.assign(window, { studio, store, engine });

  // ── Engine pipeline: geometry-affecting state → worker → output ──────────────
  engine.onOutput = (o) => act().setOutput(o);
  engine.onError = (e) => act().setError(String(e));
  watch((s) => [s.design.style, s.design.name, s.design.params] as const, () => engine.request(design()), shallow);

  // ── Output → viewport + right panel ─────────────────────────────────────────
  watch((s) => s.output, (o) => {
    if (!o) return;
    studio.setGeometry(o.mesh);
    hideBoot();
    if (!studio.pathTracing) status.textContent = `engine ${o.ms.toFixed(1)} ms`;
  });
  // ── Interactive 2D pattern ↔ 3D bag ─────────────────────────────────────────
  const partNames = () => act().output?.mesh.parts.map((p) => p.name) ?? [];
  const pieces = () => act().output?.pattern.pieces ?? [];
  let hovered: string | null = null, selected: string | null = null;
  const sync3d = () => {
    const id = hovered ?? selected;
    studio.highlight(id ? partsFor(id, partNames()) : null);
  };
  const card = $('piece-card');
  const showCard = () => {
    const id = selected; // hover only highlights; details show for the clicked piece
    const p = pieces().find((x) => x.id === id);
    const st = id ? view.stats(id) : null;
    card.classList.toggle('hidden', !p || !st);
    if (!p || !st) { card.innerHTML = ''; return; }
    const n = (v: number) => v.toFixed(1);
    card.innerHTML = `<div class="flex items-baseline justify-between gap-2"><b class="text-sm text-stone-100">${p.name}</b><span class="text-accent">${p.cut}</span></div>
      <div class="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 [&_b]:font-medium [&_b]:text-stone-200">
        <span>Finished <b>${n(st.sewW)} × ${n(st.sewH)} cm</b></span><span>Cut <b>${n(st.cutW)} × ${n(st.cutH)} cm</b></span>
        <span>Area <b>${Math.round(st.area)} cm²</b></span><span>Seam length <b>${n(st.perimeter)} cm</b></span>
        <span>Notches <b>${p.notches.length}</b></span><span>Fabric slot <b>${/lining/.test(p.id) ? 'lining' : /strap|handle/.test(p.id) ? 'strap' : 'outer'}</b></span>
      </div>${p.notes.length ? `<ul class="mt-2 list-disc space-y-0.5 pl-4 leading-snug text-stone-400">${p.notes.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}`;
  };
  // ── Two-way editing: handles in 2D and on the bag both write parameters ─────
  const num = (k: string) => Number(design().params[k]);
  const bboxOf = (id: string) => {
    const p = pieces().find((x) => x.id === id);
    if (!p || !p.sew.length) return null;
    const xs = p.sew.map((q) => q.x), ys = p.sew.map((q) => q.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const buildHandles = (): { h2: Handle[]; h3: EditHandle[] } => {
    const h2: Handle[] = [], h3: EditHandle[] = [];
    const body = bboxOf('body'), gus = bboxOf('gusset'), pk = bboxOf('pocket');
    const bounds = act().output?.mesh.bounds;
    if (body) {
      h2.push({ key: 'height', piece: 'body', at: { x: 0, y: body.y1 }, axis: 'y', label: 'Height', value: (p) => p.y });
      h2.push({ key: 'top_width', piece: 'body', at: { x: body.x1, y: body.y1 }, axis: 'x', label: 'Top width', value: (p) => p.x * 2 });
      h2.push({ key: 'width', piece: 'body', at: { x: num('width') / 2, y: body.y0 }, axis: 'x', label: 'Bottom width', value: (p) => p.x * 2 });
      const top = num('height'), tw = num('top_width') / 2;
      h3.push({ key: 'height', axis: 'y', at: [0, top, 0], gain: 1, label: 'Height' });
      h3.push({ key: 'top_width', axis: 'x', at: [tw, top, 0], gain: 2, label: 'Top width' });
      h3.push({ key: 'width', axis: 'x', at: [num('width') / 2, 0, 0], gain: 2, label: 'Bottom width' });
      h3.push({ key: 'depth', axis: 'z', at: [0, 0, bounds ? bounds[5] : num('depth') / 2], gain: 2, label: 'Bottom depth' });
    }
    if (gus) h2.push({ key: 'depth', piece: 'gusset', at: { x: gus.x1, y: (gus.y0 + gus.y1) / 2 }, axis: 'x', label: 'Bottom depth', value: (p) => p.x });
    if (pk) {
      h2.push({ key: 'pocket_width', piece: 'pocket', at: { x: pk.x1, y: (pk.y0 + pk.y1) / 2 }, axis: 'x', label: 'Pocket width', value: (p) => p.x });
      h2.push({ key: 'pocket_height', piece: 'pocket', at: { x: (pk.x0 + pk.x1) / 2, y: pk.y1 }, axis: 'y', label: 'Pocket height', value: (p) => p.y });
    }
    return { h2, h3 };
  };
  let editStart = 0;
  const applyEdit = (key: string, v: number, label: string) => {
    const r = rangeOf(key);
    if (!r || !Number.isFinite(v)) return;
    const q = Math.round(Math.min(Math.max(v, r.min), r.max) / r.step) * r.step;
    const val = Math.round(q * 100) / 100;
    if (val !== num(key)) act().setParam(key, val);
    status.textContent = `${label} ${val} cm`;
  };
  const startEdit = (key: string, piece?: string) => { editStart = num(key); if (piece) select(piece); };
  studio.onEdit = (key, delta, phase, label) => {
    if (phase === 'start') startEdit(key); else if (phase === 'move') applyEdit(key, editStart + delta, label);
    else status.textContent = `${label} ${num(key)} cm`;
  };
  const view = new PatternView($('pattern'), {
    onEdit: (key, v, phase, piece) => {
      const label = buildHandles().h2.find((h) => h.key === key)?.label ?? key;
      if (phase === 'start') startEdit(key, piece); else if (phase === 'move') applyEdit(key, v, label);
    },
    onHover: (id) => { hovered = id; sync3d(); },
    onSelect: (id) => { selected = id; sync3d(); showCard(); },
  });
  const layerBar = $('layers');
  layerBar.innerHTML = LAYERS.map((l) => `<button data-layer="${l.key}" class="btn on">${l.label}</button>`).join('');
  layerBar.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-layer]');
    if (!b) return;
    view.toggleLayer(b.dataset.layer as never);
    b.classList.toggle('on', view.layerSet.has(b.dataset.layer as never));
  };
  $('fit').onclick = () => view.fit();
  const select = (id: string | null) => { selected = id; view.setSelected(id); sync3d(); showCard(); };
  watch((s) => s.output?.pattern.pieces, (ps) => {
    if (!ps) return;
    const hs = buildHandles();
    view.setPattern(ps, design().appearance, hs.h2);
    studio.setEditHandles(hs.h3);
    if (selected && !ps.some((p) => p.id === selected)) selected = null;
    sync3d(); showCard();
  });
  watch((s) => s.design.appearance, (a) => view.setColors(a));
  // Click a part of the bag to select its pattern piece (not while a simulation is grabbing).
  {
    const vp = $('viewport');
    let down: { x: number; y: number } | null = null;
    vp.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    vp.addEventListener('pointerup', (e) => {
      const d = down; down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || act().view.simulation || act().view.pathTracing) return;
      const part = studio.pick(e.clientX, e.clientY);
      if (!part) return select(null);
      const hit = pieces().find((p) => partsFor(p.id, partNames()).includes(part));
      if (!hit) return select(null);
      act().setView({ tab: 'pattern' });
      select(hit.id === selected ? null : hit.id);
      view.zoomToPiece(hit.id);
    });
  }
  // Cut-list rows select too.
  $('info').addEventListener('click', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!r) return;
    act().setView({ tab: 'pattern' });
    select(r.dataset.id!);
    view.zoomToPiece(r.dataset.id!);
  });

  // ── Resizable pattern panel ─────────────────────────────────────────────────
  {
    const shell = $('shell'), bar = $('splitter');
    const KEY = 'bag-right-width', DEF = 460;
    const clamp = (w: number) => Math.round(Math.min(Math.max(w, 300), Math.max(320, window.innerWidth - $('left').getBoundingClientRect().width - 360)));
    const cur = () => parseInt(getComputedStyle(shell).getPropertyValue('--right')) || DEF;
    const leftW = () => $('left').getBoundingClientRect().right;
    const set = (w: number, save = true) => {
      const v = clamp(w);
      shell.style.setProperty('--right', v + 'px');
      if (save) try { localStorage.setItem(KEY, String(v)); } catch {}
    };
    try { const w = Number(localStorage.getItem(KEY)); if (w) set(w, false); } catch {}
    bar.onpointerdown = (e) => {
      bar.setPointerCapture(e.pointerId);
      shell.classList.add('resizing'); bar.classList.add('active');
      document.body.style.userSelect = 'none';
      bar.onpointermove = (m) => set(m.clientX - leftW(), false);
      bar.onpointerup = (u) => {
        bar.onpointermove = bar.onpointerup = null;
        shell.classList.remove('resizing'); bar.classList.remove('active');
        document.body.style.userSelect = '';
        set(u.clientX - leftW());
      };
    };
    bar.ondblclick = () => set(DEF);
    bar.onkeydown = (e) => {
      if (e.key === 'ArrowRight') { set(cur() + 40); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { set(cur() - 40); e.preventDefault(); }
    };
  }

  // ── Left panel: minimize ────────────────────────────────────────────────────
  {
    const shell = $('shell'), btn = $('collapse');
    const set = (c: boolean) => {
      shell.classList.toggle('collapsed', c);
      btn.textContent = c ? '»' : '«';
      btn.title = c ? 'Expand the parameter panel' : 'Minimize the parameter panel';
      btn.setAttribute('aria-expanded', String(!c));
      try { localStorage.setItem('bag-left-collapsed', c ? '1' : '0'); } catch {}
    };
    let c0 = false;
    try { c0 = localStorage.getItem('bag-left-collapsed') === '1'; } catch {}
    set(c0);
    btn.onclick = () => set(!shell.classList.contains('collapsed'));
  }
  watch((s) => s.output?.pattern, (p) => {
    if (!p) return;
    $('info').innerHTML = `<table>${p.pieces
      .map((x) => `<tr data-id="${x.id}" class="cursor-pointer hover:bg-white/5"><td><b>${x.name}</b><br><span>${x.notes.join('<br>')}</span></td><td>${x.cut}</td></tr>`)
      .join('')}</table>`
      + (p.supplies?.length ? `<h4>Supplies</h4><ul>${p.supplies.map((s) => `<li>${s}</li>`).join('')}</ul>` : '')
      + (p.steps?.length ? `<h4>Sewing order</h4><ol>${p.steps.map((s) => `<li>${s.replace(/^\d+\.\s*/, '')}</li>`).join('')}</ol>` : '');
    $('warnings').innerHTML = p.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  });
  watch((s) => s.error, (e) => e && (status.textContent = e));

  // ── Appearance → materials only (no engine call) ────────────────────────────
  watch((s) => s.design.appearance, (a) => studio.setAppearance(a));

  // ── Left panel ──────────────────────────────────────────────────────────────
  buildControls($('controls'), store);
  const nameInput = $<HTMLInputElement>('name');
  nameInput.oninput = () => act().setName(nameInput.value);
  watch((s) => s.design.name, (n) => nameInput.value !== n && (nameInput.value = n));
  $('randomize').onclick = () => act().randomize();
  $('reset').onclick = () => act().reset();

  // ── View state → toolbar + studio ───────────────────────────────────────────
  const pt = $('pt'), seams = $('seams'), spin = $('spin');
  pt.onclick = () => act().setView({ pathTracing: !act().view.pathTracing });
  seams.onclick = () => act().setView({ stitches: !act().view.stitches });
  spin.onclick = () => act().setView({ turntable: !act().view.turntable });
  $('frame').onclick = () => studio.frameView();
  $('shot').onclick = () =>
    Object.assign(document.createElement('a'), { href: studio.screenshot(), download: `${slug(design().name)}.png` }).click();

  const gpuNote = studio.weakGpu ? ` · ${studio.gpu} (integrated GPU, switch browser to NVIDIA/AMD for speed)` : ` · ${studio.gpu}`;
  studio.onSamples = (n) =>
    (status.textContent = (n < 1 ? 'compiling path tracer… (first run ~30 s)' : `ray tracing · ${n} samples`) + gpuNote);
  watch((s) => s.view.pathTracing, async (on) => {
    pt.classList.toggle('on', on);
    if (on) status.textContent = 'compiling path tracer…';
    try {
      await studio.setPathTracing(on);
    } catch (e) {
      console.error(e);
      status.textContent = `path tracer unavailable: ${e}`;
      act().setView({ pathTracing: false });
    }
  });
  watch((s) => s.view.stitches, (on) => { seams.classList.toggle('on', on); studio.setStitches(on); });
  watch((s) => s.view.turntable, (on) => { spin.classList.toggle('on', on); studio.setTurntable(on); });

  studio.onMotion = (st) => {
    if (studio.pathTracing) status.textContent = st === 'moving' ? 'ray tracing paused while the bag moves' : 'bag settled · ray tracing resumed';
  };
  const sim = $('sim');
  sim.onclick = () => act().setView({ simulation: !act().view.simulation });
  // Simulation tray: drop things into the bag, open and close the zipper.
  const tray = $('tray'), zip = $('zip'), addZip = $('add-zip');
  const syncZip = () => {
    // Contextual: the zip toggle only exists on a bag with a zip top; otherwise offer to add one.
    addZip.classList.toggle('hidden', !!design().params.zip_top);
    zip.classList.toggle('hidden', !studio.hasZip);
    zip.textContent = studio.zipper > 0.5 ? 'Open zip' : 'Close zip';
  };
  addZip.onclick = () => { act().setParam('zip_top', true); status.textContent = 'zip top added · click the pull to open it'; };
  watch((s) => s.output, () => { if (act().view.simulation) requestAnimationFrame(syncZip); });
  zip.onclick = () => {
    studio.zipper = studio.zipper > 0.5 ? 0 : 1;
    syncZip();
  };
  $('viewport').addEventListener('pointerup', () => requestAnimationFrame(syncZip));
  studio.onZipToggle = (open) => {
    syncZip();
    status.textContent = open ? 'zip open · drop items in · click the pull to close' : 'zip closed · click the pull to open';
  };
  tray.querySelectorAll<HTMLButtonElement>('[data-item]').forEach((b) => {
    b.onclick = async () => {
      const n = await studio.addItem(b.dataset.item!);
      const what = b.textContent!.toLowerCase();
      if (n === -2) status.textContent = `the ${what} is too big for this bag · try a deeper one`;
      else if (n < 0) status.textContent = `no room for the ${what} · drag something out or Empty`;
      else if (n) status.textContent = `${n} item${n > 1 ? 's' : ''} in the bag`;
    };
  });
  $('clear-items').onclick = () => { studio.clearItems(); $('fill-res').textContent = ''; };
  // Contents: what's in the bag, its weight, and "how many fit?"
  {
    const ct = $('contents'), listEl = $('ct-list'), sel = $('fill-sel') as HTMLSelectElement, res = $('fill-res');
    for (const t of catalogue()) sel.add(new Option(t.label, t.key));
    const render = () => {
      const items = studio.contents;
      const by = new Map<string, { label: string; ids: string[]; mass: number }>();
      for (const it of items) { const e = by.get(it.key) ?? { label: it.label, ids: [], mass: it.mass }; e.ids.push(it.id); by.set(it.key, e); }
      listEl.innerHTML = '';
      if (!by.size) listEl.innerHTML = '<span class="text-stone-500">Empty. Add something below.</span>';
      for (const [, e] of by) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-1';
        row.innerHTML = `<span class="flex-1">${e.ids.length}× ${e.label}</span><span class="text-stone-500">${((e.ids.length * e.mass) / 1000).toFixed(2)} kg</span>`;
        const x = document.createElement('button');
        x.className = 'btn'; x.textContent = '−'; x.title = 'Take one out';
        x.onclick = () => studio.removeItem(e.ids[e.ids.length - 1]);
        row.append(x); listEl.append(row);
      }
      const g = studio.loadGrams, cap = studio.capacityGrams, f = g / cap;
      $('ct-load').textContent = `Load ${(g / 1000).toFixed(2)} kg of ~${(cap / 1000).toFixed(0)} kg comfortable${f > 1 ? ' · too heavy, straps and seams will suffer' : f > 0.75 ? ' · heavy' : ''}`;
      const bar = $('ct-bar');
      bar.style.width = Math.min(100, f * 100) + '%';
      bar.style.background = f > 1 ? '#ef6b5b' : f > 0.75 ? '#e8c25a' : '#34d399';
    };
    studio.onItems = render;
    $('repack').onclick = () => studio.repack();
    $('fill-go').onclick = async () => {
      const key = sel.value, label = sel.selectedOptions[0].textContent!.toLowerCase();
      studio.clearItems();
      res.textContent = 'filling…';
      const n = await studio.fillWith(key);
      res.textContent = n ? `${n} ${label}${n > 1 ? 's' : ''} fit · ${((studio.loadGrams) / 1000).toFixed(2)} kg` : `not even one ${label} fits`;
    };
    watch((s) => s.view.simulation, (on) => { ct.classList.toggle('hidden', !on); ct.classList.toggle('flex', on); if (on) render(); });
  }

  watch((s) => s.view.simulation, (on) => {
    sim.classList.toggle('on', on);
    tray.classList.toggle('hidden', !on);
    tray.classList.toggle('flex', on);
    if (on) act().setView({ turntable: false });
    try {
      studio.setSimulation(on);
      syncZip();
      if (on) status.textContent = `fabric simulation · drag the fabric to lift${studio.hasZip ? ' · click the zipper pull to open' : ''} · add items from the tray, or fill the bag to see how many fit`;
    } catch (e) {
      console.error(e);
      status.textContent = `simulation failed: ${e}`;
      act().setView({ simulation: false });
    }
  });
  // ── Fit check: pick what you carry, see if it fits (geometry, not physics) ──
  {
    const panel = $('fitpanel'), list = $('fit-list'), out = $('fit-out');
    const things = catalogue();
    const counts = new Map<string, number>();
    const rowsEl = new Map<string, HTMLSpanElement>();
    const addRow = (t: Thing) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5 text-stone-300';
      row.innerHTML = `<span class="inline-block h-2.5 w-2.5 rounded-sm" style="background:${t.color}"></span><span class="flex-1">${t.label} <span class="text-stone-500">${t.dims.map((d) => d.toFixed(0)).join('×')}</span></span>`;
      const minus = document.createElement('button'), plus = document.createElement('button'), n = document.createElement('span');
      minus.className = plus.className = 'btn'; minus.textContent = '−'; plus.textContent = '+'; n.textContent = '0'; n.className = 'w-4 text-center';
      minus.onclick = () => { counts.set(t.key, Math.max(0, (counts.get(t.key) ?? 0) - 1)); n.textContent = String(counts.get(t.key)); run(); };
      plus.onclick = () => { counts.set(t.key, (counts.get(t.key) ?? 0) + 1); n.textContent = String(counts.get(t.key)); run(); };
      row.append(minus, n, plus); list.append(row); rowsEl.set(t.key, n); things.find((x) => x.key === t.key) || things.push(t);
    };
    const run = () => {
      if (panel.classList.contains('hidden')) return;
      const p = design().params as any;
      const r = checkFit(p, things.map((thing) => ({ thing, n: counts.get(thing.key) ?? 0 })), studio.bagBottom);
      studio.showFit(r.boxes);
      const col: Record<string, string> = { ok: '#6fcf8d', tight: '#e8c25a', sticks: '#e8a85a', no: '#ef6b5b' };
      const mark: Record<string, string> = { ok: '✓', tight: '≈', sticks: '!', no: '✗' };
      out.innerHTML = `<div class="text-stone-400">Inside ≈ ${r.inner.map((v) => v.toFixed(0)).join(' × ')} cm · opening ${r.opening.map((v) => v.toFixed(0)).join(' × ')} cm</div>` +
        (r.rows.length ? r.rows.map((x) => `<div style="color:${col[x.verdict]}">${mark[x.verdict]} ${x.n}× ${x.thing.label}: <span class="text-stone-400">${x.note}</span></div>`).join('') : '<div class="text-stone-500">Add items above.</div>') +
        (r.rows.length ? `<div class="text-stone-400">Bag ${(r.fill * 100).toFixed(0)}% full${r.rows.every((x) => x.verdict === 'ok' || x.verdict === 'tight') ? ' · everything fits' : ''}</div>` : '');
    };
    things.splice(0).forEach(addRow);
    $('cadd').onclick = () => {
      const v = (id: string) => Math.max(1, Number(($(id) as HTMLInputElement).value) || 1);
      const k = 'custom' + things.length;
      addRow({ key: k, label: 'Custom', dims: [v('cw'), v('ch'), v('cd')], color: '#8a7fd6' });
      counts.set(k, 1); rowsEl.get(k)!.textContent = '1'; run();
    };
    const toggle = (on: boolean) => {
      panel.classList.toggle('hidden', !on); $('fitbtn').classList.toggle('on', on);
      if (on) run(); else studio.showFit(null);
    };
    $('fitbtn').onclick = () => toggle(panel.classList.contains('hidden'));
    $('fit-x').onclick = () => toggle(false);
    watch((s) => s.output, () => run());
  }
  watch((s) => s.output, () => { const p = design().params as any; studio.bagDims = { width: p.width, top_width: p.top_width }; });
  // ── Tabs ────────────────────────────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
    b.onclick = () => act().setView({ tab: b.dataset.tab as State['view']['tab'] });
  });
  watch((s) => s.view.tab, (tab) => {
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${tab}`));
  });

  // ── Exports (all heavy work runs in the worker) ─────────────────────────────
  const name = () => slug(design().name);
  $('download-pattern').onclick = async () => {
    const fmt = $<HTMLSelectElement>('pattern-format').value;
    if (fmt === 'svg') return download(`${name()}-pattern.svg`, await engine.patternSvg(design()), 'image/svg+xml');
    download(`${name()}-pattern-${fmt}.pdf`, (await engine.patternPdf(design(), fmt)) as BlobPart, 'application/pdf');
  };
  $('obj').onclick = async () => download(`${name()}.obj`, await engine.meshObj(design()), 'text/plain');
  $('glb').onclick = async () => download(`${name()}.glb`, await studio.exportGLB(), 'model/gltf-binary');
  $('save').onclick = () => download(`${name()}.json`, JSON.stringify(design(), null, 2), 'application/json');
  const file = $<HTMLInputElement>('file');
  $('load').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      act().load(JSON.parse(await f.text()) as Partial<Design>);
    } catch (e) {
      status.textContent = `could not load: ${e}`;
    }
    file.value = '';
  };
}

/** Fade out the inline boot screen once the first bag is on screen. */
function hideBoot() {
  const boot = document.getElementById('boot');
  if (!boot || boot.classList.contains('done')) return;
  requestAnimationFrame(() => boot.classList.add('done'));
  setTimeout(() => boot.remove(), 400);
}

main().catch((e) => {
  console.error(e);
  const msg = document.getElementById('boot-msg');
  if (msg) msg.textContent = `failed to start: ${e}`;
});
