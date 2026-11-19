// Main-thread client for the engine worker.

export type Part = {
  name: string;
  material: 'outer' | 'lining' | 'strap' | 'pocket' | string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
};
export type Line = { kind: 'piping' | 'stitch'; radius: number; points: Float32Array };
export type Mesh = { parts: Part[]; lines: Line[]; bounds: number[] };
export type Piece = { id: string; name: string; cut: string; notes: string[] };
export type Finish = 'canvas' | 'leather' | 'denim' | 'nylon' | 'suede';
export type Surface = { finish: Finish; color: string };
export type Appearance = { outer: Surface; lining: Surface; strap: Surface; thread: string; piping: boolean };
export type Design = { style: string; name: string; params: Record<string, number | boolean>; appearance: Appearance };
export type Pattern = { style: string; name: string; pieces: Piece[]; warnings: string[] };
export type Output = { pattern: Pattern; params: Record<string, number | boolean>; svg: string; mesh: Mesh; ms: number };

export class Engine {
  private worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private calls = new Map<number, [(v: any) => void, (e: Error) => void]>();
  private inflight = false;
  private queued: Design | null = null;

  /** Called with the newest result of `request()`. */
  onOutput: (o: Output) => void = () => {};
  onError: (e: Error) => void = () => {};

  constructor() {
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const c = this.calls.get(id);
      if (!c) return;
      this.calls.delete(id);
      ok ? c[0](result) : c[1](new Error(error));
    };
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.calls.set(id, [res, rej]);
      this.worker.postMessage({ ...msg, id });
    });
  }

  /**
   * Latest-wins regeneration: while a build is running, only the newest
   * design is kept, so dragging a slider never queues up stale work.
   */
  request(design: Design) {
    this.queued = design;
    if (!this.inflight) void this.pump();
  }

  private async pump() {
    this.inflight = true;
    while (this.queued) {
      const design = this.queued;
      this.queued = null;
      try {
        this.onOutput(await this.call<Output>({ type: 'generate', design }));
      } catch (e) {
        this.onError(e as Error);
      }
    }
    this.inflight = false;
  }

  defaultDesign = (style: string) => this.call<Design>({ type: 'default', style });
  patternPdf = (design: Design, paper: string) => this.call<Uint8Array>({ type: 'pdf', design, paper });
  patternSvg = (design: Design) => this.call<string>({ type: 'svg', design });
  meshObj = (design: Design) => this.call<string>({ type: 'obj', design });
}
