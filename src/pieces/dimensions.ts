// Real Brio dimensions in millimetres, from the woodenrailway.info Brio track
// guide: https://woodenrailway.info/track/brio-track-guide

export const TRACK_WIDTH = 40;
export const TRACK_HEIGHT = 12;
export const GROOVE_WIDTH = 6;
export const GROOVE_DEPTH = 3;
/** Center-to-center distance between the two grooves. */
export const GROOVE_SPACING = 26;

export const PEG_DIAMETER = 11.5;
export const PEG_NECK_LENGTH = 7;
export const PEG_NECK_WIDTH = 6;
export const HOLE_DIAMETER = 16;

export const MINI_STRAIGHT = 54;
export const SHORT_STRAIGHT = 108;
export const MEDIUM_STRAIGHT = 144;
export const LONG_STRAIGHT = 216;

/** Every Brio curve is one eighth of a circle. */
export const CURVE_ANGLE = Math.PI / 4;

/** Nominal curve radii as published (E large curve, E1 short curve). */
export const LARGE_CURVE_RADIUS_NOMINAL = 182;
export const SHORT_CURVE_RADIUS_NOMINAL = 90;

/**
 * UNMEASURED ASSUMPTION. The guide gives the E curve's 182 mm at the inner
 * edge of the track; it doesn't say how E1's 90 mm is measured. We read both
 * as inner-edge radii, so the centerline sits half a track width further out.
 * Set this to false if measuring real pieces shows the figures are
 * centerline radii. Everything else derives from it.
 */
export const CURVE_RADII_ARE_INNER_EDGE = true;

export function centerlineRadius(nominal: number): number {
  return CURVE_RADII_ARE_INNER_EDGE ? nominal + TRACK_WIDTH / 2 : nominal;
}

export const LARGE_CURVE_RADIUS = centerlineRadius(LARGE_CURVE_RADIUS_NOMINAL);
export const SHORT_CURVE_RADIUS = centerlineRadius(SHORT_CURVE_RADIUS_NOMINAL);

/** F/G parallel switch: overall length, and the sideways offset of the
 * second track. The offset is UNMEASURED; the guide only says the two
 * outgoing tracks are parallel. */
export const PARALLEL_SWITCH_LENGTH = 150;
export const PARALLEL_SWITCH_OFFSET = 50;

export const CROSS_LENGTH = 116;
export const CRISS_CROSS_LENGTH = 144;
export const CRISS_CROSS_ANGLE = Math.PI / 4;

export const BUFFER_STOP_LENGTH = 40;

/**
 * Real-world play in a joint: two ends this close in position and angle
 * count as connected. Tunable.
 */
export const JOINT_PLAY_MM = 2;
export const JOINT_PLAY_DEG = 2;
