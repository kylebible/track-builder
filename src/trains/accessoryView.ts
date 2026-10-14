import * as THREE from 'three';
import type { Vec2 } from '../geometry/pose';
import type { Layout, PlacedPiece } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { toWorld } from '../render/pieceMesh';
import { CRANE, crate, CRATE, LIFT_BRIDGE, LOADER, SIGNAL } from '../scenery/models';
import type { Accessory } from './accessories';
import type { TrainSim } from './sim';
import { WHEEL_RADIUS } from './stock';
import { AXLE_HEIGHT } from './trainMesh';

// What accessories look like as they work: signal lamps lit red or green,
// the lifting bridge's span going up and down with its warning lamps, the
// crane's arm swinging a crate off a wagon onto its pile, crates dropping
// from the loader, and crates riding in wagons. Moving parts of the models
// (the span, the crane's arm) belong to the editor's piece objects, found by
// name; everything else is drawn here. Also holds the tap targets that
// switch signals and lift the bridge.

/** Height of a crate's bottom in a wagon, above the track's bottom: on the wagon's floorboards. */
const WAGON_FLOOR = AXLE_HEIGHT + WHEEL_RADIUS + 5;

const litRed = new THREE.MeshStandardMaterial({ color: 0xff3b2b, emissive: 0xff2a1a, emissiveIntensity: 1.4 });
const litGreen = new THREE.MeshStandardMaterial({ color: 0x3dff6e, emissive: 0x1fe85a, emissiveIntensity: 1.2 });
const unlit = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.5 });
const lampGeometry = new THREE.SphereGeometry(SIGNAL.lampRadius + 0.4, 14, 10);
const warnGeometry = new THREE.SphereGeometry(3.6, 12, 8);
/** Invisible, but still caught by the raycaster. */
const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const knobMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.4, emissive: 0x6b4f00, emissiveIntensity: 0.25 });
const knobGeometry = new THREE.SphereGeometry(8, 20, 14);

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Progress through [a, b] of a job's 0 to 1. */
const phase = (p: number, a: number, b: number) => ease(clamp01((p - a) / (b - a)));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Place `object` in a piece's frame. */
function atPiece(object: THREE.Object3D, piece: PlacedPiece): void {
  object.position.copy(toWorld(piece.pose.x, piece.pose.y, piece.z ?? 0));
  object.rotation.set(0, piece.pose.angle, 0);
}

export class AccessoryView {
  readonly root = new THREE.Group();
  /** One group per accessory, in its piece's frame: lamps and tap targets. */
  private readonly fixtures = new Map<string, THREE.Group>();
  private readonly crates: THREE.Group[] = [];
  private readonly template = crate();

  constructor(
    private readonly sim: TrainSim,
    private readonly pieceObjects: THREE.Object3D,
  ) {
    this.template.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
  }

  /** The accessory a tap landed on, if any. */
  hit(raycaster: THREE.Raycaster): string | null {
    const found = raycaster.intersectObject(this.root, true).find((i) => i.object.userData.accessory);
    return found ? (found.object.userData.accessory as string) : null;
  }

