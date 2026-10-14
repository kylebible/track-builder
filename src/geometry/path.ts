import type { TrackPath } from '../pieces/types';
import { applyPose, type Pose } from './pose';
import { BUMP_HEIGHT } from '../pieces/dimensions';

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
 * A spiral eases off once a turn, where it passes over its own start (and
 * at both ends), and climbs harder half a turn on. Height gained over any
 * full turn is the same, so every turn clears the one below by a level.
 */
const SPIRAL_EASE = 0.6;
const turnsOf = (path: TrackPath): number => (path.kind === 'arc' ? Math.abs(path.sweep) / (2 * Math.PI) : 1);
function spiralAt(path: TrackPath, t: number): number {
  const n = turnsOf(path);
  return t - (SPIRAL_EASE * Math.sin(2 * Math.PI * n * t)) / (2 * Math.PI * n);
}

/**
 * Height of the track bed at distance `s` along a path, above the piece's
 * bottom. A ramp climbs in one smooth S: a half cosine wave, level at both
 * ends and steepest in the middle, like the real ones.
 */
export function heightAt(path: TrackPath, s: number): number {
  const base = path.z ?? 0;
  const rise = path.rise ?? 0;
  const bumps = path.bumps ?? 0;
  if (!rise && !bumps) return base;
  const length = pathLength(path);
  const t = Math.min(Math.max(s, 0), length) / length;
  const hump = bumps ? BUMP_HEIGHT * Math.sin(Math.PI * bumps * t) ** 2 : 0;
  const climb = path.spiral ? rise * spiralAt(path, t) : (rise * (1 - Math.cos(Math.PI * t))) / 2;
  return base + climb + hump;
}

/** Rate of climb at `s` along a path, mm up per mm along. */
export function gradeAt(path: TrackPath, s: number): number {
  const rise = path.rise ?? 0;
  const bumps = path.bumps ?? 0;
  if (!rise && !bumps) return 0;
  const length = pathLength(path);
  const t = Math.min(Math.max(s, 0), length) / length;
  const hump = bumps ? ((BUMP_HEIGHT * Math.PI * bumps) / length) * Math.sin(2 * Math.PI * bumps * t) : 0;
  const climb = path.spiral
    ? (rise / length) * (1 - SPIRAL_EASE * Math.cos(2 * Math.PI * turnsOf(path) * t))
    : ((rise * Math.PI) / (2 * length)) * Math.sin(Math.PI * t);
  return climb + hump;
}
