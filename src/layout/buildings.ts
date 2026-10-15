import { Box3 } from 'three';
import { poseAt } from '../geometry/path';
import { applyPose, distance, invertPose, type Pose, type Vec2 } from '../geometry/pose';
import { offered } from '../pieces/basic';
import { getPiece } from '../pieces/catalog';
import { TRACK_HEIGHT, TRACK_WIDTH } from '../pieces/dimensions';
import { SCENERY_MODELS } from '../scenery/models';
import { ECONOMY } from '../trains/economy';
import { edgeHeight, TrackNetwork, type Edge } from '../trains/network';
import { PLACES, getPlace } from '../trains/stops';
import { SUPPLIES } from '../trains/supplies';
import { addPiece, baseOf, defOf, type Layout, type PlacedPiece } from './layout';

/** Maximum uninterrupted run between service stops, with most of a tank in reserve. */
export const BUILDING_INTERVALS: Readonly<Record<string, number>> = {
  'coaling-stage': SUPPLIES.coalMm * 0.4,
  'water-tower': SUPPLIES.waterMm * 0.4,
  'charging-post': SUPPLIES.chargeMm * 0.4,
};

// Sidings require a buffered road and room to reverse; they cannot simply go on any straight.
export const JOB_BUILDINGS = [...PLACES.filter((p) => !p.pass && !p.spares).map((p) => p.id), 'engine-shed'];

export interface BuildingOptions {
  ids: string[];
  /** A multiplier of the recommended interval. Never more than the recommendation. */
  spacing: number;
  /** Include missing coal mines, pump houses, and worker stations in each section. */
  supplyChain: boolean;
}

export const DEFAULT_BUILDINGS: BuildingOptions = {
  ids: ['coaling-stage', 'water-tower', 'charging-post'], spacing: 1, supplyChain: true,
};

export interface BuildingCoverage {
  id: string;
  interval: number;
  added: number;
  existing: number;
  /** null means a route can keep running without encountering this kind of building. */
  longestGap: number | null;
  uncovered: string[];
}

export interface Buildings {
  layout: Layout;
  uids: string[];
  coverage: BuildingCoverage[];
  warnings: string[];
  /** Track pieces whose routes still lack the requested coverage. */
  uncovered: string[];
  limited: boolean;
}

export interface BuildingContext {
  /** Whether a building footprint point is on usable land and inside the scene. */
  allowed?: (at: Vec2, z: number) => boolean;
  waterNear?: (at: Vec2, reach: number) => boolean | null;
  /** Limit additions for very large layouts. */
  maxAdded?: number;
}

interface Link { to: number; mm: number }
interface Node { edge: Edge; s: number; next: Link[]; component: number }
interface Seat { edge: Edge; at: Pose; z: number; nodes: number[]; component: number }
interface Attached { piece: PlacedPiece; edge: Edge; s: number }

/** Oriented model bounds, in plan coordinates; a margin keeps neighbouring models apart. */
interface Footprint { corners: Vec2[]; lo: number; hi: number }
const bounds = new Map<string, Box3>();

function footprint(piece: PlacedPiece): Footprint | null {
  const model = getPiece(piece.pieceId).model;
  if (!model || !SCENERY_MODELS[model]) return null;
  let box = bounds.get(model);
  if (!box) {
    const group = SCENERY_MODELS[model]();
    box = new Box3().setFromObject(group);
    bounds.set(model, box);
    group.traverse((o) => { if ('geometry' in o) (o.geometry as { dispose(): void }).dispose(); });
  }
  return {
    corners: [[box.min.x - 8, -box.max.z - 8], [box.max.x + 8, -box.max.z - 8],
      [box.max.x + 8, -box.min.z + 8], [box.min.x - 8, -box.min.z + 8]]
      .map(([x, y]) => applyPose(piece.pose, { x, y, angle: 0 })),
    lo: baseOf(piece) + box.min.y, hi: baseOf(piece) + box.max.y,
  };
}

function overlaps(a: Footprint, b: Footprint): boolean {
  if (a.lo >= b.hi || b.lo >= a.hi) return false;
  for (const rect of [a, b]) for (let i = 0; i < 2; i++) {
    const p = rect.corners[i], q = rect.corners[i + 1];
    const axis = { x: q.y - p.y, y: p.x - q.x };
    const project = (r: Footprint) => r.corners.map((v) => v.x * axis.x + v.y * axis.y);
    const x = project(a), y = project(b);
    if (Math.max(...x) <= Math.min(...y) || Math.max(...y) <= Math.min(...x)) return false;
  }
  return true;
}

