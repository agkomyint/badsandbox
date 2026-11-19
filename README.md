# Bag Sandbox

A parametric bag engine. You design the bag once in JSON. From that design the
engine produces the **sewing pattern** (PDF/SVG at true scale) and the **3D model**,
and both use the same seam lines, so the 3D model matches what you will sew.

```
crates/bag-core   Rust engine: geometry, patterns, mesh, PDF/SVG writers (no deps)
crates/bag-cli    `bag` command-line tool
crates/bag-wasm   WASM bindings for the browser
web/              Bun + Vite + Tailwind + three.js studio (raster + path tracer)
presets/          Example designs
```

## Run

Requirements: Rust, [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) on PATH, [Bun](https://bun.sh).

```sh
cd web && bun install && cd ..
bun run dev            # builds wasm, starts the studio
bun run test           # engine tests
```

## CLI

```sh
bag new tote -o my-tote.json
bag build my-tote.json --pdf --paper a4      # tiled A4 with 10 cm test square
bag build my-tote.json --pdf --paper full    # one big sheet for a plotter
bag build my-tote.json --svg --obj
bag info my-tote.json                        # cut list
```

(`bun run cli -- build presets/tote.json --pdf` works without installing.)

## Studio

- **Left panel**: every dimension, handles, pocket, construction, and materials (canvas, leather, denim, nylon, suede) at real-world texture scale.
- **Center**: PBR raster with soft shadows, ambient occlusion and a studio environment. Press **✦ Ray trace** for progressive path tracing. The first shader compile takes about 30 s.
- **Right panel**: live pattern preview, cut list, and exports: PDF (A4 or Letter tiled, or full size), SVG, design JSON, and GLB/OBJ models.

## Styles

Done: **tote**. Next: box/duffel, bucket, flap crossbody. Each new style is one Rust
module that returns `pieces()` and `mesh()` from its params.
