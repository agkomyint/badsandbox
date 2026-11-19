import type { Finish } from './engine';
import type { AppStore, State } from './store';

type Num = { key: string; label: string; min: number; max: number; step: number; unit?: string };
type Bool = { key: string; label: string; bool: true };
type Field = Num | Bool;
type Group = { title: string; fields: Field[] };

export const TOTE_SCHEMA: Group[] = [
  {
    title: 'Body',
    fields: [
      { key: 'width', label: 'Bottom width', min: 15, max: 70, step: 0.5, unit: 'cm' },
      { key: 'top_width', label: 'Top width', min: 15, max: 80, step: 0.5, unit: 'cm' },
      { key: 'height', label: 'Height', min: 15, max: 65, step: 0.5, unit: 'cm' },
      { key: 'depth', label: 'Depth (gusset)', min: 3, max: 30, step: 0.5, unit: 'cm' },
      { key: 'corner_radius', label: 'Corner radius', min: 0, max: 15, step: 0.5, unit: 'cm' },
      { key: 'softness', label: 'Softness', min: 0, max: 5, step: 0.1, unit: 'cm' },
    ],
  },
  {
    title: 'Handles',
    fields: [
      { key: 'strap_length', label: 'Loop length', min: 20, max: 130, step: 1, unit: 'cm' },
      { key: 'strap_width', label: 'Width', min: 1.5, max: 6, step: 0.25, unit: 'cm' },
      { key: 'strap_spacing', label: 'Spacing', min: 5, max: 40, step: 0.5, unit: 'cm' },
      { key: 'strap_attach', label: 'Sewn-down length', min: 2, max: 12, step: 0.5, unit: 'cm' },
    ],
  },
  {
    title: 'Pocket',
    fields: [
      { key: 'pocket', label: 'Front patch pocket', bool: true },
      { key: 'pocket_width', label: 'Width', min: 6, max: 50, step: 0.5, unit: 'cm' },
      { key: 'pocket_height', label: 'Height', min: 5, max: 40, step: 0.5, unit: 'cm' },
      { key: 'pocket_from_top', label: 'From top', min: 4, max: 40, step: 0.5, unit: 'cm' },
    ],
  },
  {
    title: 'Construction',
    fields: [
      { key: 'lining', label: 'Lined', bool: true },
      { key: 'seam_allowance', label: 'Seam allowance', min: 0.5, max: 2.5, step: 0.1, unit: 'cm' },
      { key: 'hem', label: 'Top hem (unlined)', min: 1.5, max: 6, step: 0.5, unit: 'cm' },
      { key: 'thickness', label: 'Material thickness', min: 0.05, max: 0.6, step: 0.01, unit: 'cm' },
    ],
  },
];

const FINISHES: Finish[] = ['canvas', 'leather', 'denim', 'nylon', 'suede'];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};

const CHECK = 'size-3.5 cursor-pointer accent-[var(--color-accent)]';

/** Collapsible panel section: returns [section, body]. */
function section(title: string): [HTMLElement, HTMLElement] {
  const body = h('div', { class: 'space-y-3.5 px-4 pb-4' });
  const chev = h('span', { class: 'text-stone-600 transition-transform' }, '▾');
  const sec = h('section', { class: 'border-b border-white/5' });
  const head = h('button', {
    class: 'flex w-full items-center justify-between px-4 py-3 text-[10px] font-semibold tracking-widest text-stone-500 uppercase hover:text-stone-300',
    onclick: () => {
      body.classList.toggle('hidden');
      chev.classList.toggle('-rotate-90');
    },
  }, title, chev);
  sec.append(head, body);
  return [sec, body];
}

/**
 * Builds the left panel once. Inputs dispatch store actions; each input subscribes
 * to exactly its own slice of state, so reset/load/randomize update it in place.
 */
export function buildControls(root: HTMLElement, store: AppStore) {
  root.innerHTML = '';
  const act = () => store.getState();
  const watch = <T,>(sel: (s: State) => T, fn: (v: T) => void) => store.subscribe(sel, fn, { fireImmediately: true });

  for (const g of TOTE_SCHEMA) {
    const [sec, body] = section(g.title);
    for (const f of g.fields) {
      if ('bool' in f) {
        const cb = h('input', { type: 'checkbox', class: CHECK, onchange: () => act().setParam(f.key, cb.checked) });
        watch((s) => !!s.design.params[f.key], (v) => (cb.checked = v));
        body.append(h('label', { class: 'flex cursor-pointer items-center gap-2 text-xs text-stone-300' }, cb, f.label));
      } else {
        const range = h('input', { type: 'range', min: f.min, max: f.max, step: f.step });
        const num = h('input', { type: 'number', min: f.min, max: f.max, step: f.step, class: 'w-14 bg-transparent text-right font-mono text-xs text-stone-100 outline-none focus:text-accent' });
        const set = (v: number) => Number.isFinite(v) && act().setParam(f.key, v);
        range.addEventListener('input', () => set(parseFloat(range.value)));
        num.addEventListener('change', () => set(parseFloat(num.value)));
        watch((s) => Number(s.design.params[f.key]), (v) => {
          range.value = String(v);
          num.value = String(+v.toFixed(2));
        });
        body.append(
          h('div', { class: 'space-y-1.5' },
            h('div', { class: 'flex items-center justify-between text-xs text-stone-400' },
              h('span', {}, f.label),
              h('span', { class: 'flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5' }, num, h('span', { class: 'text-[10px] text-stone-500' }, f.unit ?? '')),
            ),
            range,
          ),
        );
      }
    }
    root.append(sec);
  }

  // Appearance
  const [sec, body] = section('Materials');
  const row = (label: string, ...kids: Node[]) =>
    h('div', { class: 'grid grid-cols-[64px_1fr_auto] items-center gap-2 text-xs text-stone-400' }, h('span', {}, label), ...kids);
  for (const slot of ['outer', 'lining', 'strap'] as const) {
    const sel = h('select', { class: 'input', onchange: () => act().setSurface(slot, { finish: sel.value as Finish }) },
      ...FINISHES.map((f) => h('option', { value: f }, f[0].toUpperCase() + f.slice(1))));
    const col = h('input', { type: 'color', oninput: () => act().setSurface(slot, { color: col.value }) });
    watch((s) => s.design.appearance[slot].finish, (v) => (sel.value = v));
    watch((s) => s.design.appearance[slot].color, (v) => (col.value = v));
    body.append(row(slot === 'strap' ? 'Handles' : slot[0].toUpperCase() + slot.slice(1), sel, col));
  }
  const thread = h('input', { type: 'color', oninput: () => act().setThread(thread.value) });
  const piping = h('input', { type: 'checkbox', class: CHECK, onchange: () => act().setPiping(piping.checked) });
  watch((s) => s.design.appearance.thread, (v) => (thread.value = v));
  watch((s) => s.design.appearance.piping, (v) => (piping.checked = v));
  body.append(row('Thread', h('span'), thread));
  body.append(h('label', { class: 'flex cursor-pointer items-center gap-2 text-xs text-stone-300' }, piping, 'Seam piping'));
  root.append(sec);
}
