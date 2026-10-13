import * as THREE from 'three';
import * as D from '../pieces/dimensions';
import { defOf, sameEnd, type EndRef, type Layout, type WorldEnd } from '../layout/layout';
import { buildPieceObject, toWorld } from '../render/pieceMesh';

// Keeps three.js objects in step with a layout: one object per placed
// piece, plus a marker on every open end that can be clicked to build from.

export interface ViewState {
  layout: Layout;
  openEnds: WorldEnd[];
  selectedPieces: ReadonlySet<string>;
  selectedEnd: EndRef | null;
  /** Where a dragged piece is snapping on, shown as a ring. */
  snapAt: { x: number; y: number } | null;
}

const MARKER_RADIUS = 11;
const markerGeometry = new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 3, 32);
const ringGeometry = new THREE.TorusGeometry(MARKER_RADIUS + 5, 2, 8, 40);
const markerMaterial = {
  peg: new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.5 }),
  hole: new THREE.MeshStandardMaterial({ color: 0xe0832b, roughness: 0.5 }),
  selected: new THREE.MeshStandardMaterial({ color: 0x1f9d55, emissive: 0x1f9d55, emissiveIntensity: 0.4 }),
  snap: new THREE.MeshStandardMaterial({ color: 0x1f9d55, emissive: 0x1f9d55, emissiveIntensity: 0.8 }),
};

/** Highlighted copies of piece materials, made once per material. */
const highlighted = new Map<THREE.Material, THREE.Material>();
function highlight(material: THREE.Material): THREE.Material {
  let copy = highlighted.get(material);
  if (!copy) {
    copy = material.clone();
    if (copy instanceof THREE.MeshStandardMaterial) {
      copy.emissive.set(0x2f6fd6);
      copy.emissiveIntensity = 0.35;
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
  private readonly entries = new Map<string, PieceEntry>();
  private readonly templates = new Map<string, THREE.Group>();

  constructor(scene: THREE.Scene) {
    this.root.add(this.piecesRoot, this.markersRoot);
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
      entry.object.position.copy(toWorld(piece.pose.x, piece.pose.y));
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
    this.updateMarkers(state);
  }

  private updateMarkers(state: ViewState): void {
    this.markersRoot.clear();
    for (const end of state.openEnds) {
      const isSelected = state.selectedEnd !== null && sameEnd(state.selectedEnd, end);
      const material = isSelected ? markerMaterial.selected : markerMaterial[end.connector.gender];
      const marker = new THREE.Mesh(markerGeometry, material);
      const { x, y } = end.connector.pose;
      marker.position.copy(toWorld(x, y, D.TRACK_HEIGHT + 4));
      marker.userData.end = { uid: end.uid, connectorId: end.connectorId } satisfies EndRef;
      this.markersRoot.add(marker);
      if (isSelected) {
        const ring = new THREE.Mesh(ringGeometry, material);
        ring.rotation.x = Math.PI / 2;
        ring.position.copy(marker.position);
        ring.userData.end = marker.userData.end;
        this.markersRoot.add(ring);
      }
    }
    if (state.snapAt) {
      const ring = new THREE.Mesh(ringGeometry, markerMaterial.snap);
      ring.rotation.x = Math.PI / 2;
      ring.scale.setScalar(1.4);
      ring.position.copy(toWorld(state.snapAt.x, state.snapAt.y, D.TRACK_HEIGHT + 4));
      this.markersRoot.add(ring);
    }
  }
}