function contains(rect: Footprint, at: Vec2): boolean {
  for (let i = 0; i < 2; i++) {
    const a = rect.corners[i], b = rect.corners[i + 1];
    const x = b.x - a.x, y = b.y - a.y;
    const along = (at.x - a.x) * x + (at.y - a.y) * y;
    if (along < 0 || along > x * x + y * y) return false;
  }
  return true;
}

/** Same attachment rule as the simulation: within 12 mm of a running path, at its level. */
function attachments(layout: Layout, network: TrackNetwork): Attached[] {
  const out: Attached[] = [];
  for (const piece of layout.pieces) {
    if (!JOB_BUILDINGS.includes(piece.pieceId)) continue;
    let nearest: { edge: Edge; s: number; d: number } | null = null;
    for (const edge of network.edges) {
      const steps = Math.max(1, Math.ceil(edge.length / 4));
      for (let i = 0; i <= steps; i++) {
        const s = edge.length * i / steps;
        const plan = distance(poseAt(edge.path, s), piece.pose);
        if (plan >= 12 || Math.abs(edgeHeight(edge, s) - baseOf(piece)) > 8) continue;
        const d = plan + Math.abs(edgeHeight(edge, s) - baseOf(piece));
        if (!nearest || d < nearest.d) nearest = { edge, s, d };
      }
    }
    if (nearest) out.push({ piece, edge: nearest.edge, s: nearest.s });
  }
  return out;
}

/** Two headings at each endpoint, midpoint, and existing stop; crossings stay separate. */
function trackGraph(network: TrackNetwork, attached: Attached[]): { nodes: Node[]; seats: Seat[]; attachedNodes: Map<string, number[]> } {
  const nodes: Node[] = [], seats: Seat[] = [];
  const positions = new Map<string, { s: number; pair: number[] }[]>();
  for (const edge of network.edges) {
    const cuts = [...new Set([0, edge.length / 2, edge.length, ...attached.filter((a) => a.edge === edge).map((a) => a.s)])].sort((a, b) => a - b);
    const points = cuts.map((s) => {
      const pair = [nodes.length, nodes.length + 1];
      nodes.push({ edge, s, next: [], component: -1 }, { edge, s, next: [], component: -1 });
      return { s, pair };
    });
    positions.set(edge.key, points);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      nodes[a.pair[1]].next.push({ to: b.pair[1], mm: b.s - a.s });
      nodes[b.pair[0]].next.push({ to: a.pair[0], mm: b.s - a.s });
    }
    const def = defOf(network.piece(edge.uid)!);
    if ((def.category === 'straight' || def.category === 'double') && def.paths.every((p) => p.kind === 'straight') && edge.path.kind === 'straight'
      && !edge.path.rise && !edge.path.bumps && edge.length >= 108) {
      seats.push({ edge, at: poseAt(edge.path, edge.length / 2), z: edgeHeight(edge, edge.length / 2),
        nodes: points.find((p) => p.s === edge.length / 2)!.pair, component: -1 });
    }
  }
  for (const edge of network.edges) for (const end of [0, 1] as const) {
    const points = positions.get(edge.key)!;
    const last = end === 0 ? points[0] : points[points.length - 1];
    let count = 1;
    const first = network.onward(edge, end, (_, n) => { count = n; return 0; });
    if (first.kind !== 'edge') {
      // Count the return trip on a dead-end road too; no zero-distance shortcuts across branches.
      nodes[last.pair[end]].next.push({ to: last.pair[1 - end], mm: 0 });
    } else for (let i = 0; i < count; i++) {
      const next = i === 0 ? first : network.onward(edge, end, () => i);
      if (next.kind !== 'edge') continue;
      const target = positions.get(next.edge.key)!;
      const point = next.enterAt === 0 ? target[0] : target[target.length - 1];
      nodes[last.pair[end]].next.push({ to: point.pair[1 - next.enterAt], mm: next.fit?.gapMm ?? 0 });
    }
  }
  const neighbours = nodes.map(() => new Set<number>());
  nodes.forEach((node, i) => {
    for (const { to } of node.next) { neighbours[i].add(to); neighbours[to].add(i); }
    // The two headings share the same physical section, even on a closed one-way loop.
    neighbours[i].add(i ^ 1);
  });
  let component = 0;
  for (let i = 0; i < nodes.length; i++) if (nodes[i].component < 0) {
    const todo = [i];
    nodes[i].component = component;
    while (todo.length) for (const to of neighbours[todo.pop()!]) if (nodes[to].component < 0) {
      nodes[to].component = component;
      todo.push(to);
    }
    component++;
  }
  for (const seat of seats) seat.component = nodes[seat.nodes[0]].component;
  const attachedNodes = new Map(attached.map((a) => [a.piece.uid, positions.get(a.edge.key)!.find((p) => p.s === a.s)!.pair]));
  return { nodes, seats, attachedNodes };
}

