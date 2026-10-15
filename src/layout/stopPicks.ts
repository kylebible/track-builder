import type { Vec2 } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import { offered } from '../pieces/basic';
import { getPlace, type PlaceDef } from '../trains/stops';
import type { Layout } from './layout';

// Which stops a generated section gets, so the jobs on the layout balance
// out: a place that makes something nobody takes in yet is answered by one
// that takes it in, and the other way round; a layout with people at work
// but nowhere for them to live gets a station. Places already close to
// where the section goes count against having another of the same there,
// and every repeat anywhere counts a little against another, so a long
// list of stops comes out varied.

/** How a stop goes on the line: seated on a straight, as track itself, or beside it. */
export type StopKind = 'seat' | 'inline' | 'beside';
export interface StopDef {
  id: string;
  how: StopKind;
  /** How far beside the track, for things that stand next to it. */
  offset?: number;
}

/** How much more a stop is wanted for each kind of goods it would balance out, against 1 for any stop. */
const WANTED = 8;

/** What counts as near the new section, mm. */
export const NEAR_MM = 900;

/** Goods each place sends out and takes in. Refilling engines takes in what it refills from. */
function flows(place: PlaceDef): { makes: string[]; takes: string[] } {
  const makes = [...(place.loads ?? []), ...(place.swaps ?? [])];
  const takes = [...(place.unloads ?? []), ...(place.swaps ?? [])];
  return { makes, takes };
}

interface Tally {
  /** Of each piece, anywhere and near the section. */
  all: Map<string, number>;
  near: Map<string, number>;
  /** Places making and taking in each kind of goods. */
  makers: Map<string, number>;
  takers: Map<string, number>;
  /** Places that need people at work, and stations for them to live at. */
  staffed: number;
  stations: number;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function count(tally: Tally, id: string, near: boolean): void {
  bump(tally.all, id);
  if (near) bump(tally.near, id);
  const place = getPlace(id);
  if (!place) return;
  const { makes, takes } = flows(place);
  for (const kind of makes) bump(tally.makers, kind);
  for (const kind of takes) bump(tally.takers, kind);
  if (place.staff) tally.staffed++;
  if (place.id === 'station') tally.stations++;
}

/** How much a stop is wanted, given what's out there already. */
function weight(stop: StopDef, tally: Tally): number {
  const place = getPlace(stop.id);
  let w = place ? 1 : 0.7;
  if (place) {
    const { makes, takes } = flows(place);
    // Taking in what's made with too few to take it, or making what's wanted with too few making it.
    for (const kind of takes) w += WANTED * Math.max(0, (tally.makers.get(kind) ?? 0) - (tally.takers.get(kind) ?? 0));
    for (const kind of makes) w += WANTED * Math.max(0, (tally.takers.get(kind) ?? 0) - (tally.makers.get(kind) ?? 0));
    if (place.id === 'station') w += tally.stations ? 0 : tally.staffed ? 2 * WANTED : 1;
  }
  w /= 1 + (tally.all.get(stop.id) ?? 0);
  if (tally.near.get(stop.id)) w *= 0.25;
  return w;
}

/**
 * Pick `n` stops from `from` for a section starting near `at` on `layout`,
 * balancing the jobs: each pick counts as there for the next. Repeats are
 * allowed once every kind is out, so any number can be asked for.
 */
export function pickStops(layout: Layout, from: readonly StopDef[], n: number, at: Vec2 | null, rand: () => number): StopDef[] {
  const choices = from.filter((s) => offered(getPiece(s.id)));
  if (!choices.length) return [];
  const tally: Tally = { all: new Map(), near: new Map(), makers: new Map(), takers: new Map(), staffed: 0, stations: 0 };
  for (const piece of layout.pieces) {
    if (!getPlace(piece.pieceId) && !choices.some((s) => s.id === piece.pieceId)) continue;
    count(tally, piece.pieceId, !!at && Math.hypot(piece.pose.x - at.x, piece.pose.y - at.y) < NEAR_MM);
  }
  const picks: StopDef[] = [];
  for (let k = 0; k < n; k++) {
    const weights = choices.map((s) => weight(s, tally));
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    const pick = choices.find((_, i) => (r -= weights[i]) <= 0) ?? choices[choices.length - 1];
    picks.push(pick);
    // It goes along the new section, so it's near.
    count(tally, pick.id, true);
  }
  return picks;
}
