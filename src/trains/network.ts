import { heightGap } from '../geometry/joint';
import { gradeAt, heightAt, pathEnd, pathLength } from '../geometry/path';
import { applyPose, distance, normalizeAngle, rotate, type Pose, type Vec2 } from '../geometry/pose';
import { baseOf, defOf, findJoints, nearbyPairs, openEnds, type Layout, type PlacedPiece } from '../layout/layout';
import type { TrackPath } from '../pieces/types';

// The layout as something wheels can run along: every running path of every
// piece is an edge, and the ends of edges link up through the joints. A
// facing switch offers several ways on, picked by its lever. Every end of a
// piece where more than one path meets is a switch point with its own lever:
// one on an ordinary switch, three on a T switch, four on a star.

/** How well the rails line up where one piece meets the next. */
export interface JointFit {
  /** Distance between the two ends, mm. */
  gapMm: number;
  /** How far the grooves are offset sideways, mm. */
  lateralMm: number;
  /** Kink between the two pieces, degrees. */
  angleDeg: number;
  /** Not clipped together, just close: a gap the wheels have to bridge. */
  unjoined: boolean;
}

export type EdgeEnd =
  | { kind: 'connector'; connectorId: string }
  /** Meets another path of the same piece, like the middle of an S-bend. */
  | { kind: 'internal' }
  /** Runs out inside the piece: a buffer stop. */
  | { kind: 'dead' };

export interface Edge {
  /** `uid:index`, stable while the piece doesn't move. */
  key: string;
  uid: string;
  pieceId: string;
  /** Index into the piece's paths. */
  index: number;
  /** The path in plan coordinates. */
  path: TrackPath;
  length: number;
  /** Height of the piece's bottom above the floor. */
  base: number;
  ends: [EdgeEnd, EdgeEnd];
}

/** Height of the track bed at `s` along an edge, above the floor. */
export const edgeHeight = (edge: Edge, s: number): number => edge.base + heightAt(edge.path, s);
/** How steeply an edge climbs at `s`, mm up per mm along its path. */
export const edgeGrade = (edge: Edge, s: number): number => gradeAt(edge.path, s);

/** A piece end where a train can go more than one way, and the ways it offers. */
export interface SwitchPoint {
  /** `uid:connectorId`: what its lever is known by. */
  key: string;
  uid: string;
  /** The end itself, facing out of the piece. */
  at: Pose;
  /** The ways on from here, in path order, with which end of each starts here. */
  choices: { edge: Edge; end: 0 | 1 }[];
}

/** Where a train goes on from the end of an edge. */
export type Onward =
  | { kind: 'edge'; edge: Edge; enterAt: 0 | 1; fit: JointFit | null; at: Vec2 }
  | { kind: 'open' | 'buffer'; at: Vec2 };

/** Ends further apart than the joint play but this close count as a gap the wheels may hop. */
export const GAP_RANGE = { mm: 12, deg: 12 };

const MATCH_MM = 0.5;
const MATCH_RAD = 0.02;

const worldPath = (piece: PlacedPiece, path: TrackPath): TrackPath => ({ ...path, from: applyPose(piece.pose, path.from) });

/** The pose of an edge end, facing out of the edge. */
export function edgeEndPose(edge: Edge, end: 0 | 1): Pose {
  if (end === 1) return pathEnd(edge.path);
  const f = edge.path.from;
  return { ...f, angle: normalizeAngle(f.angle + Math.PI) };
}

export function fitBetween(a: Pose, b: Pose, unjoined: boolean): JointFit {
  const d = rotate({ x: b.x - a.x, y: b.y - a.y }, -a.angle);
  const kink = normalizeAngle(a.angle - b.angle - Math.PI);
  return { gapMm: distance(a, b), lateralMm: Math.abs(d.y), angleDeg: Math.abs((kink * 180) / Math.PI), unjoined };
}

const near = (a: Pose, b: Pose, flip: number) =>
  distance(a, b) < MATCH_MM && Math.abs(normalizeAngle(a.angle - b.angle - flip)) < MATCH_RAD;

export class TrackNetwork {
  readonly edges: Edge[] = [];
  private readonly byKey = new Map<string, Edge>();
  /** Edges of each piece with an end at each connector: `uid:connectorId`. */
  private readonly atConnector = new Map<string, { edge: Edge; end: 0 | 1 }[]>();
  /** The connector each connector is joined to, or bridges a gap to. */
  private readonly partner = new Map<string, { uid: string; connectorId: string; fit: JointFit; at: Vec2 }>();
  private readonly pieces = new Map<string, PlacedPiece>();

  constructor(readonly layout: Layout) {
    for (const piece of layout.pieces) this.addPiece(piece);
    this.link();
  }

