import * as THREE from 'three';
import type { Vec2 } from '../geometry/pose';
import { toWorld } from '../render/pieceMesh';
import type { Crossing, Route } from '../trains/route';
import type { Train, TrainSim } from '../trains/sim';
import type { Place, Synth } from './synth';

// Listens to the train simulation and makes its sounds: a clack each time an
// axle rolls over a joint, a whistle when an engine sets off or nears a level
// crossing, and the crossing's bells while a train is close to it.

/** A train this close to a level crossing, mm, sets its bells ringing. */
export const BELL_REACH_MM = 260;
/** Bells keep ringing this long after the train has gone, seconds. */
const BELL_TAIL_S = 1.2;
/** Time between bell strikes, seconds. */
const BELL_GAP_S = 0.32;
/** At most one whistle per train this often, seconds. */
const WHISTLE_GAP_S = 2.5;
/** Clacks heard in one frame; a long fast train past this just sounds busy anyway. */
const MAX_CLACKS_PER_FRAME = 6;
/** An axle that moved further than this in a frame was lifted or turned, not rolled. */
const MAX_ROLL_MM = 80;
/** Top speed of the battery engines, mm/s, to scale how hard a clack lands. */
const FULL_SPEED = 180;

const LEVEL_CROSSING = 'level-crossing';

/** The joints an axle passed going from `from` to `to` along a route. */
export function jointsPassed(from: number, to: number, crossings: readonly Crossing[]): Crossing[] {
  if (from === to) return [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  // Half-open so a joint sitting exactly on an axle counts once, whichever way it rolls.
  return crossings.filter((c) => (to > from ? c.u > lo && c.u <= hi : c.u >= lo && c.u < hi));
}

/** How hard a wheel lands over a joint, 0..1: faster and rougher joints are louder. */
export function clackStrength(speed: number, fit: Crossing['fit']): number {
  const pace = Math.min(1, Math.abs(speed) / FULL_SPEED);
  const rough = Math.min(0.4, fit.lateralMm * 0.12 + fit.angleDeg * 0.05 + (fit.unjoined ? fit.gapMm * 0.12 : 0));
  return Math.min(1, 0.2 + 0.55 * pace + rough);
}

/** The stretches of a route that are level crossings, as [start, end] along it. */
export function levelCrossingSpans(route: Route): { key: string; from: number; to: number }[] {
  return route.segments.filter((seg) => seg.edge.pieceId === LEVEL_CROSSING).map((seg) => ({ key: seg.edge.uid, from: seg.u0, to: seg.u0 + seg.edge.length }));
}

/** Level crossings a train is within `reach` mm of, by piece. */
export function crossingsNear(train: Train, reach = BELL_REACH_MM): { key: string; mid: number }[] {
  const lo = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
  const hi = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
  return levelCrossingSpans(train.route)
    .filter((span) => span.from - reach < hi && span.to + reach > lo)
    .map((span) => ({ key: span.key, mid: (span.from + span.to) / 2 }));
}

const moving = (t: Train) => !t.wrecked && t.status.kind === 'running';

export class TrainSounds {
  /** Each vehicle's axles last frame, along its train's route. */
  private readonly axles = new Map<string, { route: Route; us: number[] }>();
  private readonly throttles = new Map<number, number>();
  private readonly lastWhistle = new Map<number, number>();
  /** Level crossings each train was near last frame. */
  private readonly near = new Map<number, Set<string>>();
  private ringUntil = 0;
  private nextDing = 0;
  private bellAt: Vec2 & { z: number } = { x: 0, y: 0, z: 0 };
  private strikes = 0;

  constructor(
    readonly synth: Synth,
    private readonly camera: THREE.Camera,
  ) {}

  /** Where a spot on the layout sits in the view, and how far off it is. */
  private place(at: Vec2, z = 0): Place {
    const world = toWorld(at.x, at.y, z);
    const distance = world.distanceTo(this.camera.position);
    const p = world.clone().project(this.camera);
    const behind = p.z > 1;
    return { pan: behind ? 0 : p.x, near: Math.max(0.2, Math.min(1, 1400 / distance)) * (behind ? 0.4 : 1) };
  }

  /** Blow a train's whistle, unless it has just been blown. */
  whistle(train: Train, now = performance.now() / 1000, force = false): void {
    const last = this.lastWhistle.get(train.id) ?? -Infinity;
    if (!force && now - last < WHISTLE_GAP_S) return;
    this.lastWhistle.set(train.id, now);
    const head = train.vehicles[0].geo;
    this.synth.whistle(this.place(head.center, head.z));
  }

  /** Call once a frame, after the simulation has moved on. */
  update(sim: TrainSim, running: boolean, now = performance.now() / 1000): void {
    const seen = new Set<string>();
    const ids = new Set<number>();
    const clacks: { strength: number; place: Place }[] = [];

    for (const train of sim.trains) {
      ids.add(train.id);
      const hasEngine = train.vehicles.some((v) => v.def.motor);

      // Pressing ▶ or ◀ from a standstill: a toot to set off.
      const before = this.throttles.get(train.id);
      this.throttles.set(train.id, train.throttle);
      if (before === 0 && train.throttle !== 0 && hasEngine && !train.wrecked) this.whistle(train, now);

      // Wheels over joints.
      train.vehicles.forEach((v, i) => {
        const key = `${train.id}:${i}:${v.def.id}`;
        seen.add(key);
        const half = v.def.wheelbase / 2;
        const us = [v.u + half, v.u - half];
        const was = this.axles.get(key);
        this.axles.set(key, { route: train.route, us });
        if (!was || was.route !== train.route || train.wrecked || v.derailed) return;
        us.forEach((u, a) => {
          const from = was.us[a];
          if (Math.abs(u - from) > MAX_ROLL_MM) return;
          for (const c of jointsPassed(from, u, train.route.crossings)) clacks.push({ strength: clackStrength(v.v, c.fit), place: this.place(c.at, v.geo.z) });
        });
      });

      // Level crossings: whistle on the way in, ring the bells while close.
      if (moving(train) && running) sim.lookAround(train, BELL_REACH_MM);
      const close = moving(train) && running ? crossingsNear(train) : [];
      const wasClose = this.near.get(train.id) ?? new Set<string>();
      const nowClose = new Set(close.map((c) => c.key));
      this.near.set(train.id, nowClose);
      for (const c of close) {
        const pose = train.route.poseAt(c.mid);
        this.bellAt = { x: pose.x, y: pose.y, z: train.route.heightAt(c.mid) };
        this.ringUntil = now + BELL_TAIL_S;
        if (!wasClose.has(c.key) && hasEngine) this.whistle(train, now);
      }
    }

    for (const key of this.axles.keys()) if (!seen.has(key)) this.axles.delete(key);
    for (const map of [this.throttles, this.lastWhistle, this.near]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);

    if (running) {
      // The loudest clacks if there are more than can be heard at once.
      clacks.sort((a, b) => b.strength - a.strength);
      for (const c of clacks.slice(0, MAX_CLACKS_PER_FRAME)) this.synth.clack(c.strength, c.place);
    }

    if (!running) this.ringUntil = 0;
    if (now < this.ringUntil) {
      if (now >= this.nextDing) {
        // Two bells struck in turn, one a little to each side.
        const place = this.place(this.bellAt, this.bellAt.z);
        this.synth.ding({ ...place, pan: place.pan + (this.strikes++ % 2 ? 0.15 : -0.15) });
        this.nextDing = now + BELL_GAP_S;
      }
    } else {
      this.nextDing = 0;
    }
  }
}
