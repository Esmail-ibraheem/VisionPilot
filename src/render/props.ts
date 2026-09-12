import * as THREE from 'three';
import type { LightColor, Props } from '../world/types';
import { toSceneHeading, toSceneX } from './frame';

/** Simplified roadside props in the perception style: traffic signals and stop signs. */

const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.8 });
const housingMat = new THREE.MeshStandardMaterial({ color: 0x5a5c5e, roughness: 0.7 });
const lampOff = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.5 });
const lampOn: Record<LightColor, THREE.MeshStandardMaterial> = {
  red: new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2020, emissiveIntensity: 0.9 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffa000, emissiveIntensity: 0.9 }),
  green: new THREE.MeshStandardMaterial({ color: 0x2fd35a, emissive: 0x20c040, emissiveIntensity: 0.9 }),
};
const signRed = new THREE.MeshStandardMaterial({ color: 0xd8242c, roughness: 0.6 });
const signWhite = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });

let geos: {
  pole: THREE.CylinderGeometry;
  housing: THREE.BoxGeometry;
  lamp: THREE.CylinderGeometry;
  octaW: THREE.CylinderGeometry;
  octaR: THREE.CylinderGeometry;
  signPole: THREE.CylinderGeometry;
} | null = null;

function getGeos() {
  if (!geos) {
    const lamp = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 14);
    lamp.rotateX(Math.PI / 2);
    const octaW = new THREE.CylinderGeometry(0.4, 0.4, 0.04, 8);
    octaW.rotateX(Math.PI / 2);
    octaW.rotateZ(Math.PI / 8);
    const octaR = new THREE.CylinderGeometry(0.33, 0.33, 0.05, 8);
    octaR.rotateX(Math.PI / 2);
    octaR.rotateZ(Math.PI / 8);
    geos = {
      pole: new THREE.CylinderGeometry(0.06, 0.07, 3.3, 10),
      housing: new THREE.BoxGeometry(0.34, 1.0, 0.3),
      lamp,
      octaW,
      octaR,
      signPole: new THREE.CylinderGeometry(0.04, 0.045, 2.2, 8),
    };
  }
  return geos;
}

class TrafficLightObject {
  readonly group = new THREE.Group();
  private lamps: THREE.Mesh[];
  private state: LightColor | null = null;

  constructor() {
    const g = getGeos();
    const pole = new THREE.Mesh(g.pole, poleMat);
    pole.position.y = 1.65;
    const housing = new THREE.Mesh(g.housing, housingMat);
    housing.position.set(0, 3.55, 0);
    this.group.add(pole, housing);
    this.lamps = (['red', 'yellow', 'green'] as const).map((_, i) => {
      const lamp = new THREE.Mesh(g.lamp, lampOff);
      // lamps face +z (local); the object is rotated to `heading`
      lamp.position.set(0, 3.55 + 0.3 - i * 0.3, 0.16);
      this.group.add(lamp);
      return lamp;
    });
  }

  setState(state: LightColor): void {
    if (state === this.state) return;
    this.state = state;
    const order: LightColor[] = ['red', 'yellow', 'green'];
    this.lamps.forEach((lamp, i) => {
      lamp.material = order[i] === state ? lampOn[state] : lampOff;
    });
  }
}

class StopSignObject {
  readonly group = new THREE.Group();

  constructor() {
    const g = getGeos();
    const pole = new THREE.Mesh(g.signPole, poleMat);
    pole.position.y = 1.1;
    const white = new THREE.Mesh(g.octaW, signWhite);
    white.position.set(0, 2.35, 0);
    const red = new THREE.Mesh(g.octaR, signRed);
    red.position.set(0, 2.35, 0.012);
    this.group.add(pole, white, red);
  }
}

export class PropsRenderer {
  readonly group = new THREE.Group();
  private lights = new Map<string, TrafficLightObject>();
  private signs = new Map<string, StopSignObject>();

  update(props: Props): void {
    const seen = new Set<string>();
    for (const l of props.trafficLights) {
      seen.add(l.id);
      let obj = this.lights.get(l.id);
      if (!obj) {
        obj = new TrafficLightObject();
        this.lights.set(l.id, obj);
        this.group.add(obj.group);
      }
      obj.group.position.set(toSceneX(l.x), 0, l.z);
      obj.group.rotation.y = toSceneHeading(l.heading);
      obj.setState(l.state);
    }
    for (const [id, obj] of this.lights) {
      if (!seen.has(id)) {
        this.group.remove(obj.group);
        this.lights.delete(id);
      }
    }
    const seenSigns = new Set<string>();
    for (const s of props.signs) {
      seenSigns.add(s.id);
      let obj = this.signs.get(s.id);
      if (!obj) {
        obj = new StopSignObject();
        this.signs.set(s.id, obj);
        this.group.add(obj.group);
      }
      obj.group.position.set(toSceneX(s.x), 0, s.z);
      obj.group.rotation.y = toSceneHeading(s.heading);
    }
    for (const [id, obj] of this.signs) {
      if (!seenSigns.has(id)) {
        this.group.remove(obj.group);
        this.signs.delete(id);
      }
    }
  }
}