/** Longest run before the next stop across ALL switch choices. Unserved cycles are infinite. */
function gaps(nodes: Node[], stops: Set<number>, interval: number): { longest: number; bad: number[]; trace: (start: number) => number[] } {
  const reverse = nodes.map(() => [] as number[]);
  const remaining = nodes.map((n) => n.next.filter((l) => !stops.has(l.to)).length);
  const lengths = nodes.map(() => Infinity);
  const queue: number[] = [];
  nodes.forEach((n, i) => {
    if (stops.has(i)) { lengths[i] = 0; return; }
    for (const l of n.next) reverse[l.to].push(i);
    if (remaining[i] === 0) queue.push(i);
  });
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    lengths[at] = Math.max(0, ...nodes[at].next.map((l) => l.mm + lengths[l.to]));
    for (const prev of reverse[at]) if (--remaining[prev] === 0) queue.push(prev);
  }
  const run = (i: number) => stops.has(i) ? Math.max(0, ...nodes[i].next.map((l) => l.mm + lengths[l.to])) : lengths[i];
  const bad = nodes.map((_, i) => i).filter((i) => run(i) > interval + 1e-6)
    .sort((a, b) => run(a) === run(b) ? a - b : run(a) > run(b) ? -1 : 1);
  const trace = (start: number): number[] => {
    const path = [start], seen = new Map<number, number>([[start, 0]]);
    let at = start;
    for (let i = 0; i <= nodes.length; i++) {
      const next = nodes[at].next.reduce<Link | null>((best, l) => !best || l.mm + lengths[l.to] > best.mm + lengths[best.to] ? l : best, null);
      if (!next) return path;
      path.push(next.to);
      if (stops.has(next.to)) return path;
      const loop = seen.get(next.to);
      if (loop !== undefined) return path.slice(loop);
      seen.set(next.to, path.length - 1);
      at = next.to;
    }
    return path;
  };
  return { longest: Math.max(0, ...nodes.map((_, i) => run(i))), bad, trace };
}

