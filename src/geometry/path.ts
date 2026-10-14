import { RAMP_BLEND } from '../pieces/dimensions';
import type { TrackPath } from '../pieces/types';
import { applyPose, type Pose } from './pose';

export function pathLength(path: TrackPath): number {
  return path.kind === 'straight' ? path.length : Math.abs(path.sweep) * path.radius;
}

/** Pose at distance `s` along a path, heading along the direction of travel. */
export function poseAt(path: TrackPath, s: number): Pose {
  if (path.kind === 'straight') {
    return applyPose(path.from, { x: s, y: 0, angle: 0 });
  }
  const turn = (Math.sign(path.sweep) * s) / path.radius;
  const side = Math.sign(path.sweep);
  // Arc around a center `radius` to the turning side of the start pose.
  const local: Pose = {
    x: path.radius * Math.sin(Math.abs(turn)),
    y: side * path.radius * (1 - Math.cos(turn)),
    angle: turn,
  };
  return applyPose(path.from, local);
}

export function pathEnd(path: TrackPath): Pose {
  return poseAt(path, pathLength(path));
}

/**
 * How steep a ramp's steady climb is, as rise per mm. The climb eases in
 * and out over `RAMP_BLEND` at each end, so the ends sit level.
 */
function climbSlope(path: TrackPath, length: number): number {
  const blend = Math.min(RAMP_BLEND, length / 2);
  return (path.rise ?? 0) / (length - blend);
}

/** Height of the track bed at distance `s` along a path, above the piece's bottom. */
export function heightAt(path: TrackPath, s: number): number {
  const rise = path.rise ?? 0;
  if (!rise) return 0;
  const length = pathLength(path);
  const blend = Math.min(RAMP_BLEND, length / 2);
  const m = climbSlope(path, length);
  const t = Math.min(Math.max(s, 0), length);
  if (t < blend) return (m * t * t) / (2 * blend);
  if (t > length - blend) return rise - (m * (length - t) ** 2) / (2 * blend);
  return (m * blend) / 2 + m * (t - blend);
}

/** Rate of climb at `s` along a path, mm up per mm along. */
export function gradeAt(path: TrackPath, s: number): number {
  const rise = path.rise ?? 0;
  if (!rise) return 0;
  const length = pathLength(path);
  const blend = Math.min(RAMP_BLEND, length / 2);
  const m = climbSlope(path, length);
  const t = Math.min(Math.max(s, 0), length);
  if (t < blend) return (m * t) / blend;
  if (t > length - blend) return (m * (length - t)) / blend;
  return m;
}
