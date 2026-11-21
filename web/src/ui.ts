import type { Appearance, Finish, Metal } from './engine';
import { PRESETS, type AppStore, type State } from './store';

/**
 * `capBy` = this slider can't exceed that other param. A stored 0 (or any value
 * >= the cap) means "same as the cap", e.g. top depth = bottom depth = straight gusset.
 */
type Num = { key: string; label: string; min: number; max: number; step: number; unit?: string; capBy?: string };
type Bool = { key: string; label: string; bool: true };
type Choice = { key: string; label: string; options: [value: string | number, label: string][] };
type Field = Num | Bool | Choice;
/** `when` = the group's fields only show while this boolean param is on (or number > 0). */
type Group = { title: string; fields: Field[]; when?: string; closed?: boolean };

export const TOTE_SCHEMA: Group[] = [
  {
    title: 'Body',
    fields: [
      { key: 'width', label: 'Bottom width', min: 15, max: 70, step: 0.5, unit: 'cm' },
      { key: 'top_width', label: 'Top width', min: 15, max: 80, step: 0.5, unit: 'cm' },
      { key: 'height', label: 'Height', min: 15, max: 65, step: 0.5, unit: 'cm' },
      { key: 'depth', label: 'Bottom depth (gusset)', min: 3, max: 30, step: 0.5, unit: 'cm' },
      { key: 'top_depth', label: 'Top depth', min: 2, max: 30, step: 0.5, unit: 'cm', capBy: 'depth' },
      { key: 'corner_radius', label: 'Corner radius', min: 0, max: 15, step: 0.5, unit: 'cm' },
      { key: 'softness', label: 'Softness', min: 0, max: 5, step: 0.1, unit: 'cm' },
    ],
  },
  {
    title: 'Handles',
    fields: [
      { key: 'handles', label: 'Top handles', bool: true },
      { key: 'strap_length', label: 'Loop length', min: 20, max: 130, step: 1, unit: 'cm' },
      { key: 'strap_width', label: 'Width', min: 1.5, max: 6, step: 0.25, unit: 'cm' },
      { key: 'strap_spacing', label: 'Spacing', min: 5, max: 40, step: 0.5, unit: 'cm' },
      { key: 'strap_attach', label: 'Sewn-down length', min: 2, max: 12, step: 0.5, unit: 'cm' },
      { key: 'handle_tabs', label: 'Hang from D-ring tabs', bool: true },
    ],
  },
  {
    title: 'Shoulder strap',
    closed: true,
    fields: [
      { key: 'shoulder_strap', label: 'Add shoulder strap', bool: true },
      { key: 'shoulder_length', label: 'Length', min: 50, max: 170, step: 1, unit: 'cm' },
      { key: 'shoulder_width', label: 'Width', min: 1.5, max: 6, step: 0.25, unit: 'cm' },
    ],
  },
  {
    title: 'Zipper',
    closed: true,
    fields: [
      { key: 'zip_top', label: 'Zip-top closure', bool: true },
      { key: 'zip_type', label: 'Type', options: [['coil', 'Nylon coil'], ['metal', 'Metal teeth'], ['molded', 'Molded plastic']] },
      { key: 'zip_gauge', label: 'Size', options: [[3, '#3 fine'], [5, '#5 standard'], [8, '#8 heavy'], [10, '#10 chunky']] },
      { key: 'zip_pull', label: 'Puller', options: [['tab', 'Tab'], ['ring', 'Ring'], ['tassel', 'Tassel']] },
      { key: 'zip_ends', label: 'Zip ends', options: [['slim', 'Slim tab'], ['square', 'Square tab'], ['none', 'None (tucked)']] },
    ],
  },
  {
    title: 'Zip pocket',
    closed: true,
    fields: [
      { key: 'zip_pocket', label: 'Exposed zip pocket (front)', bool: true },
      { key: 'zip_pocket_length', label: 'Zip length', min: 6, max: 50, step: 0.5, unit: 'cm' },
      { key: 'zip_pocket_angle', label: 'Angle', min: -60, max: 60, step: 1, unit: '°' },
      { key: 'zip_pocket_x', label: 'Left / right', min: -25, max: 25, step: 0.5, unit: 'cm' },
      { key: 'zip_pocket_from_top', label: 'From top', min: 3, max: 50, step: 0.5, unit: 'cm' },
      { key: 'zip_pocket_depth', label: 'Pocket depth', min: 6, max: 50, step: 0.5, unit: 'cm' },
    ],
  },
  {
    title: 'Patch pocket',
    closed: true,
    fields: [
      { key: 'pocket', label: 'Front patch pocket', bool: true },
      { key: 'pocket_width', label: 'Width', min: 6, max: 50, step: 0.5, unit: 'cm' },
      { key: 'pocket_height', label: 'Height', min: 5, max: 40, step: 0.5, unit: 'cm' },
      { key: 'pocket_from_top', label: 'From top', min: 4, max: 40, step: 0.5, unit: 'cm' },
    ],
  },
  {
    title: 'Stripe & trim',
    closed: true,
    fields: [
      { key: 'stripe', label: 'Stripe band (front)', bool: true },
      { key: 'stripe_width', label: 'Stripe width', min: 1, max: 15, step: 0.25, unit: 'cm' },
      { key: 'stripe_x', label: 'Stripe position', min: -25, max: 25, step: 0.5, unit: 'cm' },
      { key: 'stripe_angle', label: 'Stripe angle', min: -45, max: 45, step: 1, unit: '°' },
      { key: 'base_height', label: 'Contrast base (0 = off)', min: 0, max: 30, step: 0.5, unit: 'cm' },
      { key: 'binding', label: 'Top binding (0 = off)', min: 0, max: 4, step: 0.25, unit: 'cm' },
    ],
  },
  {
    title: 'Construction',
    closed: true,
    fields: [
      { key: 'lining', label: 'Lined', bool: true },
      { key: 'seam_allowance', label: 'Seam allowance', min: 0.5, max: 2.5, step: 0.1, unit: 'cm' },
      { key: 'hem', label: 'Top hem (unlined)', min: 1.5, max: 6, step: 0.5, unit: 'cm' },
      { key: 'thickness', label: 'Material thickness', min: 0.05, max: 0.6, step: 0.01, unit: 'cm' },
    ],
  },
];

