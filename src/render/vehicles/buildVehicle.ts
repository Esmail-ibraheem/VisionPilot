import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildBodyGeometry, monotoneCurve, type BodySpec } from './loft';
import { BODY_SPECS, type BodyKind } from './specs';
import { createBlobShadowTexture } from '../blobShadow';
import { disposeDvTemplates, getDvTemplate } from './dvTemplate';

/**
 * Vehicle look: 'dv' = the car models from the sibling `driving-visualization` project (default),
 * 'loft' = this app's own cross-section lofts.
 */
export type VehicleStyle = 'dv' | 'loft';

/** Palette for the simplified "perception" look. */
export const PALETTE = {
  background: 0xf1f1f1,
  bodyGray: 0xc2c2c2,
  glassGray: 0x8b8e91,
  trimGray: 0xa9a9a9,
  tire: 0x3a3a3c,
  rim: 0x9c9c9c,
  egoBody: 0x1a1b1d,
  egoGlass: 0x363940,
  egoRim: 0x555759,
  headlight: 0xf4f4f4,
  taillightOff: 0x8a3a3a,
  taillightOn: 0xff2f2f,
};

/** Per body kind: shared geometries. Sub-parts are pre-merged so a vehicle costs ~9 draw calls. */
interface Template {
  spec: BodySpec;
  body: THREE.BufferGeometry;
  tires: THREE.BufferGeometry;
  rims: THREE.BufferGeometry;
  headlights: THREE.BufferGeometry;
  taillights: THREE.BufferGeometry;
  mirrors: THREE.BufferGeometry;
  shadow: THREE.PlaneGeometry;
}

function placed(geometry: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = geometry.clone();
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

const templates = new Map<BodyKind, Template>();
let blobTexture: THREE.Texture | null = null;

function getTemplate(kind: BodyKind): Template {
  let t = templates.get(kind);
  if (t) return t;
  const spec = BODY_SPECS[kind];
  const { geometry } = buildBodyGeometry(spec);
  const top = monotoneCurve(spec.top);
  const halfWidth = monotoneCurve(spec.halfWidth);
  const belt = monotoneCurve(spec.belt);

  // Wheels: tyre cylinders plus flat rim discs just proud of the outer faces.
  const w = spec.wheels;
  const tire = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 28, 1, false);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CircleGeometry(w.radius * 0.6, 20);
  rim.rotateY(Math.PI / 2);
  const tireParts: THREE.BufferGeometry[] = [];
  const rimParts: THREE.BufferGeometry[] = [];
  for (const z of [w.frontZ, w.rearZ]) {
    for (const side of [-1, 1]) {
      tireParts.push(placed(tire, (side * w.track) / 2, w.radius, z));
      rimParts.push(placed(rim, side * (w.track / 2 + w.width / 2 + 0.004), w.radius, z, side < 0 ? Math.PI : 0));
    }
  }

  // Lights sit on the flat nose / tail faces (the loft's end caps); mirrors embed in the A-pillar base.
  const zNose = spec.length / 2;
  const zTail = -spec.length / 2;
  const noseCapTop = top(zNose) - spec.noseEdge;
  const tailCapTop = top(zTail) - spec.tailEdge;
  const noseCapHalf = Math.max(0.25, halfWidth(zNose) - Math.min(spec.noseRadius, halfWidth(zNose) * 0.95));
  const tailCapHalf = Math.max(0.25, halfWidth(zTail) - Math.min(spec.tailRadius, halfWidth(zTail) * 0.95));
  const headlight = new THREE.BoxGeometry(0.28, 0.055, 0.03, 1, 1, 1);
  const taillight = new THREE.BoxGeometry(0.24, 0.05, 0.03, 1, 1, 1);
  const mirror = new THREE.SphereGeometry(1, 12, 8);
  mirror.scale(0.1, 0.045, 0.075);
  const zMirror = spec.glass.zFront - 0.1;
  const headParts: THREE.BufferGeometry[] = [];
  const tailParts: THREE.BufferGeometry[] = [];
  const mirrorParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    headParts.push(placed(headlight, side * noseCapHalf * 0.72, noseCapTop - 0.09, zNose + 0.01));
    tailParts.push(placed(taillight, side * tailCapHalf * 0.68, tailCapTop - 0.08, zTail - 0.012));
    mirrorParts.push(placed(mirror, side * (halfWidth(zMirror) + 0.02), belt(zMirror) + 0.04, zMirror));
  }
  const merge = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('Failed to merge vehicle part geometry');
    return merged;
  };
  const shadow = new THREE.PlaneGeometry(spec.width + 0.6, spec.length + 0.5);
  shadow.rotateX(-Math.PI / 2);
  t = {
    spec,
    body: geometry,
    tires: merge(tireParts),
    rims: merge(rimParts),
    headlights: merge(headParts),
    taillights: merge(tailParts),
    mirrors: merge(mirrorParts),
    shadow,
  };
  tire.dispose();
  rim.dispose();
  headlight.dispose();
  taillight.dispose();
  mirror.dispose();
  templates.set(kind, t);
  return t;
}

