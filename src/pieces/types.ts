import type { Pose } from '../geometry/pose';

/** Peg (male) or hole (female). Joints are always peg into hole. */
export type Gender = 'peg' | 'hole';

/**
 * One end of a piece. `angle` points outward, away from the piece, so two
 * mated connectors sit at the same spot facing opposite ways.
 */
export interface Connector {
  id: string;
  pose: Pose;
  gender: Gender;
  /** Height of this end above the bottom of the piece, mm: the top of a ramp. */
  z?: number;
}

/**
 * A running surface along the track centerline, in piece-local coordinates.
 * `rise` is how much it climbs from start to end (a ramp); it starts level
 * with the bottom of the piece.
 */
export type TrackPath =
  | { kind: 'straight'; from: Pose; length: number; rise?: number }
  /** `sweep` is signed: positive turns left (counter-clockwise). */
  | { kind: 'arc'; from: Pose; radius: number; sweep: number; rise?: number };

export type PieceCategory = 'straight' | 'curve' | 'ramp' | 'switch' | 'crossing' | 'buffer';

export interface PieceDef {
  /** Stable catalog id, used in saved layouts. */
  id: string;
  name: string;
  /** Brio catalog letters for this exact shape and gender pattern, if known. */
  brioIds: string[];
  category: PieceCategory;
  connectors: Connector[];
  paths: TrackPath[];
}
