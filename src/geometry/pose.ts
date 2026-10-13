// 2D plan-view geometry. Units are millimetres, angles are radians measured
// counter-clockwise from +x. The renderer maps plan (x, y) to three.js (x, -z).

export interface Vec2 {
  x: number;
  y: number;
}

/** A position plus a heading. */
export interface Pose extends Vec2 {
  angle: number;
}

export const IDENTITY: Pose = { x: 0, y: 0, angle: 0 };

export const deg = (d: number): number => (d * Math.PI) / 180;
export const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Wrap an angle into (-PI, PI]. */
export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

export function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Express a pose given in `frame`'s local coordinates in world coordinates. */
export function applyPose(frame: Pose, local: Pose): Pose {
  const p = rotate(local, frame.angle);
  return {
    x: frame.x + p.x,
    y: frame.y + p.y,
    angle: normalizeAngle(frame.angle + local.angle),
  };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