function getBlobTexture(): THREE.Texture {
  if (!blobTexture) blobTexture = createBlobShadowTexture(256, 0.32);
  return blobTexture;
}

const sharedMaterials = {
  tire: new THREE.MeshStandardMaterial({ color: PALETTE.tire, roughness: 0.95, metalness: 0 }),
  rim: new THREE.MeshStandardMaterial({ color: PALETTE.rim, roughness: 0.6, metalness: 0.2 }),
  egoRim: new THREE.MeshStandardMaterial({ color: PALETTE.egoRim, roughness: 0.5, metalness: 0.4 }),
  headlight: new THREE.MeshStandardMaterial({ color: PALETTE.headlight, roughness: 0.4, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.25 }),
  glass: new THREE.MeshStandardMaterial({ color: PALETTE.glassGray, roughness: 0.55, metalness: 0.05 }),
  trim: new THREE.MeshStandardMaterial({ color: PALETTE.trimGray, roughness: 0.85, metalness: 0 }),
  egoBody: new THREE.MeshStandardMaterial({ color: PALETTE.egoBody, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.8 }),
  egoGlass: new THREE.MeshStandardMaterial({ color: PALETTE.egoGlass, roughness: 0.3, metalness: 0.55, envMapIntensity: 1.3 }),
  egoTrim: new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.6, metalness: 0.2 }),
};

export function getSharedVehicleMaterials(): typeof sharedMaterials {
  return sharedMaterials;
}

/**
 * A vehicle instance in the scene. Geometry is shared per body kind; body colour and tail lights
 * are per-instance so tint and brake state can vary.
 */
export class VehicleObject {
  readonly group = new THREE.Group();
  readonly kind: BodyKind;
  readonly style: VehicleStyle;
  private bodyMaterial: THREE.MeshStandardMaterial | null = null;
  private tailMaterial: THREE.MeshStandardMaterial;
  private tailOffColor = PALETTE.taillightOff;
  private shadowMaterial: THREE.MeshBasicMaterial;
  private brake = false;

