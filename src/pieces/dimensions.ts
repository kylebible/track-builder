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
/** A3, half an A. Retired, but still about. */
export const MIDDLE_STRAIGHT = 72;
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
 * Double track: two tracks side by side on one piece, centerline to
 * centerline, as the guide gives it. EE and EE1 double curves have their
 * inner track on the E or E1 curve (an UNMEASURED reading: the guide gives
 * their radius as the plain curve's), and the outer one this much further out.
 */
export const DOUBLE_TRACK_SPACING = 46;

/**
 * Bendy track: a run of short wooden links that bends anywhere from straight
 * to a turn. Not a Brio piece, so these are UNMEASURED guesses: as long as a
 * D, and bending up to an eighth of a circle (like a curve), in steps that
 * the joint play covers between.
 */
export const BENDY_LENGTH = LONG_STRAIGHT;
export const BENDY_MAX_BEND = CURVE_ANGLE;
export const BENDY_STEP = Math.PI / 24;

/**
 * Arch bridge: one piece that climbs a level, runs level across the top
 * and comes back down, standing on its own legs, so track can pass
 * underneath. A generic accessory with UNMEASURED dimensions: slopes as
 * long as an N ramp (any steeper and a battery engine can't climb them),
 * and an A-length top.
 */
export const ARCH_BRIDGE_SLOPE = RAMP_LENGTH;
export const ARCH_BRIDGE_TOP = MEDIUM_STRAIGHT;

/**
 * Bridge spans: level track a level up on a structure of its own, joined to
 * raised track or ramp tops at both ends. Generic accessories, so their
 * lengths are UNMEASURED choices, in whole A or D lengths: a long stone
 * viaduct of three arches, a long suspension span, a D-length truss and a
 * covered bridge two A's long.
 */
export const VIADUCT_LENGTH = 3 * MEDIUM_STRAIGHT;
export const SUSPENSION_LENGTH = 2 * LONG_STRAIGHT;
export const TRUSS_LENGTH = LONG_STRAIGHT;
export const COVERED_BRIDGE_LENGTH = 2 * MEDIUM_STRAIGHT;

/** Half curves: an E or E1 curve cut in two, a sixteenth of a circle. Generic, not Brio. */
export const HALF_CURVE_ANGLE = CURVE_ANGLE / 2;

/**
 * Curved ramp: a quarter circle on the E curve's radius that climbs one
 * level as it turns. A generic piece, UNMEASURED; a quarter turn keeps it
 * no steeper than an N ramp.
 */
export const CURVED_RAMP_SWEEP = Math.PI / 2;

/**
 * Helix tower: track spiralling up round a central column, a level per
 * turn, coming out right over where it went in. UNMEASURED: two turns on
 * the E curve's radius.
 */
export const HELIX_TURNS = 2;

/**
 * Q five-point switch: the guide gives an A length, outer turns at 45°
 * (an E curve) and inner turns at 22.5°. The inner radius is UNMEASURED:
 * we pick the one that ends an A length along, like the E curve does.
 */
export const FIVE_POINT_INNER_ANGLE = Math.PI / 8;
export const FIVE_POINT_INNER_RADIUS = MEDIUM_STRAIGHT / Math.sin(FIVE_POINT_INNER_ANGLE);

/**
 * F1/G1 parallel switch and F2/G2 triple parallel switch: an A length, as
 * the guide gives. The sideways offset is UNMEASURED; we use the double
 * track spacing, so the side track lines up with double track.
 */
export const PARALLEL_SWITCH_NEW_LENGTH = MEDIUM_STRAIGHT;
export const PARALLEL_SWITCH_NEW_OFFSET = DOUBLE_TRACK_SPACING;

/** Bumpy track: an A length with humps this high. Generic, UNMEASURED. */
export const BUMPY_LENGTH = MEDIUM_STRAIGHT;
export const BUMPY_COUNT = 3;
export const BUMP_HEIGHT = 4;

/**
 * Turntable: a pit with eight track ends round it and a turning bridge
 * across the middle. Generic and UNMEASURED: a D across.
 */
export const TURNTABLE_DIAMETER = LONG_STRAIGHT;

/** Curved viaduct: a bridge span turning an eighth of a circle, on twice the E radius. UNMEASURED. */
export const CURVED_VIADUCT_RADIUS = 2 * LARGE_CURVE_RADIUS;
export const CURVED_VIADUCT_SWEEP = Math.PI / 4;

/**
 * Real-world play in a joint: two ends this close in position and angle
 * count as connected. Tunable.
 */
export const JOINT_PLAY_MM = 2;
export const JOINT_PLAY_DEG = 2;

/**
 * Lifting bridge: a D-length piece whose middle span rises straight up
 * between two towers. The span's ends along the piece, and how high it
 * lifts, are our own design, not a measured Brio piece.
 */
export const LIFT_BRIDGE_LENGTH = LONG_STRAIGHT;
export const LIFT_SPAN_FROM = 36;
export const LIFT_SPAN_TO = LIFT_BRIDGE_LENGTH - 36;
export const LIFT_HEIGHT = 100;