/** Preview buildings on existing track; yield between additions so the editor can cancel. */
export function* placeBuildings(base: Layout, options: BuildingOptions, context: BuildingContext = {}): Generator<Buildings, Buildings> {
  let layout = base;
  const uids: string[] = [], warnings: string[] = [], coverage: BuildingCoverage[] = [];
  const ids = [...new Set(options.ids)].filter((id) => JOB_BUILDINGS.includes(id) && offered(getPiece(id)));
  const spacing = Math.max(0.1, Math.min(1, Number.isFinite(options.spacing) ? options.spacing : 1));
  const network = new TrackNetwork(base);
  const attached = attachments(base, network).filter((a) => {
    if (a.piece.pieceId !== 'pump-house' || context.waterNear?.(a.piece.pose, ECONOMY.pumpReachMm) !== false) return true;
    warnings.push('An existing pump house cannot reach the water; it does not count as a water source.');
    return false;
  });
  const { nodes, seats, attachedNodes } = trackGraph(network, attached);
  const track = network.edges.flatMap((edge) => {
    const steps = Math.max(1, Math.ceil(edge.length / 20));
    return Array.from({ length: steps + 1 }, (_, i) => ({ at: poseAt(edge.path, edge.length * i / steps),
      z: edgeHeight(edge, edge.length * i / steps) + TRACK_HEIGHT, key: edge.key }));
  });
  const occupied = base.pieces.filter((p) => !defOf(p).paths.length).map(footprint).filter((p): p is Footprint => !!p);
  const stops = new Map<string, Set<number>>();
  const placed = new Map<string, Set<number>>();
  for (const a of attached) {
    const set = stops.get(a.piece.pieceId) ?? new Set<number>();
    attachedNodes.get(a.piece.uid)!.forEach((n) => set.add(n));
    stops.set(a.piece.pieceId, set);
  }
  const maxAdded = context.maxAdded ?? 200;
  const snapshot = (): Buildings => ({ layout, uids: [...uids], coverage: [...coverage], warnings: [...warnings],
    uncovered: [...new Set(coverage.flatMap((c) => c.uncovered))], limited: uids.length >= maxAdded });
  const put = (id: string, seat: Seat): boolean => {
    if (uids.length >= maxAdded) return false;
    if (id === 'pump-house' && context.waterNear?.(seat.at, ECONOMY.pumpReachMm) === false) return false;
    for (const turned of [0, Math.PI]) {
      const pose = { ...seat.at, angle: seat.at.angle + turned };
      const fake: PlacedPiece = { uid: '', pieceId: id, pose, flipped: false, z: seat.z };
      const area = footprint(fake);
      if (!area || occupied.some((other) => overlaps(area, other))) continue;
      const inverse = invertPose(pose);
      if (track.some((p) => p.key !== seat.edge.key && p.z >= area.lo && p.z < area.hi
        && Math.abs(applyPose(inverse, { ...p.at, angle: 0 }).y) > TRACK_WIDTH / 2 + 6 && contains(area, p.at))) continue;
      if (context.allowed && [pose, ...area.corners].some((p) => !context.allowed!(p, seat.z))) continue;
      const added = addPiece(layout, id, pose, false, seat.z);
      layout = added.layout;
      uids.push(added.uid);
      occupied.push(area);
      const set = stops.get(id) ?? new Set<number>();
      seat.nodes.forEach((n) => set.add(n));
      stops.set(id, set);
      const comps = placed.get(id) ?? new Set<number>();
      comps.add(seat.component);
      placed.set(id, comps);
      return true;
    }
    return false;
  };
  yield snapshot();
  if (!ids.length) return snapshot();
  for (const id of ids) {
    const interval = (BUILDING_INTERVALS[id] ?? 6000) * spacing;
    const existing = attached.filter((a) => a.piece.pieceId === id).length;
    const before = uids.length;
    const unavailable = new Set<Seat>();
    let report = gaps(nodes, stops.get(id) ?? new Set(), interval);
    while (report.bad.length && uids.length < maxAdded) {
      const eligible = seats.filter((s) => !unavailable.has(s) && !s.nodes.some((n) => stops.get(id)?.has(n)));
      if (!eligible.length) break;
      const components = new Set(eligible.map((s) => s.component));
      let done = false;
      const tried = new Set<Seat>();
      for (const start of report.bad) {
        if (!components.has(nodes[start].component)) continue;
        const path = report.trace(start);
        const along = new Map(path.map((n, i) => [n, i]));
        const candidates = eligible.filter((s) => !tried.has(s) && s.nodes.some((n) => along.has(n)));
        const middle = path.length / 2;
        candidates.sort((a, b) => Math.min(...a.nodes.map((n) => Math.abs((along.get(n) ?? Infinity) - middle)))
          - Math.min(...b.nodes.map((n) => Math.abs((along.get(n) ?? Infinity) - middle))));
        for (const seat of candidates) {
          tried.add(seat);
          if (put(id, seat)) { done = true; break; }
          unavailable.add(seat);
        }
        if (done) break;
        if (tried.size === eligible.length) break;
      }
      if (!done) break;
      yield snapshot();
      report = gaps(nodes, stops.get(id) ?? new Set(), interval);
    }
    report = gaps(nodes, stops.get(id) ?? new Set(), interval);
    coverage.push({ id, interval, existing, added: uids.length - before,
      longestGap: Number.isFinite(report.longest) ? report.longest : null,
      uncovered: [...new Set(report.bad.map((n) => nodes[n].edge.uid))] });
    yield snapshot();
  }
  {
    const components = new Set(nodes.map((n) => n.component));
    const present = (id: string, component: number) => placed.get(id)?.has(component)
      || attached.some((a) => a.piece.pieceId === id && nodes[attachedNodes.get(a.piece.uid)![0]].component === component);
    for (const component of components) {
      const required = new Set<string>();
      if (present('coaling-stage', component) || present('power-station', component)) required.add('coal-mine');
      if (present('water-tower', component)) required.add('pump-house');
      if ([...ids, ...required].some((id) => getPlace(id)?.staff && present(id, component)) || required.size) required.add('station');
      for (const id of required) {
        if (present(id, component)) continue;
        const name = getPiece(id).name.toLowerCase();
        if (!options.supplyChain) warnings.push(`Track section ${component + 1} needs a ${name} and deliveries when goods & workers are on.`);
        else if (!seats.some((s) => s.component === component && put(id, s))) warnings.push(`No room for a working ${name} on track section ${component + 1}.${id === 'pump-house' ? ' In a water scene, add clear straight track within 30 cm of the water.' : ''}`);
        yield snapshot();
      }
    }
  }
  if (stops.has('charging-post') && stops.has('power-station')) warnings.push('Charging posts depend on the power station having coal and workers.');
  if (uids.length >= maxAdded) warnings.push('Placement limit reached. Apply this batch, then run again.');
  return snapshot();
}

export function autoPlaceBuildings(base: Layout, options: BuildingOptions = DEFAULT_BUILDINGS, context: BuildingContext = {}): Buildings {
  const search = placeBuildings(base, options, context);
  let next = search.next();
  while (!next.done) next = search.next();
  return next.value;
}
