import type { Train, Vehicle } from './sim';
import { AXLE_HEIGHT } from './trainMesh';

// Riding along: where the eye sits on a train and which way it looks. The
// eye rides on whichever vehicle leads the way the train is going, so a train
// backing up is watched from its other end: over an engine's cab, or over
// the middle of a car being pushed.

/** Above the roof, mm: high enough to see over a chimney to the track ahead. */
export const EYE_ABOVE_ROOF = 34;
/** An engine's cab, back from its middle as a share of its length. */
const CAB_BACK = 0.22;
/** How far past the front of the train the eye looks, mm, so it follows the track round curves. */
const LOOK_AHEAD = 170;
/** Below this speed, mm/s, the train counts as standing still. */
const MOVING = 2;

export interface CabPose {
  /** The vehicle the eye rides on. */
  vehicle: Vehicle;
  /** +1 when travelling along the route (front of the train first). */
  way: 1 | -1;
  /** Eye position in plan, mm, and height above the floor. */
  x: number;
  y: number;
  z: number;
  /** The way of travel in plan, radians. */
  heading: number;
  /** Nose up (positive) along the way of travel, radians. */
  pitch: number;
}

/** Which way the train is going, or would go once its engines push. */
export function travelWay(train: Train, last: 1 | -1): 1 | -1 {
  const v = train.vehicles.reduce((sum, x) => sum + x.v, 0) / train.vehicles.length;
  if (Math.abs(v) > MOVING) return v > 0 ? 1 : -1;
  const engine = train.vehicles.find((x) => x.def.motor);
  if (train.throttle && engine) return (train.throttle * engine.facing) as 1 | -1;
  return last;
}

/** Where the eye goes on a train travelling `way`. */
export function cabPose(train: Train, way: 1 | -1): CabPose {
  const vehicle = way === 1 ? train.vehicles[0] : train.vehicles[train.vehicles.length - 1];
  const { geo, def } = vehicle;
  // The cab is at the engine's own back, whichever way it is going.
  const back = def.motor ? def.length * CAB_BACK : 0;
  const x = geo.center.x - Math.cos(geo.heading) * back;
  const y = geo.center.y - Math.sin(geo.heading) * back;
  // Look at the track a little way ahead rather than straight off the nose.
  const u = vehicle.u + way * (def.length / 2 + LOOK_AHEAD);
  const target = train.route.poseAt(u);
  const reach = Math.hypot(target.x - x, target.y - y);
  return {
    vehicle,
    way,
    x,
    y,
    z: geo.z + AXLE_HEIGHT + def.height + EYE_ABOVE_ROOF,
    heading: Math.atan2(target.y - y, target.x - x),
    pitch: Math.atan2(train.route.heightAt(u) - geo.z, reach),
  };
}
