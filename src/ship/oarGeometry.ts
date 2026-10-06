import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OarSlot } from './oarLayout';

/** The same material coordinates used by evaluateOar and blade clipping. */
export function buildOarGeometry(slot: Readonly<OarSlot>): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.03, 0.042, slot.length, 6, 1)
    .rotateZ(-Math.PI / 2).translate(slot.length / 2 - slot.inboard, 0, 0);
  const blade = new THREE.BoxGeometry(slot.bladeLength, slot.bladeWidth, slot.bladeThickness)
    .translate(slot.bladeRadius, 0, 0);
  const geometry = mergeGeometries([shaft, blade]);
  shaft.dispose(); blade.dispose();
  return geometry;
}
