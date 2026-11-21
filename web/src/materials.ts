// Procedural fabric and leather materials. Textures are generated once per finish.
// Mesh UVs are in real centimetres, so `tileCm` sets the true physical scale.
import * as THREE from 'three';
import type { Finish } from './engine';

const N = 512;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Tileable value noise with `g` cells across. */
function valueNoise(g: number, seed: number) {
  const r = rng(seed);
  const lat = Float32Array.from({ length: g * g }, r);
  const at = (x: number, y: number) => lat[((y % g) + g) % g * g + (((x % g) + g) % g)];
  return (u: number, v: number) => {
    const x = u * g, y = v * g;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function fbm(octaves: number, base: number, seed: number) {
  const ns = Array.from({ length: octaves }, (_, i) => valueNoise(base << i, seed + i * 31));
  return (u: number, v: number) => {
    let s = 0, amp = 0.5, tot = 0;
    for (const n of ns) { s += n(u, v) * amp; tot += amp; amp *= 0.5; }
    return s / tot;
  };
}

/** Tileable Worley noise: distance to the nearest feature point (pebbled leather). */
function worley(g: number, seed: number) {
  const r = rng(seed);
  const pts = Array.from({ length: g * g }, () => [r(), r()]);
  return (u: number, v: number) => {
    const x = u * g, y = v * g;
    const cx = Math.floor(x), cy = Math.floor(y);
    let best = 9;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const p = pts[((gy % g) + g) % g * g + (((gx % g) + g) % g)];
        const dx = gx + p[0] - x, dy = gy + p[1] - y;
        best = Math.min(best, dx * dx + dy * dy);
      }
    return Math.sqrt(best);
  };
}

function weave(u: number, v: number, threads: number, twill: boolean) {
  const x = u * threads, y = v * threads;
  const cx = Math.floor(x), cy = Math.floor(y);
  const fx = x - cx, fy = y - cy;
  const warp = Math.pow(Math.sin(Math.PI * fx), 0.7);
  const weft = Math.pow(Math.sin(Math.PI * fy), 0.7);
  const warpOnTop = twill ? ((cx - cy) % 3 + 3) % 3 !== 0 : (cx + cy) % 2 === 0;
  return warpOnTop ? 0.45 + 0.55 * warp * (0.6 + 0.4 * Math.sin(Math.PI * fy)) : 0.45 + 0.55 * weft * (0.6 + 0.4 * Math.sin(Math.PI * fx));
}

type Spec = { tileCm: number; height: (u: number, v: number) => number; strength: number };

const specs: Record<Finish, () => Spec> = {
  canvas: () => {
    const fz = fbm(3, 8, 7);
    return { tileCm: 2.0, strength: 3.2, height: (u, v) => weave(u, v, 28, false) * 0.85 + fz(u, v) * 0.15 };
  },
  denim: () => {
    const fz = fbm(3, 16, 11);
    return { tileCm: 1.6, strength: 3.0, height: (u, v) => weave(u, v, 32, true) * 0.8 + fz(u, v) * 0.2 };
  },
  nylon: () => {
    const fz = fbm(2, 8, 5);
    return {
      tileCm: 1.6, strength: 1.6,
      height: (u, v) => {
        const rip = (Math.abs(((u * 6) % 1) - 0.5) < 0.04 || Math.abs(((v * 6) % 1) - 0.5) < 0.04) ? 0.35 : 0;
        return weave(u, v, 48, false) * 0.5 + rip + fz(u, v) * 0.1;
      },
    };
  },
  leather: () => {
    const w1 = worley(22, 3), w2 = worley(60, 9), fz = fbm(4, 4, 13);
    return {
      tileCm: 7.0, strength: 2.2,
      height: (u, v) => Math.pow(Math.min(1, w1(u, v) * 1.25), 0.55) * 0.7 + Math.min(1, w2(u, v)) * 0.18 + fz(u, v) * 0.12,
    };
  },
  suede: () => {
    const fz = fbm(5, 32, 17);
    return { tileCm: 3.0, strength: 1.2, height: (u, v) => fz(u, v) };
  },
};

type Maps = { normal: THREE.DataTexture; rough: THREE.DataTexture; tileCm: number };
const cache = new Map<Finish, Maps>();

function maps(finish: Finish): Maps {
  const hit = cache.get(finish);
  if (hit) return hit;
  const s = specs[finish]();
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = s.height(x / N, y / N);
  const nd = new Uint8Array(N * N * 4);
  const rd = new Uint8Array(N * N * 4);
  const H = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * s.strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * s.strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 4;
      nd[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      nd[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      nd[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nd[i + 3] = 255;
      const r = 200 + (0.5 - H(x, y)) * 90;
      rd[i] = rd[i + 1] = rd[i + 2] = Math.max(0, Math.min(255, r));
      rd[i + 3] = 255;
    }
  const mk = (d: Uint8Array) => {
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.repeat.set(1 / s.tileCm, 1 / s.tileCm);
    t.needsUpdate = true;
    return t;
  };
  const m = { normal: mk(nd), rough: mk(rd), tileCm: s.tileCm };
  cache.set(finish, m);
  return m;
}

export function makeMaterial(finish: Finish, color: string): THREE.MeshPhysicalMaterial {
  const { normal, rough } = maps(finish);
  const c = new THREE.Color(color);
  const m = new THREE.MeshPhysicalMaterial({
    color: c,
    normalMap: normal,
    roughnessMap: rough,
    side: THREE.DoubleSide,
  });
  const sheenColor = c.clone().lerp(new THREE.Color('#ffffff'), 0.35);
  switch (finish) {
    case 'canvas':
      Object.assign(m, { roughness: 1.0, sheen: 0.9, sheenRoughness: 0.6, sheenColor });
      m.normalScale.set(0.9, 0.9);
      break;
    case 'denim':
      Object.assign(m, { roughness: 1.0, sheen: 0.6, sheenRoughness: 0.5, sheenColor });
      m.normalScale.set(0.9, 0.9);
      break;
    case 'nylon':
      Object.assign(m, { roughness: 0.55, sheen: 0.3, sheenRoughness: 0.3, sheenColor, clearcoat: 0.1 });
      m.normalScale.set(0.5, 0.5);
      break;
    case 'leather':
      Object.assign(m, { roughness: 0.75, clearcoat: 0.35, clearcoatRoughness: 0.45 });
      m.normalScale.set(0.7, 0.7);
      break;
    case 'suede':
      Object.assign(m, { roughness: 1.0, sheen: 1.0, sheenRoughness: 0.9, sheenColor });
      m.normalScale.set(0.4, 0.4);
      break;
  }
  return m;
}

const METAL: Record<string, [string, number]> = {
  gold: ['#d4a94f', 0.22],
  silver: ['#d6d8dc', 0.18],
  gunmetal: ['#55575c', 0.3],
  black: ['#1c1c1e', 0.45],
};

/** Polished hardware. Pure metalness: the path tracer handles this natively. */
export function metalMaterial(kind: string): THREE.MeshPhysicalMaterial {
  const [color, roughness] = METAL[kind] ?? METAL.gold;
  return new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness, side: THREE.DoubleSide });
}

/** Smooth plain-colour surfaces (zip tape, zip teeth, stripe webbing). */
export function plainMaterial(color: string, roughness: number, sheen = 0): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(color);
  return new THREE.MeshPhysicalMaterial({ color: c, roughness, sheen, sheenRoughness: 0.5, sheenColor: c.clone(), side: THREE.DoubleSide });
}

export function threadMaterial(color: string) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.6, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color(color) });
}
