// Studio renderer: PBR materials, HDR studio environment, soft shadows,
// ambient occlusion, MSAA, plus an optional progressive path tracer.
//
// Performance model:
//  - render on demand: nothing is drawn while the view is idle
//  - shadow map is cached and only redrawn when the geometry changes
//  - ambient occlusion only runs once the view settles (skipped while orbiting/dragging)
//  - meshes and materials persist; updates swap geometry buffers / change colours in place
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Appearance, Finish, Line, Mesh } from './engine';
import { makeMaterial, threadMaterial } from './materials';

const CM = 0.01; // engine works in cm, scene in metres
const SETTLE_MS = 180; // idle time before AO kicks back in
type Slot = 'outer' | 'lining' | 'strap';

/** Curved studio backdrop (floor sweeping up into a wall). */
function cyclorama(width = 10, front = 5, back = 2.5, radius = 1.4, height = 5) {
  const prof: [number, number][] = [[front, 0], [-back + radius, 0]];
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    prof.push([-back + radius - Math.sin(a) * radius, radius - Math.cos(a) * radius]);
  }
  prof.push([-back, height]);
  const pos: number[] = [], idx: number[] = [];
  const nx = 2;
  prof.forEach(([z, y]) => {
    for (let i = 0; i <= nx; i++) pos.push(-width / 2 + (width * i) / nx, y, z);
  });
  for (let r = 0; r < prof.length - 1; r++)
    for (let i = 0; i < nx; i++) {
      const a = r * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Bakes RoomEnvironment into a float equirect DataTexture. Usable by both the
 * rasterizer (PMREM'd internally) and the path tracer, which needs CPU-side pixels
 * for importance sampling and can't convert cube maps on current three.js.
 */
function studioEquirect(renderer: THREE.WebGLRenderer, w = 1024) {
  const h = w / 2;
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const room = new RoomEnvironment();
  new THREE.CubeCamera(0.05, 100, cubeRT).update(renderer, room);
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: cubeRT.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `uniform samplerCube map; varying vec2 vUv;
        void main(){
          float phi = (vUv.x - 0.5) * 6.2831853, th = (vUv.y - 0.5) * 3.1415927;
          vec3 d = vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
          gl_FragColor = vec4(textureCube(map, d).rgb, 1.);
        }`,
      depthTest: false,
    }),
  );
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget(), prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(quad, cam);
  const data = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, data);
  renderer.setRenderTarget(prevTarget);
  renderer.toneMapping = prevTone;
  for (const x of [cubeRT, rt, quad.geometry, quad.material]) x.dispose();
  room.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose(); });
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * All stitches of all stitch lines as one geometry, written straight into typed
 * arrays: each stitch is a 4-sided prism (8 verts, 8 tris). No per-stitch objects.
 */