  update(layout: Layout, time: number, controls: boolean): void {
    const pieces = new Map(layout.pieces.map((p) => [p.uid, p]));
    const objects = new Map<string, THREE.Object3D>();
    for (const o of this.pieceObjects.children) objects.set(o.userData.uid as string, o);
    let crates = 0;
    const crateAt = (position: THREE.Vector3, heading = 0, pitch = 0) => {
      let c = this.crates[crates];
      if (!c) {
        c = this.template.clone(true);
        this.crates.push(c);
        this.root.add(c);
      }
      crates++;
      c.visible = true;
      c.position.copy(position);
      c.rotation.set(0, heading, 0);
      c.rotateZ(pitch);
    };

    const seen = new Set<string>();
    for (const acc of this.sim.accessories) {
      const piece = pieces.get(acc.uid);
      if (!piece) continue;
      seen.add(acc.uid);
      const fixture = this.fixture(acc);
      atPiece(fixture, piece);
      const object = objects.get(acc.uid);
      if (acc.kind === 'signal') {
        const red = this.sim.redSignals.has(acc.uid);
        fixture.getObjectByName('red')!.userData.mesh.material = red ? litRed : unlit;
        fixture.getObjectByName('green')!.userData.mesh.material = red ? unlit : litGreen;
        fixture.getObjectByName('hit')!.visible = controls;
      } else if (acc.kind === 'bridge') {
        const lift = this.sim.bridges.get(acc.uid)?.lift ?? 0;
        const deck = object?.getObjectByName('lift-deck');
        if (deck) deck.position.y = ease(lift) * D.LIFT_HEIGHT;
        const open = this.sim.bridgeOpen(acc.uid);
        const flash = Math.floor(time / 400) % 2;
        fixture.children.forEach((c) => {
          if (c.userData.warn !== undefined && c instanceof THREE.Mesh) c.material = open && c.userData.warn === flash ? litRed : unlit;
        });
        fixture.getObjectByName('knob')!.visible = controls;
      } else if (acc.kind === 'crane') {
        this.drawCrane(acc, piece, object, crateAt);
      } else if (acc.kind === 'loader') {
        const job = this.sim.jobs.get(acc.uid);
        if (job) {
          // A crate drops out of the chute into the wagon.
          const p = clamp01((this.sim.time - job.start) / (job.end - job.start));
          const fall = clamp01((p - 0.3) / 0.35);
          const bottom = acc.trackBase + WAGON_FLOOR;
          const top = acc.base + LOADER.chuteHeight - CRATE.height;
          if (p > 0.2) crateAt(toWorld(acc.at.x, acc.at.y, lerp(top, bottom, fall * fall)), acc.angle);
        }
      }
    }
    for (const [uid, fixture] of this.fixtures) {
      if (!seen.has(uid)) {
        this.root.remove(fixture);
        this.fixtures.delete(uid);
      }
    }

    // Crates riding in wagons, unless a crane has just lifted one out.
    for (const train of this.sim.trains) {
      train.vehicles.forEach((v, i) => {
        if (!v.entry.load) return;
        const lifting = [...this.sim.jobs.entries()].some(([uid, job]) => {
          if (job.trainId !== train.id || job.vehicle !== i) return false;
          const p = (this.sim.time - job.start) / (job.end - job.start);
          return this.sim.accessories.find((a) => a.uid === uid)?.kind === 'crane' && p > 0.25;
        });
        if (lifting) return;
        const lift = new THREE.Vector3(0, WAGON_FLOOR, 0).applyEuler(new THREE.Euler(0, 0, v.geo.pitch));
        crateAt(toWorld(v.geo.center.x + lift.x * Math.cos(v.geo.heading), v.geo.center.y + lift.x * Math.sin(v.geo.heading), v.geo.z + lift.y), v.geo.heading, v.geo.pitch);
      });
    }
    for (let i = crates; i < this.crates.length; i++) this.crates[i].visible = false;
  }

