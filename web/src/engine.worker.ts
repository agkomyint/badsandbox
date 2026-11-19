/// <reference lib="webworker" />
// Runs the Rust/WASM engine off the main thread. Geometry comes back as
// transferable typed arrays, so nothing is copied or JSON-parsed on the UI thread.
import init, * as wasm from './wasm/bag_wasm.js';

const ready = init();
const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent) => {
  const { id, type, design, paper, style } = e.data;
  try {
    await ready;
    const js = design ? JSON.stringify(design) : '';
    switch (type) {
      case 'generate': {
        const t0 = performance.now();
        const r = wasm.generate_packed(js);
        const meta = JSON.parse(r.meta);
        const parts = meta.parts.map((p: any, i: number) => ({ ...p, ...r.parts[i] }));
        const lines = meta.lines.map((l: any, i: number) => ({ ...l, points: r.lines[i] }));
        const transfer = [
          ...parts.flatMap((p: any) => [p.positions.buffer, p.normals.buffer, p.uvs.buffer, p.indices.buffer]),
          ...lines.map((l: any) => l.points.buffer),
        ];
        const result = {
          pattern: meta.pattern,
          params: meta.params,
          svg: meta.svg,
          mesh: { parts, lines, bounds: meta.bounds },
          ms: performance.now() - t0,
        };
        return post({ id, ok: true, result }, transfer);
      }
      case 'pdf': {
        const bytes: Uint8Array = wasm.pattern_pdf(js, paper);
        return post({ id, ok: true, result: bytes }, [bytes.buffer]);
      }
      case 'svg':
        return post({ id, ok: true, result: wasm.pattern_svg(js) });
      case 'obj':
        return post({ id, ok: true, result: wasm.mesh_obj(js) });
      case 'default':
        return post({ id, ok: true, result: JSON.parse(wasm.default_design(style)) });
    }
    throw new Error(`unknown request ${type}`);
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
