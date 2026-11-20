import * as THREE from 'three';
import {
  AIR_BURST_RANGE_M,
  GRAVITY_ACCEL_BY_MODE,
  GRAVITY_MODE,
  LOCKON_RANGE_M,
  MAT,
  MATERIAL_SPEC,
  NOZZLE_HOLD_SPEED_M_S,
  NOZZLE_TAP_SPEED_M_S,
  PLAYER_TORSO_OFFSET_M,
  VOXEL_SIZE_M,
  nozzlePressureMult,
  type GravityMode,
} from '../core/balance.ts';
import type { PlumbLineResult } from '../core/physics.ts';
import { cellIndex, getMat, inRoomBounds, isSolidMat, type RoomState } from '../core/types.ts';
import {
  getActiveChamber,
  type Entity,
  type PlayerTankState,
  type SuitActionState,
} from '../core/world.ts';

const RIBBON_SEGMENTS = 12;
const AIM_ARC_POINTS = 28;

export class PlayerRig {
  public readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly tankFillMesh: THREE.Mesh;
  private readonly tankFillMat: THREE.MeshStandardMaterial;
  private readonly plumbLine: THREE.Line;
  private readonly plumbPositions: Float32Array;
  private readonly plumbRing: THREE.Mesh;
  private readonly plumbLineMat: THREE.LineBasicMaterial;
  private readonly plumbRingMat: THREE.MeshBasicMaterial;
  private readonly siphonRibbon: THREE.Line;
  private readonly siphonPositions: Float32Array;
  private readonly siphonMat: THREE.LineBasicMaterial;
  private readonly siphonRing: THREE.Mesh;
  private readonly siphonRingMat: THREE.MeshBasicMaterial;

  // Diegetic Nozzle Aim Arc + Splash Landing Ring + 0G Altitude Drop-Line
  private readonly aimArcLine: THREE.Line;
  private readonly aimArcPositions: Float32Array;
  private readonly aimArcMat: THREE.LineBasicMaterial;
  private readonly aimLandingRing: THREE.Mesh;
  private readonly aimLandingRingMat: THREE.MeshBasicMaterial;
  private readonly aimDropLine: THREE.Line;
  private readonly aimDropPositions: Float32Array;
  private readonly aimDropMat: THREE.LineBasicMaterial;

  private currentFlipRad = 0;

