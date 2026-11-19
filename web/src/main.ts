import { shallow } from 'zustand/vanilla/shallow';
import { Engine, type Design } from './engine';
import { Studio } from './scene';
import { createAppStore, type State } from './store';
import { buildControls } from './ui';

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
  watch((s) => s.output?.svg, (svg) => svg && ($('pattern').innerHTML = svg));
  watch((s) => s.output?.pattern, (p) => {
    if (!p) return;
    $('info').innerHTML = `<table>${p.pieces
      .map((x) => `<tr><td><b>${x.name}</b><br><span>${x.notes.join('<br>')}</span></td><td>${x.cut}</td></tr>`)
      .join('')}</table>`;
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

  studio.onSamples = (n) =>
    (status.textContent = n < 1 ? 'compiling path tracer… (first run ~30 s)' : `ray tracing · ${n} samples`);
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
  document.querySelectorAll<HTMLButtonElement>('[data-pdf]').forEach((b) => {
    b.onclick = async () => download(`${name()}-pattern-${b.dataset.pdf}.pdf`, (await engine.patternPdf(design(), b.dataset.pdf!)) as BlobPart, 'application/pdf');
  });
  $('svg').onclick = async () => download(`${name()}-pattern.svg`, await engine.patternSvg(design()), 'image/svg+xml');
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
