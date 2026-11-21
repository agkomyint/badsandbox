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
import { makeMaterial, metalMaterial, plainMaterial, threadMaterial } from './materials';
import { ClothSim } from './fabric';
import { Items, ITEMS } from './items';

const CM = 0.01; // engine works in cm, scene in metres
const SETTLE_MS = 180; // idle time before AO kicks back in
type Surf = 'outer' | 'lining' | 'strap' | 'trim';
type Slot = Surf | 'metal' | 'zip_tape' | 'zip_teeth' | 'stripe_edge' | 'stripe_mid';
const SURFS: Surf[] = ['outer', 'lining', 'strap', 'trim'];
const SLOTS = new Set<string>([...SURFS, 'metal', 'zip_tape', 'zip_teeth', 'stripe_edge', 'stripe_mid']);

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
  /** Physics moves this; `bag` sits inside it with its bottom at y = 0. */
  rig = new THREE.Group();
  onSamples: (n: number) => void = () => {};
  onPhysics: (state: 'moving' | 'settled') => void = () => {};
  /** Fired when a click on the zipper pull opens (true) or closes (false) the zip. */
  onZipToggle?: (open: boolean) => void;
  pathTracing = false;

  private physics: import('./physics').Physics | null = null;
  private physicsOn = false;
  private cloth: ClothSim | null = null;
  private clothOn = false;
  private items: Items | null = null;
  private moving = false;
  private lastT = performance.now();
  private ray = new THREE.Raycaster();
  private dragPlane = new THREE.Plane();

  private ao: GTAOPass;
  private meshes = new Map<string, THREE.Mesh>();
  private piping = new THREE.Group();
  private stitches: THREE.Mesh;
  private mats: Record<Slot | 'piping', THREE.MeshPhysicalMaterial>;
  private thread: THREE.MeshPhysicalMaterial;
  private finish: Record<Surf, Finish> = { outer: 'canvas', lining: 'canvas', strap: 'leather', trim: 'leather' };
  private metal = 'gold';
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
    this.rig.add(this.bag);
    this.scene.add(stage, this.rig);
    this.initPointer(r.domElement);
    this.bag.scale.setScalar(CM);

    this.mats = {
      outer: makeMaterial('canvas', '#cdbb9f'),
      lining: makeMaterial('canvas', '#7d2c26'),
      strap: makeMaterial('leather', '#6a3a1e'),
      trim: makeMaterial('leather', '#6a3a1e'),
      metal: metalMaterial('gold'),
      zip_tape: plainMaterial('#2b2622', 0.85, 0.6),
      zip_teeth: plainMaterial('#2b2622', 0.35),
      stripe_edge: makeMaterial('canvas', '#1f2f4a'),
      stripe_mid: makeMaterial('canvas', '#efe6d2'),
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

  /** The GPU the browser gave us, e.g. "NVIDIA GeForce RTX 3060" or "Intel(R) UHD Graphics". */
  get gpu(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
    // "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 ...)" -> "Intel(R) UHD Graphics"
    return raw.match(/ANGLE \([^,]+, ([^(,]+)/)?.[1]?.trim() ?? raw;
  }

  /** True when running on an integrated / software GPU, where path tracing is slow or unreliable. */
  get weakGpu(): boolean {
    return /intel|swiftshader|llvmpipe|basic render|microsoft/i.test(this.gpu);
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
    const now = performance.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.controls.update();
    const sim = this.clothOn ? this.cloth : this.physicsOn ? this.physics : null;
    if (sim) {
      let moving = sim.step(dt);
      if (this.clothOn && this.items?.count) {
        const g = this.items.group;
        g.position.copy(this.bag.position);
        g.scale.copy(this.bag.scale);
        moving = this.items.step(dt) || moving;
      }
      if (moving) {
        this.shadowDirty = true;
        this.invalidate(true);
      }
      if (moving !== this.moving) {
        this.moving = moving;
        this.onPhysics(moving ? 'moving' : 'settled');
        // Path tracing can't keep up with motion: raster while moving, re-trace once settled.
        if (!moving && this.pathTracing) this.pt?.setScene(this.scene, this.camera);
      }
    }
    if (this.pathTracing && this.pt && !this.moving) {
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
    return (SLOTS.has(material) ? material : 'outer') as Slot; // 'pocket' etc. use the outer fabric
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
    this.physics?.setShape(this.bag);
    if (this.clothOn) this.startCloth();
    if (!this.framed) {
      this.framed = true;
      this.frameView();
      this.warmPathTracer();
    }
    this.shadowDirty = true;
    this.invalidate(true);
    this.schedulePathTracerRebuild();
  }

  /** Colour changes are in-place; only a finish change creates a new material. */
  setAppearance(app: Appearance) {
    const swap = (slot: Slot, mat: THREE.MeshPhysicalMaterial) => {
      const old = this.mats[slot];
      this.mats[slot] = mat;
      for (const m of this.meshes.values()) if (m.userData.slot === slot) m.material = mat;
      old.dispose();
    };
    const metal = app.metal ?? 'gold';
    if (metal !== this.metal) {
      this.metal = metal;
      swap('metal', metalMaterial(metal));
    }
    if (app.zipper) {
      recolor(this.mats.zip_tape, app.zipper.tape);
      recolor(this.mats.zip_teeth, app.zipper.teeth);
    }
    if (app.stripe) {
      recolor(this.mats.stripe_edge, app.stripe.edge);
      recolor(this.mats.stripe_mid, app.stripe.mid);
    }
    for (const slot of SURFS) {
      const s = app[slot];
      if (!s) continue;
      if (this.finish[slot] !== s.finish) {
        swap(slot, makeMaterial(s.finish, s.color));
        this.finish[slot] = s.finish;
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

  /** Gravity + floor + mouse pick-up. Turning it on drops the bag from a little height. */
  async setPhysics(on: boolean) {
    if (on && !this.physics) {
      const { Physics } = await import('./physics');
      this.physics = await Physics.create(this.rig);
      this.physics.setShape(this.bag);
    }
    this.physicsOn = on;
    if (!this.physics) return;
    if (on) this.physics.reset(0.25);
    else {
      this.physics.reset(0);
      this.moving = false;
      this.onPhysics('settled');
      if (this.pathTracing) this.pt?.setScene(this.scene, this.camera);
    }
    this.shadowDirty = true;
    this.invalidate(true);
  }

  /** Soft-body fabric simulation: the bag slumps, drapes and can be lifted by any point. */
  setSimulation(on: boolean) {
    this.clothOn = on;
    if (on) {
      this.rig.position.set(0, 0, 0);
      this.rig.quaternion.identity();
      this.startCloth();
    } else {
      this.cloth?.restore();
      this.cloth = null;
      this.items?.clear();
      this.moving = false;
      this.onPhysics('settled');
      if (this.pathTracing) this.pt?.setScene(this.scene, this.camera);
    }
    this.shadowDirty = true;
    this.invalidate(true);
  }

  /** Number of fabric particles in the running simulation (0 when off). */
  get clothParticles() {
    return this.cloth?.n ?? 0;
  }

  private startCloth() {
    const floor = this.lastMesh ? this.lastMesh.bounds[1] : 0;
    this.cloth = new ClothSim(this.bag, floor, this.finish.outer);
    this.cloth.items = this.items;
    this.items?.setFloor(floor);
    this.moving = true;
    this.onPhysics('moving');
  }

  /** True if the simulated bag has a zip top you can open. */
  get hasZip() {
    return !!this.cloth?.hasZip;
  }
  /** Zip slider: 0 = open, 1 = closed (simulation only). */
  get zipper() {
    return this.cloth?.zipper ?? 1;
  }
  set zipper(s: number) {
    if (!this.cloth) return;
    this.cloth.zipper = s;
    this.moving = true; // wake the loop: a settled bag isn't being stepped
    this.invalidate(true);
  }

  /** Drop an item into (or onto) the bag. Simulation only. */
  async addItem(key: string) {
    if (!this.cloth || !this.lastMesh) return 0;
    const b = this.lastMesh.bounds; // [minX, minY, minZ, maxX, maxY, maxZ] in cm
    if (!this.items) {
      this.items = await Items.create(b[1]);
      this.rig.add(this.items.group);
    }
    if (!this.cloth) return 0; // turned off while Rapier was loading
    this.cloth.items = this.items;
    const spec = ITEMS[key];
    // The way in: an open zip, or the whole top of a bag without one.
    let zs = this.cloth.zipSpan;
    if (zs && this.cloth.zipper > 0.5) zs = null; // zipped shut: it lands on top
    else if (!zs) { const bb = this.cloth.bodyBox(); zs = { x0: bb[0] + 1.5, x1: bb[3] - 1.5, y: bb[4] }; }
    if (zs && spec) {
      // Pack it the way people do: long side along the zip, lying flat on the
      // bottom if it fits across the gusset, else standing on its long edge. Standing
      // things upright looked nice but they lean on a wall and lever a soft bag over.
      const [a, bb, c] = spec.size;
      // Depth where it'll lie: at the bottom (gussets often taper toward it).
      const [z0, z1] = this.cloth.bodyDepth(b[1] - 1, b[1] + 3);
      const zipLen = zs.x1 - zs.x0, depth = z1 - z0, zc = (z0 + z1) / 2;
      const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
      const q = new THREE.Quaternion();
      let hx: number, hy: number;
      if (spec.kind === 'box') {
        const long = Math.max(a, bb), wide = Math.min(a, bb);
        if (bb > a) q.setFromAxisAngle(Z, Math.PI / 2); // model's long axis (y) → x
        if (2 * long > zipLen - 1) { q.identity(); hx = a; hy = bb; } // too long: upright
        else if (2 * wide <= depth + 0.5) { q.premultiply(new THREE.Quaternion().setFromAxisAngle(X, Math.PI / 2)); hx = long; hy = c; }
        else { hx = long; hy = wide; }
        // A tall flat thing standing in a narrow bag leans on a wall and levers it over.
        if (hy > c + 1 && hy > depth * 0.6) return -2;
      } else if (bb > 0 && 2 * (a + bb) <= zipLen + 2) { // soft sides give a little
        q.setFromAxisAngle(Z, Math.PI / 2); hx = a + bb; hy = a; // lying along the zip
      } else { hx = a; hy = a + bb; }
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.1)));
      const free = Math.max(0, (zs.x1 - zs.x0) / 2 - hx - 1);
      // Pick the lowest free spot along the zip, packing from one end so the next item
      // still fits beside it. Never spawn inside something already in the bag (the
      // solver would fling both): if it's full, drop it clear above the opening.
      // All of the above is in the bag's rest shape, but the simulated bag shifts and
      // turns as it slumps: map each spot to where that part of the bag is now.
      const cloth = this.cloth;
      const now = (rx: number, ry: number) => cloth.toCurrent(new THREE.Vector3(rx, ry, zc));
      const mid = (zs.x0 + zs.x1) / 2;
      let at = now(mid, b[1]), best = Infinity, top = -Infinity;
      for (let k = 0; k < 13; k++) {
        const p = now(mid + free * (k / 6 - 1), b[1]);
        const t = this.items.topNear(p.x, hx + 0.3);
        const score = Math.max(t, -1e3) + k * 0.05; // ties → leftmost
        if (score < best) { best = score; top = t; at = p; }
      }
      // Rest it just above the fabric actually under it (the bottom panel is thick
      // and sags): spawning inside the fabric lets an item burrow under and lever the bag.
      const ground = cloth.floorUnder(at.x - hx, at.x + hx, at.z, at.y + 4); // bottom panel band only
      // Not dropped from the opening: a long fall tunnels straight through the fabric.
      let y = (ground > -1e9 ? ground : at.y) + 0.8 + hy + 0.6;
      if (top + 0.5 > y - hy) y = top + hy + 0.5;
      // No room left below the opening: dropping it on the pile just knocks things out.
      if (y + hy > now(mid, zs.y).y + 0.5) return -1; // must fit wholly below the opening
      this.items.add(key, new THREE.Vector3(at.x, y, at.z), q.premultiply(cloth.fitQ));
    } else {
      const spread = (b[3] - b[0]) * 0.25;
      const top = this.cloth.bodyBox()[4]; // body, not the strap high above it
      this.items.add(key, new THREE.Vector3((Math.random() - 0.5) * spread, top + 8 + this.items.count * 2, 0));
    }
    this.moving = true;
    this.invalidate(true);
    return this.items.count;
  }
  clearItems() {
    this.items?.clear();
    this.invalidate();
  }

  /** Drag the bag while physics is on. Orbit still works when you miss the bag. */
  private initPointer(el: HTMLElement) {
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const aim = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.camera);
    };
    // Capture phase: runs before OrbitControls' own pointerdown on the same element.
    // Whichever simulation is active; cloth works in bag-local cm, rigid physics in world metres.
    type Handler = {
      holding: boolean;
      grab: (p: THREE.Vector3, obj: THREE.Object3D) => void;
      drag: (p: THREE.Vector3) => void;
      release: () => void;
    };
    const active = (): Handler | null => {
      if (this.clothOn && this.cloth) {
        const c = this.cloth, it = this.items;
        const local = (p: THREE.Vector3) => this.bag.worldToLocal(p.clone());
        return {
          holding: c.holding || !!it?.holding,
          // An item, the zipper pull, or else the nearest bit of fabric.
          grab: (p, obj) => { const l = local(p); if (!it?.grab(obj, l)) c.grab(l, obj.name); },
          drag: (p) => (it?.holding ? it.drag(local(p)) : c.drag(local(p))),
          release: () => { c.release(); it?.release(); },
        };
      }
      const ph = this.physicsOn ? this.physics : null;
      return ph && { holding: ph.holding, grab: (p) => ph.grab(p), drag: (p) => ph.drag(p), release: () => ph.release() };
    };
    let zipClick: { x: number; y: number; was: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      const sim = active();
      if (!sim || e.button !== 0) return;
      aim(e);
      const hits = this.ray.intersectObject(this.rig, true);
      // Things in a bag are mostly hidden under fabric: if the ray reaches an item just
      // behind the first surface (through a thin wall or a half-open zip), take the item.
      const ig = this.items?.group;
      const reach = 12 * this.bag.scale.x; // 12 cm, in world units
      // Same for the zipper pull, which the strap often lies across.
      const near = (h: THREE.Intersection) => h.distance - (hits[0]?.distance ?? 0) < reach;
      const itemHit = hits.find((h) => near(h) && /^zip_top_(slider|ring|tassel)/.test(h.object.name))
        || (ig && hits.find((h) => near(h) && ig.children.includes(h.object)));
      let hit = itemHit || hits[0];
      // The pull is small: any click within ~28 px of it on screen counts as grabbing it.
      if (this.clothOn && this.hasZip && !/^zip_top_(slider|ring|tassel)/.test(hit?.object.name ?? '')) {
        let pull: THREE.Mesh | null = null;
        this.bag.traverse((m) => { if (!pull && /^zip_top_slider/.test(m.name) && (m as THREE.Mesh).geometry) pull = m as THREE.Mesh; });
        if (pull) {
          const g = (pull as THREE.Mesh).geometry;
          g.computeBoundingBox(); // vertices move with the cloth
          const c = (pull as THREE.Mesh).localToWorld(g.boundingBox!.getCenter(new THREE.Vector3()));
          const s = c.clone().project(this.camera), r = el.getBoundingClientRect();
          const dx = r.left + (s.x + 1) / 2 * r.width - e.clientX, dy = r.top + (1 - s.y) / 2 * r.height - e.clientY;
          if (dx * dx + dy * dy < 28 * 28) hit = { object: pull, point: c, distance: 0 } as THREE.Intersection;
        }
      }
      if (!hit) return;
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      // Drag on a vertical plane facing the camera through the grab point.
      const n = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(n, hit.point);
      sim.grab(hit.point, hit.object);
      // A click (no drag) on the pull toggles the zip open/closed; a drag slides it.
      zipClick = this.clothOn && /^zip_top_(slider|ring|tassel)/.test(hit.object.name)
        ? { x: e.clientX, y: e.clientY, was: this.zipper } : null;
      el.style.cursor = 'grabbing';
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      const sim = active();
      if (!sim?.holding) return;
      aim(e);
      if (this.ray.ray.intersectPlane(this.dragPlane, hitPoint)) sim.drag(hitPoint);
    });
    const up = (e: PointerEvent) => {
      const sim = active();
      if (!sim?.holding) return;
      sim.release();
      if (zipClick && Math.hypot(e.clientX - zipClick.x, e.clientY - zipClick.y) < 6) {
        this.zipper = zipClick.was > 0.5 ? 0 : 1;
        this.onZipToggle?.(this.zipper < 0.5);
      }
      zipClick = null;
      this.controls.enabled = true;
      el.releasePointerCapture?.(e.pointerId);
      el.style.cursor = '';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** BVH rebuilds are expensive: coalesce bursts of edits into one. */
  private schedulePathTracerRebuild() {
    if (!this.pathTracing) return;
    clearTimeout(this.ptTimer);
    this.ptTimer = window.setTimeout(() => this.pt?.setScene(this.scene, this.camera), 250);
  }

  private async ensurePathTracer() {
    if (this.pt) return;
    this.ptMod ??= await import('three-gpu-pathtracer');
    if (this.pt) return; // another caller won the race
    this.pt = new this.ptMod.WebGLPathTracer(this.renderer);
    // Set everything that changes shader defines *before* the first compile.
    this.pt.minSamples = 1;
    this.pt.bounces = 6;
    this.pt.filterGlossyFactor = 0.5;
    this.pt.dynamicLowRes = true;
  }

  /**
   * Compile the path-tracing shader in the background right after load, so the
   * Ray trace button starts almost instantly instead of waiting ~30 s.
   * Uses parallel (non-blocking) shader compilation; nothing is drawn.
   */
  private warmed = false;
  private warmPathTracer() {
    if (this.warmed) return;
    this.warmed = true;
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(async () => {
      try {
        await this.ensurePathTracer();
        if (this.pathTracing) return; // user already turned it on
        this.pt.setScene(this.scene, this.camera);
        const core = this.pt._pathTracer;
        if (!this.pt.isCompiling) await core?.compileMaterial?.();
        console.info('[studio] path tracer pre-compiled');
      } catch (e) {
        console.warn('[studio] path tracer warm-up failed', e);
      }
    });
  }

  async setPathTracing(on: boolean) {
    if (on) await this.ensurePathTracer();
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