  constructor(scene: THREE.Scene) {
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
    const tankShellMat = new THREE.MeshStandardMaterial({
      color: 0x90d8e8,
      transparent: true,
      opacity: 0.36,
      roughness: 0.18,
      metalness: 0.25,
      depthWrite: false,
    });
    this.tankFillMat = new THREE.MeshStandardMaterial({
      color: 0x2b95d6,
      emissive: 0x0e334a,
      emissiveIntensity: 0.55,
      roughness: 0.25,
      metalness: 0.15,
    });

    const bootGeo = new THREE.BoxGeometry(0.18, 0.16, 0.26);
    const leftBoot = new THREE.Mesh(bootGeo, bootMat);
    leftBoot.position.set(-0.13, -0.72, 0.02);
    leftBoot.castShadow = true;
    const rightBoot = new THREE.Mesh(bootGeo, bootMat);
    rightBoot.position.set(0.13, -0.72, 0.02);
    rightBoot.castShadow = true;
    this.body.add(leftBoot, rightBoot);

    const legGeo = new THREE.CylinderGeometry(0.085, 0.095, 0.52, 10);
    const leftLeg = new THREE.Mesh(legGeo, suitMat);
    leftLeg.position.set(-0.13, -0.38, 0);
    leftLeg.castShadow = true;
    const rightLeg = new THREE.Mesh(legGeo, suitMat);
    rightLeg.position.set(0.13, -0.38, 0);
    rightLeg.castShadow = true;
    this.body.add(leftLeg, rightLeg);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.32), suitMat);
    torso.position.set(0, 0.16, 0);
    torso.castShadow = true;
    this.body.add(torso);

    const pauldronGeo = new THREE.BoxGeometry(0.56, 0.14, 0.34);
    const pauldrons = new THREE.Mesh(pauldronGeo, trimMat);
    pauldrons.position.set(0, 0.36, 0);
    pauldrons.castShadow = true;
    this.body.add(pauldrons);

    const tankShell = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.52, 12), tankShellMat);
    tankShell.position.set(0, 0.18, 0.22);
    this.body.add(tankShell);

    const tankFillGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.46, 12);
    tankFillGeo.translate(0, 0.23, 0);
    this.tankFillMesh = new THREE.Mesh(tankFillGeo, this.tankFillMat);
    this.tankFillMesh.position.set(0, -0.05, 0.22);
    this.tankFillMesh.visible = false;
    this.body.add(this.tankFillMesh);

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), trimMat);
    helmet.position.set(0, 0.61, 0);
    helmet.castShadow = true;
    this.body.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.12), visorMat);
    visor.position.set(0, 0.62, -0.14);
    this.body.add(visor);

    this.root.add(this.body);
    scene.add(this.root);

    // Deck-relative Laser Plumb-Line + Surface Ring
    this.plumbPositions = new Float32Array(6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.plumbPositions, 3));
    this.plumbLineMat = new THREE.LineBasicMaterial({
      color: 0x38e8ff,
      transparent: true,
      opacity: 0.9,
    });
    this.plumbLine = new THREE.Line(lineGeo, this.plumbLineMat);
    this.plumbLine.frustumCulled = false;
    this.plumbLine.visible = false;
    scene.add(this.plumbLine);

    const ringGeo = new THREE.RingGeometry(0.24, 0.38, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.plumbRingMat = new THREE.MeshBasicMaterial({
      color: 0x38e8ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.plumbRing = new THREE.Mesh(ringGeo, this.plumbRingMat);
    this.plumbRing.visible = false;
    scene.add(this.plumbRing);

    // Cosmetic Siphon Ribbon + Intake Ring
    this.siphonPositions = new Float32Array((RIBBON_SEGMENTS + 1) * 3);
    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(this.siphonPositions, 3));
    this.siphonMat = new THREE.LineBasicMaterial({
      color: 0x5be7ff,
      transparent: true,
      opacity: 0.92,
    });
    this.siphonRibbon = new THREE.Line(ribbonGeo, this.siphonMat);
    this.siphonRibbon.frustumCulled = false;
    this.siphonRibbon.visible = false;
    scene.add(this.siphonRibbon);

    const sRingGeo = new THREE.RingGeometry(0.12, 0.24, 18);
    sRingGeo.rotateX(-Math.PI / 2);
    this.siphonRingMat = new THREE.MeshBasicMaterial({
      color: 0x5be7ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.siphonRing = new THREE.Mesh(sRingGeo, this.siphonRingMat);
    this.siphonRing.visible = false;
    scene.add(this.siphonRing);

    // Nozzle Aim Arc + Splash Landing Ring + 0G Aim Drop-Line
    this.aimArcPositions = new Float32Array(AIM_ARC_POINTS * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(this.aimArcPositions, 3));
    this.aimArcMat = new THREE.LineBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.62,
    });
    this.aimArcLine = new THREE.Line(arcGeo, this.aimArcMat);
    this.aimArcLine.frustumCulled = false;
    scene.add(this.aimArcLine);

    const landRingGeo = new THREE.RingGeometry(0.14, 0.26, 20);
    landRingGeo.rotateX(-Math.PI / 2);
    this.aimLandingRingMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    this.aimLandingRing = new THREE.Mesh(landRingGeo, this.aimLandingRingMat);
    this.aimLandingRing.visible = false;
    scene.add(this.aimLandingRing);

    this.aimDropPositions = new Float32Array(6);
    const dropGeo = new THREE.BufferGeometry();
    dropGeo.setAttribute('position', new THREE.BufferAttribute(this.aimDropPositions, 3));
    this.aimDropMat = new THREE.LineBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.35,
    });
    this.aimDropLine = new THREE.Line(dropGeo, this.aimDropMat);
    this.aimDropLine.frustumCulled = false;
    this.aimDropLine.visible = false;
    scene.add(this.aimDropLine);
  }

  private updateAimIndicator(
    room: RoomState,
    entity: Entity,
    tank: PlayerTankState,
    suit: SuitActionState,
    mode: GravityMode,
    nozzlePressureRank: number,
  ): void {
    const chamber = getActiveChamber(tank);
    const loaded = chamber.liters > 0 && chamber.mat !== MAT.AIR;
    const colorHex = loaded
      ? chamber.mat === MAT.OIL
        ? 0xd4955a
        : (MATERIAL_SPEC[chamber.mat]?.colorHex ?? 0x7ef9ff)
      : 0x7ef9ff;
    this.aimArcMat.color.setHex(colorHex);
    this.aimLandingRingMat.color.setHex(colorHex);
    this.aimDropMat.color.setHex(colorHex);

    const ox = entity.x + suit.aimDirX * 0.42;
    const oy = entity.y + PLAYER_TORSO_OFFSET_M + suit.aimDirY * 0.42;
    const oz = entity.z + suit.aimDirZ * 0.42;

    let endX = ox;
    let endY = oy;
    let endZ = oz;
    let usedPts = 1;

    this.aimArcPositions[0] = ox;
    this.aimArcPositions[1] = oy;
    this.aimArcPositions[2] = oz;

    if (loaded && mode !== GRAVITY_MODE.G0) {
      const speed =
        (suit.nozzleHoseActive ? NOZZLE_HOLD_SPEED_M_S : NOZZLE_TAP_SPEED_M_S) *
        nozzlePressureMult(nozzlePressureRank);
      const gAccel = GRAVITY_ACCEL_BY_MODE[mode];
      const dtStep = 0.032;
      let px = ox;
      let py = oy;
      let pz = oz;
      let vx = suit.aimDirX * speed;
      let vy = suit.aimDirY * speed;
      let vz = suit.aimDirZ * speed;

      for (let i = 1; i < AIM_ARC_POINTS; i++) {
        vy += gAccel * dtStep;
        const nx = px + vx * dtStep;
        const ny = py + vy * dtStep;
        const nz = pz + vz * dtStep;
        const gx = Math.floor(nx / VOXEL_SIZE_M);
        const gy = Math.floor(ny / VOXEL_SIZE_M);
        const gz = Math.floor(nz / VOXEL_SIZE_M);
        const hitSolid =
          !inRoomBounds(room, gx, gy, gz) || isSolidMat(getMat(room.grid[cellIndex(gx, gy, gz)]));
        const base = i * 3;
        if (hitSolid) {
          this.aimArcPositions[base] = px;
          this.aimArcPositions[base + 1] = py;
          this.aimArcPositions[base + 2] = pz;
          endX = px;
          endY = py;
          endZ = pz;
          usedPts = i + 1;
          break;
        }
        px = nx;
        py = ny;
        pz = nz;
        this.aimArcPositions[base] = px;
        this.aimArcPositions[base + 1] = py;
        this.aimArcPositions[base + 2] = pz;
        endX = px;
        endY = py;
        endZ = pz;
        usedPts = i + 1;
      }
    } else {
      // Straight aim ray (Air Burst or 0G fluid shot) up to 8.0 m or first solid hit
      const maxDist = loaded ? LOCKON_RANGE_M : AIR_BURST_RANGE_M;
      const stepM = maxDist / (AIM_ARC_POINTS - 1);
      for (let i = 1; i < AIM_ARC_POINTS; i++) {
        const d = i * stepM;
        const nx = ox + suit.aimDirX * d;
        const ny = oy + suit.aimDirY * d;
        const nz = oz + suit.aimDirZ * d;
        const gx = Math.floor(nx / VOXEL_SIZE_M);
        const gy = Math.floor(ny / VOXEL_SIZE_M);
        const gz = Math.floor(nz / VOXEL_SIZE_M);
        const hitSolid =
          !inRoomBounds(room, gx, gy, gz) || isSolidMat(getMat(room.grid[cellIndex(gx, gy, gz)]));
        const base = i * 3;
        this.aimArcPositions[base] = nx;
        this.aimArcPositions[base + 1] = ny;
        this.aimArcPositions[base + 2] = nz;
        endX = nx;
        endY = ny;
        endZ = nz;
        usedPts = i + 1;
        if (hitSolid) break;
      }
    }

    const arcGeo = this.aimArcLine.geometry as THREE.BufferGeometry;
    arcGeo.setDrawRange(0, usedPts);
    (arcGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // Position landing ring and optional vertical drop-line for 3D isometric depth cue
    const evx = Math.max(0, Math.min(room.roomW - 1, Math.floor(endX / VOXEL_SIZE_M)));
    const evz = Math.max(0, Math.min(room.roomD - 1, Math.floor(endZ / VOXEL_SIZE_M)));
    let floorY = endY;
    const startVY = Math.max(0, Math.min(room.roomH - 1, Math.floor(endY / VOXEL_SIZE_M)));
    for (let vy = startVY; vy >= 0; vy--) {
      if (isSolidMat(getMat(room.grid[cellIndex(evx, vy, evz)]))) {
        floorY = (vy + 1) * VOXEL_SIZE_M;
        break;
      }
    }

    this.aimLandingRing.position.set(endX, endY + 0.03, endZ);
    this.aimLandingRing.visible = true;

    if (endY - floorY > 0.25) {
      this.aimDropPositions[0] = endX;
      this.aimDropPositions[1] = endY;
      this.aimDropPositions[2] = endZ;
      this.aimDropPositions[3] = endX;
      this.aimDropPositions[4] = floorY + 0.02;
      this.aimDropPositions[5] = endZ;
      (this.aimDropLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.aimDropLine.visible = true;
      // Place landing ring on the deck below in 0G so alignment over vents/pods is obvious
      if (!loaded || mode === GRAVITY_MODE.G0) {
        this.aimLandingRing.position.set(endX, floorY + 0.03, endZ);
      }
    } else {
      this.aimDropLine.visible = false;
    }
  }

  public update(
    room: RoomState,
    entity: Entity,
    tank: PlayerTankState,
    suit: SuitActionState,
    mode: GravityMode,
    plumb: PlumbLineResult,
    nozzlePressureRank: number,
    dt: number,
    timeSec: number,
  ): void {
    this.root.position.set(entity.x, entity.y + entity.height * 0.5, entity.z);

    const aimHorizSq = suit.aimDirX * suit.aimDirX + suit.aimDirZ * suit.aimDirZ;
    if (aimHorizSq > 1e-4) {
      this.root.rotation.y = Math.atan2(-suit.aimDirX, -suit.aimDirZ);
    } else if (entity.vx * entity.vx + entity.vz * entity.vz > 0.25) {
      this.root.rotation.y = Math.atan2(-entity.vx, -entity.vz);
    }

    const targetFlip = entity.upSign === 1 ? 0 : Math.PI;
    const diff = targetFlip - this.currentFlipRad;
    const step = Math.min(Math.abs(diff), 16.0 * dt) * Math.sign(diff);
    this.currentFlipRad += step;
    this.body.rotation.z = this.currentFlipRad;

    const chamber = getActiveChamber(tank);
    if (chamber.liters > 0 && chamber.mat !== MAT.AIR) {
      const fill = Math.max(0.05, Math.min(1, chamber.liters / Math.max(1, chamber.capL)));
      this.tankFillMesh.visible = true;
      this.tankFillMesh.scale.set(1, fill, 1);
      const colHex = MATERIAL_SPEC[chamber.mat]?.colorHex ?? 0x2b95d6;
      this.tankFillMat.color.setHex(colHex);
      this.tankFillMat.emissive.setHex(colHex);
      this.tankFillMat.emissiveIntensity = chamber.chargeUnits > 0 ? 0.95 : 0.35;
    } else {
      this.tankFillMesh.visible = false;
    }

    this.updateAimIndicator(room, entity, tank, suit, mode, nozzlePressureRank);

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

    if (suit.siphonActive && suit.siphonMat !== MAT.AIR) {
      const hex = MATERIAL_SPEC[suit.siphonMat]?.colorHex ?? 0x5be7ff;
      this.siphonMat.color.setHex(hex);
      this.siphonRingMat.color.setHex(hex);

      const nx = entity.x + suit.aimDirX * 0.35;
      const ny = entity.y + PLAYER_TORSO_OFFSET_M + suit.aimDirY * 0.35;
      const nz = entity.z + suit.aimDirZ * 0.35;
      const tx = suit.siphonTargetX;
      const ty = suit.siphonTargetY;
      const tz = suit.siphonTargetZ;

      for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
        const t = i / RIBBON_SEGMENTS;
        const arc = Math.sin(t * Math.PI);
        const wave = Math.sin(t * 14.0 - timeSec * 24.0) * 0.06 * arc;
        const base = i * 3;
        this.siphonPositions[base] = nx + (tx - nx) * t + wave;
        this.siphonPositions[base + 1] = ny + (ty - ny) * t + 0.16 * arc;
        this.siphonPositions[base + 2] = nz + (tz - nz) * t - wave;
      }
      (this.siphonRibbon.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.siphonRibbon.visible = true;

      this.siphonRing.position.set(tx, ty + 0.04, tz);
      const pulseScale = 0.85 + 0.25 * Math.sin(timeSec * 18.0);
      this.siphonRing.scale.set(pulseScale, pulseScale, pulseScale);
      this.siphonRing.visible = true;
    } else {
      this.siphonRibbon.visible = false;
      this.siphonRing.visible = false;
    }
  }
}
