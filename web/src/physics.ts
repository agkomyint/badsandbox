// Rigid-body physics for the bag (Rapier): gravity, floor contact, and picking the
// bag up with the mouse. The bag is one convex body, with its collision hull taken
// from the panels. Grabbing attaches a kinematic "hand" with a ball joint, so a bag
// lifted by a handle hangs and swings from that point.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const HULL_PARTS = /^(front|back|gusset|base|rim|zip_panel)/;
const MAX_HULL_PTS = 1500;

export class Physics {
  private world: RAPIER.World;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider | null = null;
  private hand: RAPIER.RigidBody | null = null;
  private joint: RAPIER.ImpulseJoint | null = null;
  private acc = 0;

  private constructor(private rig: THREE.Object3D) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    // Floor: the studio sweep is flat at y = 0 out to well past the bag.
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.05, 5).setTranslation(0, -0.05, 0).setFriction(0.9));
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setLinearDamping(0.4).setAngularDamping(1.2).setCanSleep(true),
    );
  }

  static async create(rig: THREE.Object3D) {
    await RAPIER.init();
    return new Physics(rig);
  }

  /** Rebuild the collision hull from the bag's panel meshes (points in rig space). */
  setShape(bag: THREE.Object3D) {
    const pts: number[] = [];
    const v = new THREE.Vector3();
    bag.updateMatrix();
    bag.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !HULL_PARTS.test(m.name)) return;
      const pos = m.geometry.getAttribute('position');
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(bag.matrix);
        pts.push(v.x, v.y, v.z);
      }
    });
    if (pts.length / 3 > MAX_HULL_PTS) pts.length = MAX_HULL_PTS * 3;
    const desc = pts.length >= 12 ? RAPIER.ColliderDesc.convexHull(new Float32Array(pts)) : null;
    if (!desc) return;
    if (this.collider) this.world.removeCollider(this.collider, false);
    // A real tote weighs ~0.5-1 kg; density is tuned to land in that range.
    this.collider = this.world.createCollider(desc.setDensity(60).setFriction(0.8).setRestitution(0.05), this.body);
    this.body.wakeUp();
  }

  /** Put the bag upright, `lift` metres above the floor, at rest. */
  reset(lift = 0) {
    this.release();
    this.body.setTranslation({ x: 0, y: lift, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.sync();
  }

  /** Grab the bag at a world-space point. */
  grab(p: THREE.Vector3) {
    this.release();
    const t = this.body.translation(), r = this.body.rotation();
    const local = p.clone().sub(new THREE.Vector3(t.x, t.y, t.z))
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
    this.hand = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
    this.joint = this.world.createImpulseJoint(
      RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: local.x, y: local.y, z: local.z }),
      this.hand, this.body, true,
    );
    this.body.wakeUp();
  }

  /** Move the hand. Kept above the floor so the bag can't be pushed through it. */
  drag(p: THREE.Vector3) {
    this.hand?.setNextKinematicTranslation({ x: p.x, y: Math.max(p.y, 0.01), z: p.z });
    this.body.wakeUp();
  }

  release() {
    if (this.joint) this.world.removeImpulseJoint(this.joint, true);
    if (this.hand) this.world.removeRigidBody(this.hand);
    this.joint = null;
    this.hand = null;
  }

  get holding() {
    return !!this.hand;
  }

  /** Advance with a fixed 120 Hz step. Returns true while anything is still moving. */
  step(dt: number): boolean {
    if (this.body.isSleeping() && !this.hand) return false;
    this.acc = Math.min(this.acc + dt, 0.1);
    const h = 1 / 120;
    this.world.timestep = h;
    while (this.acc >= h) {
      this.world.step();
      this.acc -= h;
    }
    this.sync();
    return !this.body.isSleeping() || !!this.hand;
  }

  private sync() {
    const t = this.body.translation(), r = this.body.rotation();
    this.rig.position.set(t.x, t.y, t.z);
    this.rig.quaternion.set(r.x, r.y, r.z, r.w);
  }

  dispose() {
    this.world.free();
  }
}
