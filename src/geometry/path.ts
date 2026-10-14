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
 * Height of the track bed at distance `s` along a path, above the piece's
 * bottom. A ramp climbs in one smooth S: a half cosine wave, level at both
 * ends and steepest in the middle, like the real ones.
 */
export function heightAt(path: TrackPath, s: number): number {
  const rise = path.rise ?? 0;
  if (!rise) return 0;
  const length = pathLength(path);
  const t = Math.min(Math.max(s, 0), length) / length;
  return (rise * (1 - Math.cos(Math.PI * t))) / 2;
}

/** Rate of climb at `s` along a path, mm up per mm along. */
export function gradeAt(path: TrackPath, s: number): number {
  const rise = path.rise ?? 0;
  if (!rise) return 0;
  const length = pathLength(path);
  const t = Math.min(Math.max(s, 0), length) / length;
  return ((rise * Math.PI) / (2 * length)) * Math.sin(Math.PI * t);
}
