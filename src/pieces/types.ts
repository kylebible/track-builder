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
}

/** A running surface along the track centerline, in piece-local coordinates. */
export type TrackPath =
  | { kind: 'straight'; from: Pose; length: number }
  /** `sweep` is signed: positive turns left (counter-clockwise). */
  | { kind: 'arc'; from: Pose; radius: number; sweep: number };

export type PieceCategory = 'straight' | 'curve' | 'switch' | 'crossing' | 'buffer' | 'scenery';

export interface PieceDef {
  /** Stable catalog id, used in saved layouts. */
  id: string;
  name: string;
  /** Brio catalog letters for this exact shape and gender pattern, if known. */
  brioIds: string[];
  category: PieceCategory;
  connectors: Connector[];
  paths: TrackPath[];
  /**
   * A model drawn with the piece, by file name in public/models/scenery.
   * Scenery that isn't track has no paths or connectors: it is placed and
   * moved like track, but never joins anything.
   */
  model?: string;
  /** Scenery that sits over a straight (a tunnel), snapped onto its middle when dragged near. */
  seatsOnTrack?: boolean;
  /** Turned over from the catalog piece, see `mirrorPiece`. */
  mirrored?: boolean;
}