  /** The lamps and tap targets that go with an accessory, made once. */
  private fixture(acc: Accessory): THREE.Group {
    let g = this.fixtures.get(acc.uid);
    if (g && g.userData.kind === acc.kind) return g;
    if (g) this.root.remove(g);
    g = new THREE.Group();
    g.userData.kind = acc.kind;
    const tag = (o: THREE.Object3D) => {
      o.traverse((c) => (c.userData.accessory = acc.uid));
      return o;
    };
    if (acc.kind === 'signal') {
      for (const name of ['red', 'green'] as const) {
        const lamp = new THREE.Mesh(lampGeometry, unlit);
        const holder = new THREE.Group();
        holder.name = name;
        holder.userData.mesh = lamp;
        holder.position.set(...SIGNAL[name]);
        holder.add(lamp);
        g.add(tag(holder));
      }
      const hit = new THREE.Mesh(new THREE.BoxGeometry(30, 60, 34), hitMaterial);
      hit.name = 'hit';
      hit.position.set(0, (SIGNAL.red[1] + SIGNAL.green[1]) / 2, 0);
      g.add(tag(hit));
    } else if (acc.kind === 'bridge') {
      LIFT_BRIDGE.lamps.forEach((at, i) => {
        const lamp = new THREE.Mesh(warnGeometry, unlit);
        lamp.position.set(...at);
        lamp.userData.warn = i % 2;
        g!.add(lamp);
      });
      const knob = new THREE.Group();
      knob.name = 'knob';
      const [x, y, z] = LIFT_BRIDGE.control;
      const ball = new THREE.Mesh(knobGeometry, knobMaterial);
      ball.position.set(x, y + 4, z);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 14, 10), new THREE.MeshStandardMaterial({ color: 0x5a4026 }));
      stem.position.set(x, y - 6, z);
      knob.add(ball, stem);
      g.add(tag(knob));
    }
    this.fixtures.set(acc.uid, g);
    this.root.add(g);
    return g;
  }

  /**
   * Turn the crane's arm toward its track and run its job: lower the magnet
   * onto the crate, lift it, swing round to the pile, set it down, swing back.
   */
  private drawCrane(acc: Accessory, piece: PlacedPiece, object: THREE.Object3D | undefined, crateAt: (p: THREE.Vector3) => void): void {
    const local = (p: Vec2) => {
      const dx = p.x - piece.pose.x;
      const dy = p.y - piece.pose.y;
      const c = Math.cos(-piece.pose.angle);
      const s = Math.sin(-piece.pose.angle);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    };
    const track = local(acc.at);
    const trackAngle = Math.atan2(track.y, track.x);
    const trackReach = Math.hypot(track.x, track.y);
    const pileAngle = trackAngle + Math.PI;
    const pile = this.sim.piles.get(acc.uid) ?? 0;
    // Heights in the crane's own frame, from its base up.
    const pivot = CRANE.pivotHeight + 18;
    const wagonTop = acc.trackBase - acc.base + WAGON_FLOOR + CRATE.height;
    const job = this.sim.jobs.get(acc.uid);
    const p = job ? clamp01((this.sim.time - job.start) / (job.end - job.start)) : 0;
    const swing = phase(p, 0.45, 0.72) - phase(p, 0.9, 1);
    const angle = trackAngle + swing * (pileAngle - trackAngle);
    const reach = lerp(trackReach, CRANE.pileReach, swing);
    const rest = pivot - CRANE.restDrop;
    const pileTop = pileHeight(pile);
    // Magnet bottom height through the job.
    let magnet = rest;
    if (job) {
      magnet = lerp(rest, wagonTop, phase(p, 0, 0.22));
      magnet = lerp(magnet, rest, phase(p, 0.25, 0.42));
      magnet = lerp(magnet, pileTop + CRATE.height, phase(p, 0.72, 0.86));
      magnet = lerp(magnet, rest, phase(p, 0.88, 1));
    }
    const arm = object?.getObjectByName('crane-arm');
    if (arm) {
      arm.rotation.y = angle;
      const hook = arm.getObjectByName('crane-hook')!;
      hook.position.x = reach;
      const drop = pivot - magnet - CRANE.magnetHeight;
      arm.getObjectByName('crane-rope')!.scale.y = Math.max(1, drop);
      arm.getObjectByName('crane-magnet')!.position.y = -drop;
    }
    const world = (r: number, a: number, h: number) => {
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      const c = Math.cos(piece.pose.angle);
      const s = Math.sin(piece.pose.angle);
      return toWorld(piece.pose.x + x * c - y * s, piece.pose.y + x * s + y * c, acc.base + h);
    };
    // The crate on the magnet, between picking it up and setting it down.
    if (job && p > 0.25 && p < 0.88) crateAt(world(reach, angle, magnet - CRATE.height));
    // The pile: rows of crates beside the crane, two layers at most shown.
    const shown = Math.min(pile + (job && p >= 0.88 ? 1 : 0), 8);
    for (let i = 0; i < shown; i++) {
      const layer = Math.floor(i / 4);
      const k = i % 4;
      const along = ((k % 2) - 0.5) * (CRATE.size + 2);
      const out = (Math.floor(k / 2) - 0.5) * (CRATE.size + 2);
      const a = pileAngle + along / CRANE.pileReach;
      crateAt(world(CRANE.pileReach + out, a, layer * CRATE.height));
    }
  }
}

/** Top of the pile a crane is stacking onto, from its base. */
function pileHeight(count: number): number {
  return Math.floor(Math.min(count, 7) / 4) * CRATE.height;
}
