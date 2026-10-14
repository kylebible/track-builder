import * as THREE from 'three';
import * as D from '../pieces/dimensions';
import { baseOf, defOf, sameEnd, type EndRef, type Layout, type WorldEnd } from '../layout/layout';
import { supportsOf } from '../layout/supports';
import { buildPieceObject, buildSupport, toWorld } from '../render/pieceMesh';

// Keeps three.js objects in step with a layout: one object per placed
// piece, plus a marker on every open end that can be clicked to build from.

export interface ViewState {
  layout: Layout;
  openEnds: WorldEnd[];
  selectedPieces: ReadonlySet<string>;
  selectedEnd: EndRef | null;
  /** Where a dragged piece is snapping on, shown as a ring; `z` is its height. */
  snapAt: { x: number; y: number; z?: number } | null;
  /** Problems the layout check found, shown as red rings on the track. */
  marks: { at: { x: number; y: number }; z?: number; focused: boolean }[];
}

const MARKER_RADIUS = 11;
/** Markers float a little above the track top, so they read as buttons. */
const MARKER_LIFT = 6;
const markerGeometry = new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 4, 40);
const rimGeometry = new THREE.TorusGeometry(MARKER_RADIUS, 1.8, 10, 40);
const ringGeometry = new THREE.TorusGeometry(MARKER_RADIUS + 6, 2.2, 10, 48);
const markGeometry = new THREE.TorusGeometry(34, 3, 10, 64);
const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
const markerMaterial = {
  peg: new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.45 }),
  hole: new THREE.MeshStandardMaterial({ color: 0xe0832b, roughness: 0.45 }),
  selected: new THREE.MeshStandardMaterial({ color: 0x1f9d55, emissive: 0x1f9d55, emissiveIntensity: 0.4 }),
  snap: new THREE.MeshStandardMaterial({ color: 0x1f9d55, emissive: 0x1f9d55, emissiveIntensity: 0.8 }),
  problem: new THREE.MeshStandardMaterial({ color: 0xc8352b, emissive: 0xc8352b, emissiveIntensity: 0.5 }),
};

/** Highlighted copies of piece materials, made once per material. */
const highlighted = new Map<THREE.Material, THREE.Material>();
function highlight(material: THREE.Material): THREE.Material {
  let copy = highlighted.get(material);
  if (!copy) {
    copy = material.clone();
    if (copy instanceof THREE.MeshStandardMaterial) {
      copy.emissive.set(0x1f9d55);
      copy.emissiveIntensity = 0.3;
    }
    highlighted.set(material, copy);
  }
  return copy;
}

/** Each piece mesh's own material, to restore after highlighting. */
const baseMaterials = new WeakMap<THREE.Mesh, THREE.Material>();

interface PieceEntry {
  key: string;
  object: THREE.Group;
  selected: boolean;
}

