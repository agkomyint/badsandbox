// Things you can drop into the bag while the fabric simulation runs: a phone, a
// wallet, a bottle... Each one is a Rapier rigid body (bag-local space, centimetres
// and grams). Items and cloth push on each other both ways: the cloth particles are
// projected out of each item's shape, and the item receives the equal and opposite
// impulse, so a full bag bulges and items get carried when you lift it.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

type Kind = 'box' | 'capsule';
type Spec = {
  label: string;
  kind: Kind;
  size: [number, number, number]; // box: half extents. capsule: [radius, half height, 0]
  mass: number; // g
  color: string;
  roughness: number;
  metalness?: number;
};

export const ITEMS: Record<string, Spec> = {
  phone: { label: 'Phone', kind: 'box', size: [3.7, 7.6, 0.42], mass: 200, color: '#1c1d21', roughness: 0.18, metalness: 0.3 },
  wallet: { label: 'Wallet', kind: 'box', size: [5.5, 4.4, 1.0], mass: 150, color: '#6b3d22', roughness: 0.55 },
  bottle: { label: 'Bottle', kind: 'capsule', size: [3.3, 7.5, 0], mass: 500, color: '#3f7f86', roughness: 0.3, metalness: 0.6 },
  book: { label: 'Notebook', kind: 'box', size: [7.4, 10.5, 0.8], mass: 350, color: '#c9b48a', roughness: 0.8 },
  case: { label: 'Glasses case', kind: 'capsule', size: [2.4, 5.2, 0], mass: 90, color: '#2b3a55', roughness: 0.5 },
  apple: { label: 'Apple', kind: 'capsule', size: [4.0, 0, 0], mass: 180, color: '#b8322a', roughness: 0.35 },
};

type Item = {
  spec: Spec;
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  pos: THREE.Vector3; // cached pose for cloth collision
  rot: Float32Array; // 3x3 column-major
  reach: number; // bounding radius
  imp: THREE.Vector3; // Σ push-out (direction × depth) from cloth contacts this frame
  hits: number; // contact count behind `imp`
};

const PARTICLE_R = 0.8; // cm: cloth thickness for item contact
const PARTICLE_M = 3; // g: cloth mass per particle for the coupling
/**
 * How much of a contact the cloth gives way (the item takes the rest). The fabric is
 * corrected every substep but the item only once per frame, so even a fair mass ratio
 * lets an item ratchet a wall outward, shoving the whole shape-matched bag until it
 * tips. So the item does nearly all the separating; the fabric just bulges a little.
 */
const clothShare = (mi: number) => Math.min(0.1, mi / 4000);

export class Items {
  readonly group = new THREE.Group();
  private world: RAPIER.World;
  private ground: RAPIER.Collider;
  private items: Item[] = [];
  private held: Item | null = null;
  private target = new THREE.Vector3();

