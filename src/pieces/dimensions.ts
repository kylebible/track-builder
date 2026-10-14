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

/** N ascending track: a D-length straight that climbs 64 mm. */
export const RAMP_LENGTH = LONG_STRAIGHT;
export const RAMP_RISE = 64;
/**
 * UNMEASURED. How long the ramp takes to bend from level to its steady
 * climb at each end. The ends have to be level to join flat track.
 */
export const RAMP_BLEND = 36;

/**
 * Height of one level of raised track: what one N ramp climbs, and (an
 * UNMEASURED assumption) the height of one stacking support block.
 */
export const LEVEL_HEIGHT = RAMP_RISE;
/** Footprint of a support block, along and across the track. UNMEASURED. */
export const SUPPORT_LENGTH = 30;
export const SUPPORT_WIDTH = 52;

/**
 * Track that passes under other track needs this much headroom, from the
 * lower track's bottom to the upper track's bottom: one full level. Half
 * way up a ramp is too low.
 */
export const HEADROOM = LEVEL_HEIGHT - 4;

/**
 * T and X (star) switches: built on a D-length straight, with quarter-circle
 * curves that run into its ends, so their centerline radius is half a D.
 * The guide's 88 mm is that radius at the inner edge (108 - 20), which fits
 * how we read the other curve radii.
 */
export const T_SWITCH_LENGTH = LONG_STRAIGHT;
export const T_SWITCH_RADIUS = T_SWITCH_LENGTH / 2;

/**
 * Real-world play in a joint: two ends this close in position and angle
 * count as connected. Tunable.
 */
export const JOINT_PLAY_MM = 2;
export const JOINT_PLAY_DEG = 2;