export class LayoutView {
  readonly root = new THREE.Group();
  private readonly piecesRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();
  private readonly supportsRoot = new THREE.Group();
  private supportsKey = '';
  private readonly entries = new Map<string, PieceEntry>();
  private readonly templates = new Map<string, THREE.Group>();
  /** Rings that gently pulse: the selected end and the snap target. */
  private pulsing: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene) {
    this.root.add(this.piecesRoot, this.supportsRoot, this.markersRoot);
    scene.add(this.root);
  }

  /** Objects that clicks and drags can hit: markers first, then pieces. */
  get pickables(): THREE.Object3D[] {
    return [this.markersRoot, this.piecesRoot];
  }

  private template(key: string, pieceId: string, flipped: boolean): THREE.Group {
    let t = this.templates.get(key);
    if (!t) {
      t = buildPieceObject(defOf({ pieceId, flipped }));
      this.templates.set(key, t);
    }
    return t;
  }

  update(state: ViewState): void {
    const seen = new Set<string>();
    for (const piece of state.layout.pieces) {
      seen.add(piece.uid);
      const key = `${piece.pieceId}${piece.flipped ? ':flipped' : ''}`;
      let entry = this.entries.get(piece.uid);
      if (!entry || entry.key !== key) {
        if (entry) this.piecesRoot.remove(entry.object);
        const object = this.template(key, piece.pieceId, piece.flipped).clone(true);
        object.traverse((o) => {
          o.userData.uid = piece.uid;
          if (o instanceof THREE.Mesh) baseMaterials.set(o, o.material);
        });
        entry = { key, object, selected: false };
        this.entries.set(piece.uid, entry);
        this.piecesRoot.add(object);
      }
      entry.object.position.copy(toWorld(piece.pose.x, piece.pose.y, baseOf(piece)));
      entry.object.rotation.y = piece.pose.angle;
      const selected = state.selectedPieces.has(piece.uid);
      if (selected !== entry.selected) {
        entry.selected = selected;
        entry.object.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const base = baseMaterials.get(o)!;
          o.material = selected ? highlight(base) : base;
        });
      }
    }
    for (const [uid, entry] of this.entries) {
      if (!seen.has(uid)) {
        this.piecesRoot.remove(entry.object);
        this.entries.delete(uid);
      }
    }
    this.updateSupports(state.layout);
    this.updateMarkers(state);
  }

  /** Support stacks under raised ends, rebuilt only when they change. */
  private updateSupports(layout: Layout): void {
    const supports = supportsOf(layout);
    const key = supports.map((s) => `${s.at.x.toFixed(1)},${s.at.y.toFixed(1)},${s.angle.toFixed(3)},${s.height},${s.blocks}`).join(';');
    if (key === this.supportsKey) return;
    this.supportsKey = key;
    this.supportsRoot.clear();
    for (const s of supports) this.supportsRoot.add(buildSupport(s.at.x, s.at.y, s.angle, s.height, s.blocks));
  }

  /** Animate the pulsing rings; call once a frame with the time in ms. */
  tick(time: number): void {
    const s = 1 + 0.12 * Math.sin(time / 220);
    for (const ring of this.pulsing) ring.scale.setScalar(ring.userData.baseScale * s);
  }

  private updateMarkers(state: ViewState): void {
    this.markersRoot.clear();
    this.pulsing = [];
    for (const end of state.openEnds) {
      const isSelected = state.selectedEnd !== null && sameEnd(state.selectedEnd, end);
      const material = isSelected ? markerMaterial.selected : markerMaterial[end.connector.gender];
      const marker = new THREE.Mesh(markerGeometry, material);
      const { x, y } = end.connector.pose;
      marker.position.copy(toWorld(x, y, (end.connector.z ?? 0) + D.TRACK_HEIGHT + MARKER_LIFT));
      marker.userData.end = { uid: end.uid, connectorId: end.connectorId } satisfies EndRef;
      const rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.rotation.x = Math.PI / 2;
      rim.position.copy(marker.position);
      rim.userData.end = marker.userData.end;
      this.markersRoot.add(marker, rim);
      if (isSelected) this.addRing(marker.position, material, 1, marker.userData.end);
    }
    for (const mark of state.marks) {
      const at = toWorld(mark.at.x, mark.at.y, (mark.z ?? 0) + D.TRACK_HEIGHT + 2);
      const ring = new THREE.Mesh(markGeometry, markerMaterial.problem);
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(at);
      ring.userData.baseScale = 1;
      this.markersRoot.add(ring);
      // Only the one being looked at pulses, so a busy layout stays calm.
      if (mark.focused) this.pulsing.push(ring);
    }
    if (state.snapAt) {
      this.addRing(toWorld(state.snapAt.x, state.snapAt.y, (state.snapAt.z ?? 0) + D.TRACK_HEIGHT + MARKER_LIFT), markerMaterial.snap, 1.4);
    }
  }

  private addRing(at: THREE.Vector3, material: THREE.Material, scale: number, end?: EndRef): void {
    const ring = new THREE.Mesh(ringGeometry, material);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(at);
    ring.scale.setScalar(scale);
    ring.userData.baseScale = scale;
    if (end) ring.userData.end = end;
    this.markersRoot.add(ring);
    this.pulsing.push(ring);
  }
}