  private constructor(private floor: number) {
    this.world = new RAPIER.World({ x: 0, y: -981, z: 0 });
    const ip = this.world.integrationParameters as any;
    if ('lengthUnit' in ip) ip.lengthUnit = 100; // centimetres
    // Ground sits on top of the cloth lying on the floor.
    this.ground = this.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 5, 500).setFriction(0.8));
    this.setFloor(floor);
    this.group.name = 'items';
  }

  /** Floor height in bag-local cm (changes when the bag is rebuilt). */
  setFloor(floor: number) {
    this.floor = floor;
    this.ground.setTranslation({ x: 0, y: floor + 0.12 + PARTICLE_R - 5, z: 0 });
  }

  static async create(floor: number) {
    await RAPIER.init();
    return new Items(floor);
  }

  get count() {
    return this.items.length;
  }

  /**
   * Drop a new item from `at` (bag-local cm). `q` sets its orientation (items are
   * modelled long side along y, thin side along z); default is a random tumble.
   */
  add(key: string, at: THREE.Vector3, q?: THREE.Quaternion) {
    const spec = ITEMS[key];
    if (!spec) return;
    q ??= new THREE.Quaternion().setFromEuler(
      new THREE.Euler((Math.random() - 0.5) * 0.8, Math.random() * Math.PI, (Math.random() - 0.5) * 0.8),
    );
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation(q)
        .setLinearDamping(0.3)
        .setAngularDamping(0.8)
        .setCcdEnabled(true),
    );
    const [a, b, c] = spec.size;
    const desc = spec.kind === 'box'
      ? RAPIER.ColliderDesc.roundCuboid(a - 0.15, b - 0.15, c - 0.15, 0.15)
      : b > 0 ? RAPIER.ColliderDesc.capsule(b, a) : RAPIER.ColliderDesc.ball(a);
    this.world.createCollider(desc.setMass(spec.mass).setFriction(0.6).setRestitution(0.1), body);

    const geo = spec.kind === 'box'
      ? roundedBox(a, b, c, Math.min(0.6, c * 0.6))
      : b > 0 ? new THREE.CapsuleGeometry(a, b * 2, 8, 24) : new THREE.SphereGeometry(a, 32, 20);
    const mat = new THREE.MeshPhysicalMaterial({
      color: spec.color, roughness: spec.roughness, metalness: spec.metalness ?? 0, clearcoat: spec.roughness < 0.3 ? 0.6 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `item_${key}`;
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
    const reach = spec.kind === 'box' ? Math.hypot(a, b, c) : a + b;
    const item: Item = {
      spec, body, mesh, pos: new THREE.Vector3(), rot: new Float32Array(9), reach,
      imp: new THREE.Vector3(), hits: 0,
    };
    mesh.userData.item = item;
    this.items.push(item);
    this.sync();
  }

  clear() {
    this.release();
    for (const it of this.items) {
      this.world.removeRigidBody(it.body);
      this.group.remove(it.mesh);
      it.mesh.geometry.dispose();
      (it.mesh.material as THREE.Material).dispose();
    }
    this.items = [];
  }

  dispose() {
    this.clear();
    this.world.free();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────
  /** Grab the item this mesh belongs to (if any). */
  grab(mesh: THREE.Object3D, local: THREE.Vector3) {
    const it = mesh.userData.item as Item | undefined;
    if (!it) return false;
    this.held = it;
    this.target.copy(local);
    it.body.setGravityScale(0, true);
    return true;
  }
  drag(local: THREE.Vector3) {
    this.target.copy(local);
    this.target.y = Math.max(this.target.y, this.floor + 2);
  }
  release() {
    this.held?.body.setGravityScale(1, true);
    this.held = null;
  }
  /** Highest point (bag-local cm) of any item overlapping x ∈ [x - hw, x + hw], or -Infinity. */
  topNear(x: number, hw: number) {
    let top = -Infinity;
    const box = new THREE.Box3();
    for (const it of this.items) {
      const g = it.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      it.mesh.updateMatrix();
      box.copy(g.boundingBox!).applyMatrix4(it.mesh.matrix); // item box in bag-local cm
      if (box.max.x > x - hw && box.min.x < x + hw) top = Math.max(top, box.max.y);
    }
    return top;
  }
  get holding() {
    return !!this.held;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  /** Apply the cloth's pushes, advance the rigid bodies. Returns true while anything moves. */
  step(frameDt: number): boolean {
    // Same dt as the cloth frame that just banked the impulses: stepping on a separate
    // fixed clock let some frames apply a push without moving the item, so the next
    // frame found the same deep contact and pushed again — items rattled and bags tipped.
    const dt = Math.min(frameDt, 1 / 30);
    // Cloth → item, at the velocity level. The shape-matched bag is close to rigid, so
    // turning penetration into impulses shoved items around at several g (they rattled
    // and could knock the bag over). Instead: along the average push-out direction,
    // cancel any approach speed and add a gentle separation speed. That can stop a
    // fall and hold an item up, but never fling or spin it.
    for (const it of this.items) {
      if (it.hits > 0 && it.imp.lengthSq() > 1e-12) {
        const depth = it.imp.length() / it.hits; // mean penetration, cm
        const n = it.imp.normalize();
        const v = it.body.linvel();
        const vn = v.x * n.x + v.y * n.y + v.z * n.z;
        const add = Math.max(0, -vn) + Math.min(depth * 15, 20);
        it.body.setLinvel({ x: v.x + n.x * add, y: v.y + n.y * add, z: v.z + n.z * add }, true);
        // …and take the item's share of the overlap out directly, a little per frame.
        const out = Math.min(depth * (1 - clothShare(it.spec.mass)), 1);
        const p = it.body.translation();
        it.body.setTranslation({ x: p.x + n.x * out, y: p.y + n.y * out, z: p.z + n.z * out }, true);
        // Rubbing against fabric: bleed off spin and some sliding.
        const w = it.body.angvel(), f = Math.max(0.85, 1 - it.hits * 0.004);
        it.body.setAngvel({ x: w.x * f, y: w.y * f, z: w.z * f }, true);
      }
      it.imp.set(0, 0, 0);
      it.hits = 0;
    }
    if (this.held) {
      const b = this.held.body, p = b.translation();
      const k = 12;
      b.setLinvel({ x: (this.target.x - p.x) * k, y: (this.target.y - p.y) * k, z: (this.target.z - p.z) * k }, true);
      const w = b.angvel();
      b.setAngvel({ x: w.x * 0.9, y: w.y * 0.9, z: w.z * 0.9 }, true);
    }
    // No tunnelling: the fabric is only ~2 particle radii thick and it collides once per
    // frame with the item, so never let an item travel further than that in one frame.
    const vmax = (PARTICLE_R * 1.5) / dt;
    for (const it of this.items) {
      if (it === this.held) continue;
      const v = it.body.linvel(), s = Math.hypot(v.x, v.y, v.z);
      if (s > vmax) it.body.setLinvel({ x: (v.x * vmax) / s, y: (v.y * vmax) / s, z: (v.z * vmax) / s }, true);
    }
    const sub = dt > 1 / 70 ? 2 : 1;
    this.world.timestep = dt / sub;
    for (let s = 0; s < sub; s++) this.world.step();
    this.sync();
    return this.items.some((it) => !it.body.isSleeping()) || !!this.held;
  }

  private sync() {
    const m3 = new THREE.Matrix3(), m4 = new THREE.Matrix4();
    for (const it of this.items) {
      const t = it.body.translation(), r = it.body.rotation();
      it.mesh.position.set(t.x, t.y, t.z);
      it.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      it.pos.set(t.x, t.y, t.z);
      m3.setFromMatrix4(m4.makeRotationFromQuaternion(it.mesh.quaternion));
      it.rot.set(m3.elements);
    }
  }

  /**
   * Push cloth particles (bag-local cm) out of every item, and bank the reaction on
   * the item. Called once per cloth substep.
   */
  collide(x: Float32Array, w: Float32Array, n: number, dt: number) {
    if (!this.items.length) return;
    const R = PARTICLE_R;
    for (const it of this.items) {
      const { pos, rot: e, spec } = it;
      const reach2 = (it.reach + R) ** 2;
      const [a, b, c] = spec.size;
      const share = clothShare(spec.mass);
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const i3 = i * 3;
        const dx = x[i3] - pos.x, dy = x[i3 + 1] - pos.y, dz = x[i3 + 2] - pos.z;
        if (dx * dx + dy * dy + dz * dz > reach2) continue;
        // Into the item's frame (Rᵀ d).
        const px = e[0] * dx + e[1] * dy + e[2] * dz;
        const py = e[3] * dx + e[4] * dy + e[5] * dz;
        const pz = e[6] * dx + e[7] * dy + e[8] * dz;
        let nx = 0, ny = 0, nz = 0, pen = 0;
        if (spec.kind === 'box') {
          const qx = Math.abs(px) - a, qy = Math.abs(py) - b, qz = Math.abs(pz) - c;
          if (qx > 0 || qy > 0 || qz > 0) {
            const cx = Math.max(qx, 0) * Math.sign(px), cy = Math.max(qy, 0) * Math.sign(py), cz = Math.max(qz, 0) * Math.sign(pz);
            const d = Math.hypot(cx, cy, cz);
            if (d >= R || d < 1e-9) continue;
            nx = cx / d; ny = cy / d; nz = cz / d; pen = R - d;
          } else if (qx >= qy && qx >= qz) { nx = Math.sign(px) || 1; pen = R - qx; }
          else if (qy >= qz) { ny = Math.sign(py) || 1; pen = R - qy; }
          else { nz = Math.sign(pz) || 1; pen = R - qz; }
        } else {
          const sy = Math.max(-b, Math.min(b, py));
          const ox = px, oy = py - sy, oz = pz;
          const d = Math.hypot(ox, oy, oz);
          if (d >= a + R) continue;
          if (d < 1e-9) { ny = 1; pen = a + R; } else { nx = ox / d; ny = oy / d; nz = oz / d; pen = a + R - d; }
        }
        // Back to bag space (R n).
        const wx = e[0] * nx + e[3] * ny + e[6] * nz;
        const wy = e[1] * nx + e[4] * ny + e[7] * nz;
        const wz = e[2] * nx + e[5] * ny + e[8] * nz;
        const mv = pen * share;
        x[i3] += wx * mv; x[i3 + 1] += wy * mv; x[i3 + 2] += wz * mv;
        // The item feels the opposite push (resolved in step()).
        it.imp.x -= wx * pen; it.imp.y -= wy * pen; it.imp.z -= wz * pen;
        it.hits++;
      }
    }
  }
}

/** A box with rounded edges (looks like a real object, not a CAD primitive). */
function roundedBox(hx0: number, hy0: number, hz: number, r: number) {
  const bevS = Math.min(r, hz * 0.9) * 0.6; // the bevel grows the outline by this much
  const hx = hx0 - bevS, hy = hy0 - bevS;
  r = Math.min(r, hx, hy);
  const s = new THREE.Shape();
  const w = hx - r, h = hy - r;
  s.moveTo(-w, -hy);
  s.lineTo(w, -hy);
  s.quadraticCurveTo(hx, -hy, hx, -h);
  s.lineTo(hx, h);
  s.quadraticCurveTo(hx, hy, w, hy);
  s.lineTo(-w, hy);
  s.quadraticCurveTo(-hx, hy, -hx, h);
  s.lineTo(-hx, -h);
  s.quadraticCurveTo(-hx, -hy, -w, -hy);
  const bev = Math.min(r, hz * 0.9);
  const g = new THREE.ExtrudeGeometry(s, { depth: 2 * hz - 2 * bev, bevelEnabled: true, bevelSize: bev * 0.6, bevelThickness: bev, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(hz - bev));
  return g;
}
