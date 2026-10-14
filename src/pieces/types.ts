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
 * `rise` is how much it climbs from start to end (a ramp; negative goes
 * down). `z` is how high it starts above the bottom of the piece, for
 * track carried up on a piece's own legs (a bridge deck); missing is level
 * with the bottom.
 */
export type TrackPath =
  | { kind: 'straight'; from: Pose; length: number; rise?: number; z?: number }
  /** `sweep` is signed: positive turns left (counter-clockwise). */
  | { kind: 'arc'; from: Pose; radius: number; sweep: number; rise?: number; z?: number };

/** How a bridge span is built, for its model. */
export type BridgeStyle = 'viaduct' | 'suspension' | 'truss' | 'covered';

export type PieceCategory = 'straight' | 'curve' | 'double' | 'ramp' | 'switch' | 'crossing' | 'buffer' | 'scenery';

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
  /** Seated scenery that holds the track up this high (a pier), standing on the floor under raised track. */
  holdsTrackAt?: number;
  /**
   * The catalog piece this one is a shape of, for pieces you reshape on the
   * floor (bendy track): the parts list counts them all as that piece.
   */
  partOf?: string;
  /**
   * A bridge span: track a level up, standing on its own structure, so it
   * needs no support blocks, and nor does track joined to its ends.
   */
  bridge?: BridgeStyle;
  /** How far a bendy track is bent, degrees, before any flip. */
  bend?: number;
  /** Turned over from the catalog piece, see `mirrorPiece`. */
  mirrored?: boolean;
}