function buildStitches(lines: Line[]): THREE.BufferGeometry | null {
  const STITCH = 0.32, GAP = 0.16, SIDES = 4;
  const segs: number[] = []; // ax ay az bx by bz r
  for (const l of lines) {
    if (l.kind !== 'stitch') continue;
    const p = l.points;
    let carry = 0;
    for (let i = 0; i + 5 < p.length; i += 3) {
      const ax = p[i], ay = p[i + 1], az = p[i + 2];
      const dx = p[i + 3] - ax, dy = p[i + 4] - ay, dz = p[i + 5] - az;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      let t = carry;
      while (t + STITCH <= len) {
        const t1 = t + STITCH;
        segs.push(ax + ux * t, ay + uy * t, az + uz * t, ax + ux * t1, ay + uy * t1, az + uz * t1, l.radius);
        t += STITCH + GAP;
      }
      carry = Math.max(0, t - len);
    }
  }
  const n = segs.length / 7;
  if (!n) return null;
  const pos = new Float32Array(n * SIDES * 2 * 3);
  const nor = new Float32Array(n * SIDES * 2 * 3);
  const idx = new Uint32Array(n * SIDES * 6);
  let v = 0, f = 0;
  for (let s = 0; s < n; s++) {
    const o = s * 7;
    const ax = segs[o], ay = segs[o + 1], az = segs[o + 2], bx = segs[o + 3], by = segs[o + 4], bz = segs[o + 5], r = segs[o + 6];
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const l = Math.hypot(dx, dy, dz);
    dx /= l; dy /= l; dz /= l;
    // u = normalize(d × helper), w = d × u  →  (u, w, d) right-handed
    const hx = Math.abs(dy) < 0.9 ? 0 : 1, hy = Math.abs(dy) < 0.9 ? 1 : 0;
    let ux = dy * 0 - dz * hy, uy = dz * hx - dx * 0, uz = dx * hy - dy * hx;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    const base = v;
    for (let k = 0; k < SIDES; k++) {
      const ang = (k / SIDES) * Math.PI * 2 + Math.PI / 4;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const nx = ux * c + wx * sn, ny = uy * c + wy * sn, nz = uz * c + wz * sn;
      for (const [ex, ey, ez] of [[ax, ay, az], [bx, by, bz]]) {
        pos[v * 3] = ex + nx * r; pos[v * 3 + 1] = ey + ny * r; pos[v * 3 + 2] = ez + nz * r;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        v++;
      }
    }
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      const a0 = base + k * 2, b0 = a0 + 1, a1 = base + k2 * 2, b1 = a1 + 1;
      idx[f++] = a0; idx[f++] = a1; idx[f++] = b0;
      idx[f++] = a1; idx[f++] = b1; idx[f++] = b0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export class Studio {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  bag = new THREE.Group();
  onSamples: (n: number) => void = () => {};
  pathTracing = false;

  private ao: GTAOPass;
  private meshes = new Map<string, THREE.Mesh>();
  private piping = new THREE.Group();
  private stitches: THREE.Mesh;
  private mats: Record<Slot | 'piping', THREE.MeshPhysicalMaterial>;
  private thread: THREE.MeshPhysicalMaterial;
  private finish: Record<Slot, Finish> = { outer: 'canvas', lining: 'canvas', strap: 'leather' };
  private lastMesh: Mesh | null = null;
  private framed = false;

  private dirty = true;
  private shadowDirty = true;
  private dragging = false;
  private lastMove = 0;
  private ptMod: any = null;
  private pt: any = null;
  private ptTimer = 0;

  constructor(private el: HTMLElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.VSMShadowMap;
    r.shadowMap.autoUpdate = false;
    el.appendChild(r.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    this.camera.position.set(0.9, 0.65, 1.35);
    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.enableDamping = true;
    c.maxPolarAngle = Math.PI * 0.495;
    c.minDistance = 0.25;
    c.maxDistance = 5;
    c.autoRotateSpeed = 1.2;
    c.addEventListener('start', () => (this.dragging = true));
    c.addEventListener('end', () => { this.dragging = false; this.lastMove = performance.now(); });
    c.addEventListener('change', () => { this.invalidate(true); this.pt?.updateCamera(); });

    this.scene.environment = studioEquirect(r);
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color('#d9d5cf');

    const key = new THREE.DirectionalLight('#fff4e6', 2.6);
    key.position.set(1.4, 2.6, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -0.8, right: 0.8, top: 0.8, bottom: -0.8, near: 0.5, far: 6 });
    key.shadow.radius = 10;
    key.shadow.blurSamples = 20;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#dfe8ff', 1.1);
    rim.position.set(-1.6, 1.4, -1.8);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b9ae9f', 0.35));

    const stage = new THREE.Mesh(cyclorama(), new THREE.MeshStandardMaterial({ color: '#e4e0da', roughness: 0.95 }));
    stage.receiveShadow = true;
    this.scene.add(stage, this.bag);
    this.bag.scale.setScalar(CM);

    this.mats = {
      outer: makeMaterial('canvas', '#cdbb9f'),
      lining: makeMaterial('canvas', '#7d2c26'),
      strap: makeMaterial('leather', '#6a3a1e'),
      piping: makeMaterial('canvas', '#cdbb9f'),
    };
    this.thread = threadMaterial('#f1e7d4');
    this.stitches = new THREE.Mesh(new THREE.BufferGeometry(), this.thread);
    this.stitches.castShadow = true;
    this.bag.add(this.piping, this.stitches);

    const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.5, thickness: 1, scale: 1, samples: 16 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    r.setAnimationLoop(() => this.frame());
  }

  /** Request a redraw. `moving` = this change is part of an ongoing interaction. */
  invalidate(moving = false) {
    this.dirty = true;
    if (moving) this.lastMove = performance.now();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pt?.updateCamera();
    this.invalidate();
  }

  private frame() {
    this.controls.update();
    if (this.pathTracing && this.pt) {
      this.pt.renderSample();
      this.onSamples(Math.floor(this.pt.samples));
      return;
    }
    const interacting = this.dragging || this.controls.autoRotate || performance.now() - this.lastMove < SETTLE_MS;
    // Settled: turn AO back on and draw one full-quality frame.
    if (this.ao.enabled === interacting) {
      this.ao.enabled = !interacting;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    this.composer.render();
  }

  private slotOf(material: string): Slot {
    return material === 'lining' || material === 'strap' ? material : 'outer';
  }

  /** Swap in new geometry. Meshes are reused by part name; old buffers are disposed. */
  setGeometry(mesh: Mesh) {
    const seen = new Set<string>();
    for (const p of mesh.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeBoundingSphere();
      const slot = this.slotOf(p.material);
      let m = this.meshes.get(p.name);
      if (m) {
        m.geometry.dispose();
        m.geometry = g;
      } else {
        m = new THREE.Mesh(g);
        m.name = p.name;
        m.castShadow = m.receiveShadow = true;
        this.meshes.set(p.name, m);
        this.bag.add(m);
      }
      m.userData.slot = slot;
      m.material = this.mats[slot];
      seen.add(p.name);
    }
    for (const [name, m] of this.meshes)
      if (!seen.has(name)) {
        m.geometry.dispose();
        this.bag.remove(m);
        this.meshes.delete(name);
      }

    for (const t of this.piping.children as THREE.Mesh[]) t.geometry.dispose();
    this.piping.clear();
    for (const l of mesh.lines) {
      if (l.kind !== 'piping' || l.points.length < 6) continue;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < l.points.length; i += 3) pts.push(new THREE.Vector3(l.points[i], l.points[i + 1], l.points[i + 2]));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, l.radius, 8), this.mats.piping);
      tube.castShadow = tube.receiveShadow = true;
      this.piping.add(tube);
    }

    this.stitches.geometry.dispose();
    this.stitches.geometry = buildStitches(mesh.lines) ?? new THREE.BufferGeometry();

    this.bag.position.y = -mesh.bounds[1] * CM;
    this.lastMesh = mesh;
    if (!this.framed) {
      this.framed = true;
      this.frameView();
    }
    this.shadowDirty = true;
    this.invalidate(true);
    this.schedulePathTracerRebuild();
  }

  /** Colour changes are in-place; only a finish change creates a new material. */
  setAppearance(app: Appearance) {
    for (const slot of ['outer', 'lining', 'strap'] as const) {
      const s = app[slot];
      if (this.finish[slot] !== s.finish) {
        const old = this.mats[slot];
        this.mats[slot] = makeMaterial(s.finish, s.color);
        this.finish[slot] = s.finish;
        for (const m of this.meshes.values()) if (m.userData.slot === slot) m.material = this.mats[slot];
        old.dispose();
        if (slot === 'outer') {
          const oldP = this.mats.piping;
          this.mats.piping = makeMaterial(s.finish, s.color);
          for (const t of this.piping.children as THREE.Mesh[]) t.material = this.mats.piping;
          oldP.dispose();
        }
      }
      recolor(this.mats[slot], s.color);
    }
    recolor(this.mats.piping, app.outer.color, 0.8);
    recolor(this.thread, app.thread);
    this.piping.visible = app.piping;
    this.invalidate();
    if (this.pathTracing) this.pt?.updateMaterials();
  }

  frameView(mesh = this.lastMesh) {
    if (!mesh) return;
    const b = mesh.bounds;
    const h = (b[4] - b[1]) * CM, w = (b[3] - b[0]) * CM;
    const d = Math.max(h, w) * 2.6;
    this.controls.target.set(0, h * 0.45, 0);
    this.camera.position.set(d * 0.55, h * 0.45 + d * 0.32, d * 0.85);
    this.controls.update();
    this.pt?.updateCamera();
    this.invalidate();
  }

  setStitches(on: boolean) {
    this.stitches.visible = on;
    this.invalidate();
    this.schedulePathTracerRebuild();
  }

  setTurntable(on: boolean) {
    this.controls.autoRotate = on;
    this.invalidate(true);
  }

  /** BVH rebuilds are expensive: coalesce bursts of edits into one. */
  private schedulePathTracerRebuild() {
    if (!this.pathTracing) return;
    clearTimeout(this.ptTimer);
    this.ptTimer = window.setTimeout(() => this.pt?.setScene(this.scene, this.camera), 250);
  }

  async setPathTracing(on: boolean) {
    if (on && !this.pt) {
      this.ptMod ??= await import('three-gpu-pathtracer');
      this.pt = new this.ptMod.WebGLPathTracer(this.renderer);
      this.pt.minSamples = 1;
      this.pt.bounces = 6;
      this.pt.filterGlossyFactor = 0.5;
      this.pt.dynamicLowRes = true;
    }
    this.pathTracing = on;
    // The path tracer lights the scene with the environment, so it needs a brighter studio.
    this.scene.environmentIntensity = on ? 1.1 : 0.55;
    if (on) {
      this.renderer.shadowMap.autoUpdate = false;
      this.pt.setScene(this.scene, this.camera);
    } else {
      this.shadowDirty = true;
      this.invalidate();
    }
  }

  screenshot(): string {
    // No preserveDrawingBuffer (faster), so draw and read back in the same task.
    if (this.pathTracing && this.pt) this.pt.renderSample();
    else this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  async exportGLB(): Promise<ArrayBuffer> {
    return (await new GLTFExporter().parseAsync(this.bag, { binary: true })) as ArrayBuffer;
  }
}

const WHITE = new THREE.Color('#ffffff');
function recolor(m: THREE.MeshPhysicalMaterial, hex: string, mul = 1) {
  m.color.set(hex).multiplyScalar(mul);
  m.sheenColor.copy(m.color).lerp(WHITE, 0.35);
}
