// Three.js Renderer:
// - Strictly Bounded Physical Droplet Deformation (max radius <= 0.14m — Zero Giant Fried-Egg Saucers!)
// - Sub-Voxel Faceted Ice Crystals & Sleek Cylindrical Catwalk Support Columns
// - Surgical Per-Voxel X-Ray Occlusion

import * as THREE from 'three';
import {
  MaterialID,
  MATERIAL_TABLE,
  VOXEL_SIZE,
  getVoxelIndex,
  isSolidVoxel,
} from '../core/types';
import type {
  RoomGrid,
  PlayerInputState,
  PlayerRigState,
  LockOnTarget,
  GlassVatTank,
} from '../core/types';
import { setVoxel, recountActiveCells, spawnDynamicEntity } from '../core/roomGen';
import { shatterCylindricalVat } from '../core/fluids';
import {
  raycastVoxelGrid,
  stepWorldPhysics,
  toggleRoomGravity,
  triggerPlayerDash,
  fireCompressedAirNozzle,
  findMagneticLockOnTarget,
  computeFloorAltitudeBelow,
} from '../core/physics';

const FLUID_MATERIALS: MaterialID[] = [
  MaterialID.WATER,
  MaterialID.OIL,
  MaterialID.CRYO,
];

interface EntityVisualGroup {
  root: THREE.Group;
  bodyMesh: THREE.Mesh;
  plumbLine: THREE.Line;
  plumbRing: THREE.Mesh;
  hpFillMesh: THREE.Mesh;
}

interface OverhangVoxelRecord {
  x: number;
  y: number;
  z: number;
  wx: number;
  wy: number;
  wz: number;
  r: number;
  g: number;
  b: number;
  isColumn: boolean;
}

export class Scene3DViewer {
  private room: RoomGrid;
  private player: PlayerRigState;
  private input: PlayerInputState = {
    moveX: 0,
    moveZ: 0,
    moveY: 0,
    aimWorldX: 12,
    aimWorldY: 1.5,
    aimWorldZ: 12,
    cursorHitGeometry: false,
  };
  private keysPressed = new Set<string>();

  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;

  private viewSize = 7.4;
  private camTargetPos = new THREE.Vector3(8, 2, 14);

  private hullOpaqueMesh!: THREE.InstancedMesh;
  private hullBoundaryCutawayMesh!: THREE.InstancedMesh;
  private hullOccludingMesh!: THREE.InstancedMesh;
  private columnCylinderMesh!: THREE.InstancedMesh;
  private iceCrystalMesh!: THREE.InstancedMesh;
  private glassBlockMesh!: THREE.InstancedMesh;
  private overhangRecords: OverhangVoxelRecord[] = [];

  private fluidQuantaMeshes = new Map<MaterialID, THREE.InstancedMesh>();
  private fluidMaterials = new Map<MaterialID, THREE.Material>();
  private dummy = new THREE.Object3D();
  private colorScratch = new THREE.Color();
  private upVec = new THREE.Vector3(0, 1, 0);
  private stretchAxis = new THREE.Vector3();
  private quatScratch = new THREE.Quaternion();

  private playerGroup = new THREE.Group();
  private leftLegPivot = new THREE.Group();
  private rightLegPivot = new THREE.Group();
  private leftArmPivot = new THREE.Group();
  private rightArmPivot = new THREE.Group();
  private thrusterFlameLeft!: THREE.Mesh;
  private thrusterFlameRight!: THREE.Mesh;
  private plumbLine!: THREE.Line;
  private plumbRing!: THREE.Mesh;

  private vatVisuals = new Map<number, THREE.Group>();
  private entityVisuals = new Map<number, EntityVisualGroup>();

  private airBurstMesh!: THREE.LineSegments;
  private airBurstPositions = new Float32Array(32 * 2 * 3);

  private lockOnTarget: LockOnTarget | null = null;
  private lockReticleGroup = new THREE.Group();
  private lockTargetPlumbLine!: THREE.Line;
  private lockTargetPlumbRing!: THREE.Mesh;

