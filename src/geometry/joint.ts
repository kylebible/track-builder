import { JOINT_PLAY_DEG, JOINT_PLAY_MM } from '../pieces/dimensions';
import type { Connector, PieceDef } from '../pieces/types';
import { applyPose, distance, normalizeAngle, rotate, type Pose } from './pose';

export interface Play {
  mm: number;
  deg: number;
}

export const DEFAULT_PLAY: Play = { mm: JOINT_PLAY_MM, deg: JOINT_PLAY_DEG };

/** A connector of a piece placed in the world at `placement`. */
export function worldConnector(placement: Pose, connector: Connector): Connector {
  return { ...connector, pose: applyPose(placement, connector.pose) };
}

/**
 * Where to place `piece` so its connector `connectorId` mates exactly with
 * the world connector `target`: same spot, facing the opposite way.
 */
export function placeToMate(target: Pose, piece: PieceDef, connectorId: string): Pose {
  const c = piece.connectors.find((k) => k.id === connectorId);
  if (!c) throw new Error(`${piece.id} has no connector ${connectorId}`);
  const angle = normalizeAngle(target.angle + Math.PI - c.pose.angle);
  const offset = rotate(c.pose, angle);
  return { x: target.x - offset.x, y: target.y - offset.y, angle };
}

export interface JointError {
  /** Gap between the two connector points, mm. */
  gapMm: number;
  /** How far the ends are from facing each other head on, degrees. */
  angleDeg: number;
}

export function jointError(a: Pose, b: Pose): JointError {
  const misalignment = normalizeAngle(a.angle - b.angle - Math.PI);
  return { gapMm: distance(a, b), angleDeg: Math.abs((misalignment * 180) / Math.PI) };
}

/** Two world connectors form a real joint: peg into hole, within play. */
export function canMate(a: Connector, b: Connector, play: Play = DEFAULT_PLAY): boolean {
  if (a.gender === b.gender) return false;
  const e = jointError(a.pose, b.pose);
  return e.gapMm <= play.mm && e.angleDeg <= play.deg + 1e-9;
}