const FINISHES: Finish[] = ['canvas', 'leather', 'denim', 'nylon', 'suede'];
const METALS: [Metal, string][] = [['gold', 'Gold'], ['silver', 'Silver'], ['gunmetal', 'Gunmetal'], ['black', 'Matte black']];

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
function section(title: string, closed = false): [HTMLElement, HTMLElement] {
  const body = h('div', { class: 'space-y-3.5 px-4 pb-4' });
  const chev = h('span', { class: 'text-stone-600 transition-transform' }, '▾');
  const sec = h('section', { class: 'border-b border-white/5' });
  const toggle = () => {
    body.classList.toggle('hidden');
    chev.classList.toggle('-rotate-90');
  };
  const head = h('button', {
    class: 'flex w-full items-center justify-between px-4 py-3 text-[10px] font-semibold tracking-widest text-stone-500 uppercase hover:text-stone-300',
    onclick: toggle,
  }, title, chev);
  sec.append(head, body);
  if (closed) toggle();
  return [sec, body];
}

/**
 * Builds the left panel once. Inputs dispatch store actions; each input subscribes
 * to exactly its own slice of state, so reset/load/randomize/presets update it in place.
 */
export function buildControls(root: HTMLElement, store: AppStore) {
  root.innerHTML = '';
  const act = () => store.getState();
  const watch = <T,>(sel: (s: State) => T, fn: (v: T) => void) => store.subscribe(sel, fn, { fireImmediately: true });
  const labelRow = (label: string, ctl: Node) =>
    h('div', { class: 'grid grid-cols-[1fr_auto] items-center gap-2 text-xs text-stone-400' }, h('span', {}, label), ctl);

  // Presets
  {
    const [sec, body] = section('Start from');
    const sel = h('select', { class: 'input w-full', onchange: () => sel.value && act().applyPreset(sel.value) },
      h('option', { value: '' }, 'Choose a preset…'),
      ...PRESETS.map((p) => h('option', { value: p.name }, p.name)));
    body.append(sel, h('p', { class: 'text-[10px] leading-snug text-stone-500' }, 'Presets replace all settings. Every part stays editable.'));
    root.append(sec);
  }

  for (const g of TOTE_SCHEMA) {
    const [sec, body] = section(g.title, g.closed);
    for (const f of g.fields) {
      if ('bool' in f) {
        const cb = h('input', { type: 'checkbox', class: CHECK, onchange: () => act().setParam(f.key, cb.checked) });
        watch((s) => !!s.design.params[f.key], (v) => (cb.checked = v));
        body.append(h('label', { class: 'flex cursor-pointer items-center gap-2 text-xs text-stone-300' }, cb, f.label));
      } else if ('options' in f) {
        const numeric = typeof f.options[0][0] === 'number';
        const sel = h('select', {
          class: 'input',
          onchange: () => act().setParam(f.key, numeric ? Number(sel.value) : sel.value),
        }, ...f.options.map(([v, l]) => h('option', { value: String(v) }, l)));
        watch((s) => String(s.design.params[f.key]), (v) => (sel.value = v));
        body.append(labelRow(f.label, sel));
      } else {
        const range = h('input', { type: 'range', min: f.min, max: f.max, step: f.step });
        const num = h('input', { type: 'number', min: f.min, max: f.max, step: f.step, class: 'w-14 bg-transparent text-right font-mono text-xs text-stone-100 outline-none focus:text-accent' });
        const cap = () => (f.capBy ? Number(act().design.params[f.capBy]) : f.max);
        const set = (v: number) => {
          if (!Number.isFinite(v)) return;
          // At (or past) the cap, store 0 = "follow the cap" so it tracks later changes.
          act().setParam(f.key, f.capBy && v >= cap() ? 0 : v);
        };
        range.addEventListener('input', () => set(parseFloat(range.value)));
        num.addEventListener('change', () => set(parseFloat(num.value)));
        const shown = (s: State) => {
          const v = Number(s.design.params[f.key]);
          if (!f.capBy) return `${v}`;
          const c = Number(s.design.params[f.capBy]);
          return `${c}|${v <= 0 || v >= c ? c : v}`;
        };
        watch(shown, (key) => {
          const parts = key.split('|').map(Number);
          const v = parts[parts.length - 1];
          if (f.capBy) range.max = num.max = String(parts[0]);
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
  const names = { outer: 'Outer', lining: 'Lining', strap: 'Handles', trim: 'Trim' } as const;
  for (const slot of ['outer', 'lining', 'strap', 'trim'] as const) {
    const sel = h('select', { class: 'input', onchange: () => act().setSurface(slot, { finish: sel.value as Finish }) },
      ...FINISHES.map((f) => h('option', { value: f }, f[0].toUpperCase() + f.slice(1))));
    const col = h('input', { type: 'color', oninput: () => act().setSurface(slot, { color: col.value }) });
    watch((s) => s.design.appearance[slot].finish, (v) => (sel.value = v));
    watch((s) => s.design.appearance[slot].color, (v) => (col.value = v));
    body.append(row(names[slot], sel, col));
  }
  body.append(h('p', { class: '-mt-2 text-[10px] text-stone-500' }, 'Trim = base, binding, tabs, zip tabs, tassels.'));

  const metal = h('select', { class: 'input', onchange: () => act().setAppearance({ metal: metal.value as Metal }) },
    ...METALS.map(([v, l]) => h('option', { value: v }, l)));
  watch((s) => s.design.appearance.metal, (v) => (metal.value = v));
  body.append(row('Hardware', metal, h('span')));

  // Two-colour pickers: zipper tape/teeth, stripe edge/mid.
  const pair = <K extends 'zipper' | 'stripe'>(label: string, key: K, a: keyof Appearance[K], b: keyof Appearance[K]) => {
    const mk = (sub: keyof Appearance[K]) => {
      const c = h('input', { type: 'color', title: String(sub) });
      c.addEventListener('input', () => {
        const cur = act().design.appearance[key];
        act().setAppearance({ [key]: { ...cur, [sub]: c.value } } as Partial<Appearance>);
      });
      watch((s) => s.design.appearance[key][sub] as unknown as string, (v) => (c.value = v));
      return c;
    };
    body.append(row(label, h('span', { class: 'flex gap-1' }, mk(a), h('span', { class: 'self-center text-[10px] text-stone-500' }, `${String(a)} / ${String(b)}`)), mk(b)));
  };
  pair('Zipper', 'zipper', 'tape', 'teeth');
  pair('Stripe', 'stripe', 'edge', 'mid');

  const thread = h('input', { type: 'color', oninput: () => act().setThread(thread.value) });
  const piping = h('input', { type: 'checkbox', class: CHECK, onchange: () => act().setPiping(piping.checked) });
  watch((s) => s.design.appearance.thread, (v) => (thread.value = v));
  watch((s) => s.design.appearance.piping, (v) => (piping.checked = v));
  body.append(row('Thread', h('span'), thread));
  body.append(h('label', { class: 'flex cursor-pointer items-center gap-2 text-xs text-stone-300' }, piping, 'Seam piping'));
  root.append(sec);
}
