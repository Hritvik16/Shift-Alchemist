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
  TEMP_BYTE,
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

const AIM_ARC_POINTS = 26;
const SIPHON_BEADS = 14;
const MAX_DASH_GHOSTS = 5;

interface DashGhost {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
}

function createRigGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.42)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export class PlayerRig {
  public readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly suitMat: THREE.MeshStandardMaterial;
  private readonly visorMat: THREE.MeshStandardMaterial;
  private readonly tankFillMesh: THREE.Mesh;
  private readonly tankFillMat: THREE.MeshStandardMaterial;
  private readonly nozzleTipMat: THREE.MeshStandardMaterial;
  private readonly thrusterMat: THREE.MeshBasicMaterial;
  private readonly leftFlare: THREE.Mesh;
  private readonly rightFlare: THREE.Mesh;
  private readonly suitLight: THREE.PointLight;
  private readonly visorGlowMat: THREE.SpriteMaterial;

  private readonly shadowDisc: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;

  private readonly plumbBeam: THREE.Mesh;
  private readonly plumbBeamMat: THREE.MeshBasicMaterial;
  private readonly plumbRing: THREE.Mesh;
  private readonly plumbRingMat: THREE.MeshBasicMaterial;

  private readonly siphonBeads: THREE.InstancedMesh;
  private readonly siphonBeadMat: THREE.MeshBasicMaterial;
  private readonly siphonRing: THREE.Mesh;
  private readonly siphonRingMat: THREE.MeshBasicMaterial;

  private readonly aimBeads: THREE.InstancedMesh;
  private readonly aimBeadMat: THREE.MeshBasicMaterial;
  private readonly aimLandingRing: THREE.Mesh;
  private readonly aimLandingRingMat: THREE.MeshBasicMaterial;
  private readonly aimDropBeam: THREE.Mesh;
  private readonly aimDropMat: THREE.MeshBasicMaterial;

  private readonly dashGhosts: DashGhost[] = [];
  private dashGhostCursor = 0;
  private dashGhostTimer = 0;

  private readonly shiftRing: THREE.Mesh;
  private readonly shiftRingMat: THREE.MeshBasicMaterial;
  private shiftRingAge = 1;
  private lastMode: GravityMode = GRAVITY_MODE.G1;

  private readonly tmpMat4 = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpPosB = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpDir = new THREE.Vector3();

  private currentFlipRad = 0;

  constructor(scene: THREE.Scene) {
    this.suitMat = new THREE.MeshStandardMaterial({
      color: 0x3b8ea8,
      emissive: 0x0b222e,
      emissiveIntensity: 0.35,
      roughness: 0.36,
      metalness: 0.48,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xe6f1fb,
      roughness: 0.28,
      metalness: 0.56,
    });
    const darkJointMat = new THREE.MeshStandardMaterial({
      color: 0x1e2836,
      roughness: 0.55,
      metalness: 0.65,
    });
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0xff9f1c,
      emissive: 0x773c00,
      emissiveIntensity: 0.72,
      roughness: 0.35,
      metalness: 0.6,
    });
    this.visorMat = new THREE.MeshStandardMaterial({
      color: 0x5ef2d6,
      emissive: 0x26d9b8,
      emissiveIntensity: 1.25,
      roughness: 0.1,
      metalness: 0.2,
    });
    const tankShellMat = new THREE.MeshStandardMaterial({
      color: 0x90d8e8,
      transparent: true,
      opacity: 0.34,
      roughness: 0.16,
      metalness: 0.28,
      depthWrite: false,
    });
    this.tankFillMat = new THREE.MeshStandardMaterial({
      color: 0x2b95d6,
      emissive: 0x0e334a,
      emissiveIntensity: 0.72,
      roughness: 0.22,
      metalness: 0.15,
    });
    this.nozzleTipMat = new THREE.MeshStandardMaterial({
      color: 0x7ef9ff,
      emissive: 0x5ef2d6,
      emissiveIntensity: 1.05,
      roughness: 0.18,
      metalness: 0.3,
    });
    this.thrusterMat = new THREE.MeshBasicMaterial({
      color: 0xffc857,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });

    // Soft local non-shadow suit light so the player always reads crisply on dark freighter steel
    this.suitLight = new THREE.PointLight(0x5ef2d6, 0.95, 3.6, 1.8);
    this.suitLight.position.set(0, 0.45, 0);
    this.root.add(this.suitLight);

    const glowTex = createRigGlowTexture();
    this.visorGlowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x5ef2d6,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const visorGlow = new THREE.Sprite(this.visorGlowMat);
    visorGlow.position.set(0, 0.62, -0.22);
    visorGlow.scale.set(0.62, 0.42, 1);
    this.body.add(visorGlow);

    const bootGeo = new THREE.BoxGeometry(0.19, 0.17, 0.27);
    const leftBoot = new THREE.Mesh(bootGeo, bootMat);
    leftBoot.position.set(-0.13, -0.71, 0.02);
    leftBoot.castShadow = true;
    const rightBoot = new THREE.Mesh(bootGeo, bootMat);
    rightBoot.position.set(0.13, -0.71, 0.02);
    rightBoot.castShadow = true;
    this.body.add(leftBoot, rightBoot);

    const legGeo = new THREE.CylinderGeometry(0.085, 0.095, 0.52, 10);
    const leftLeg = new THREE.Mesh(legGeo, this.suitMat);
    leftLeg.position.set(-0.13, -0.38, 0);
    leftLeg.castShadow = true;
    const rightLeg = new THREE.Mesh(legGeo, this.suitMat);
    rightLeg.position.set(0.13, -0.38, 0);
    rightLeg.castShadow = true;
    this.body.add(leftLeg, rightLeg);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.32), this.suitMat);
    torso.position.set(0, 0.16, 0);
    torso.castShadow = true;
    this.body.add(torso);

    const pauldrons = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.15, 0.35), trimMat);
    pauldrons.position.set(0, 0.36, 0);
    pauldrons.castShadow = true;
    this.body.add(pauldrons);

    const cannonBody = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.08, 0.48, 10), darkJointMat);
    cannonBody.rotation.x = Math.PI * 0.5;
    cannonBody.position.set(0.32, 0.12, -0.22);
    const cannonTip = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.072, 0.12, 10), this.nozzleTipMat);
    cannonTip.rotation.x = Math.PI * 0.5;
    cannonTip.position.set(0.32, 0.12, -0.46);
    this.body.add(cannonBody, cannonTip);

    const tankShell = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.54, 14), tankShellMat);
    tankShell.position.set(0, 0.18, 0.24);
    const tankCapTop = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 14), darkJointMat);
    tankCapTop.position.set(0, 0.46, 0.24);
    const tankCapBot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 14), darkJointMat);
    tankCapBot.position.set(0, -0.1, 0.24);
    this.body.add(tankShell, tankCapTop, tankCapBot);

    const tankFillGeo = new THREE.CylinderGeometry(0.115, 0.115, 0.46, 12);
    tankFillGeo.translate(0, 0.23, 0);
    this.tankFillMesh = new THREE.Mesh(tankFillGeo, this.tankFillMat);
    this.tankFillMesh.position.set(0, -0.05, 0.24);
    this.tankFillMesh.visible = false;
    this.body.add(this.tankFillMesh);

    const flareGeo = new THREE.ConeGeometry(0.09, 0.34, 8);
    flareGeo.rotateX(Math.PI);
    this.leftFlare = new THREE.Mesh(flareGeo, this.thrusterMat);
    this.leftFlare.position.set(-0.14, -0.26, 0.24);
    this.leftFlare.visible = false;
    this.rightFlare = new THREE.Mesh(flareGeo, this.thrusterMat);
    this.rightFlare.position.set(0.14, -0.26, 0.24);
    this.rightFlare.visible = false;
    this.body.add(this.leftFlare, this.rightFlare);

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), trimMat);
    helmet.position.set(0, 0.61, 0);
    helmet.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.13), this.visorMat);
    visor.position.set(0, 0.62, -0.15);
    this.body.add(helmet, visor);

    this.root.add(this.body);
    scene.add(this.root);

    const shadowGeo = new THREE.CircleGeometry(0.36, 20);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x05080f,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.shadowDisc = new THREE.Mesh(shadowGeo, this.shadowMat);
    scene.add(this.shadowDisc);

    const beamGeo = new THREE.CylinderGeometry(0.018, 0.018, 1.0, 8);
    this.plumbBeamMat = new THREE.MeshBasicMaterial({
      color: 0x38e8ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.plumbBeam = new THREE.Mesh(beamGeo, this.plumbBeamMat);
    this.plumbBeam.visible = false;
    scene.add(this.plumbBeam);

    const ringGeo = new THREE.RingGeometry(0.26, 0.42, 24);
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

    const sBeadGeo = new THREE.OctahedronGeometry(0.055, 0);
    this.siphonBeadMat = new THREE.MeshBasicMaterial({
      color: 0x5be7ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.siphonBeads = new THREE.InstancedMesh(sBeadGeo, this.siphonBeadMat, SIPHON_BEADS);
    this.siphonBeads.count = 0;
    this.siphonBeads.frustumCulled = false;
    scene.add(this.siphonBeads);

    const sRingGeo = new THREE.RingGeometry(0.14, 0.28, 18);
    sRingGeo.rotateX(-Math.PI / 2);
    this.siphonRingMat = new THREE.MeshBasicMaterial({
      color: 0x5be7ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.siphonRing = new THREE.Mesh(sRingGeo, this.siphonRingMat);
    this.siphonRing.visible = false;
    scene.add(this.siphonRing);

    const aimBeadGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.16, 6);
    this.aimBeadMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.aimBeads = new THREE.InstancedMesh(aimBeadGeo, this.aimBeadMat, AIM_ARC_POINTS);
    this.aimBeads.count = 0;
    this.aimBeads.frustumCulled = false;
    scene.add(this.aimBeads);

    const landRingGeo = new THREE.RingGeometry(0.16, 0.3, 20);
    landRingGeo.rotateX(-Math.PI / 2);
    this.aimLandingRingMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    this.aimLandingRing = new THREE.Mesh(landRingGeo, this.aimLandingRingMat);
    this.aimLandingRing.visible = false;
    scene.add(this.aimLandingRing);

    this.aimDropMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    this.aimDropBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.0, 6), this.aimDropMat);
    this.aimDropBeam.visible = false;
    scene.add(this.aimDropBeam);

    const ghostGeo = new THREE.CapsuleGeometry(0.24, 0.95, 4, 8);
    for (let i = 0; i < MAX_DASH_GHOSTS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x5ef2d6,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(ghostGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.dashGhosts.push({ mesh, mat, age: 0, life: 0 });
    }

    const shiftGeo = new THREE.RingGeometry(0.35, 0.56, 28);
    shiftGeo.rotateX(-Math.PI / 2);
    this.shiftRingMat = new THREE.MeshBasicMaterial({
      color: 0x5ef2d6,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.shiftRing = new THREE.Mesh(shiftGeo, this.shiftRingMat);
    this.shiftRing.visible = false;
    scene.add(this.shiftRing);
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
        ? 0xc88d55
        : (MATERIAL_SPEC[chamber.mat]?.colorHex ?? 0x7ef9ff)
      : 0x9cf4ff;
    this.aimBeadMat.color.setHex(colorHex);
    this.aimLandingRingMat.color.setHex(colorHex);
    this.aimDropMat.color.setHex(colorHex);
    this.nozzleTipMat.color.setHex(colorHex);
    this.nozzleTipMat.emissive.setHex(colorHex);

    const ox = entity.x + suit.aimDirX * 0.45;
    const oy = entity.y + PLAYER_TORSO_OFFSET_M + suit.aimDirY * 0.45;
    const oz = entity.z + suit.aimDirZ * 0.45;

    let endX = ox;
    let endY = oy;
    let endZ = oz;
    let prevX = ox;
    let prevY = oy;
    let prevZ = oz;
    let beadCount = 0;

    if (loaded && mode !== GRAVITY_MODE.G0) {
      const speed =
        (suit.nozzleHoseActive ? NOZZLE_HOLD_SPEED_M_S : NOZZLE_TAP_SPEED_M_S) *
        nozzlePressureMult(nozzlePressureRank);
      const gAccel = GRAVITY_ACCEL_BY_MODE[mode];
      const dtStep = 0.036;
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
        if (hitSolid) {
          endX = px;
          endY = py;
          endZ = pz;
          break;
        }
        this.tmpDir.set(nx - prevX, ny - prevY, nz - prevZ);
        const segLen = this.tmpDir.length();
        if (segLen > 1e-4) {
          this.tmpDir.divideScalar(segLen);
          this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpDir);
          this.tmpPos.set((prevX + nx) * 0.5, (prevY + ny) * 0.5, (prevZ + nz) * 0.5);
          this.tmpScale.set(1.0, Math.min(1.6, segLen / 0.16), 1.0);
          this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.aimBeads.setMatrixAt(beadCount++, this.tmpMat4);
        }
        prevX = nx;
        prevY = ny;
        prevZ = nz;
        px = nx;
        py = ny;
        pz = nz;
        endX = px;
        endY = py;
        endZ = pz;
      }
    } else {
      const maxDist = loaded ? LOCKON_RANGE_M : AIR_BURST_RANGE_M;
      const segs = 14;
      const stepM = maxDist / segs;
      this.tmpDir.set(suit.aimDirX, suit.aimDirY, suit.aimDirZ).normalize();
      this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpDir);
      for (let i = 1; i <= segs; i++) {
        const d = i * stepM;
        const nx = ox + suit.aimDirX * d;
        const ny = oy + suit.aimDirY * d;
        const nz = oz + suit.aimDirZ * d;
        const gx = Math.floor(nx / VOXEL_SIZE_M);
        const gy = Math.floor(ny / VOXEL_SIZE_M);
        const gz = Math.floor(nz / VOXEL_SIZE_M);
        const hitSolid =
          !inRoomBounds(room, gx, gy, gz) || isSolidMat(getMat(room.grid[cellIndex(gx, gy, gz)]));
        endX = nx;
        endY = ny;
        endZ = nz;
        if (i % 2 === 1 || loaded) {
          this.tmpPos.set(nx, ny, nz);
          this.tmpScale.set(loaded ? 1.0 : 0.85, loaded ? 1.2 : 0.9, loaded ? 1.0 : 0.85);
          this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.aimBeads.setMatrixAt(beadCount++, this.tmpMat4);
        }
        if (hitSolid) break;
      }
    }

    this.aimBeads.count = beadCount;
    if (beadCount > 0) this.aimBeads.instanceMatrix.needsUpdate = true;

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

    const dropH = endY - floorY;
    if (dropH > 0.22) {
      this.aimDropBeam.position.set(endX, floorY + dropH * 0.5, endZ);
      this.aimDropBeam.scale.set(1, dropH, 1);
      this.aimDropBeam.visible = true;
      if (!loaded || mode === GRAVITY_MODE.G0) {
        this.aimLandingRing.position.set(endX, floorY + 0.03, endZ);
      }
    } else {
      this.aimDropBeam.visible = false;
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
    let accentHex = 0x5ef2d6;
    if (chamber.liters > 0 && chamber.mat !== MAT.AIR) {
      const fill = Math.max(0.05, Math.min(1, chamber.liters / Math.max(1, chamber.capL)));
      this.tankFillMesh.visible = true;
      this.tankFillMesh.scale.set(1, fill, 1);
      const colHex =
        chamber.mat === MAT.OIL ? 0x6e4f38 : (MATERIAL_SPEC[chamber.mat]?.colorHex ?? 0x2b95d6);
      this.tankFillMat.color.setHex(colHex);
      this.tankFillMat.emissive.setHex(colHex);
      this.tankFillMat.emissiveIntensity = chamber.chargeUnits > 0 ? 1.15 : 0.62;
      accentHex = chamber.mat === MAT.OIL ? 0xd4955a : colHex;
    } else {
      this.tankFillMesh.visible = false;
    }

    // Reactive suit silhouette lighting & live status feedback (shock / burn / brittle frost)
    if (entity.shockTicks > 0) {
      const flash = 0.75 + 0.55 * Math.abs(Math.sin(timeSec * 36.0));
      this.suitMat.emissive.setHex(0x62e8ff);
      this.suitMat.emissiveIntensity = flash;
      this.suitLight.color.setHex(0x7ef9ff);
      this.suitLight.intensity = 1.6 * flash;
      this.visorGlowMat.color.setHex(0x9cf7ff);
    } else if (entity.burnTicks > 0) {
      const flick = 0.7 + 0.35 * Math.sin(timeSec * 24.0);
      this.suitMat.emissive.setHex(0xff5a14);
      this.suitMat.emissiveIntensity = 0.85 * flick;
      this.suitLight.color.setHex(0xff7b29);
      this.suitLight.intensity = 1.5 * flick;
      this.visorGlowMat.color.setHex(0xff9f1c);
    } else if (entity.tempByte <= TEMP_BYTE.EMBRITTLED) {
      this.suitMat.emissive.setHex(0x4be8ff);
      this.suitMat.emissiveIntensity = 0.72;
      this.suitLight.color.setHex(0x5be7ff);
      this.suitLight.intensity = 1.25;
      this.visorGlowMat.color.setHex(0x8ef7ff);
    } else {
      this.suitMat.emissive.setHex(0x0b222e);
      this.suitMat.emissiveIntensity = 0.35;
      this.suitLight.color.setHex(accentHex);
      this.suitLight.intensity = 0.95;
      this.visorGlowMat.color.setHex(0x5ef2d6);
    }

    const thrusting = entity.dashTimer > 0 || (mode === GRAVITY_MODE.G0 && Math.abs(entity.vy) > 0.8);
    this.leftFlare.visible = thrusting;
    this.rightFlare.visible = thrusting;
    if (thrusting) {
      const s = 0.85 + 0.35 * Math.sin(timeSec * 45.0);
      this.leftFlare.scale.set(1, s, 1);
      this.rightFlare.scale.set(1, s, 1);
      this.thrusterMat.color.setHex(entity.dashTimer > 0 ? 0x5ef2d6 : 0xffbe55);
    }

    if (entity.dashTimer > 0) {
      this.dashGhostTimer -= dt;
      if (this.dashGhostTimer <= 0) {
        this.dashGhostTimer = 0.045;
        const g = this.dashGhosts[this.dashGhostCursor];
        this.dashGhostCursor = (this.dashGhostCursor + 1) % MAX_DASH_GHOSTS;
        g.mesh.position.set(entity.x, entity.y + entity.height * 0.5, entity.z);
        g.mesh.visible = true;
        g.age = 0;
        g.life = 0.24;
        g.mat.opacity = 0.42;
      }
    } else {
      this.dashGhostTimer = 0;
    }
    for (let i = 0; i < this.dashGhosts.length; i++) {
      const g = this.dashGhosts[i];
      if (g.life <= 0) continue;
      g.age += dt;
      if (g.age >= g.life) {
        g.life = 0;
        g.mesh.visible = false;
      } else {
        const t = 1 - g.age / g.life;
        g.mat.opacity = 0.42 * t;
        g.mesh.scale.setScalar(0.85 + 0.15 * t);
      }
    }

    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.shiftRingAge = 0;
      const gHex =
        mode === GRAVITY_MODE.G0
          ? 0x62f2ff
          : mode === GRAVITY_MODE.GN1
            ? 0xff6be6
            : mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3
              ? 0xffb347
              : 0x5ef2d6;
      this.shiftRingMat.color.setHex(gHex);
      this.shiftRing.position.set(entity.x, entity.y + 0.12, entity.z);
      this.shiftRing.visible = true;
    }
    if (this.shiftRingAge < 0.38) {
      this.shiftRingAge += dt;
      const t = Math.min(1, this.shiftRingAge / 0.38);
      this.shiftRing.position.set(entity.x, entity.y + 0.12, entity.z);
      this.shiftRing.scale.setScalar(0.8 + t * 4.2);
      this.shiftRingMat.opacity = 0.85 * (1 - t);
      if (t >= 1) this.shiftRing.visible = false;
    }

    this.updateAimIndicator(room, entity, tank, suit, mode, nozzlePressureRank);

    const shadowScale = Math.max(0.45, 1.0 - plumb.distanceM * 0.11);
    this.shadowDisc.position.set(
      plumb.originX,
      plumb.hitY - plumb.plumbDir * 0.012,
      plumb.originZ,
    );
    this.shadowDisc.scale.setScalar(shadowScale);
    this.shadowMat.opacity = Math.max(0.22, 0.65 - plumb.distanceM * 0.08);
    this.shadowDisc.visible = true;

    if (plumb.visible) {
      const colorHex =
        mode === GRAVITY_MODE.GN1
          ? 0xff4fd8
          : mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3
            ? 0xffaa2b
            : 0x38e8ff;
      this.plumbBeamMat.color.setHex(colorHex);
      this.plumbRingMat.color.setHex(colorHex);

      const h = Math.max(0.05, Math.abs(plumb.originY - plumb.hitY));
      this.plumbBeam.position.set(
        plumb.originX,
        (plumb.originY + plumb.hitY) * 0.5,
        plumb.originZ,
      );
      this.plumbBeam.scale.set(1, h, 1);
      this.plumbBeam.visible = true;

      this.plumbRing.position.set(
        plumb.originX,
        plumb.hitY - plumb.plumbDir * 0.018,
        plumb.originZ,
      );
      this.plumbRing.visible = true;
    } else {
      this.plumbBeam.visible = false;
      this.plumbRing.visible = false;
    }

    if (suit.siphonActive && suit.siphonMat !== MAT.AIR) {
      const hex =
        suit.siphonMat === MAT.OIL
          ? 0xc88d55
          : (MATERIAL_SPEC[suit.siphonMat]?.colorHex ?? 0x5be7ff);
      this.siphonBeadMat.color.setHex(hex);
      this.siphonRingMat.color.setHex(hex);

      const nx = entity.x + suit.aimDirX * 0.38;
      const ny = entity.y + PLAYER_TORSO_OFFSET_M + suit.aimDirY * 0.38;
      const nz = entity.z + suit.aimDirZ * 0.38;
      const tx = suit.siphonTargetX;
      const ty = suit.siphonTargetY;
      const tz = suit.siphonTargetZ;

      this.tmpQuat.identity();
      for (let i = 0; i < SIPHON_BEADS; i++) {
        const rawT = (i / SIPHON_BEADS - timeSec * 2.6) % 1.0;
        const t = rawT < 0 ? rawT + 1.0 : rawT;
        const arc = Math.sin(t * Math.PI);
        const spiral = Math.sin(t * 14.0 - timeSec * 18.0) * 0.08 * arc;
        this.tmpPosB.set(
          nx + (tx - nx) * t + spiral,
          ny + (ty - ny) * t + 0.18 * arc,
          nz + (tz - nz) * t - spiral,
        );
        const s = 0.65 + 0.55 * arc;
        this.tmpScale.setScalar(s);
        this.tmpMat4.compose(this.tmpPosB, this.tmpQuat, this.tmpScale);
        this.siphonBeads.setMatrixAt(i, this.tmpMat4);
      }
      this.siphonBeads.count = SIPHON_BEADS;
      this.siphonBeads.instanceMatrix.needsUpdate = true;

      this.siphonRing.position.set(tx, ty + 0.04, tz);
      const pulseScale = 0.85 + 0.28 * Math.sin(timeSec * 18.0);
      this.siphonRing.scale.set(pulseScale, pulseScale, pulseScale);
      this.siphonRing.visible = true;
    } else {
      this.siphonBeads.count = 0;
      this.siphonRing.visible = false;
    }
  }
}
