import { distance, type Vec2 } from '../geometry/pose';
import { poseAt } from '../geometry/path';
import { baseOf, defOf, type Layout } from '../layout/layout';
import { CRANE } from '../scenery/models';
import type { Edge } from './network';
import type { Route } from './route';

// Accessories that work with running trains. Each one acts on a spot of
// track, found from where it stands: a signal on the track beside it, a
// station or cargo loader on the track it sits over, a crane on the track
// its hook reaches, a lifting bridge on its own span. Trains with their
// engines on brake for them: at a red signal or a raised bridge until it
// clears, at a station for a few seconds, under the loader until an empty
// open wagon is filled, and at the crane while it lifts a crate off. Each
// line across a turntable is one too: trains wait short of it until the
// bridge lines up with them (see turntable.ts).

export type AccessoryKind = 'signal' | 'station' | 'bridge' | 'loader' | 'crane' | 'turntable';

export interface Accessory {
  uid: string;
  kind: AccessoryKind;
  /** The track it acts on, and where along it: a point, or a span for a bridge. */
  edgeKey: string;
  from: number;
  to: number;
  /** The spot on the track, in plan. */
  at: Vec2;
  /** The piece itself: where it stands and which way it faces. */
  origin: Vec2;
  angle: number;
  /** Height of the piece's bottom, and of the track it acts on. */
  base: number;
  trackBase: number;
  /** Which line across a turntable. */
  line?: number;
}

/** Tunable estimates. Times in seconds of simulated time. */
export const ACCESSORY = {
  /** How hard a train brakes for a stop, mm/s². */
  brakeMmS2: 1200,
  /** Where a train's front stops short of a red signal, or of a raised span. */
  signalGapMm: 14,
  bridgeGapMm: 12,
  stationSeconds: 3,
  loaderSeconds: 2.4,
  craneSeconds: 4.5,
  /** Time for the bridge's span to go all the way up or down. */
  bridgeSeconds: 2.5,
  /** A signal works the track this close to it. */
  signalReachMm: 90,
  /** A station or loader works the track it sits over, this close. */
  seatReachMm: 30,
};

export type Nearest = (point: Vec2, reach: number, height?: number) => { edge: Edge; s: number } | null;

/** Every accessory in the layout that has track to work on. */
export function findAccessories(layout: Layout, edgeOf: (key: string) => Edge | undefined, nearest: Nearest): Accessory[] {
  const out: Accessory[] = [];
  for (const piece of layout.pieces) {
    const def = defOf(piece);
    const base = baseOf(piece);
    const origin = { x: piece.pose.x, y: piece.pose.y };
    const make = (kind: AccessoryKind, edge: Edge, from: number, to = from): Accessory => {
      const at = poseAt(edge.path, (from + to) / 2);
      return { uid: piece.uid, kind, edgeKey: edge.key, from, to, at: { x: at.x, y: at.y }, origin, angle: piece.pose.angle, base, trackBase: edge.base };
    };
    if (def.structure === 'turntable') {
      def.paths.forEach((_, i) => {
        const edge = edgeOf(`${piece.uid}:${i}`);
        if (edge) out.push({ ...make('turntable', edge, 0, edge.length), line: i });
      });
      continue;
    }
    if (def.liftSpan) {
      // Its own first path. Edges are keyed `uid:index`.
      const edge = edgeOf(`${piece.uid}:0`);
      if (edge) out.push(make('bridge', edge, def.liftSpan[0], def.liftSpan[1]));
      continue;
    }
    const kind = ({ signal: 'signal', station: 'station', 'cargo-loader': 'loader', crane: 'crane' } as const)[def.model ?? ''];
    if (!kind) continue;
    const reach = kind === 'signal' ? ACCESSORY.signalReachMm : kind === 'crane' ? CRANE.maxReach : ACCESSORY.seatReachMm;
    const track = nearest(origin, reach, base);
    if (!track) continue;
    if (kind === 'crane' && distance(poseAt(track.edge.path, track.s), origin) < CRANE.minReach) continue;
    out.push(make(kind, track.edge, track.s));
  }
  return out;
}

/**
 * Where an accessory's spot falls along a route, every time the route
 * passes it (a short loop can pass twice): from and to, in route order.
 */
export function onRoute(route: Route, acc: Accessory): [number, number][] {
  const out: [number, number][] = [];
  for (const seg of route.segments) {
    if (seg.edge.key !== acc.edgeKey) continue;
    const at = (s: number) => seg.u0 + (seg.reversed ? seg.edge.length - s : s);
    const a = at(acc.from);
    const b = at(acc.to);
    out.push([Math.min(a, b), Math.max(a, b)]);
  }
  return out;
}

/** A loader dropping a crate into a wagon, or a crane lifting one off: which train, which vehicle, and when. */
export interface Job {
  trainId: number;
  vehicle: number;
  start: number;
  end: number;
}