  private raycaster = new THREE.Raycaster();
  private mouseNDC = new THREE.Vector2(0, 0);
  private aimFallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.5);
  private aimFallbackTarget = new THREE.Vector3();
  private cursorMesh: THREE.LineSegments;
  private hoveredVoxel: { x: number; y: number; z: number } | null = null;
  private placeVoxelCoords: { x: number; y: number; z: number } | null = null;

  private selectedMaterial: MaterialID = MaterialID.WATER;
  private hudElement: HTMLDivElement;
  private fps = 60;
  private frameCount = 0;
  private lastFpsTime = performance.now();
  private lastFrameTime = performance.now();

  constructor(container: HTMLElement, room: RoomGrid, player: PlayerRigState) {
    this.room = room;
    this.player = player;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d14);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.OrthographicCamera(
      -this.viewSize * aspect,
      this.viewSize * aspect,
      this.viewSize,
      -this.viewSize,
      0.1,
      120
    );

    this.camTargetPos.set(player.x, player.y + 0.8, player.z);
    this.camera.position.set(player.x + 6.5, player.y + 18.0, player.z + 15.5);
    this.camera.lookAt(this.camTargetPos);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.innerHTML = '';
    container.appendChild(this.renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xa5b4fc, 0x1e293b, 0.85);
    this.scene.add(hemiLight);

    const roomCenterX = (room.width * VOXEL_SIZE) / 2;
    const roomCenterZ = (room.depth * VOXEL_SIZE) / 2;

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.4);
    keyLight.position.set(roomCenterX + 12, 26, roomCenterZ + 14);
    keyLight.target.position.set(roomCenterX, 0, roomCenterZ);
    this.scene.add(keyLight.target);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    const d = 19;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.001;
    this.scene.add(keyLight);

    const cryoLight = new THREE.PointLight(0x22d3ee, 2.4, 10.0);
    cryoLight.position.set(15.5, 1.5, 15.0);
    this.scene.add(cryoLight);

    const catwalkLight = new THREE.PointLight(0xf59e0b, 2.0, 11.0);
    catwalkLight.position.set(9.0, 5.5, 2.5);
    this.scene.add(catwalkLight);

    this.initInstancedMeshes();
    this.initHumanoidRigAndPlumbLine();
    this.initLockOnReticle();
    this.initAirBurstBuffer();

    const boxGeo = new THREE.BoxGeometry(
      VOXEL_SIZE * 1.02,
      VOXEL_SIZE * 1.02,
      VOXEL_SIZE * 1.02
    );
    const edges = new THREE.EdgesGeometry(boxGeo);
    this.cursorMesh = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    this.scene.add(this.cursorMesh);

    this.hudElement = document.createElement('div');
    this.hudElement.style.cssText = `
      position: fixed;
      top: 12px;
      left: 12px;
      padding: 10px 14px;
      background: rgba(9, 13, 20, 0.88);
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 6px;
      color: #e2e8f0;
      font-family: 'SFMono-Regular', Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      pointer-events: none;
      user-select: none;
      z-index: 10;
    `;
    document.body.appendChild(this.hudElement);

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.clearKeysOnBlur());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearKeysOnBlur();
    });

    this.rebuildDirtyInstances();
    this.updateHUD();
  }

  private clearKeysOnBlur(): void {
    this.keysPressed.clear();
    this.syncMovementKeys();
  }

  private initAirBurstBuffer(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.airBurstPositions, 3)
    );
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.85,
    });
    this.airBurstMesh = new THREE.LineSegments(geo, mat);
    this.airBurstMesh.frustumCulled = false;
    this.scene.add(this.airBurstMesh);
  }

  private initInstancedMeshes(): void {
    const seamlessBoxGeo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);

    const hullOpaqueMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.45,
    });

    const boundaryCutawayMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.35,
      metalness: 0.5,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
    });

    const occludingCutawayMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.4,
      metalness: 0.5,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });

    this.hullOpaqueMesh = new THREE.InstancedMesh(seamlessBoxGeo, hullOpaqueMat, 16384);
    this.hullOpaqueMesh.frustumCulled = false;
    this.hullOpaqueMesh.castShadow = true;
    this.hullOpaqueMesh.receiveShadow = true;
    this.scene.add(this.hullOpaqueMesh);

    this.hullBoundaryCutawayMesh = new THREE.InstancedMesh(
      seamlessBoxGeo,
      boundaryCutawayMat,
      4096
    );
    this.hullBoundaryCutawayMesh.frustumCulled = false;
    this.scene.add(this.hullBoundaryCutawayMesh);

    this.hullOccludingMesh = new THREE.InstancedMesh(
      seamlessBoxGeo,
      occludingCutawayMat,
      4096
    );
    this.hullOccludingMesh.frustumCulled = false;
    this.scene.add(this.hullOccludingMesh);

    const colGeo = new THREE.CylinderGeometry(
      VOXEL_SIZE * 0.42,
      VOXEL_SIZE * 0.46,
      VOXEL_SIZE,
      14
    );
    this.columnCylinderMesh = new THREE.InstancedMesh(colGeo, hullOpaqueMat, 512);
    this.columnCylinderMesh.frustumCulled = false;
    this.columnCylinderMesh.castShadow = true;
    this.scene.add(this.columnCylinderMesh);

    const iceCrystalGeo = new THREE.IcosahedronGeometry(1.0, 0);
    const iceMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x0284c7,
      emissiveIntensity: 0.28,
      roughness: 0.1,
      metalness: 0.2,
    });
    this.iceCrystalMesh = new THREE.InstancedMesh(iceCrystalGeo, iceMat, 8192);
    this.iceCrystalMesh.frustumCulled = false;
    this.scene.add(this.iceCrystalMesh);

    const glassBlockMat = new THREE.MeshStandardMaterial({
      color: 0xbae6fd,
      emissive: 0x0284c7,
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.38,
      roughness: 0.1,
      metalness: 0.25,
    });
    this.glassBlockMesh = new THREE.InstancedMesh(seamlessBoxGeo, glassBlockMat, 2048);
    this.glassBlockMesh.frustumCulled = false;
    this.scene.add(this.glassBlockMesh);

    const quantumEllipsoidGeo = new THREE.SphereGeometry(1.0, 10, 8);

    const waterMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x0369a1,
      emissiveIntensity: 0.22,
      transparent: true,
      opacity: 0.88,
      roughness: 0.06,
      metalness: 0.15,
    });

    const oilMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.06,
      metalness: 0.4,
    });

    const cryoMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.65,
      transparent: true,
      opacity: 0.92,
      roughness: 0.1,
    });

    this.fluidMaterials.set(MaterialID.WATER, waterMat);
    this.fluidMaterials.set(MaterialID.OIL, oilMat);
    this.fluidMaterials.set(MaterialID.CRYO, cryoMat);

    for (const matId of FLUID_MATERIALS) {
      const mat = this.fluidMaterials.get(matId)!;
      const mesh = new THREE.InstancedMesh(quantumEllipsoidGeo, mat, 8192);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.fluidQuantaMeshes.set(matId, mesh);
    }
  }

  private disposeGroupResources(group: THREE.Object3D): void {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          for (const m of mesh.material) {
            if (!this.isSharedMaterial(m)) m.dispose();
          }
        } else if (!this.isSharedMaterial(mesh.material)) {
          mesh.material.dispose();
        }
      }
    });
  }

  private isSharedMaterial(mat: THREE.Material): boolean {
    for (const shared of this.fluidMaterials.values()) {
      if (shared === mat) return true;
    }
    return false;
  }

  private createCylindricalVatVisual(vat: GlassVatTank): THREE.Group {
    const group = new THREE.Group();

    const capMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.35,
      metalness: 0.75,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xbae6fd,
      emissive: 0x0284c7,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.34,
      roughness: 0.1,
      metalness: 0.25,
    });

    const baseCap = new THREE.Mesh(
      new THREE.CylinderGeometry(vat.radius * 1.04, vat.radius * 1.06, 0.16, 20),
      capMat
    );
    baseCap.position.y = 0.08;
    const topCap = new THREE.Mesh(
      new THREE.CylinderGeometry(vat.radius * 1.04, vat.radius * 1.04, 0.16, 20),
      capMat
    );
    topCap.position.y = vat.height - 0.08;

    const coreColor =
      vat.fluidMat === MaterialID.CRYO
        ? 0x67e8f9
        : vat.fluidMat === MaterialID.OIL
        ? 0x18181b
        : 0x0ea5e9;
    const liquidMat = new THREE.MeshStandardMaterial({
      color: coreColor,
      emissive: vat.fluidMat === MaterialID.CRYO ? 0x06b6d4 : 0x000000,
      emissiveIntensity: 0.5,
      roughness: 0.1,
    });
    const liquidCore = new THREE.Mesh(
      new THREE.CylinderGeometry(
        vat.radius * 0.82,
        vat.radius * 0.82,
        vat.height * 0.78,
        18
      ),
      liquidMat
    );
    liquidCore.position.y = vat.height * 0.48;

    const glassShell = new THREE.Mesh(
      new THREE.CylinderGeometry(vat.radius, vat.radius, vat.height - 0.2, 20),
      glassMat
    );
    glassShell.position.y = vat.height * 0.5;

    group.add(baseCap, topCap, liquidCore, glassShell);
    group.position.set(vat.x, vat.y, vat.z);
    this.scene.add(group);
    return group;
  }

  private initHumanoidRigAndPlumbLine(): void {
    const suitArmorMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.35,
      metalness: 0.5,
    });
    const darkJointMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.6,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.85,
      roughness: 0.1,
    });
    const tankMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.3,
      metalness: 0.4,
    });

    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.46, 0.24),
      suitArmorMat
    );
    torso.position.y = 0.72;
    torso.castShadow = true;
    this.playerGroup.add(torso);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28, 0.28),
      suitArmorMat
    );
    head.position.y = 1.12;
    head.castShadow = true;
    this.playerGroup.add(head);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.12, 0.06),
      visorMat
    );
    visor.position.set(0, 1.13, 0.13);
    this.playerGroup.add(visor);

    const backTank = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.42, 10),
      tankMat
    );
    backTank.position.set(0, 0.76, -0.18);
    this.playerGroup.add(backTank);

    const thrusterGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.22, 8);
    const leftThruster = new THREE.Mesh(thrusterGeo, darkJointMat);
    leftThruster.position.set(-0.14, 0.72, -0.18);
    const rightThruster = new THREE.Mesh(thrusterGeo, darkJointMat);
    rightThruster.position.set(0.14, 0.72, -0.18);
    this.playerGroup.add(leftThruster, rightThruster);

    const flameGeo = new THREE.ConeGeometry(0.06, 0.28, 8);
    flameGeo.rotateX(Math.PI);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    this.thrusterFlameLeft = new THREE.Mesh(flameGeo, flameMat);
    this.thrusterFlameLeft.position.set(-0.14, 0.5, -0.18);
    this.thrusterFlameRight = new THREE.Mesh(flameGeo, flameMat);
    this.thrusterFlameRight.position.set(0.14, 0.5, -0.18);
    this.playerGroup.add(this.thrusterFlameLeft, this.thrusterFlameRight);

    const legGeo = new THREE.BoxGeometry(0.13, 0.46, 0.14);
    const leftLeg = new THREE.Mesh(legGeo, darkJointMat);
    leftLeg.position.y = -0.23;
    this.leftLegPivot.position.set(-0.1, 0.48, 0);
    this.leftLegPivot.add(leftLeg);

    const rightLeg = new THREE.Mesh(legGeo, darkJointMat);
    rightLeg.position.y = -0.23;
    this.rightLegPivot.position.set(0.1, 0.48, 0);
    this.rightLegPivot.add(rightLeg);

    const armGeo = new THREE.BoxGeometry(0.11, 0.4, 0.12);
    const leftArm = new THREE.Mesh(armGeo, suitArmorMat);
    leftArm.position.y = -0.18;
    this.leftArmPivot.position.set(-0.25, 0.9, 0);
    this.leftArmPivot.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, suitArmorMat);
    rightArm.position.y = -0.18;
    const nozzleBarrel = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.38),
      tankMat
    );
    nozzleBarrel.position.set(0, -0.28, 0.18);
    this.rightArmPivot.position.set(0.25, 0.9, 0);
    this.rightArmPivot.add(rightArm, nozzleBarrel);

    this.playerGroup.add(
      this.leftLegPivot,
      this.rightLegPivot,
      this.leftArmPivot,
      this.rightArmPivot
    );
    this.scene.add(this.playerGroup);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    this.plumbLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.scene.add(this.plumbLine);

    const ringGeo = new THREE.RingGeometry(0.24, 0.35, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.plumbRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      })
    );
    this.scene.add(this.plumbRing);
  }

  private initLockOnReticle(): void {
    const ringGeo = new THREE.RingGeometry(0.45, 0.56, 4);
    ringGeo.rotateX(-Math.PI / 2);
    const outerRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        side: THREE.DoubleSide,
      })
    );
    const vertGeo = new THREE.RingGeometry(0.38, 0.46, 16);
    const vertRing = new THREE.Mesh(
      vertGeo,
      new THREE.MeshBasicMaterial({
        color: 0xef4444,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
      })
    );
    this.lockReticleGroup.add(outerRing, vertRing);
    this.lockReticleGroup.visible = false;
    this.scene.add(this.lockReticleGroup);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    this.lockTargetPlumbLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.lockTargetPlumbLine.visible = false;
    this.scene.add(this.lockTargetPlumbLine);

    const tRingGeo = new THREE.RingGeometry(0.22, 0.32, 20);
    tRingGeo.rotateX(-Math.PI / 2);
    this.lockTargetPlumbRing = new THREE.Mesh(
      tRingGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.lockTargetPlumbRing.visible = false;
    this.scene.add(this.lockTargetPlumbRing);
  }

  private createEntityVisual(kind: 'crate' | 'alien'): EntityVisualGroup {
    const root = new THREE.Group();
    let bodyMesh: THREE.Mesh;

    if (kind === 'crate') {
      const crateGeo = new THREE.BoxGeometry(0.68, 0.68, 0.68);
      const crateMat = new THREE.MeshStandardMaterial({
        color: 0xd97706,
        roughness: 0.7,
        metalness: 0.1,
      });
      bodyMesh = new THREE.Mesh(crateGeo, crateMat);
      bodyMesh.position.y = 0.34;
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;

      const bandEdges = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(0.7, 0.7, 0.7)
      );
      const bandLines = new THREE.LineSegments(
        bandEdges,
        new THREE.LineBasicMaterial({ color: 0x78350f })
      );
      bandLines.position.y = 0.34;
      root.add(bodyMesh, bandLines);
    } else {
      const chitinMat = new THREE.MeshStandardMaterial({
        color: 0x1e1b4b,
        emissive: 0x311042,
        emissiveIntensity: 0.35,
        roughness: 0.25,
        metalness: 0.6,
      });
      const glandMat = new THREE.MeshStandardMaterial({
        color: 0xa855f7,
        emissive: 0x9333ea,
        emissiveIntensity: 0.75,
        roughness: 0.2,
      });

      bodyMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.56, 0.34),
        chitinMat
      );
      bodyMesh.position.y = 0.68;
      bodyMesh.castShadow = true;
      root.add(bodyMesh);

      const cranium = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.24, 0.62),
        chitinMat
      );
      cranium.position.set(0, 1.12, 0.12);
      cranium.rotation.x = 0.2;
      root.add(cranium);

      const sac = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        glandMat
      );
      sac.position.set(0, 0.82, -0.2);
      root.add(sac);

      const legGeo = new THREE.BoxGeometry(0.12, 0.45, 0.12);
      const lLeg = new THREE.Mesh(legGeo, chitinMat);
      lLeg.position.set(-0.16, 0.22, 0);
      const rLeg = new THREE.Mesh(legGeo, chitinMat);
      rLeg.position.set(0.16, 0.22, 0);
      root.add(lLeg, rLeg);
    }

    const barY = kind === 'alien' ? 1.52 : 0.92;
    const bgPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.75, 0.09),
      new THREE.MeshBasicMaterial({ color: 0x0f172a, side: THREE.DoubleSide })
    );
    bgPlane.position.set(0, barY, 0);
    bgPlane.rotation.x = -0.65;

    const hpFillMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.71, 0.06),
      new THREE.MeshBasicMaterial({
        color: kind === 'alien' ? 0xef4444 : 0xf59e0b,
        side: THREE.DoubleSide,
      })
    );
    hpFillMesh.position.set(0, barY, 0.01);
    hpFillMesh.rotation.x = -0.65;
    root.add(bgPlane, hpFillMesh);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    const plumbLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0.7,
      })
    );
    this.scene.add(plumbLine);

    const ringGeo = new THREE.RingGeometry(0.2, 0.28, 18);
    ringGeo.rotateX(-Math.PI / 2);
    const plumbRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xef4444,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
      })
    );
    this.scene.add(plumbRing);
    this.scene.add(root);

    return { root, bodyMesh, plumbLine, plumbRing, hpFillMesh };
  }

  public rebuildDirtyInstances(): void {
    const { width, height, depth, matGrid } = this.room;

    if (this.room.dirtyStaticRender) {
      let opaqueCount = 0;
      let boundaryCutawayCount = 0;
      let glassBlockCount = 0;
      this.overhangRecords = [];

      const cylinderVatVoxels = new Set<number>();
      for (const vat of this.room.vats) {
        for (const vIdx of vat.voxelIndices) {
          cylinderVatVoxels.add(vIdx);
        }
      }

      const catwalkDepth = Math.max(7, Math.floor(depth * 0.18));

      for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
          for (let x = 0; x < width; x++) {
            const idx = getVoxelIndex(this.room, x, y, z);
            const mat = matGrid[idx] as MaterialID;
            if (mat !== MaterialID.HULL_STEEL && mat !== MaterialID.GLASS_VAT) {
              continue;
            }

            if (mat === MaterialID.GLASS_VAT && cylinderVatVoxels.has(idx)) {
              continue;
            }

            if (
              mat === MaterialID.HULL_STEEL &&
              y < 2 &&
              x > 0 &&
              x < width - 1 &&
              z > 0 &&
              z < depth - 1 &&
              isSolidVoxel(this.room, x, y + 1, z) &&
              isSolidVoxel(this.room, x + 1, y, z) &&
              isSolidVoxel(this.room, x - 1, y, z) &&
              isSolidVoxel(this.room, x, y, z + 1) &&
              isSolidVoxel(this.room, x, y, z - 1)
            ) {
              continue;
            }

            const wx = (x + 0.5) * VOXEL_SIZE;
            const wy = (y + 0.5) * VOXEL_SIZE;
            const wz = (z + 0.5) * VOXEL_SIZE;

            this.dummy.position.set(wx, wy, wz);
            this.dummy.rotation.set(0, 0, 0);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.updateMatrix();

            if (mat === MaterialID.GLASS_VAT) {
              if (glassBlockCount < this.glassBlockMesh.instanceMatrix.count) {
                this.glassBlockMesh.setMatrixAt(glassBlockCount++, this.dummy.matrix);
              }
              continue;
            }

            const isSouthOrEastUpperWall =
              (z === depth - 1 || x === width - 1) && y > 3;
            if (isSouthOrEastUpperWall) {
              if (boundaryCutawayCount < this.hullBoundaryCutawayMesh.instanceMatrix.count) {
                this.hullBoundaryCutawayMesh.setMatrixAt(
                  boundaryCutawayCount++,
                  this.dummy.matrix
                );
              }
              continue;
            }

            const isOuterWall =
              x === 0 || x === width - 1 || z === 0 || z === depth - 1;
            const isStairs = x >= 1 && x <= 5 && z >= 9 && z <= 22;
            const isOverhangOrPillar = !isOuterWall && !isStairs && y >= 3;
            const isSupportColumn =
              y >= 3 && y < 7 && z === catwalkDepth && (x - 8) % 12 === 0;

            const checker = (x + z) % 2 === 0 ? 0.016 : 0.0;
            if (y === 0) {
              this.colorScratch.setRGB(0.15 + checker, 0.2 + checker, 0.27 + checker);
            } else if (y <= 2) {
              this.colorScratch.setRGB(0.29 + checker, 0.34 + checker, 0.42 + checker);
            } else if (y === 7) {
              const isEdge = z === catwalkDepth || x === width - 8;
              if (isEdge && (x + z) % 2 === 0) {
                this.colorScratch.setRGB(0.9, 0.62, 0.14);
              } else {
                this.colorScratch.setRGB(0.44 + checker, 0.49 + checker, 0.58 + checker);
              }
            } else if (isStairs) {
              this.colorScratch.setRGB(0.55, 0.47, 0.34);
            } else {
              this.colorScratch.setRGB(0.24 + y * 0.014, 0.28 + y * 0.014, 0.36 + y * 0.014);
            }

            if (isOverhangOrPillar) {
              this.overhangRecords.push({
                x,
                y,
                z,
                wx,
                wy,
                wz,
                r: this.colorScratch.r,
                g: this.colorScratch.g,
                b: this.colorScratch.b,
                isColumn: isSupportColumn,
              });
            } else if (opaqueCount < this.hullOpaqueMesh.instanceMatrix.count) {
              this.hullOpaqueMesh.setMatrixAt(opaqueCount, this.dummy.matrix);
              this.hullOpaqueMesh.setColorAt(opaqueCount, this.colorScratch);
              opaqueCount++;
            }
          }
        }
      }

      this.hullOpaqueMesh.userData.baseCount = opaqueCount;
      this.hullBoundaryCutawayMesh.count = boundaryCutawayCount;
      this.hullBoundaryCutawayMesh.instanceMatrix.needsUpdate = true;

      this.glassBlockMesh.count = glassBlockCount;
      this.glassBlockMesh.instanceMatrix.needsUpdate = true;

      this.room.dirtyStaticRender = false;
      this.updateSurgicalOcclusionInstances();
    }

    // 2. Render Sub-Voxel Quanta with Strictly Bounded Physical Radius (max <= 0.135m — Zero Giant Saucers!)
    if (this.room.dirtyFluidRender) {
      const counts = new Map<MaterialID, number>();
      for (const m of FLUID_MATERIALS) counts.set(m, 0);
      let iceCount = 0;

      const quanta = this.room.fluidQuanta;

      for (let i = 0; i < quanta.length; i++) {
        const q = quanta[i];
        // Exact physical radius for a 0.05L quantum: ~0.095m
        const baseR = 0.21 * Math.cbrt(q.vol); // ~0.077m tiny individual drop radius

        if (q.mat === MaterialID.ICE) {
          if (iceCount >= this.iceCrystalMesh.instanceMatrix.count) continue;
          this.dummy.position.set(q.x, q.y, q.z);
          this.dummy.rotation.set(q.shimmer * 3.1, q.id * 1.7, q.shimmer * 2.3);
          this.dummy.scale.set(baseR * 1.1, baseR * 0.9, baseR * 1.1);
          this.dummy.updateMatrix();
          this.iceCrystalMesh.setMatrixAt(iceCount, this.dummy.matrix);

          const tint = 0.85 + q.shimmer * 0.15;
          this.colorScratch.setRGB(0.7 * tint, 0.92 * tint, 1.0 * tint);
          this.iceCrystalMesh.setColorAt(iceCount, this.colorScratch);
          iceCount++;
          continue;
        }

        const mesh = this.fluidQuantaMeshes.get(q.mat);
        if (!mesh) continue;
        const instanceIdx = counts.get(q.mat)!;
        if (instanceIdx >= mesh.instanceMatrix.count) continue;

        const speed = Math.hypot(q.vx, q.vy, q.vz);

        // Bounded Volume-Preserving Deformation:
        // - Floor contact gently flattens the droplet (height 0.55x, radius 1.35x -> 0.13m max)
        // - Free-flight velocity stretches the droplet along its velocity vector (up to 2.2x)
        const crowdBlend = 1.0 + Math.min(0.38, q.neighborCount * 0.055);
        const floorFlatten = q.grounded && this.room.gravityG > 0 ? 0.42 : 1.0;
        const velStretch = !q.grounded ? 1.0 + Math.min(1.2, speed * 0.18) : 1.0;

        const rEff = baseR * crowdBlend;
        const axialScale = rEff * floorFlatten * velStretch;
        const radialScale = rEff / Math.sqrt(floorFlatten * velStretch);

        this.dummy.position.set(q.x, q.y, q.z);
        if (speed > 0.35 && !q.grounded) {
          this.stretchAxis.set(q.vx, q.vy, q.vz).normalize();
          this.quatScratch.setFromUnitVectors(this.upVec, this.stretchAxis);
          this.dummy.quaternion.copy(this.quatScratch);
        } else {
          this.dummy.rotation.set(0, 0, 0);
        }
        this.dummy.scale.set(radialScale, axialScale, radialScale);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(instanceIdx, this.dummy.matrix);

        const kineticAeration = Math.min(0.55, speed * speed * 0.025);
        const shim = (q.shimmer - 0.5) * 0.12;

        if (q.mat === MaterialID.WATER) {
          this.colorScratch.setRGB(
            Math.min(1, 0.06 + shim * 0.4 + kineticAeration * 1.3),
            Math.min(1, 0.65 + shim + kineticAeration * 0.65),
            Math.min(1, 0.92 + shim * 0.5 + kineticAeration * 0.2)
          );
        } else if (q.mat === MaterialID.CRYO) {
          this.colorScratch.setRGB(
            Math.min(1, 0.4 + shim + kineticAeration),
            Math.min(1, 0.92 + shim * 0.5 + kineticAeration * 0.2),
            1.0
          );
        } else {
          const sheen = 0.09 + Math.max(0, shim * 0.45) + kineticAeration * 0.15;
          this.colorScratch.setRGB(sheen * 1.1, sheen * 0.95, sheen * 1.25);
        }

        mesh.setColorAt(instanceIdx, this.colorScratch);
        counts.set(q.mat, instanceIdx + 1);
      }

      for (const m of FLUID_MATERIALS) {
        const mesh = this.fluidQuantaMeshes.get(m)!;
        mesh.count = counts.get(m) || 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      this.iceCrystalMesh.count = iceCount;
      this.iceCrystalMesh.instanceMatrix.needsUpdate = true;
      if (this.iceCrystalMesh.instanceColor) {
        this.iceCrystalMesh.instanceColor.needsUpdate = true;
      }

      this.room.dirtyFluidRender = false;
    }
  }

  private updateSurgicalOcclusionInstances(): void {
    const baseCount: number = this.hullOpaqueMesh.userData.baseCount || 0;
    let opaqueIdx = baseCount;
    let occludingIdx = 0;
    let colIdx = 0;

    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;

    const actors: { x: number; y: number; z: number }[] = [
      { x: this.player.x, y: this.player.y + 0.65, z: this.player.z },
    ];
    for (const ent of this.room.entities) {
      if (ent.kind === 'alien') {
        actors.push({ x: ent.x, y: ent.y + 0.65, z: ent.z });
      }
    }

    for (let i = 0; i < this.overhangRecords.length; i++) {
      const rec = this.overhangRecords[i];
      let isOccludingAnyActor = false;

      for (let a = 0; a < actors.length; a++) {
        const act = actors[a];
        if (rec.wy < act.y - 0.2) continue;

        const abX = camX - act.x;
        const abY = camY - act.y;
        const abZ = camZ - act.z;
        const abLenSq = abX * abX + abY * abY + abZ * abZ;

        const apX = rec.wx - act.x;
        const apY = rec.wy - act.y;
        const apZ = rec.wz - act.z;
        const t = (apX * abX + apY * abY + apZ * abZ) / abLenSq;

        if (t > 0.02 && t < 0.85) {
          const closestX = act.x + abX * t;
          const closestY = act.y + abY * t;
          const closestZ = act.z + abZ * t;
          const distSq =
            (rec.wx - closestX) ** 2 +
            (rec.wy - closestY) ** 2 +
            (rec.wz - closestZ) ** 2;
          if (distSq < 1.65 * 1.65) {
            isOccludingAnyActor = true;
            break;
          }
        }
      }

      this.dummy.position.set(rec.wx, rec.wy, rec.wz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.colorScratch.setRGB(rec.r, rec.g, rec.b);

      if (isOccludingAnyActor) {
        if (occludingIdx < this.hullOccludingMesh.instanceMatrix.count) {
          this.hullOccludingMesh.setMatrixAt(occludingIdx, this.dummy.matrix);
          this.hullOccludingMesh.setColorAt(occludingIdx, this.colorScratch);
          occludingIdx++;
        }
      } else if (rec.isColumn) {
        if (colIdx < this.columnCylinderMesh.instanceMatrix.count) {
          this.columnCylinderMesh.setMatrixAt(colIdx, this.dummy.matrix);
          this.columnCylinderMesh.setColorAt(colIdx, this.colorScratch);
          colIdx++;
        }
      } else if (opaqueIdx < this.hullOpaqueMesh.instanceMatrix.count) {
        this.hullOpaqueMesh.setMatrixAt(opaqueIdx, this.dummy.matrix);
        this.hullOpaqueMesh.setColorAt(opaqueIdx, this.colorScratch);
        opaqueIdx++;
      }
    }

    this.hullOpaqueMesh.count = opaqueIdx;
    this.hullOpaqueMesh.instanceMatrix.needsUpdate = true;
    if (this.hullOpaqueMesh.instanceColor)
      this.hullOpaqueMesh.instanceColor.needsUpdate = true;

    this.hullOccludingMesh.count = occludingIdx;
    this.hullOccludingMesh.instanceMatrix.needsUpdate = true;
    if (this.hullOccludingMesh.instanceColor)
      this.hullOccludingMesh.instanceColor.needsUpdate = true;

    this.columnCylinderMesh.count = colIdx;
    this.columnCylinderMesh.instanceMatrix.needsUpdate = true;
    if (this.columnCylinderMesh.instanceColor)
      this.columnCylinderMesh.instanceColor.needsUpdate = true;
  }

  private updateRaycastAndLockOn(): void {
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const ray = this.raycaster.ray;
    const hit = raycastVoxelGrid(
      this.room,
      ray.origin.x,
      ray.origin.y,
      ray.origin.z,
      ray.direction.x,
      ray.direction.y,
      ray.direction.z
    );

    if (hit) {
      this.hoveredVoxel = hit.hitVoxel;
      this.placeVoxelCoords = hit.adjacentVoxel;
      this.input.aimWorldX = hit.worldPoint.x;
      this.input.aimWorldY = hit.worldPoint.y;
      this.input.aimWorldZ = hit.worldPoint.z;
      this.input.cursorHitGeometry = true;

      this.cursorMesh.visible = true;
      this.cursorMesh.position.set(
        (this.placeVoxelCoords.x + 0.5) * VOXEL_SIZE,
        (this.placeVoxelCoords.y + 0.5) * VOXEL_SIZE,
        (this.placeVoxelCoords.z + 0.5) * VOXEL_SIZE
      );
    } else {
      this.cursorMesh.visible = false;
      this.hoveredVoxel = null;
      this.placeVoxelCoords = null;
      this.input.cursorHitGeometry = false;

      this.aimFallbackPlane.constant = -(this.player.y + 0.75);
      if (ray.intersectPlane(this.aimFallbackPlane, this.aimFallbackTarget)) {
        this.input.aimWorldX = this.aimFallbackTarget.x;
        this.input.aimWorldY = this.aimFallbackTarget.y;
        this.input.aimWorldZ = this.aimFallbackTarget.z;
      } else {
        this.input.aimWorldX = ray.origin.x + ray.direction.x * 20;
        this.input.aimWorldY = ray.origin.y + ray.direction.y * 20;
        this.input.aimWorldZ = ray.origin.z + ray.direction.z * 20;
      }
    }

    this.lockOnTarget = findMagneticLockOnTarget(
      this.room,
      this.player,
      ray.origin.x,
      ray.origin.y,
      ray.origin.z,
      ray.direction.x,
      ray.direction.y,
      ray.direction.z,
      this.input.aimWorldX,
      this.input.aimWorldY,
      this.input.aimWorldZ,
      this.input.cursorHitGeometry
    );

    if (this.lockOnTarget) {
      this.input.aimWorldX = this.lockOnTarget.x;
      this.input.aimWorldY = this.lockOnTarget.y;
      this.input.aimWorldZ = this.lockOnTarget.z;
    }
  }

  private syncMovementKeys(): void {
    const w = this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp');
    const s = this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown');
    const a = this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft');
    const d = this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight');
    const up = this.keysPressed.has('KeyE');
    const down =
      this.keysPressed.has('ShiftLeft') || this.keysPressed.has('ShiftRight');

    this.input.moveZ = (s ? 1 : 0) - (w ? 1 : 0);
    this.input.moveX = (d ? 1 : 0) - (a ? 1 : 0);
    this.input.moveY = (up ? 1 : 0) - (down ? 1 : 0);
  }

  private updateCameraAndVisuals(dt: number): void {
    const p = this.player;
    this.playerGroup.position.set(p.x, p.y, p.z);
    this.playerGroup.rotation.y = p.yaw;

    const lookAheadX = Math.max(-2.2, Math.min(2.2, (this.input.aimWorldX - p.x) * 0.18));
    const lookAheadZ = Math.max(-2.2, Math.min(2.2, (this.input.aimWorldZ - p.z) * 0.18));
    const desiredCamX = p.x + lookAheadX;
    const desiredCamY = p.y * 0.5 + 1.2;
    const desiredCamZ = p.z + lookAheadZ;

    const camLerp = Math.min(1, dt * 7.5);
    this.camTargetPos.x += (desiredCamX - this.camTargetPos.x) * camLerp;
    this.camTargetPos.y += (desiredCamY - this.camTargetPos.y) * camLerp;
    this.camTargetPos.z += (desiredCamZ - this.camTargetPos.z) * camLerp;

    this.camera.position.set(
      this.camTargetPos.x + 6.5,
      this.camTargetPos.y + 18.0,
      this.camTargetPos.z + 15.5
    );
    this.camera.lookAt(this.camTargetPos);

    this.updateSurgicalOcclusionInstances();

    const limbLerp = Math.min(1, dt * 16);
    let targetLLeg = 0;
    let targetRLeg = 0;
    let targetLArm = -0.15;
    let targetRArm = -0.35;

    if (this.room.gravityG === 0 || !p.grounded) {
      targetLLeg = 0.25;
      targetRLeg = -0.2;
      targetLArm = -0.35;
      targetRArm = -0.5;
    } else {
      const swing = Math.sin(p.walkPhase) * 0.55 * p.walkBlend;
      targetLLeg = swing;
      targetRLeg = -swing;
      targetLArm = -swing * 0.65;
      targetRArm = -0.35 + swing * 0.2;
    }

    this.leftLegPivot.rotation.x += (targetLLeg - this.leftLegPivot.rotation.x) * limbLerp;
    this.rightLegPivot.rotation.x += (targetRLeg - this.rightLegPivot.rotation.x) * limbLerp;
    this.leftArmPivot.rotation.x += (targetLArm - this.leftArmPivot.rotation.x) * limbLerp;
    this.rightArmPivot.rotation.x += (targetRArm - this.rightArmPivot.rotation.x) * limbLerp;

    const showFlames = this.room.gravityG === 0 || p.jetpackActive;
    this.thrusterFlameLeft.visible = showFlames;
    this.thrusterFlameRight.visible = showFlames;
    if (showFlames) {
      const pulse = (p.dashTimer > 0 ? 1.6 : 0.85) + 0.3 * Math.sin(performance.now() * 0.025);
      this.thrusterFlameLeft.scale.set(1, pulse, 1);
      this.thrusterFlameRight.scale.set(1, pulse, 1);
    }

    const altitude = Math.max(0, p.y - p.floorY);
    this.plumbRing.position.set(p.x, p.floorY + 0.02, p.z);
    (this.plumbRing.material as THREE.MeshBasicMaterial).color.setHex(
      this.room.gravityG === 0 ? 0x38bdf8 : 0x4ade80
    );

    const posAttr = this.plumbLine.geometry.getAttribute(
      'position'
    ) as THREE.BufferAttribute;
    posAttr.setXYZ(0, p.x, p.floorY + 0.02, p.z);
    posAttr.setXYZ(1, p.x, p.y + 0.1, p.z);
    posAttr.needsUpdate = true;
    this.plumbLine.visible = altitude > 0.05 || this.room.gravityG === 0;

    const activeVatIds = new Set<number>();
    for (const vat of this.room.vats) {
      activeVatIds.add(vat.id);
      if (!this.vatVisuals.has(vat.id)) {
        this.vatVisuals.set(vat.id, this.createCylindricalVatVisual(vat));
      }
    }
    for (const [id, group] of this.vatVisuals.entries()) {
      if (!activeVatIds.has(id)) {
        this.scene.remove(group);
        this.disposeGroupResources(group);
        this.vatVisuals.delete(id);
      }
    }

    const activeIds = new Set<number>();
    for (const ent of this.room.entities) {
      activeIds.add(ent.id);
      let vis = this.entityVisuals.get(ent.id);
      if (!vis) {
        vis = this.createEntityVisual(ent.kind);
        this.entityVisuals.set(ent.id, vis);
      }

      vis.root.position.set(ent.x, ent.y, ent.z);
      vis.root.rotation.y = ent.yaw;

      const mat = vis.bodyMesh.material as THREE.MeshStandardMaterial;
      if (ent.slamFlashTimer > 0.5) {
        mat.emissive.setHex(0xef4444);
        mat.emissiveIntensity = 1.2;
      } else if (ent.hitStunTimer > 0) {
        mat.emissive.setHex(0x38bdf8);
        mat.emissiveIntensity = 0.85;
      } else {
        mat.emissive.setHex(ent.kind === 'alien' ? 0x311042 : 0x000000);
        mat.emissiveIntensity = ent.kind === 'alien' ? 0.35 : 0;
      }

      const hpRatio = Math.max(0.01, ent.hp / ent.maxHp);
      vis.hpFillMesh.scale.set(hpRatio, 1, 1);

      const entAlt = Math.max(0, ent.y - ent.floorY);
      const showEntPlumb = ent.kind === 'alien' && (entAlt > 0.1 || this.room.gravityG === 0);
      vis.plumbLine.visible = showEntPlumb;
      vis.plumbRing.visible = showEntPlumb;
      if (showEntPlumb) {
        vis.plumbRing.position.set(ent.x, ent.floorY + 0.02, ent.z);
        const eAttr = vis.plumbLine.geometry.getAttribute(
          'position'
        ) as THREE.BufferAttribute;
        eAttr.setXYZ(0, ent.x, ent.floorY + 0.02, ent.z);
        eAttr.setXYZ(1, ent.x, ent.y + 0.1, ent.z);
        eAttr.needsUpdate = true;
      }
    }

    for (const [id, vis] of this.entityVisuals.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(vis.root, vis.plumbLine, vis.plumbRing);
        this.disposeGroupResources(vis.root);
        this.disposeGroupResources(vis.plumbLine);
        this.disposeGroupResources(vis.plumbRing);
        this.entityVisuals.delete(id);
      }
    }

    if (this.lockOnTarget) {
      this.lockReticleGroup.visible = true;
      this.lockReticleGroup.position.set(
        this.lockOnTarget.x,
        this.lockOnTarget.y,
        this.lockOnTarget.z
      );
      this.lockReticleGroup.rotation.y += dt * 4.5;

      this.lockTargetPlumbLine.visible = true;
      this.lockTargetPlumbRing.visible = true;

      let targetFloorY = computeFloorAltitudeBelow(
        this.room,
        this.lockOnTarget.x,
        this.lockOnTarget.y,
        this.lockOnTarget.z,
        0.25
      );
      if (this.lockOnTarget.kind === 'entity') {
        const ent = this.room.entities.find(
          (e) => e.id === this.lockOnTarget?.entityId
        );
        if (ent) targetFloorY = ent.floorY;
      } else if (this.lockOnTarget.kind === 'vat') {
        const vat = this.room.vats.find((v) => v.id === this.lockOnTarget?.vatId);
        if (vat) targetFloorY = vat.y;
      }

      this.lockTargetPlumbRing.position.set(
        this.lockOnTarget.x,
        targetFloorY + 0.02,
        this.lockOnTarget.z
      );
      const lAttr = this.lockTargetPlumbLine.geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      lAttr.setXYZ(
        0,
        this.lockOnTarget.x,
        targetFloorY + 0.02,
        this.lockOnTarget.z
      );
      lAttr.setXYZ(
        1,
        this.lockOnTarget.x,
        this.lockOnTarget.y,
        this.lockOnTarget.z
      );
      lAttr.needsUpdate = true;
    } else {
      this.lockReticleGroup.visible = false;
      this.lockTargetPlumbLine.visible = false;
      this.lockTargetPlumbRing.visible = false;
    }

    const burstCount = Math.min(32, this.room.airBursts.length);
    for (let i = 0; i < burstCount; i++) {
      const b = this.room.airBursts[i];
      const base = i * 6;
      this.airBurstPositions[base] = b.startX;
      this.airBurstPositions[base + 1] = b.startY;
      this.airBurstPositions[base + 2] = b.startZ;
      this.airBurstPositions[base + 3] = b.endX;
      this.airBurstPositions[base + 4] = b.endY;
      this.airBurstPositions[base + 5] = b.endZ;
    }
    const burstAttr = this.airBurstMesh.geometry.getAttribute(
      'position'
    ) as THREE.BufferAttribute;
    burstAttr.needsUpdate = true;
    this.airBurstMesh.geometry.setDrawRange(0, burstCount * 2);
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private onMouseDown(e: MouseEvent): void {
    this.updateRaycastAndLockOn();
    if (e.button === 0) {
      fireCompressedAirNozzle(
        this.room,
        this.player,
        this.input,
        this.lockOnTarget
      );
      this.rebuildDirtyInstances();
      this.updateHUD();
    } else if (e.button === 2 && this.hoveredVoxel) {
      const { x, y, z } = this.hoveredVoxel;
      const idx = getVoxelIndex(this.room, x, y, z);

      const struckVat = this.room.vats.find((v) => v.voxelIndices.includes(idx));
      if (struckVat) {
        const matName = MATERIAL_TABLE[struckVat.fluidMat].name;
        shatterCylindricalVat(this.room, struckVat);
        this.room.lastCombatLog = `Carved & breached ${matName} Vat — 240 micro-quanta released!`;
      } else {
        setVoxel(this.room, x, y, z, MaterialID.AIR, 0.0);
        recountActiveCells(this.room);
      }

      this.rebuildDirtyInstances();
      this.updateHUD();
    }
  }

  private updateCameraFrustum(): void {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera.left = -this.viewSize * aspect;
    this.camera.right = this.viewSize * aspect;
    this.camera.top = this.viewSize;
    this.camera.bottom = -this.viewSize;
    this.camera.updateProjectionMatrix();
  }

  private onWheel(e: WheelEvent): void {
    this.viewSize = Math.max(5.2, Math.min(14.5, this.viewSize + e.deltaY * 0.005));
    this.updateCameraFrustum();
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.keysPressed.add(e.code);
    this.syncMovementKeys();

    if (e.code === 'KeyQ' && !e.repeat) {
      toggleRoomGravity(this.room, this.player);
      this.rebuildDirtyInstances();
      this.updateHUD();
    } else if (e.code === 'Space' && !e.repeat) {
      triggerPlayerDash(
        this.room,
        this.player,
        this.input,
        this.lockOnTarget
      );
    } else if (e.code === 'KeyF' && !e.repeat && this.placeVoxelCoords) {
      const { x, y, z } = this.placeVoxelCoords;
      if (this.selectedMaterial === MaterialID.WOOD_CRATE) {
        spawnDynamicEntity(
          this.room,
          'crate',
          (x + 0.5) * VOXEL_SIZE,
          y * VOXEL_SIZE,
          (z + 0.5) * VOXEL_SIZE
        );
      } else {
        setVoxel(this.room, x, y, z, this.selectedMaterial, 1.0);
      }
      recountActiveCells(this.room);
      this.rebuildDirtyInstances();
      this.updateHUD();
    } else if (e.code === 'KeyG' && !e.repeat && this.placeVoxelCoords) {
      const { x, y, z } = this.placeVoxelCoords;
      spawnDynamicEntity(
        this.room,
        'alien',
        (x + 0.5) * VOXEL_SIZE,
        y * VOXEL_SIZE,
        (z + 0.5) * VOXEL_SIZE
      );
      this.updateHUD();
    }

    const keyMap: Record<string, MaterialID> = {
      Digit1: MaterialID.HULL_STEEL,
      Digit2: MaterialID.WOOD_CRATE,
      Digit3: MaterialID.GLASS_VAT,
      Digit4: MaterialID.WATER,
      Digit5: MaterialID.OIL,
      Digit6: MaterialID.CRYO,
    };
    if (keyMap[e.code] !== undefined) {
      this.selectedMaterial = keyMap[e.code];
      this.updateHUD();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keysPressed.delete(e.code);
    this.syncMovementKeys();
  }

  private onResize(): void {
    this.updateCameraFrustum();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private updateHUD(): void {
    const gravLabel =
      this.room.gravityG > 0
        ? '<span style="color:#4ade80">1G INCOMPRESSIBLE SPH</span>'
        : '<span style="color:#38bdf8">0G COHESIVE CLUSTERS</span>';
    const lockStr = this.lockOnTarget
      ? `<span style="color:#facc15">LOCKED: ${this.lockOnTarget.label}</span>`
      : '<span style="color:#94a3b8">None (Hover within 14m & Line-of-Sight)</span>';

    const matName = MATERIAL_TABLE[this.selectedMaterial].name;
    const massBreakdown = `Total: <span style="color:#38bdf8">${this.room.totalFluidVolume.toFixed(
      2
    )}L</span> (Grid: ${this.room.gridFluidVolume.toFixed(
      1
    )}L | Vats: ${this.room.vatFluidVolume.toFixed(
      1
    )}L | Ice: ${this.room.iceVolume.toFixed(1)}L | Quanta: ${this.room.fluidQuanta.length})`;

    this.hudElement.innerHTML = `
      <div><strong>SHIFT ALCHEMIST — Bounded Micro-Quanta & 1G Pile-Collapse SPH</strong></div>
      <div>FPS: <span style="color:#4ade80">${this.fps}</span> | Gravity [Q]: <strong>${gravLabel}</strong> | ${massBreakdown}</div>
      <div>3D Magnetic Lock-On: ${lockStr}</div>
      <div>Combat Log: <span style="color:#fb923c">${this.room.lastCombatLog}</span></div>
      <div style="color:#cbd5e1; font-size:11px; margin-top:3px;">
        <strong>Test:</strong> Shatter Catwalk Vat -> Column collapses flat & pours over ledge with zero saucer overhang!<br/>
        <strong>Debug:</strong> [F] Spawn ${matName} [1-6] | [G] Spawn Alien | [R-Click] Carve
      </div>
    `;
  }

  public render(): void {
    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    this.updateRaycastAndLockOn();
    stepWorldPhysics(this.room, this.player, this.input, dt);
    this.updateCameraAndVisuals(dt);

    this.frameCount++;
    if (now - this.lastFpsTime >= 350) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.frameCount = 0;
      this.lastFpsTime = now;
      this.updateHUD();
    }

    this.rebuildDirtyInstances();
    this.renderer.render(this.scene, this.camera);
  }
}