  private addPiece(piece: PlacedPiece): void {
    this.pieces.set(piece.uid, piece);
    const def = defOf(piece);
    def.paths.forEach((local, index) => {
      const path = worldPath(piece, local);
      const edge: Edge = {
        key: `${piece.uid}:${index}`,
        uid: piece.uid,
        pieceId: piece.pieceId,
        index,
        path,
        length: pathLength(path),
        base: baseOf(piece),
        ends: [{ kind: 'dead' }, { kind: 'dead' }],
      };
      this.edges.push(edge);
      this.byKey.set(edge.key, edge);
    });
    const mine = this.edges.slice(this.edges.length - def.paths.length);
    const connectors = def.connectors.map((c) => ({ id: c.id, pose: applyPose(piece.pose, c.pose) }));
    for (const edge of mine) {
      for (const end of [0, 1] as const) {
        const pose = edgeEndPose(edge, end);
        const c = connectors.find((k) => near(k.pose, pose, 0));
        if (c) {
          edge.ends[end] = { kind: 'connector', connectorId: c.id };
          const key = `${piece.uid}:${c.id}`;
          this.atConnector.set(key, [...(this.atConnector.get(key) ?? []), { edge, end }]);
        } else if (mine.some((o) => o !== edge && ([0, 1] as const).some((k) => near(edgeEndPose(o, k), pose, Math.PI)))) {
          edge.ends[end] = { kind: 'internal' };
        }
      }
    }
  }

  private link(): void {
    const joints = findJoints(this.layout);
    for (const j of joints) {
      const a = this.connectorPose(j.a.uid, j.a.connectorId);
      const b = this.connectorPose(j.b.uid, j.b.connectorId);
      this.partner.set(`${j.a.uid}:${j.a.connectorId}`, { ...j.b, fit: fitBetween(a, b, false), at: a });
      this.partner.set(`${j.b.uid}:${j.b.connectorId}`, { ...j.a, fit: fitBetween(b, a, false), at: b });
    }
    // Loose ends that nearly meet: the closest pairs first.
    const open = openEnds(this.layout, joints);
    const pairs: { i: number; j: number; gap: number }[] = [];
    for (const [i, j] of nearbyPairs(open, GAP_RANGE.mm)) {
      if (open[i].uid === open[j].uid) continue;
      if (heightGap(open[i].connector, open[j].connector) > 1) continue;
      const fit = fitBetween(open[i].connector.pose, open[j].connector.pose, true);
      if (fit.gapMm <= GAP_RANGE.mm && fit.angleDeg <= GAP_RANGE.deg) pairs.push({ i, j, gap: fit.gapMm });
    }
    pairs.sort((p, q) => p.gap - q.gap);
    const used = new Set<number>();
    for (const { i, j } of pairs) {
      if (used.has(i) || used.has(j)) continue;
      used.add(i).add(j);
      const [a, b] = [open[i], open[j]];
      this.partner.set(`${a.uid}:${a.connectorId}`, { uid: b.uid, connectorId: b.connectorId, fit: fitBetween(a.connector.pose, b.connector.pose, true), at: a.connector.pose });
      this.partner.set(`${b.uid}:${b.connectorId}`, { uid: a.uid, connectorId: a.connectorId, fit: fitBetween(b.connector.pose, a.connector.pose, true), at: b.connector.pose });
    }
  }

  private connectorPose(uid: string, connectorId: string): Pose {
    const piece = this.pieces.get(uid)!;
    const c = defOf(piece).connectors.find((k) => k.id === connectorId)!;
    return applyPose(piece.pose, c.pose);
  }

  edge(key: string): Edge | undefined {
    return this.byKey.get(key);
  }

  piece(uid: string): PlacedPiece | undefined {
    return this.pieces.get(uid);
  }

  /** Ends where a train running in can go more than one way, with their choices in order. */
  switches(): SwitchPoint[] {
    const out: SwitchPoint[] = [];
    for (const [key, list] of this.atConnector) {
      if (list.length < 2) continue;
      const uid = key.slice(0, key.indexOf(':'));
      out.push({ key, uid, at: edgeEndPose(list[0].edge, list[0].end), choices: [...list].sort((a, b) => a.edge.index - b.edge.index) });
    }
    return out;
  }

  /**
   * Where a train leaving `edge` through its end `end` runs on to. At a
   * facing switch, `choose` picks among the ways on (sorted by path), by
   * the switch point's key.
   */
  onward(edge: Edge, end: 0 | 1, choose: (key: string, count: number) => number): Onward {
    const here = edge.ends[end];
    const pose = edgeEndPose(edge, end);
    if (here.kind === 'dead') return { kind: this.isBuffer(edge) ? 'buffer' : 'open', at: pose };
    let key = `${edge.uid}:internal`;
    let fit: JointFit | null = null;
    let candidates: { edge: Edge; end: 0 | 1 }[];
    if (here.kind === 'internal') {
      candidates = this.edges
        .filter((e) => e.uid === edge.uid && e !== edge)
        .flatMap((e) => ([0, 1] as const).filter((k) => near(edgeEndPose(e, k), pose, Math.PI)).map((k) => ({ edge: e, end: k })));
    } else {
      const partner = this.partner.get(`${edge.uid}:${here.connectorId}`);
      if (!partner) return { kind: 'open', at: pose };
      key = `${partner.uid}:${partner.connectorId}`;
      fit = partner.fit;
      candidates = this.atConnector.get(`${partner.uid}:${partner.connectorId}`) ?? [];
    }
    if (!candidates.length) return { kind: 'open', at: pose };
    const sorted = [...candidates].sort((a, b) => a.edge.index - b.edge.index);
    const pick = sorted.length > 1 ? sorted[choose(key, sorted.length) % sorted.length] : sorted[0];
    return { kind: 'edge', edge: pick.edge, enterAt: pick.end, fit, at: pose };
  }

  private isBuffer(edge: Edge): boolean {
    return defOf(this.pieces.get(edge.uid)!).category === 'buffer';
  }
}