  constructor(kind: BodyKind, style: VehicleStyle = 'dv') {
    this.kind = kind;
    this.style = style;
    const isEgo = kind === 'ego';
    if (style === 'dv') {
      const dv = getDvTemplate(kind);
      for (const p of dv.parts) this.group.add(new THREE.Mesh(p.geometry, p.material));
      if (dv.tail) {
        this.tailMaterial = dv.tail.material.clone();
        this.tailOffColor = dv.tail.material.color.getHex();
        this.tailMaterial.emissive = new THREE.Color(PALETTE.taillightOn);
        this.tailMaterial.emissiveIntensity = 0;
        this.group.add(new THREE.Mesh(dv.tail.geometry, this.tailMaterial));
      } else {
        this.tailMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.taillightOff });
      }
      this.shadowMaterial = new THREE.MeshBasicMaterial({
        map: getBlobTexture(),
        transparent: true,
        depthWrite: false,
        opacity: isEgo ? 0.45 : 0.34,
        color: 0x000000,
      });
      const shadowGeo = new THREE.PlaneGeometry(dv.width + 0.6, dv.length + 0.5);
      shadowGeo.rotateX(-Math.PI / 2);
      const shadow = new THREE.Mesh(shadowGeo, this.shadowMaterial);
      shadow.position.y = 0.01;
      shadow.renderOrder = -1;
      this.group.add(shadow);
      return;
    }
    const t = getTemplate(kind);

    this.bodyMaterial = isEgo
      ? sharedMaterials.egoBody
      : new THREE.MeshStandardMaterial({ color: PALETTE.bodyGray, roughness: 0.72, metalness: 0.0, envMapIntensity: 0.35 });
    this.tailMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.taillightOff,
      roughness: 0.4,
      metalness: 0,
      emissive: PALETTE.taillightOn,
      emissiveIntensity: 0,
    });

    const body = new THREE.Mesh(t.body, [
      this.bodyMaterial,
      isEgo ? sharedMaterials.egoGlass : sharedMaterials.glass,
      isEgo ? sharedMaterials.egoTrim : sharedMaterials.trim,
    ]);
    body.name = 'body';
    this.group.add(body);

    const rimMat = isEgo ? sharedMaterials.egoRim : sharedMaterials.rim;
    this.group.add(
      new THREE.Mesh(t.tires, sharedMaterials.tire),
      new THREE.Mesh(t.rims, rimMat),
      new THREE.Mesh(t.headlights, sharedMaterials.headlight),
      new THREE.Mesh(t.taillights, this.tailMaterial),
      new THREE.Mesh(t.mirrors, isEgo ? sharedMaterials.egoTrim : this.bodyMaterial),
    );

    // Soft contact shadow.
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: getBlobTexture(),
      transparent: true,
      depthWrite: false,
      opacity: isEgo ? 0.45 : 0.34,
      color: 0x000000,
    });
    const shadow = new THREE.Mesh(t.shadow, this.shadowMaterial);
    shadow.position.y = 0.01;
    shadow.renderOrder = -1;
    this.group.add(shadow);
  }

  setBrake(on: boolean): void {
    if (on === this.brake) return;
    this.brake = on;
    this.tailMaterial.emissiveIntensity = on ? 0.75 : 0;
    this.tailMaterial.color.setHex(on ? 0xd02020 : this.tailOffColor);
  }

  /** 0..1 → slightly darker .. slightly lighter gray. */
  setTint(t: number): void {
    if (this.kind === 'ego' || !this.bodyMaterial) return;
    const l = 0.76 + (t - 0.5) * 0.08;
    this.bodyMaterial.color.setHSL(0, 0, l);
  }

  dispose(): void {
    if (this.kind !== 'ego' && this.bodyMaterial) this.bodyMaterial.dispose();
    this.tailMaterial.dispose();
    this.shadowMaterial.dispose();
    if (this.style === 'dv') {
      // the shadow plane is per instance in this style
      for (const o of this.group.children) if (o instanceof THREE.Mesh && o.material === this.shadowMaterial) o.geometry.dispose();
    }
  }
}

export function disposeVehicleTemplates(): void {
  for (const t of templates.values()) {
    t.body.dispose();
    t.tires.dispose();
    t.rims.dispose();
    t.headlights.dispose();
    t.taillights.dispose();
    t.mirrors.dispose();
    t.shadow.dispose();
  }
  templates.clear();
  blobTexture?.dispose();
  blobTexture = null;
  disposeDvTemplates();
}
