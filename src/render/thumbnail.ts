import * as THREE from 'three';

// Small still pictures of 3D objects, for palette tiles. One offscreen
// renderer is shared and made on first use.

const SIZE = 128;
let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a88f, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 2, 1.5);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);

/** A PNG data URL of `object` seen from the front, a little above. */
export function thumbnail(object: THREE.Object3D): string {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE);
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  const direction = new THREE.Vector3(0.9, 0.75, 1).normalize();
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.lookAt(sphere.center);
  renderer.render(scene, camera);
  scene.remove(object);
  return renderer.domElement.toDataURL();
}
