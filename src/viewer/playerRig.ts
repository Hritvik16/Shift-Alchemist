import * as THREE from 'three';
import { GRAVITY_MODE, type GravityMode } from '../core/balance.ts';
import type { PlumbLineResult } from '../core/physics.ts';
import type { Entity } from '../core/world.ts';

export class PlayerRig {
  public readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly plumbLine: THREE.Line;
  private readonly plumbPositions: Float32Array;
  private readonly plumbRing: THREE.Mesh;
  private readonly plumbLineMat: THREE.LineBasicMaterial;
  private readonly plumbRingMat: THREE.MeshBasicMaterial;
  private currentFlipRad = 0;

  constructor(scene: THREE.Scene) {
    // 0.6 x 1.6 x 0.6 m humanoid exo-suit centered at local y = 0 (-0.8..+0.8)
    const suitMat = new THREE.MeshStandardMaterial({
      color: 0x3b8ea5,
      roughness: 0.42,
      metalness: 0.45,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xd9e6f2,
      roughness: 0.35,
      metalness: 0.55,
    });
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0xff9f1c,
      emissive: 0x663400,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.6,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x5ef2d6,
      emissive: 0x26d9b8,
      emissiveIntensity: 0.85,
      roughness: 0.15,
      metalness: 0.2,
    });
    const tankMat = new THREE.MeshStandardMaterial({
      color: 0x90d8e8,
      transparent: true,
      opacity: 0.72,
      roughness: 0.18,
      metalness: 0.25,
    });

    // Magnetic boots (clearly indicate upSign orientation during 180° -1G flip)
    const bootGeo = new THREE.BoxGeometry(0.18, 0.16, 0.26);
    const leftBoot = new THREE.Mesh(bootGeo, bootMat);
    leftBoot.position.set(-0.13, -0.72, 0.02);
    leftBoot.castShadow = true;
    const rightBoot = new THREE.Mesh(bootGeo, bootMat);
    rightBoot.position.set(0.13, -0.72, 0.02);
    rightBoot.castShadow = true;
    this.body.add(leftBoot, rightBoot);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.085, 0.095, 0.52, 10);
    const leftLeg = new THREE.Mesh(legGeo, suitMat);
    leftLeg.position.set(-0.13, -0.38, 0);
    leftLeg.castShadow = true;
    const rightLeg = new THREE.Mesh(legGeo, suitMat);
    rightLeg.position.set(0.13, -0.38, 0);
    rightLeg.castShadow = true;
    this.body.add(leftLeg, rightLeg);

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.32), suitMat);
    torso.position.set(0, 0.16, 0);
    torso.castShadow = true;
    this.body.add(torso);

    // Shoulder pauldrons
    const pauldronGeo = new THREE.BoxGeometry(0.56, 0.14, 0.34);
    const pauldrons = new THREE.Mesh(pauldronGeo, trimMat);
    pauldrons.position.set(0, 0.36, 0);
    pauldrons.castShadow = true;
    this.body.add(pauldrons);

    // Backpack fluid tank
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 12), tankMat);
    tank.position.set(0, 0.18, 0.22);
    tank.castShadow = true;
    this.body.add(tank);

    // Helmet + glowing visor
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), trimMat);
    helmet.position.set(0, 0.61, 0);
    helmet.castShadow = true;
    this.body.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.12), visorMat);
    visor.position.set(0, 0.62, -0.14);
    this.body.add(visor);

    this.root.add(this.body);
    scene.add(this.root);

    // Deck-relative Laser Plumb-Line + Surface Ring (3D Overlay Pass)
    this.plumbPositions = new Float32Array(6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.plumbPositions, 3));
    this.plumbLineMat = new THREE.LineBasicMaterial({
      color: 0x38e8ff,
      transparent: true,
      opacity: 0.85,
    });
    this.plumbLine = new THREE.Line(lineGeo, this.plumbLineMat);
    this.plumbLine.frustumCulled = false;
    this.plumbLine.visible = false;
    scene.add(this.plumbLine);

    const ringGeo = new THREE.RingGeometry(0.22, 0.34, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.plumbRingMat = new THREE.MeshBasicMaterial({
      color: 0x38e8ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.plumbRing = new THREE.Mesh(ringGeo, this.plumbRingMat);
    this.plumbRing.visible = false;
    scene.add(this.plumbRing);
  }

  public update(
    entity: Entity,
    mode: GravityMode,
    plumb: PlumbLineResult,
    dt: number,
  ): void {
    // Center rig inside AABB [y, y + height]
    this.root.position.set(entity.x, entity.y + entity.height * 0.5, entity.z);

    // Face movement direction when moving
    const horizSpeedSq = entity.vx * entity.vx + entity.vz * entity.vz;
    if (horizSpeedSq > 0.25) {
      const targetYaw = Math.atan2(-entity.vx, -entity.vz);
      this.root.rotation.y = targetYaw;
    }

    // Smooth 180° gyro boot flip when upSign toggles (+1 <-> -1)
    const targetFlip = entity.upSign === 1 ? 0 : Math.PI;
    const diff = targetFlip - this.currentFlipRad;
    const step = Math.min(Math.abs(diff), 16.0 * dt) * Math.sign(diff);
    this.currentFlipRad += step;
    this.body.rotation.z = this.currentFlipRad;

    // Update Laser Plumb-Line & Surface Ring
    if (plumb.visible) {
      const colorHex =
        mode === GRAVITY_MODE.GN1
          ? 0xff4fd8
          : mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3
            ? 0xffaa2b
            : 0x38e8ff;
      this.plumbLineMat.color.setHex(colorHex);
      this.plumbRingMat.color.setHex(colorHex);

      this.plumbPositions[0] = plumb.originX;
      this.plumbPositions[1] = plumb.originY;
      this.plumbPositions[2] = plumb.originZ;
      this.plumbPositions[3] = plumb.originX;
      this.plumbPositions[4] = plumb.hitY;
      this.plumbPositions[5] = plumb.originZ;
      (this.plumbLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.plumbLine.visible = true;

      // Offset ring 1.5 cm off surface along -plumbDir to prevent z-fighting
      this.plumbRing.position.set(
        plumb.originX,
        plumb.hitY - plumb.plumbDir * 0.015,
        plumb.originZ,
      );
      this.plumbRing.visible = true;
    } else {
      this.plumbLine.visible = false;
      this.plumbRing.visible = false;
    }
  }
}
