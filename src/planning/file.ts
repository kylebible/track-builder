import { deg, normalizeAngle, toDeg } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import type { Layout, PlacedPiece } from '../layout/layout';
import { environmentId, type EnvironmentId } from '../environments/environments';

// Layouts as files and links. One format serves the autosave, downloaded
// layout files and share links: plain JSON listing each piece's catalog id,
// position in mm and heading in degrees, and height for raised track.
// Joints are never stored; they come back from the positions, as they do
// on the floor. Supports aren't stored either: they follow from the heights.
// A layout can also name the environment it was built on (a play table, a
// rug); older files and apps simply leave that out.
//
// Version 2 added heights (`z`). A layout with nothing raised saves exactly
// as version 1 did, apart from the number.

export const FORMAT = 'track-builder-layout';
export const VERSION = 2;

interface SavedPiece {
  piece: string;
  x: number;
  y: number;
  /** Heading in degrees, counter-clockwise. */
  angle: number;
  flipped?: true;
  /** Height above the floor in mm, when raised. */
  z?: number;
}

export interface SavedLayout {
  format: typeof FORMAT;
  version: number;
  pieces: SavedPiece[];
  environment?: EnvironmentId;
}

/** A layout as a file holds it: the pieces, and what they're built on. */
export interface LayoutFile extends Layout {
  environment?: EnvironmentId;
}

/** Rounded well inside the joint play, so saving never opens a joint. */
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f || 0;
};

export function toSaved(layout: LayoutFile): SavedLayout {
  return {
    format: FORMAT,
    version: VERSION,
    ...(layout.environment ? { environment: layout.environment } : {}),
    pieces: layout.pieces.map((p) => ({
      piece: p.pieceId,
      x: round(p.pose.x, 3),
      y: round(p.pose.y, 3),
      angle: round(toDeg(p.pose.angle), 4),
      ...(p.flipped ? { flipped: true as const } : {}),
      ...(p.z ? { z: round(p.z, 3) } : {}),
    })),
  };
}

export class LayoutFileError extends Error {}

/** Read a saved layout, checking every piece is one we know. Throws LayoutFileError. */
export function fromSaved(data: unknown): LayoutFile {
  const d = data as Partial<SavedLayout> | null;
  if (!d || typeof d !== 'object' || d.format !== FORMAT || !Array.isArray(d.pieces)) {
    throw new LayoutFileError("This isn't a track layout file.");
  }
  if (typeof d.version !== 'number' || d.version > VERSION) {
    throw new LayoutFileError('This layout was saved by a newer version of the app.');
  }
  const pieces: PlacedPiece[] = d.pieces.map((p, i) => {
    const ok =
      p &&
      typeof p.piece === 'string' &&
      [p.x, p.y, p.angle].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      (p.z === undefined || (typeof p.z === 'number' && Number.isFinite(p.z) && p.z >= 0));
    if (!ok) throw new LayoutFileError(`Piece ${i + 1} in this layout is damaged.`);
    try {
      getPiece(p.piece);
    } catch {
      throw new LayoutFileError(`This layout uses a piece the app doesn't know (${p.piece}).`);
    }
    const pose = { x: p.x, y: p.y, angle: normalizeAngle(deg(p.angle)) };
    return { uid: `p${i + 1}`, pieceId: p.piece, flipped: p.flipped === true, pose, ...(p.z ? { z: p.z } : {}) };
  });
  // An environment this app doesn't know is no reason to refuse the track.
  const environment = environmentId(d.environment);
  return environment ? { pieces, environment } : { pieces };
}

export const layoutToJson = (layout: LayoutFile): string => JSON.stringify(toSaved(layout), null, 2);

export function layoutFromJson(text: string): LayoutFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LayoutFileError("This isn't a track layout file.");
  }
  return fromSaved(data);
}

// ---- share links -----------------------------------------------------------

/** The hash parameter a share link carries its layout in. */
export const LINK_PARAM = 'layout';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** The layout packed for a URL: compact JSON, deflated, base64url. */
export async function encodeLayout(layout: LayoutFile): Promise<string> {
  const json = JSON.stringify(toSaved(layout));
  return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}

export async function decodeLayout(code: string): Promise<LayoutFile> {
  let json: string;
  try {
    json = new TextDecoder().decode(await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw')));
  } catch {
    throw new LayoutFileError('This share link is incomplete or damaged.');
  }
  return layoutFromJson(json);
}

/** A link to `base` (the app's address) that opens with this layout. */
export async function shareUrl(layout: LayoutFile, base: string): Promise<string> {
  const url = new URL(base);
  url.hash = `${LINK_PARAM}=${await encodeLayout(layout)}`;
  return url.toString();
}

/** The layout code in a URL hash like "#layout=…", if there is one. */
export function codeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(LINK_PARAM);
}
