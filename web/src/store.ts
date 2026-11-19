// App state: a vanilla Zustand store (no React). Subscribers pick narrow slices
// with selectors, so e.g. a colour change never triggers a geometry rebuild.
import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import type { Appearance, Design, Finish, Output, Surface } from './engine';

export type Slot = 'outer' | 'lining' | 'strap';
export type Tab = 'pattern' | 'info';
export type View = { pathTracing: boolean; stitches: boolean; turntable: boolean; tab: Tab };

export type State = {
  design: Design;
  output: Output | null;
  error: string | null;
  view: View;

  setName: (name: string) => void;
  setParam: (key: string, value: number | boolean) => void;
  setSurface: (slot: Slot, patch: Partial<Surface>) => void;
  setThread: (color: string) => void;
  setPiping: (on: boolean) => void;
  randomize: () => void;
  reset: () => void;
  load: (d: Partial<Design>) => void;
  setOutput: (o: Output) => void;
  setError: (e: string | null) => void;
  setView: (patch: Partial<View>) => void;
};

/** Fills anything missing from an older or hand-edited design with defaults. */
export function mergeDesign(defaults: Design, d?: Partial<Design> | null): Design {
  if (!d) return structuredClone(defaults);
  return {
    ...defaults,
    ...d,
    params: { ...defaults.params, ...d.params },
    appearance: { ...defaults.appearance, ...d.appearance } as Appearance,
  };
}

export function createAppStore(defaults: Design) {
  return createStore<State>()(
    subscribeWithSelector(
      persist(
        (set) => {
          const design = (fn: (d: Design) => Design) => set((s) => ({ design: fn(s.design) }));
          const app = (fn: (a: Appearance) => Appearance) => design((d) => ({ ...d, appearance: fn(d.appearance) }));
          return {
            design: structuredClone(defaults),
            output: null,
            error: null,
            view: { pathTracing: false, stitches: true, turntable: false, tab: 'pattern' },

            setName: (name) => design((d) => ({ ...d, name })),
            setParam: (key, value) => design((d) => ({ ...d, params: { ...d.params, [key]: value } })),
            setSurface: (slot, patch) => app((a) => ({ ...a, [slot]: { ...a[slot], ...patch } })),
            setThread: (thread) => app((a) => ({ ...a, thread })),
            setPiping: (piping) => app((a) => ({ ...a, piping })),
            randomize: () => design(randomized),
            reset: () => set({ design: structuredClone(defaults) }),
            load: (d) => set({ design: mergeDesign(defaults, d) }),
            setOutput: (output) => set({ output, error: null }),
            setError: (error) => set({ error }),
            setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
          };
        },
        {
          name: 'bag-studio',
          version: 1,
          partialize: (s) => ({ design: s.design }),
          merge: (persisted, current) => ({ ...current, design: mergeDesign(defaults, (persisted as any)?.design) }),
        },
      ),
    ),
  );
}

export type AppStore = ReturnType<typeof createAppStore>;

const rnd = (a: number, b: number, step = 0.5) => Math.round((a + Math.random() * (b - a)) / step) * step;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const PALETTE = ['#cdbb9f', '#2f3a33', '#8a2f2a', '#1f2a44', '#d8cfc0', '#5b4636', '#b46a3c', '#3c3c3c', '#e8e2d6', '#6f7d5c', '#a3896b', '#141414'];

function randomized(d: Design): Design {
  const w = rnd(24, 50);
  return {
    ...d,
    params: {
      ...d.params,
      width: w,
      top_width: w + rnd(-4, 14),
      height: rnd(22, 50),
      depth: rnd(6, 20),
      corner_radius: rnd(0, 9),
      softness: rnd(0.4, 2.8, 0.1),
      strap_width: rnd(2, 4.5, 0.25),
      strap_spacing: rnd(10, 20),
      strap_length: rnd(35, 75, 1),
      pocket: Math.random() < 0.6,
    },
    appearance: {
      ...d.appearance,
      outer: { finish: pick<Finish>(['canvas', 'canvas', 'denim', 'nylon', 'leather', 'suede']), color: pick(PALETTE) },
      lining: { finish: 'canvas', color: pick(PALETTE) },
      strap: { finish: pick<Finish>(['leather', 'leather', 'canvas', 'suede']), color: pick(PALETTE) },
      thread: pick(['#f1e7d4', '#1b1b1b', '#c9a24b', '#ffffff']),
    },
  };
}
