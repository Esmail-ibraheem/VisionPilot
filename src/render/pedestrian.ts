import * as THREE from 'three';
import { createBlobShadowTexture } from './blobShadow';

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x8d8f91, roughness: 0.85, metalness: 0 });
const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x6f7173, roughness: 0.85, metalness: 0 });

let geos: {
  head: THREE.SphereGeometry;
  torso: THREE.CapsuleGeometry;
  leg: THREE.CapsuleGeometry;
  arm: THREE.CapsuleGeometry;
  shadow: THREE.PlaneGeometry;
} | null = null;
let shadowTex: THREE.Texture | null = null;

function getGeos() {
  if (!geos) {
    const shadow = new THREE.PlaneGeometry(0.9, 0.9);
    shadow.rotateX(-Math.PI / 2);
    geos = {
      head: new THREE.SphereGeometry(0.11, 16, 12),
      torso: new THREE.CapsuleGeometry(0.16, 0.42, 6, 14),
      leg: new THREE.CapsuleGeometry(0.075, 0.62, 5, 10),
      arm: new THREE.CapsuleGeometry(0.05, 0.5, 5, 10),
      shadow,
    };
  }
  return geos;
}

/** A simplified 1.75 m walking figure with a small walk cycle driven by `phase`. */
export class PedestrianObject {
  readonly group = new THREE.Group();
  private legs: THREE.Group[] = [];
  private arms: THREE.Group[] = [];

  constructor() {
    const g = getGeos();
    const head = new THREE.Mesh(g.head, bodyMaterial);
    head.position.y = 1.63;
    const torso = new THREE.Mesh(g.torso, bodyMaterial);
    torso.position.y = 1.15;
    this.group.add(head, torso);
    for (const side of [-1, 1]) {
      // Limbs hang from pivots at hip / shoulder height so the walk cycle swings them naturally.
      const hip = new THREE.Group();
      hip.position.set(side * 0.09, 0.86, 0);
      const leg = new THREE.Mesh(g.leg, darkMaterial);
      leg.position.y = -0.39;
      hip.add(leg);
      this.legs.push(hip);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.24, 1.4, 0);
      const arm = new THREE.Mesh(g.arm, bodyMaterial);
      arm.position.y = -0.3;
      shoulder.add(arm);
      this.arms.push(shoulder);
      this.group.add(hip, shoulder);
    }
    if (!shadowTex) shadowTex = createBlobShadowTexture(64, 0.5);
    const shadow = new THREE.Mesh(
      g.shadow,
      new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    shadow.position.y = 0.01;
    this.group.add(shadow);
  }

  setPhase(phase: number): void {
    const swing = Math.sin(phase) * 0.45;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.arms[0].rotation.x = -swing * 0.6;
    this.arms[1].rotation.x = swing * 0.6;
  }
}
