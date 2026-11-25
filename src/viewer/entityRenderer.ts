import * as THREE from 'three';
import {
  AIR_BURST_RANGE_M,
  ARENA_W,
  SLICE_STRIDE,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  GRAVITY_MODE,
  MAT,
  MAX_ENTITIES,
  PLAYER_TORSO_OFFSET_M,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
} from '../core/balance.ts';
import { cellIndex, getMat, getTimerOrCharge, isSolidMat, type ExplosionKind, type RoomState } from '../core/types.ts';
import { getWorkbenchOffer } from '../core/workbench.ts';
import type { WorldState } from '../core/world.ts';

interface EntityVisual {
  group: THREE.Group;
  mainMesh: THREE.Mesh;
  mainMat: THREE.MeshStandardMaterial;
  accentMesh: THREE.Mesh;
  accentMat: THREE.MeshStandardMaterial;
  frostGroup: THREE.Group;
  burnMesh: THREE.Mesh;
  shadowDisc: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  tetherMesh: THREE.Mesh;
  hpBarBg: THREE.Mesh;
  hpBarFill: THREE.Mesh;
  kind: 'pod' | 'skitterer' | 'bruiser' | 'spitter' | 'floater' | 'crate';
  stunRing: THREE.Mesh;
  telegraphBeam: THREE.Mesh;
  telegraphMat: THREE.MeshBasicMaterial;
  legs: THREE.Mesh[];
  bioCache: boolean;
  baseColorHex: number;
  baseEmissiveHex: number;
  baseEmissiveIntensity: number;
  hitFlashTimer: number;
}

interface VaporVoxel {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rotSpeed: number;
  baseScale: number;
  colorHex: number;
  lifeScale: number;
}

interface VolumetricBlast {
  coreMesh: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  voxels: VaporVoxel[];
  age: number;
  life: number;
  radiusM: number;
  kind: ExplosionKind;
}

interface DebrisCube {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rotSpeed: number;
  scale: number;
  colorHex: number;
  age: number;
  life: number;
}

interface VentVisual {
  group: THREE.Group;
  plumeMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  plumeMat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshStandardMaterial;
}

interface ConduitVisual {
  group: THREE.Group;
  orbMat: THREE.MeshStandardMaterial;
  arcMesh: THREE.LineSegments;
}

interface VatCollarVisual {
  group: THREE.Group;
  bottomRing: THREE.LineSegments;
  topRing: THREE.LineSegments;
  posts: THREE.Mesh[];
  mat: THREE.LineBasicMaterial;
}

interface TerminalVisual {
  group: THREE.Group;
  screenMat: THREE.MeshStandardMaterial;
  holoMesh: THREE.Mesh;
  holoMat: THREE.MeshBasicMaterial;
}

const MAX_BLASTS = 16;
const BLAST_VOXELS_PER_EVENT = 96;
const MAX_BLAST_INSTANCES = MAX_BLASTS * BLAST_VOXELS_PER_EVENT;
const MAX_DEBRIS = 220;
const AIR_RING_COUNT = 2;
const AIR_FLECK_COUNT = 10;
const MAX_0G_SHADOWS = 32;

const STEAM_PALETTE = [0xffffff, 0xeef5fc, 0xd8e6f2, 0xc4d6e6] as const;
const CRYO_PALETTE = [0xf2ffff, 0xc7f8ff, 0x8ef0ff, 0x5be7ff] as const;

function findSurfaceYBelow(room: RoomState, xM: number, startYM: number, zM: number): number {
  const vx = Math.max(0, Math.min(room.roomW - 1, Math.floor(xM / VOXEL_SIZE_M)));
  const vz = Math.max(0, Math.min(room.roomD - 1, Math.floor(zM / VOXEL_SIZE_M)));
  const startVY = Math.max(0, Math.min(room.roomH - 1, Math.floor((startYM - 1e-4) / VOXEL_SIZE_M)));
  for (let vy = startVY; vy >= 0; vy--) {
    if (isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]))) {
      return (vy + 1) * VOXEL_SIZE_M;
    }
  }
  return 0.2;
}

function createSoftShadowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(4, 7, 14, 0.72)');
    grad.addColorStop(0.55, 'rgba(4, 7, 14, 0.34)');
    grad.addColorStop(1, 'rgba(4, 7, 14, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.55)');
    grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.14)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function applyFresnelRim(mat: THREE.MeshStandardMaterial, rimHex: number, strength: number, key: string): void {
  const r = ((rimHex >> 16) & 255) / 255;
  const g = ((rimHex >> 8) & 255) / 255;
  const b = (rimHex & 255) / 255;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `float rimPow = pow(1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0), 2.3);
       gl_FragColor.rgb += vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}) * rimPow * ${strength.toFixed(2)};
       #include <dithering_fragment>`,
    );
  };
  mat.customProgramCacheKey = () => `ent_rim_${key}`;
}

export class EntityRenderer {
  private readonly visuals = new Map<number, EntityVisual>();
  private readonly scene: THREE.Scene;

  private readonly podSacGeo: THREE.IcosahedronGeometry;
  private readonly podStalkGeo: THREE.CylinderGeometry;
  private readonly podRibGeo: THREE.BoxGeometry;
  private readonly podCoreGeo: THREE.SphereGeometry;
  private readonly crateGeo: THREE.BoxGeometry;
  private readonly crateRibGeo: THREE.BoxGeometry;
  private readonly bioCoreGeo: THREE.CylinderGeometry;
  private readonly frostSpikeGeo: THREE.ConeGeometry;
  private readonly burnFlameGeo: THREE.OctahedronGeometry;
  private readonly shadowGeo: THREE.CircleGeometry;
  private readonly tetherGeo: THREE.CylinderGeometry;
  private readonly barGeo: THREE.PlaneGeometry;
  private readonly softShadowTex: THREE.CanvasTexture;
  private readonly glowTex: THREE.CanvasTexture;
  private readonly stunRingGeo: THREE.RingGeometry;
  private readonly telegraphGeo: THREE.PlaneGeometry;

  private readonly reticleGroup = new THREE.Group();
  private readonly reticleRing: THREE.LineLoop;
  private readonly reticleMat: THREE.LineBasicMaterial;
  private readonly reticleDiamond: THREE.LineSegments;

  // Pneumatic Shockwave Air Burst (3 expanding rings + 18 air flecks)
  private readonly airRings: THREE.Mesh[] = [];
  private readonly airRingMats: THREE.MeshBasicMaterial[] = [];
  private readonly airFleckMesh: THREE.InstancedMesh;
  private airBurstAge = 1;
  private readonly airBurstOrigin = new THREE.Vector3();
  private readonly airBurstDir = new THREE.Vector3(0, 0, 1);

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpMat4 = new THREE.Matrix4();
  private readonly tmpColor = new THREE.Color();
  private readonly seenIds = new Set<number>();

  private readonly blasts: VolumetricBlast[] = [];
  private blastCursor = 0;
  private readonly blastInstancedMesh: THREE.InstancedMesh;
  private readonly blastLight: THREE.PointLight;
  private blastLightAge = 1;
  private blastLightLife = 0;
  private blastLightPeak = 0;

  // Instanced shatter/impact debris pool
  private readonly debris: DebrisCube[] = [];
  private debrisCursor = 0;
  private readonly debrisMesh: THREE.InstancedMesh;

  // 0G fluid cluster ground drop-shadows
  private readonly fluidShadowMesh: THREE.InstancedMesh;
  private readonly electricBoltMesh: THREE.InstancedMesh;
  private readonly electricLight: THREE.PointLight;
  private readonly boltUpVec = new THREE.Vector3(0, 1, 0);
  private readonly boltDirVec = new THREE.Vector3();
  private readonly boltMidVec = new THREE.Vector3();
  private readonly fireLight: THREE.PointLight;
  private readonly fireEmberMesh: THREE.InstancedMesh;
  private readonly fireSmokeMesh: THREE.InstancedMesh;
  private readonly chargedSampleX = new Float32Array(56);
  private readonly chargedSampleY = new Float32Array(56);
  private readonly chargedSampleZ = new Float32Array(56);
  private readonly dummy = new THREE.Object3D();

  private readonly ventVisuals: VentVisual[] = [];
  private readonly conduitVisuals: ConduitVisual[] = [];
  private readonly cryoPipeVisuals: Array<{ group: THREE.Group; ringMat: THREE.MeshBasicMaterial }> = [];
  private readonly vatCollars: VatCollarVisual[] = [];
  private readonly terminalVisuals: TerminalVisual[] = [];
  private readonly termBaseGeo: THREE.BoxGeometry;
  private readonly termScreenGeo: THREE.BoxGeometry;
  private readonly termHoloGeo: THREE.OctahedronGeometry;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.podSacGeo = new THREE.IcosahedronGeometry(0.42, 1);
    this.podSacGeo.scale(1.0, 1.18, 1.0);
    this.podStalkGeo = new THREE.CylinderGeometry(0.32, 0.44, 0.34, 8);
    this.podRibGeo = new THREE.BoxGeometry(0.09, 0.72, 0.14);
    this.podCoreGeo = new THREE.SphereGeometry(0.24, 10, 8);

    this.crateGeo = new THREE.BoxGeometry(0.94, 0.94, 0.94);
    this.crateRibGeo = new THREE.BoxGeometry(1.0, 0.13, 1.0);
    this.bioCoreGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.72, 12);

    this.frostSpikeGeo = new THREE.ConeGeometry(0.11, 0.42, 5);
    this.burnFlameGeo = new THREE.OctahedronGeometry(0.22, 0);
    this.shadowGeo = new THREE.CircleGeometry(0.5, 18);
    this.shadowGeo.rotateX(-Math.PI / 2);
    this.tetherGeo = new THREE.CylinderGeometry(0.012, 0.012, 1.0, 6);
    this.barGeo = new THREE.PlaneGeometry(0.84, 0.095);
    this.softShadowTex = createSoftShadowTexture();
    this.glowTex = createGlowTexture();
    this.stunRingGeo = new THREE.RingGeometry(0.32, 0.44, 18);
    this.stunRingGeo.rotateX(-Math.PI / 2);
    this.telegraphGeo = new THREE.PlaneGeometry(0.28, 1.0);
    this.telegraphGeo.rotateX(-Math.PI / 2);

    this.termBaseGeo = new THREE.BoxGeometry(0.38, 0.96, 0.38);
    this.termScreenGeo = new THREE.BoxGeometry(0.42, 0.34, 0.14);
    this.termHoloGeo = new THREE.OctahedronGeometry(0.15, 0);

    // 3D Magnetic Lock-On Reticle
    this.reticleMat = new THREE.LineBasicMaterial({
      color: 0xff595e,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const ringPts: number[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ringPts.push(Math.cos(a), 0, Math.sin(a));
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
    this.reticleRing = new THREE.LineLoop(ringGeo, this.reticleMat);
    this.reticleRing.renderOrder = 20;

    const diamondGeo = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.32, 0));
    this.reticleDiamond = new THREE.LineSegments(diamondGeo, this.reticleMat);
    this.reticleDiamond.renderOrder = 20;

    this.reticleGroup.add(this.reticleRing, this.reticleDiamond);
    this.reticleGroup.visible = false;
    scene.add(this.reticleGroup);

    // Pneumatic Crescent Shockwave Air Burst (curved horizontal wind-slash blades + tight air streaks)
    const crescentGeo = new THREE.RingGeometry(0.42, 0.72, 18, 1, -Math.PI * 0.34, Math.PI * 0.68);
    crescentGeo.rotateX(-Math.PI / 2);
    crescentGeo.rotateY(Math.PI / 2);
    for (let i = 0; i < AIR_RING_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i === 0 ? 0xe8fdff : 0x62f2ff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(crescentGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.airRings.push(mesh);
      this.airRingMats.push(mat);
    }

    const fleckGeo = new THREE.BoxGeometry(0.05, 0.05, 0.28);
    const fleckMat = new THREE.MeshBasicMaterial({
      color: 0xd8fbff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.airFleckMesh = new THREE.InstancedMesh(fleckGeo, fleckMat, AIR_FLECK_COUNT);
    this.airFleckMesh.count = 0;
    this.airFleckMesh.frustumCulled = false;
    scene.add(this.airFleckMesh);

    // Shared 1-draw-call InstancedMesh for volumetric steam/cryo vapor voxel bursts
    const voxelGeo = new THREE.BoxGeometry(VOXEL_SIZE_M, VOXEL_SIZE_M, VOXEL_SIZE_M);
    const voxelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.0,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.blastInstancedMesh = new THREE.InstancedMesh(voxelGeo, voxelMat, MAX_BLAST_INSTANCES);
    this.blastInstancedMesh.count = 0;
    this.blastInstancedMesh.frustumCulled = false;
    scene.add(this.blastInstancedMesh);

    this.blastLight = new THREE.PointLight(0xffffff, 0, 7.5, 2);
    scene.add(this.blastLight);

    const coreGeo = new THREE.BoxGeometry(VOXEL_SIZE_M * 1.4, VOXEL_SIZE_M * 1.4, VOXEL_SIZE_M * 1.4);
    for (let i = 0; i < MAX_BLASTS; i++) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      coreMesh.visible = false;
      scene.add(coreMesh);

      const voxels: VaporVoxel[] = [];
      for (let v = 0; v < BLAST_VOXELS_PER_EVENT; v++) {
        voxels.push({
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          rx: 0, ry: 0, rotSpeed: 0, baseScale: 1, colorHex: 0xffffff, lifeScale: 1,
        });
      }
      this.blasts.push({
        coreMesh, coreMat, voxels, age: 0, life: 0, radiusM: 1.8, kind: 'steam',
      });
    }

    // Shatter / kill debris pool
    const debGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);
    const debMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.15,
    });
    this.debrisMesh = new THREE.InstancedMesh(debGeo, debMat, MAX_DEBRIS);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    scene.add(this.debrisMesh);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rotSpeed: 0, scale: 1, colorHex: 0xffffff, age: 0, life: 0,
      });
    }

    // 0G fluid cluster ground drop-shadow pool
    const fShadGeo = new THREE.CircleGeometry(0.75, 16);
    fShadGeo.rotateX(-Math.PI / 2);
    const fShadMat = new THREE.MeshBasicMaterial({
      map: this.softShadowTex,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.fluidShadowMesh = new THREE.InstancedMesh(fShadGeo, fShadMat, MAX_0G_SHADOWS);
    this.fluidShadowMesh.count = 0;
    this.fluidShadowMesh.frustumCulled = false;
    scene.add(this.fluidShadowMesh);

    // Razor-thin surface-skimming electric arc segments (no vertical grass spikes!)
    const boltGeo = new THREE.BoxGeometry(0.022, 1.0, 0.022);
    const boltMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.electricBoltMesh = new THREE.InstancedMesh(boltGeo, boltMat, 220);
    this.electricBoltMesh.renderOrder = 5;
    this.electricBoltMesh.count = 0;
    this.electricBoltMesh.frustumCulled = false;
    scene.add(this.electricBoltMesh);

    this.electricLight = new THREE.PointLight(0x66dcff, 0, 11.0, 1.5);
    scene.add(this.electricLight);

    // Dynamic flickering firelight + Noita-style rising dark charcoal smoke + crisp micro-sparks
    this.fireLight = new THREE.PointLight(0xff6b1a, 0, 13.0, 1.4);
    scene.add(this.fireLight);

    this.fireSmokeMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.11),
      new THREE.MeshBasicMaterial({
        color: 0x1b181b,
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
      }),
      110,
    );
    this.fireSmokeMesh.renderOrder = 5;
    this.fireSmokeMesh.count = 0;
    this.fireSmokeMesh.frustumCulled = false;
    scene.add(this.fireSmokeMesh);

    this.fireEmberMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.044, 0.055, 0.044),
      new THREE.MeshBasicMaterial({
        color: 0xffc83d,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      128,
    );
    this.fireEmberMesh.renderOrder = 5;
    this.fireEmberMesh.count = 0;
    this.fireEmberMesh.frustumCulled = false;
    scene.add(this.fireEmberMesh);
  }

  private spawnDebrisBurst(x: number, y: number, z: number, count: number, colorHex: number, speed = 4.5): void {
    const golden = 2.399963229728653;
    for (let i = 0; i < count; i++) {
      const d = this.debris[this.debrisCursor];
      this.debrisCursor = (this.debrisCursor + 1) % MAX_DEBRIS;
      const frac = (i + 0.5) / count;
      const theta = i * golden + this.debrisCursor * 0.37;
      const horiz = Math.sqrt(Math.max(0.1, 1 - frac * frac));
      const spd = speed * (0.55 + (i % 4) * 0.22);
      d.x = x + Math.cos(theta) * 0.12;
      d.y = y + 0.1;
      d.z = z + Math.sin(theta) * 0.12;
      d.vx = Math.cos(theta) * horiz * spd;
      d.vy = 1.8 + frac * spd * 0.9;
      d.vz = Math.sin(theta) * horiz * spd;
      d.rx = theta;
      d.ry = frac * 3.14;
      d.rotSpeed = (i & 1 ? 1 : -1) * 7.5;
      d.scale = 0.7 + (i % 3) * 0.35;
      d.colorHex = colorHex;
      d.age = 0;
      d.life = 0.52 + (i % 4) * 0.1;
    }
  }

  private createVisual(kind: 'pod' | 'skitterer' | 'bruiser' | 'spitter' | 'floater' | 'crate', bioCache: boolean, glandMatId: number): EntityVisual {
    const group = new THREE.Group();

    const baseColorHex = kind === 'floater' ? 0x5c2a6b : kind === 'bruiser' ? 0x4a5568 : kind === 'spitter' ? 0x2d4a3e : kind === 'skitterer' ? 0x3b1838 : kind === 'pod' ? 0x7b1d4a : bioCache ? 0x253847 : 0x9b6b3b;
    const baseEmissiveHex = kind === 'floater' ? 0x321242 : kind === 'bruiser' ? 0x1b2433 : kind === 'spitter' ? 0x112b20 : kind === 'pod' ? 0x450d28 : bioCache ? 0x0b2a30 : 0x000000;
    const baseEmissiveIntensity = kind === 'pod' ? 0.7 : bioCache ? 0.45 : 0.0;

    const mainMat = new THREE.MeshStandardMaterial({
      color: baseColorHex,
      emissive: baseEmissiveHex,
      emissiveIntensity: baseEmissiveIntensity,
      roughness: kind === 'pod' ? 0.42 : bioCache ? 0.45 : 0.82,
      metalness: kind === 'pod' ? 0.18 : bioCache ? 0.62 : 0.08,
    });
    const rimHex = kind === 'floater' ? 0xe082ff : kind === 'bruiser' ? 0xffb347 : kind === 'spitter' ? 0x5ef2d6 : kind === 'skitterer' || kind === 'pod' ? 0xff5a8a : bioCache ? 0x5ef2d6 : 0xd4a373;
    const rimStr = kind === 'crate' && !bioCache ? 0.24 : 0.62;
    applyFresnelRim(mainMat, rimHex, rimStr, `${kind}_${bioCache ? 1 : 0}`);

    const accentMat = new THREE.MeshStandardMaterial(
      kind === 'pod'
        ? {
            color: 0xff4d79,
            emissive: 0xff2a6d,
            emissiveIntensity: 1.35,
            roughness: 0.18,
            metalness: 0.1,
          }
        : {
            color: bioCache ? 0x5ef2d6 : 0x56391e,
            emissive: bioCache ? 0x26e8c0 : 0x000000,
            emissiveIntensity: bioCache ? 1.25 : 0.0,
            roughness: bioCache ? 0.18 : 0.65,
            metalness: bioCache ? 0.25 : 0.35,
          },
    );

    const glandHex = glandMatId === MAT.WATER ? 0x38b6ff : glandMatId === MAT.CRYO ? 0x5be7ff : 0xe89b3c;
    const legs: THREE.Mesh[] = [];
    let mainMesh: THREE.Mesh;
    let accentMesh: THREE.Mesh;

    if (kind === 'floater') {
      // Hovering Gas-Bladder Floater: bulbous buoyant dome + glowing fluid core + dangling stabilizer tendrils
      mainMesh = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 12), mainMat);
      mainMesh.scale.set(1.0, 0.88, 1.0);
      mainMesh.position.set(0, 0.22, 0);
      mainMesh.castShadow = true;

      accentMat.color.setHex(glandHex);
      accentMat.emissive.setHex(glandHex);
      accentMat.emissiveIntensity = 1.35;
      accentMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), accentMat);
      accentMesh.position.set(0, -0.18, 0);

      const tendrilMat = new THREE.MeshStandardMaterial({ color: 0x26122f, roughness: 0.55, metalness: 0.2 });
      const tendrilGeo = new THREE.CylinderGeometry(0.045, 0.02, 0.48, 6);
      for (let t = 0; t < 4; t++) {
        const a = (t / 4) * Math.PI * 2 + 0.4;
        const leg = new THREE.Mesh(tendrilGeo, tendrilMat);
        leg.position.set(Math.cos(a) * 0.26, -0.44, Math.sin(a) * 0.26);
        group.add(leg);
        legs.push(leg);
      }
      const flGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: glandHex,
          transparent: true,
          opacity: 0.42,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      flGlow.position.set(0, 0.1, 0);
      flGlow.scale.set(1.4, 1.4, 1);
      group.add(mainMesh, accentMesh, flGlow);
    } else if (kind === 'bruiser') {
      // Heavy Armored Carapace Bruiser: thick metallic-plated hull + angled shoulder pauldrons + glowing vents + stomp legs
      mainMat.metalness = 0.72;
      mainMat.roughness = 0.34;
      mainMesh = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.92, 1.18), mainMat);
      mainMesh.position.set(0, 0.08, 0);
      mainMesh.castShadow = true;
      mainMesh.receiveShadow = true;

      const plateMat = new THREE.MeshStandardMaterial({ color: 0x6b7c93, roughness: 0.28, metalness: 0.85 });
      const pauldronL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.56, 1.02), plateMat);
      pauldronL.position.set(-0.66, 0.22, 0);
      pauldronL.rotation.z = 0.22;
      const pauldronR = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.56, 1.02), plateMat);
      pauldronR.position.set(0.66, 0.22, 0);
      pauldronR.rotation.z = -0.22;
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.26, 0.34), plateMat);
      brow.position.set(0, 0.38, -0.56);

      accentMat.color.setHex(0xff9f1c);
      accentMat.emissive.setHex(0xff6b1a);
      accentMat.emissiveIntensity = 1.2;
      accentMesh = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.22, 0.24), accentMat);
      accentMesh.position.set(0, 0.14, -0.58);

      const legMat = new THREE.MeshStandardMaterial({ color: 0x262f3d, roughness: 0.5, metalness: 0.7 });
      const legGeo = new THREE.BoxGeometry(0.28, 0.52, 0.32);
      for (let side = -1; side <= 1; side += 2) {
        for (let r = -1; r <= 1; r += 2) {
          const leg = new THREE.Mesh(legGeo, legMat);
          leg.position.set(side * 0.44, -0.52, r * 0.38);
          group.add(leg);
          legs.push(leg);
        }
      }
      group.add(mainMesh, pauldronL, pauldronR, brow, accentMesh);
    } else if (kind === 'spitter') {
      // High-Ground Scaffold Spitter: tall perched tripod + elevated glowing fluid mortar sac + range snout
      mainMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.62, 8), mainMat);
      mainMesh.position.set(0, -0.1, 0);
      mainMesh.castShadow = true;
      mainMesh.receiveShadow = true;

      accentMat.color.setHex(glandHex);
      accentMat.emissive.setHex(glandHex);
      accentMat.emissiveIntensity = 1.25;
      accentMesh = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 10), accentMat);
      accentMesh.position.set(0, 0.34, 0.08);

      const snoutMat = new THREE.MeshStandardMaterial({ color: 0x1e2c26, roughness: 0.5, metalness: 0.35 });
      const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.17, 0.46, 8), snoutMat);
      snout.rotation.x = Math.PI * 0.35;
      snout.position.set(0, 0.26, -0.34);

      const legGeo = new THREE.BoxGeometry(0.12, 0.52, 0.12);
      for (let t = 0; t < 3; t++) {
        const a = (t / 3) * Math.PI * 2;
        const leg = new THREE.Mesh(legGeo, snoutMat);
        leg.position.set(Math.cos(a) * 0.36, -0.34, Math.sin(a) * 0.36);
        leg.rotation.z = -Math.cos(a) * 0.35;
        leg.rotation.x = Math.sin(a) * 0.35;
        group.add(leg);
        legs.push(leg);
      }
      group.add(mainMesh, accentMesh, snout);
    } else if (kind === 'skitterer') {
      // Low-slung Chitin Skitterer: armored carapace + 6 articulated legs + glowing dorsal fluid gland sac + red eyes
      mainMesh = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.34, 0.94), mainMat);
      mainMesh.position.set(0, -0.05, 0);
      mainMesh.castShadow = true;
      mainMesh.receiveShadow = true;

      accentMat.color.setHex(glandHex);
      accentMat.emissive.setHex(glandHex);
      accentMat.emissiveIntensity = 0.85;
      accentMesh = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 8), accentMat);
      accentMesh.scale.set(1.0, 0.78, 1.25);
      accentMesh.position.set(0, 0.2, 0.14);

      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a55 });
      const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.08), eyeMat);
      eyeL.position.set(-0.17, 0.02, -0.48);
      const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.08), eyeMat);
      eyeR.position.set(0.17, 0.02, -0.48);

      const legMat = new THREE.MeshStandardMaterial({ color: 0x221024, roughness: 0.6, metalness: 0.3 });
      const legGeo = new THREE.BoxGeometry(0.32, 0.08, 0.1);
      for (let side = -1; side <= 1; side += 2) {
        for (let r = -1; r <= 1; r++) {
          const leg = new THREE.Mesh(legGeo, legMat);
          leg.position.set(side * 0.44, -0.22, r * 0.28);
          leg.rotation.z = side * -0.45;
          group.add(leg);
          legs.push(leg);
        }
      }
      group.add(mainMesh, accentMesh, eyeL, eyeR);
    } else if (kind === 'pod') {
      // Multi-part alien Brood Pod: chitin base stalk + bulbous organic sac + 4 dark carapace ribs + glowing spore core
      const stalkMat = new THREE.MeshStandardMaterial({ color: 0x2b1525, roughness: 0.7, metalness: 0.2 });
      const stalk = new THREE.Mesh(this.podStalkGeo, stalkMat);
      stalk.position.set(0, -0.43, 0);
      stalk.castShadow = true;
      group.add(stalk);

      mainMesh = new THREE.Mesh(this.podSacGeo, mainMat);
      mainMesh.position.set(0, 0.06, 0);
      mainMesh.castShadow = true;
      mainMesh.receiveShadow = true;

      accentMesh = new THREE.Mesh(this.podCoreGeo, accentMat);
      accentMesh.position.set(0, 0.22, 0);

      for (let r = 0; r < 4; r++) {
        const a = (r / 4) * Math.PI * 2 + Math.PI * 0.25;
        const rib = new THREE.Mesh(this.podRibGeo, stalkMat);
        rib.position.set(Math.cos(a) * 0.34, -0.02, Math.sin(a) * 0.34);
        rib.rotation.y = -a;
        rib.rotation.z = 0.22;
        group.add(rib);
      }
      group.add(mainMesh, accentMesh);
    } else if (bioCache) {
      // High-visibility Bio-Cache Salvage Canister: armored frame + bright glowing cyan fluid core
      mainMesh = new THREE.Mesh(this.crateGeo, mainMat);
      mainMesh.scale.set(0.86, 0.2, 0.86);
      mainMesh.position.set(0, -0.38, 0);
      mainMesh.castShadow = true;

      const topCap = new THREE.Mesh(this.crateGeo, mainMat);
      topCap.scale.set(0.86, 0.2, 0.86);
      topCap.position.set(0, 0.38, 0);
      topCap.castShadow = true;
      group.add(topCap);

      for (let p = 0; p < 4; p++) {
        const sx = p & 1 ? 0.34 : -0.34;
        const sz = p & 2 ? 0.34 : -0.34;
        const post = new THREE.Mesh(this.podRibGeo, mainMat);
        post.position.set(sx, 0, sz);
        group.add(post);
      }

      accentMesh = new THREE.Mesh(this.bioCoreGeo, accentMat);
      const bioGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0x5ef2d6,
          transparent: true,
          opacity: 0.48,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      bioGlow.scale.set(1.4, 1.4, 1);
      group.add(mainMesh, accentMesh, bioGlow);
    } else {
      // Slatted Timber Shipping Crate: wood box + top/bottom metal-trimmed framing bands + diagonal brace
      mainMesh = new THREE.Mesh(this.crateGeo, mainMat);
      mainMesh.castShadow = true;
      mainMesh.receiveShadow = true;

      accentMesh = new THREE.Mesh(this.crateRibGeo, accentMat);
      accentMesh.position.set(0, 0.38, 0);
      const bottomBand = new THREE.Mesh(this.crateRibGeo, accentMat);
      bottomBand.position.set(0, -0.38, 0);
      const midBand = new THREE.Mesh(this.crateRibGeo, accentMat);
      midBand.scale.set(1.01, 0.7, 1.01);
      group.add(mainMesh, accentMesh, bottomBand, midBand);
    }

    // Status Auras: Jagged Frost Crystals (embrittled) + Flickering Flame (burning)
    const frostGroup = new THREE.Group();
    const frostMat = new THREE.MeshStandardMaterial({
      color: 0x8ef7ff,
      emissive: 0x38d9f5,
      emissiveIntensity: 0.9,
      roughness: 0.15,
      metalness: 0.1,
    });
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2;
      const spike = new THREE.Mesh(this.frostSpikeGeo, frostMat);
      spike.position.set(Math.cos(a) * 0.42, 0.1, Math.sin(a) * 0.42);
      spike.rotation.z = -Math.cos(a) * 0.65;
      spike.rotation.x = Math.sin(a) * 0.65;
      frostGroup.add(spike);
    }
    frostGroup.visible = false;
    group.add(frostGroup);

    const burnMesh = new THREE.Mesh(
      this.burnFlameGeo,
      new THREE.MeshBasicMaterial({ color: 0xff7b1a, transparent: true, opacity: 0.85 }),
    );
    burnMesh.position.set(0, 0.65, 0);
    burnMesh.visible = false;
    group.add(burnMesh);

    const hpBarBg = new THREE.Mesh(
      this.barGeo,
      new THREE.MeshBasicMaterial({ color: 0x10141c, side: THREE.DoubleSide }),
    );
    hpBarBg.position.set(0, kind === 'pod' ? 0.96 : 0.82, 0);
    hpBarBg.visible = false;

    const hpBarFill = new THREE.Mesh(
      this.barGeo,
      new THREE.MeshBasicMaterial({
        color: kind === 'pod' ? 0xff4d79 : bioCache ? 0x5ef2d6 : 0xffbe55,
        side: THREE.DoubleSide,
      }),
    );
    hpBarFill.position.set(0, kind === 'pod' ? 0.96 : 0.82, 0.005);
    hpBarFill.visible = false;
    group.add(hpBarBg, hpBarFill);

    // Independent ground drop-shadow & altitude tether (added directly to scene)
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.softShadowTex,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const shadowDisc = new THREE.Mesh(this.shadowGeo, shadowMat);
    this.scene.add(shadowDisc);

    const stunRing = new THREE.Mesh(
      this.stunRingGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffe066,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    stunRing.position.set(0, kind === 'skitterer' ? 0.65 : 0.85, 0);
    stunRing.visible = false;
    group.add(stunRing);

    const telegraphMat = new THREE.MeshBasicMaterial({
      color: 0xff2a55,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const telegraphBeam = new THREE.Mesh(this.telegraphGeo, telegraphMat);
    telegraphBeam.visible = false;
    this.scene.add(telegraphBeam);

    const tetherMesh = new THREE.Mesh(
      this.tetherGeo,
      new THREE.MeshBasicMaterial({
        color: kind === 'pod' ? 0xff4d79 : 0xffbe55,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    tetherMesh.visible = false;
    this.scene.add(tetherMesh);

    this.scene.add(group);
    return {
      group,
      mainMesh,
      mainMat,
      accentMesh,
      accentMat,
      frostGroup,
      burnMesh,
      shadowDisc,
      shadowMat,
      tetherMesh,
      hpBarBg,
      hpBarFill,
      kind,
      stunRing,
      telegraphBeam,
      telegraphMat,
      legs,
      bioCache,
      baseColorHex,
      baseEmissiveHex,
      baseEmissiveIntensity,
      hitFlashTimer: 0,
    };
  }

  private disposeVisual(v: EntityVisual): void {
    this.scene.remove(v.group);
    this.scene.remove(v.shadowDisc);
    this.scene.remove(v.tetherMesh);
    this.scene.remove(v.telegraphBeam);
    v.telegraphMat.dispose();
    (v.stunRing.material as THREE.Material).dispose();
    v.mainMat.dispose();
    v.accentMat.dispose();
    v.shadowMat.dispose();
    (v.tetherMesh.material as THREE.Material).dispose();
    (v.burnMesh.material as THREE.Material).dispose();
    (v.hpBarBg.material as THREE.Material).dispose();
    (v.hpBarFill.material as THREE.Material).dispose();
  }

  private syncVentsAndConduits(world: WorldState, timeSec: number): void {
    const vents = world.room.emitters.filter((em) => em.kind === 'vent');
    while (this.ventVisuals.length > vents.length) {
      const v = this.ventVisuals.pop()!;
      this.scene.remove(v.group);
      v.plumeMat.dispose();
      v.coreMat.dispose();
    }
    while (this.ventVisuals.length < vents.length) {
      const group = new THREE.Group();
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0xff6b1a,
        emissive: 0xff4500,
        emissiveIntensity: 1.5,
        roughness: 0.28,
        metalness: 0.4,
      });
      // Wide glowing Floor Furnace Grate / Incendiary Brazier (0.76 m footprint, unmistakable ignition source)
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x261d1c, roughness: 0.65, metalness: 0.72 });
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.14, 0.76), frameMat);
      rim.position.set(0, 0.07, 0);
      const coals = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.62), coreMat);
      coals.position.set(0, 0.12, 0);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.38), coreMat);
      cap.position.set(0, 0.28, 0);
      group.add(rim, coals, cap);
      for (let b = -2; b <= 2; b++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.045), frameMat);
        bar.position.set(0, 0.21, b * 0.13);
        group.add(bar);
      }

      const plumeMat = new THREE.MeshBasicMaterial({
        color: 0xff7b1a,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const plumeMesh = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.85, 8, 1, true), plumeMat);
      plumeMesh.position.set(0, 0.62, 0);

      const ringGeo = new THREE.RingGeometry(0.24, 0.38, 16);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMesh = new THREE.Mesh(ringGeo, plumeMat);
      ringMesh.position.set(0, 0.35, 0);

      const ventGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0xff6b1a,
          transparent: true,
          opacity: 0.58,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ventGlow.position.set(0, 0.34, 0);
      ventGlow.scale.set(1.65, 1.65, 1);
      group.add(plumeMesh, ringMesh, ventGlow);
      this.scene.add(group);
      this.ventVisuals.push({ group, plumeMesh, ringMesh, plumeMat, coreMat });
    }

    for (let i = 0; i < vents.length; i++) {
      const em = vents[i];
      const vis = this.ventVisuals[i];
      vis.group.position.set(
        (em.x + 0.5) * VOXEL_SIZE_M,
        em.y * VOXEL_SIZE_M,
        (em.z + 0.5) * VOXEL_SIZE_M,
      );
      const pulse = 0.85 + 0.35 * Math.sin(timeSec * 8.0 + i);
      vis.coreMat.emissiveIntensity = 1.25 * pulse;
      vis.plumeMat.opacity = 0.18 + 0.12 * Math.sin(timeSec * 11.0 + i);
      const rise = (timeSec * 1.4 + i * 0.3) % 1.0;
      vis.ringMesh.position.y = 0.34 + rise * 0.95;
      vis.ringMesh.scale.setScalar(0.7 + rise * 0.85);
    }

    // High-Voltage Sparking Conduits (copper coils + pulsing plasma orb + crackling arcs)
    const conduits = world.room.emitters.filter((em) => em.kind === 'conduit');
    while (this.conduitVisuals.length > conduits.length) {
      const cv = this.conduitVisuals.pop()!;
      this.scene.remove(cv.group);
      cv.orbMat.dispose();
    }
    while (this.conduitVisuals.length < conduits.length) {
      const group = new THREE.Group();
      // Upright Floor-Level Tesla Coil Pylon with copper windings + glowing electric-yellow discharge torus
      const coilMat = new THREE.MeshStandardMaterial({ color: 0xd48a3b, roughness: 0.28, metalness: 0.85 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e2636, roughness: 0.5, metalness: 0.7 });
      const orbMat = new THREE.MeshStandardMaterial({
        color: 0xd8faff,
        emissive: 0x45d8ff,
        emissiveIntensity: 1.9,
        roughness: 0.1,
        metalness: 0.2,
      });
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.17, 0.78, 10), darkMat);
      mast.position.set(0, 0.32, 0);
      const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.036, 8, 16), coilMat);
      ring1.rotation.x = Math.PI * 0.5;
      ring1.position.set(0, 0.26, 0);
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.036, 8, 16), coilMat);
      ring2.rotation.x = Math.PI * 0.5;
      ring2.position.set(0, 0.46, 0);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), orbMat);
      orb.position.set(0, 0.72, 0);
      const baseRing = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.36, 20),
        new THREE.MeshBasicMaterial({ color: 0x5be7ff, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
      );
      baseRing.rotation.x = -Math.PI * 0.5;
      baseRing.position.set(0, -0.12, 0);

      const arcPts = new Float32Array(12 * 3);
      const arcGeo = new THREE.BufferGeometry();
      arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPts, 3));
      const arcMesh = new THREE.LineSegments(
        arcGeo,
        new THREE.LineBasicMaterial({ color: 0x9cf7ff, transparent: true, opacity: 0.95 }),
      );
      const orbGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0x62e8ff,
          transparent: true,
          opacity: 0.65,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      orbGlow.position.set(0, 0.72, 0);
      orbGlow.scale.set(1.25, 1.25, 1);
      group.add(mast, ring1, ring2, orb, orbGlow, baseRing, arcMesh);
      this.scene.add(group);
      this.conduitVisuals.push({ group, orbMat, arcMesh });
    }

    for (let i = 0; i < conduits.length; i++) {
      const em = conduits[i];
      const cv = this.conduitVisuals[i];
      cv.group.position.set(
        (em.x + 0.5) * VOXEL_SIZE_M,
        (em.y + 0.5) * VOXEL_SIZE_M,
        (em.z + 0.5) * VOXEL_SIZE_M,
      );
      cv.orbMat.emissiveIntensity = 1.1 + 0.9 * Math.abs(Math.sin(timeSec * 16.0 + i));
      const attr = cv.arcMesh.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let s = 0; s < 6; s++) {
        const a = timeSec * 18.0 + s * 1.1 + i;
        const jx = Math.sin(a * 3.1) * 0.24;
        const jy = Math.cos(a * 2.7) * 0.24;
        const jz = 0.28 + Math.sin(a * 4.3) * 0.14;
        arr[s * 6] = 0;
        arr[s * 6 + 1] = 0.72;
        arr[s * 6 + 2] = 0;
        arr[s * 6 + 3] = jx * 1.3;
        arr[s * 6 + 4] = 0.65 + jy * 1.1;
        arr[s * 6 + 5] = (jz - 0.28) * 2.2;
      }
      attr.needsUpdate = true;
    }

    // Leaking Cryo Pipe nozzles (frosted cyan flange + pulsing cryo mist ring while reserveL > 0)
    const pipes = world.room.emitters.filter((em) => em.kind === 'cryo_pipe');
    while (this.cryoPipeVisuals.length > pipes.length) {
      const pv = this.cryoPipeVisuals.pop()!;
      this.scene.remove(pv.group);
      pv.ringMat.dispose();
    }
    while (this.cryoPipeVisuals.length < pipes.length) {
      const group = new THREE.Group();
      const pipeMat = new THREE.MeshStandardMaterial({
        color: 0x62e8ff,
        emissive: 0x16809e,
        emissiveIntensity: 0.7,
        roughness: 0.25,
        metalness: 0.55,
      });
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.28, 12), pipeMat);
      nozzle.rotation.z = Math.PI * 0.5;
      nozzle.position.set(-0.2, 0, 0);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x9cf7ff,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.22, 16), ringMat);
      ring.rotation.y = Math.PI * 0.5;
      ring.position.set(-0.34, 0, 0);
      const pipeGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0x5be7ff,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      pipeGlow.position.set(-0.28, 0, 0);
      pipeGlow.scale.set(1.05, 1.05, 1);
      group.add(nozzle, ring, pipeGlow);
      this.scene.add(group);
      this.cryoPipeVisuals.push({ group, ringMat });
    }
    for (let i = 0; i < pipes.length; i++) {
      const em = pipes[i];
      const pv = this.cryoPipeVisuals[i];
      pv.group.position.set(
        (em.x + 0.5) * VOXEL_SIZE_M,
        (em.y + 0.5) * VOXEL_SIZE_M,
        (em.z + 0.5) * VOXEL_SIZE_M,
      );
      pv.ringMat.opacity = em.reserveL > 0 ? 0.35 + 0.3 * Math.abs(Math.sin(timeSec * 8.0 + i)) : 0.0;
    }

    // 3D Industrial Steel Corner Cages + Color-Coded Pressure Rings around each Glass Vat
    const vats = world.room.vats;
    while (this.vatCollars.length > vats.length) {
      const vc = this.vatCollars.pop()!;
      this.scene.remove(vc.group);
      vc.bottomRing.geometry.dispose();
      vc.topRing.geometry.dispose();
      vc.mat.dispose();
    }
    while (this.vatCollars.length < vats.length) {
      const group = new THREE.Group();
      const pts = [
        -0.5, 0, -0.5, 0.5, 0, -0.5,
        0.5, 0, -0.5, 0.5, 0, 0.5,
        0.5, 0, 0.5, -0.5, 0, 0.5,
        -0.5, 0, 0.5, -0.5, 0, -0.5,
      ];
      const mat = new THREE.LineBasicMaterial({ color: 0x58c4ff, transparent: true, opacity: 0.85 });
      const bGeo = new THREE.BufferGeometry();
      bGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const bottomRing = new THREE.LineSegments(bGeo, mat);
      const tGeo = new THREE.BufferGeometry();
      tGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const topRing = new THREE.LineSegments(tGeo, mat);

      const postMat = new THREE.MeshStandardMaterial({ color: 0x252f3f, roughness: 0.45, metalness: 0.78 });
      const postGeo = new THREE.BoxGeometry(0.065, 1.0, 0.065);
      const posts: THREE.Mesh[] = [];
      for (let pIdx = 0; pIdx < 4; pIdx++) {
        const post = new THREE.Mesh(postGeo, postMat);
        group.add(post);
        posts.push(post);
      }
      group.add(bottomRing, topRing);
      this.scene.add(group);
      this.vatCollars.push({ group, bottomRing, topRing, posts, mat });
    }
    const gGrid = world.room.grid;
    for (let i = 0; i < vats.length; i++) {
      const v = vats[i];
      const vc = this.vatCollars[i];
      const wM = (v.maxX - v.minX + 1) * VOXEL_SIZE_M + 0.08;
      const hM = (v.maxY - v.minY + 1) * VOXEL_SIZE_M;
      const dM = (v.maxZ - v.minZ + 1) * VOXEL_SIZE_M + 0.08;
      const baseY = v.minY * VOXEL_SIZE_M;

      const midY = Math.min(v.maxY, v.minY + 2);
      const intact =
        getMat(gGrid[cellIndex(v.minX, midY, v.minZ)]) === MAT.GLASS_VAT ||
        getMat(gGrid[cellIndex(v.maxX, midY, v.minZ)]) === MAT.GLASS_VAT ||
        getMat(gGrid[cellIndex(v.minX, midY, v.maxZ)]) === MAT.GLASS_VAT ||
        getMat(gGrid[cellIndex(v.maxX, midY, v.maxZ)]) === MAT.GLASS_VAT;

      vc.group.position.set(v.centerX, baseY, v.centerZ);
      vc.bottomRing.position.y = 0.025;
      vc.bottomRing.scale.set(wM, 1, dM);
      vc.topRing.visible = intact;
      vc.topRing.position.y = hM - 0.02;
      vc.topRing.scale.set(wM, 1, dM);

      const hx = wM * 0.5;
      const hz = dM * 0.5;
      const corners: readonly [number, number][] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
      for (let pIdx = 0; pIdx < 4; pIdx++) {
        const post = vc.posts[pIdx];
        post.visible = intact;
        post.position.set(corners[pIdx][0], hM * 0.5, corners[pIdx][1]);
        post.scale.set(1, hM, 1);
      }
      vc.mat.color.setHex(
        v.mat === MAT.OIL ? 0xe8a14a : v.mat === MAT.CRYO ? 0x5be7ff : 0x3da8ff,
      );
      vc.mat.opacity = intact ? 0.85 : 0.25;
    }
  }

  private syncTerminals(world: WorldState, timeSec: number): void {
    const terms = world.room.workbenchTerminals;
    while (this.terminalVisuals.length > terms.length) {
      const tv = this.terminalVisuals.pop()!;
      this.scene.remove(tv.group);
      tv.screenMat.dispose();
      tv.holoMat.dispose();
    }
    while (this.terminalVisuals.length < terms.length) {
      const group = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x222c3c,
        roughness: 0.42,
        metalness: 0.76,
      });
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), baseMat);
      pad.position.set(0, 0.04, 0);
      const base = new THREE.Mesh(this.termBaseGeo, baseMat);
      base.position.set(0, 0.48, 0);
      base.castShadow = true;

      const screenMat = new THREE.MeshStandardMaterial({
        color: 0x5ef2d6,
        emissive: 0x26d9b8,
        emissiveIntensity: 0.9,
        roughness: 0.18,
        metalness: 0.3,
      });
      const screen = new THREE.Mesh(this.termScreenGeo, screenMat);
      screen.position.set(0, 0.98, 0.12);
      screen.rotation.x = -0.35;

      const holoMat = new THREE.MeshBasicMaterial({
        color: 0x5ef2d6,
        wireframe: true,
        transparent: true,
        opacity: 0.88,
      });
      const holoMesh = new THREE.Mesh(this.termHoloGeo, holoMat);
      holoMesh.position.set(0, 1.42, 0);

      group.add(pad, base, screen, holoMesh);
      this.scene.add(group);
      this.terminalVisuals.push({ group, screenMat, holoMesh, holoMat });
    }

    const baseColors = [0x3be8b0, 0x58c4ff, 0xffd166, 0xd875ff] as const;
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const vis = this.terminalVisuals[i];
      vis.group.position.set(t.x, t.y, t.z);

      const offer = getWorkbenchOffer(world, t.index);
      const isNear = world.nearbyTerminalIndex === t.index;

      let hex: number = baseColors[t.index];
      let intensity = isNear ? 1.6 : 0.9;
      let showHolo = true;

      if (offer.status === 'offline') {
        hex = 0xc92a3e;
        intensity = 0.45;
        showHolo = false;
      } else if (offer.status === 'sold_out') {
        hex = 0x455064;
        intensity = 0.15;
        showHolo = false;
      } else if (offer.status === 'full_hp') {
        hex = 0x3be8b0;
        intensity = 0.35;
      } else if (offer.status === 'cant_afford') {
        intensity = isNear ? 0.95 : 0.45;
      }

      vis.screenMat.color.setHex(hex);
      vis.screenMat.emissive.setHex(hex);
      vis.screenMat.emissiveIntensity = intensity;
      vis.holoMat.color.setHex(hex);
      vis.holoMesh.visible = showHolo;
      if (showHolo) {
        vis.holoMesh.position.y = 1.42 + 0.06 * Math.sin(timeSec * 3.5 + i);
        vis.holoMesh.rotation.y = timeSec * 1.8 + i;
        vis.holoMesh.scale.setScalar(isNear ? 1.3 : 0.95);
      }
    }
  }

  public reset(): void {
    for (const v of this.visuals.values()) {
      this.disposeVisual(v);
    }
    this.visuals.clear();
    while (this.ventVisuals.length > 0) {
      const v = this.ventVisuals.pop()!;
      this.scene.remove(v.group);
      v.plumeMat.dispose();
      v.coreMat.dispose();
    }
    while (this.conduitVisuals.length > 0) {
      const cv = this.conduitVisuals.pop()!;
      this.scene.remove(cv.group);
      cv.orbMat.dispose();
    }
    while (this.cryoPipeVisuals.length > 0) {
      const pv = this.cryoPipeVisuals.pop()!;
      this.scene.remove(pv.group);
      pv.ringMat.dispose();
    }
    while (this.vatCollars.length > 0) {
      const vc = this.vatCollars.pop()!;
      this.scene.remove(vc.group);
      vc.bottomRing.geometry.dispose();
      vc.topRing.geometry.dispose();
      vc.mat.dispose();
    }
    while (this.terminalVisuals.length > 0) {
      const tv = this.terminalVisuals.pop()!;
      this.scene.remove(tv.group);
      tv.screenMat.dispose();
      tv.holoMat.dispose();
    }
    for (let i = 0; i < this.blasts.length; i++) {
      this.blasts[i].life = 0;
      this.blasts[i].coreMesh.visible = false;
    }
    for (let i = 0; i < this.debris.length; i++) {
      this.debris[i].life = 0;
    }
    this.blastInstancedMesh.count = 0;
    this.debrisMesh.count = 0;
    this.fluidShadowMesh.count = 0;
    this.electricBoltMesh.count = 0;
    this.electricLight.intensity = 0;
    this.fireLight.intensity = 0;
    this.fireEmberMesh.count = 0;
    this.fireSmokeMesh.count = 0;
    this.blastLight.intensity = 0;
    this.blastLightLife = 0;
    this.reticleGroup.visible = false;
    this.airBurstAge = 1;
    for (let i = 0; i < this.airRings.length; i++) this.airRings[i].visible = false;
    this.airFleckMesh.count = 0;
  }

  public update(world: WorldState, camera: THREE.Camera, timeSec: number, dt: number): void {
    this.seenIds.clear();
    this.syncVentsAndConduits(world, timeSec);
    this.syncTerminals(world, timeSec);

    // Consume combat visual events for white hit-flash & shatter debris
    const evs = world.room.combatEvents;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.entityId > 0) {
        const vis = this.visuals.get(ev.entityId);
        if (vis) vis.hitFlashTimer = 0.09;
      }
      if (ev.kind === 'vat_break') {
        this.spawnDebrisBurst(ev.x, ev.y, ev.z, 6, 0xa2f5ff, 3.8);
      } else if (ev.kind === 'crate_break') {
        this.spawnDebrisBurst(ev.x, ev.y, ev.z, 18, ev.colorHex, 5.2);
      } else if (ev.kind === 'kill') {
        this.spawnDebrisBurst(ev.x, ev.y, ev.z, 24, 0xff4d79, 6.0);
      } else if (ev.kind === 'shatter') {
        this.spawnDebrisBurst(ev.x, ev.y, ev.z, 14, 0x8ef7ff, 5.6);
      }
    }

    const count = Math.min(world.entities.length, MAX_ENTITIES);
    for (let i = 0; i < count; i++) {
      const e = world.entities[i];
      if (e.hp <= 0 || e.deathHusk) continue;
      this.seenIds.add(e.id);

      let vis = this.visuals.get(e.id);
      if (!vis) {
        const vKind = e.kind === 'crate' ? 'crate' : e.locomotion === 'floater' ? 'floater' : e.locomotion === 'crusher' ? 'bruiser' : e.locomotion === 'spitter' ? 'spitter' : e.locomotion === 'skitterer' ? 'skitterer' : 'pod';
        const glMat = e.glands.length > 0 ? e.glands[0].mat : MAT.OIL;
        vis = this.createVisual(vKind, e.bioCache, glMat);
        this.visuals.set(e.id, vis);
      }

      vis.group.position.set(e.x, e.y + e.height * 0.5, e.z);
      if (vis.hitFlashTimer > 0) vis.hitFlashTimer = Math.max(0, vis.hitFlashTimer - dt);

      // Ground drop-shadow + airborne altitude tether
      const surfY = findSurfaceYBelow(world.room, e.x, e.y + 0.05, e.z);
      const alt = Math.max(0, e.y - surfY);
      const baseRad = Math.max(e.halfW, e.halfD) * 2.0;
      const shadScale = baseRad * Math.max(0.45, 1.0 - alt * 0.1);
      vis.shadowDisc.position.set(e.x, surfY + 0.014, e.z);
      vis.shadowDisc.scale.setScalar(shadScale);
      vis.shadowMat.opacity = Math.max(0.18, 0.58 - alt * 0.08);

      if (alt > 0.25) {
        vis.tetherMesh.visible = true;
        vis.tetherMesh.position.set(e.x, surfY + alt * 0.5, e.z);
        vis.tetherMesh.scale.set(1, alt, 1);
      } else {
        vis.tetherMesh.visible = false;
      }

      // Status auras + crisp pure-white hit-flash
      const isBrittle = e.tempByte <= TEMP_BYTE.EMBRITTLED;
      const isBurning = e.burnTicks > 0;
      vis.frostGroup.visible = isBrittle;
      vis.burnMesh.visible = isBurning;
      if (isBurning) {
        vis.burnMesh.rotation.y = timeSec * 9.0 + e.id;
        vis.burnMesh.scale.setScalar(0.85 + 0.35 * Math.sin(timeSec * 24.0 + e.id));
      }

      if (vis.hitFlashTimer > 0) {
        vis.mainMat.color.setHex(0xffffff);
        vis.mainMat.emissive.setHex(0xffffff);
        vis.mainMat.emissiveIntensity = 1.8;
      } else if (isBurning) {
        vis.mainMat.color.setHex(0xff7b29);
        vis.mainMat.emissive.setHex(0xff4500);
        vis.mainMat.emissiveIntensity = 0.85 + 0.35 * Math.sin(timeSec * 22.0 + e.id);
      } else if (isBrittle) {
        vis.mainMat.color.setHex(0x88f2ff);
        vis.mainMat.emissive.setHex(0x22b8cf);
        vis.mainMat.emissiveIntensity = 0.78;
      } else if (e.wetTicks > 0) {
        vis.mainMat.color.setHex(vis.baseColorHex);
        vis.mainMat.emissive.setHex(0x164c73);
        vis.mainMat.emissiveIntensity = 0.45;
      } else {
        vis.mainMat.color.setHex(vis.baseColorHex);
        vis.mainMat.emissive.setHex(vis.baseEmissiveHex);
        vis.mainMat.emissiveIntensity = vis.baseEmissiveIntensity;
      }

      const hpFrac = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
      // Stun halo
      vis.stunRing.visible = e.stunTicks > 0;
      if (e.stunTicks > 0) {
        vis.stunRing.rotation.z = timeSec * 6.0;
        vis.stunRing.scale.setScalar(0.9 + 0.15 * Math.sin(timeSec * 14.0));
      }

      // Crimson attack telegraph danger strip (Skitterer lunge or Spitter charge)
      if (e.kind === 'alien' && e.aiState === 'telegraph') {
        const len = e.aiAttackKind === 'melee' ? 3.4 : 4.5;
        const yaw = Math.atan2(e.telegraphDirX, e.telegraphDirZ);
        vis.telegraphBeam.visible = true;
        vis.telegraphBeam.position.set(
          e.x + e.telegraphDirX * (len * 0.5),
          e.y + 0.08,
          e.z + e.telegraphDirZ * (len * 0.5),
        );
        vis.telegraphBeam.rotation.set(0, yaw, 0);
        vis.telegraphBeam.scale.set(e.aiAttackKind === 'melee' ? 1.5 : 0.7, 1, len);
        vis.telegraphMat.color.setHex(e.aiAttackKind === 'melee' ? 0xff2a55 : 0xffb347);
        vis.telegraphMat.opacity = 0.45 + 0.35 * Math.abs(Math.sin(timeSec * 28.0));
      } else {
        vis.telegraphBeam.visible = false;
      }

      // Skitterer facing, leg scuttle, 0G helpless tumble & dynamic dorsal gland fill
      if (vis.kind === 'skitterer' || vis.kind === 'bruiser' || vis.kind === 'spitter' || vis.kind === 'floater') {
        if (world.room.gravityMode === GRAVITY_MODE.G0) {
          vis.group.rotation.x += dt * 2.2;
          vis.group.rotation.z += dt * 1.7;
        } else {
          vis.group.rotation.x = 0;
          vis.group.rotation.z = e.upSign === -1 ? Math.PI : 0;
          const fx = e.aiState === 'telegraph' || e.aiState === 'lunge' ? e.telegraphDirX : e.vx;
          const fz = e.aiState === 'telegraph' || e.aiState === 'lunge' ? e.telegraphDirZ : e.vz;
          if (fx * fx + fz * fz > 0.04) {
            vis.group.rotation.y = Math.atan2(-fx, -fz);
          }
        }
        const speed = Math.hypot(e.vx, e.vz);
        for (let l = 0; l < vis.legs.length; l++) {
          const phase = timeSec * (world.room.gravityMode === GRAVITY_MODE.G0 ? 18.0 : 8.0 + speed * 3.0) + l * 1.4;
          vis.legs[l].rotation.y = Math.sin(phase) * 0.35;
        }
        if (vis.kind !== 'bruiser') {
          const gl = e.glands[0];
          if (gl && gl.liters > 0) {
            const fill = Math.max(0.25, gl.liters / Math.max(1, gl.capL));
            vis.accentMesh.visible = true;
            vis.accentMesh.scale.set(fill, 0.85 * fill, 1.15 * fill);
          } else {
            vis.accentMesh.visible = false;
          }
        }
      }
      const flashSquash = vis.hitFlashTimer > 0 ? 1.16 : 1.0;
      if (vis.kind === 'pod') {
        const pulse = (1.0 + 0.06 * Math.sin(timeSec * 4.5 + e.id * 1.7)) * flashSquash;
        vis.mainMesh.scale.set(pulse, 1.0 / Math.sqrt(pulse), pulse);
        vis.accentMesh.scale.setScalar(0.9 + 0.22 * Math.sin(timeSec * 7.0 + e.id));
        vis.accentMat.emissiveIntensity = (0.9 + (1 - hpFrac) * 1.2) * (vis.hitFlashTimer > 0 ? 2.2 : 1.0);
      } else if (vis.bioCache) {
        vis.accentMat.emissiveIntensity = 1.0 + 0.4 * Math.sin(timeSec * 5.0 + e.id);
      } else {
        vis.mainMesh.scale.setScalar(flashSquash);
      }

      const showBar = hpFrac < 0.999;
      vis.hpBarBg.visible = showBar;
      vis.hpBarFill.visible = showBar;
      if (showBar) {
        vis.hpBarBg.quaternion.copy(camera.quaternion);
        vis.hpBarFill.quaternion.copy(camera.quaternion);
        vis.hpBarFill.scale.set(Math.max(0.02, hpFrac), 1, 1);
      }
    }

    for (const [id, vis] of this.visuals.entries()) {
      if (!this.seenIds.has(id)) {
        this.disposeVisual(vis);
        this.visuals.delete(id);
      }
    }

    // 0G floating fluid cluster drop-shadows so airborne water/oil/cryo spheres show exact floor position
    const mode = world.room.gravityMode;
    let fluidShadCount = 0;
    if (mode === GRAVITY_MODE.G0) {
      const plane = CHUNKS_X * CHUNKS_Z;
      this.tmpQuat.identity();
      for (let c = 0; c < TOTAL_CHUNKS && fluidShadCount < MAX_0G_SHADOWS; c++) {
        const cnt = world.room.chunkFluidVoxelCount[c];
        if (world.room.outOfBounds[c] || cnt < 20) continue;
        const cy = Math.floor(c / plane);
        const rem = c - cy * plane;
        const cz = Math.floor(rem / CHUNKS_X);
        const cx = rem - cz * CHUNKS_X;
        const mx = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
        const my = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
        const mz = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
        const surfY = findSurfaceYBelow(world.room, mx, my, mz);
        if (my - surfY < 0.35) continue;
        this.tmpPos.set(mx, surfY + 0.012, mz);
        this.tmpScale.setScalar(Math.min(1.5, 0.55 + cnt * 0.002));
        this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.fluidShadowMesh.setMatrixAt(fluidShadCount++, this.tmpMat4);
      }
    }
    this.fluidShadowMesh.count = fluidShadCount;
    if (fluidShadCount > 0) this.fluidShadowMesh.instanceMatrix.needsUpdate = true;

    // Volumetric 3D electric-yellow & white-hot lightning bolts across ALL charged water/acid/grate cells
    const afList = world.room.activeFluidCur;
    const afCount = world.room.activeFluidCurCount;
    const ccList = world.room.chargedCells;
    const ccCount = world.room.chargedCellsCount;
    let boltCount = 0;
    let eSumX = 0;
    let eSumY = 0;
    let eSumZ = 0;
    let eSamples = 0;

    const pushBoltSeg = (
      x0: number, y0: number, z0: number,
      x1: number, y1: number, z1: number,
      thick: number, colorHex: number,
    ): void => {
      if (boltCount >= 220) return;
      this.boltDirVec.set(x1 - x0, y1 - y0, z1 - z0);
      const len = this.boltDirVec.length();
      if (len < 1e-4) return;
      this.boltDirVec.multiplyScalar(1 / len);
      this.boltMidVec.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
      this.tmpQuat.setFromUnitVectors(this.boltUpVec, this.boltDirVec);
      this.tmpScale.set(thick, len, thick);
      this.tmpMat4.compose(this.boltMidVec, this.tmpQuat, this.tmpScale);
      this.electricBoltMesh.setMatrixAt(boltCount, this.tmpMat4);
      this.tmpColor.setHex(colorHex);
      this.electricBoltMesh.setColorAt(boltCount, this.tmpColor);
      boltCount++;
    };

    // Collect surface samples from chargedCells and chain horizontal surface-skimming arcs BETWEEN cells (zero vertical spikes!)
    let sampleCount = 0;
    const arcStep = Math.floor(timeSec * 14.0);
    if (ccCount > 0) {
      const targetSamples = Math.min(56, ccCount);
      const stride = Math.max(1, Math.floor(ccCount / targetSamples));
      const phaseOffset = (arcStep * 7) % stride;
      const g = world.room.grid;
      for (let i = phaseOffset; i < ccCount && sampleCount < 56; i += stride) {
        const idx = ccList[i];
        const val = g[idx];
        const m = getMat(val);
        if (m !== MAT.WATER && m !== MAT.ACID && m !== MAT.STEEL_GRATE) continue;
        if (getTimerOrCharge(val) <= 0) continue;
        const vy = Math.floor(idx / SLICE_STRIDE);
        const rem = idx - vy * SLICE_STRIDE;
        const vz = Math.floor(rem / ARENA_W);
        const vx = rem - vz * ARENA_W;
        const wx = (vx + 0.5) * VOXEL_SIZE_M;
        const wy = (vy + 1.04) * VOXEL_SIZE_M;
        const wz = (vz + 0.5) * VOXEL_SIZE_M;
        this.chargedSampleX[sampleCount] = wx;
        this.chargedSampleY[sampleCount] = wy;
        this.chargedSampleZ[sampleCount] = wz;
        sampleCount++;
        eSumX += wx;
        eSumY += wy;
        eSumZ += wz;
        eSamples++;
      }

      const pushJaggedChain = (
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        seed: number, jitterH: number, jitterY: number, thick: number,
      ): void => {
        const dx = x1 - x0;
        const dz = z1 - z0;
        const hLen = Math.hypot(dx, dz);
        const px = hLen > 1e-4 ? -dz / hLen : 1;
        const pz = hLen > 1e-4 ? dx / hLen : 0;
        const j1 = Math.sin(seed * 12.9898) * jitterH;
        const j2 = Math.cos(seed * 78.233) * jitterH;
        const jy1 = Math.abs(Math.sin(seed * 37.719)) * jitterY;
        const jy2 = Math.abs(Math.cos(seed * 53.117)) * jitterY;

        const ax = x0 + dx * 0.35 + px * j1;
        const ay = y0 + (y1 - y0) * 0.35 + jy1;
        const az = z0 + dz * 0.35 + pz * j1;
        const bx = x0 + dx * 0.70 + px * j2;
        const by = y0 + (y1 - y0) * 0.70 + jy2;
        const bz = z0 + dz * 0.70 + pz * j2;

        const bright = (Math.floor(seed) & 3) === 0;
        const cCore = bright ? 0xffffff : 0xc8f8ff;
        const cRim = bright ? 0x7ef3ff : 0x38b6ff;
        pushBoltSeg(x0, y0, z0, ax, ay, az, thick, cCore);
        pushBoltSeg(ax, ay, az, bx, by, bz, thick * 0.9, cRim);
        pushBoltSeg(bx, by, bz, x1, y1, z1, thick * 0.85, cCore);
      };

      // 1. Horizontal surface-skimming electric chains across the puddle (~18 chains max)
      let chains = 0;
      for (let i = 0; i < sampleCount && chains < 18 && boltCount + 3 <= 165; i += 2) {
        const x0 = this.chargedSampleX[i];
        const y0 = this.chargedSampleY[i];
        const z0 = this.chargedSampleZ[i];
        let bestJ = -1;
        let bestDistSq = 1.85 * 1.85;
        for (let j = i + 1; j < sampleCount; j++) {
          const ddx = this.chargedSampleX[j] - x0;
          const ddy = this.chargedSampleY[j] - y0;
          const ddz = this.chargedSampleZ[j] - z0;
          if (Math.abs(ddy) > 0.35) continue;
          const dSq = ddx * ddx + ddz * ddz;
          if (dSq > 0.22 * 0.22 && dSq < bestDistSq) {
            bestDistSq = dSq;
            bestJ = j;
          }
        }
        if (bestJ >= 0) {
          pushJaggedChain(
            x0, y0, z0,
            this.chargedSampleX[bestJ], this.chargedSampleY[bestJ], this.chargedSampleZ[bestJ],
            arcStep * 3.1 + i * 1.7 + bestJ * 0.9,
            0.14, 0.04, 0.72,
          );
          chains++;
        }
      }

      // 2. Targeted tether bolts from every Tesla Pylon orb directly into the nearest wet edge
      for (let ei = 0; ei < world.room.emitters.length && boltCount + 3 <= 190; ei++) {
        const em = world.room.emitters[ei];
        if (em.kind !== 'conduit') continue;
        const ox = (em.x + 0.5) * VOXEL_SIZE_M;
        const oy = (em.y + 0.5) * VOXEL_SIZE_M + 0.72;
        const oz = (em.z + 0.5) * VOXEL_SIZE_M;
        let nearJ = -1;
        let nearSq = 2.4 * 2.4;
        for (let j = 0; j < sampleCount; j++) {
          const ddx = this.chargedSampleX[j] - ox;
          const ddz = this.chargedSampleZ[j] - oz;
          const dSq = ddx * ddx + ddz * ddz;
          if (dSq < nearSq) {
            nearSq = dSq;
            nearJ = j;
          }
        }
        if (nearJ >= 0) {
          pushJaggedChain(
            ox, oy, oz,
            this.chargedSampleX[nearJ], this.chargedSampleY[nearJ], this.chargedSampleZ[nearJ],
            arcStep * 5.3 + ei * 2.1,
            0.16, 0.08, 1.05,
          );
        }
      }

      // 3. Tether bolts snapping from live water onto any shocked enemy or player
      const shockTargets = [world.player, ...world.entities];
      for (let ti = 0; ti < shockTargets.length && boltCount + 3 <= 216; ti++) {
        const ent = shockTargets[ti];
        if (ent.hp <= 0 || ent.deathHusk || ent.shockTicks <= 0) continue;
        let nearJ = -1;
        let nearSq = 2.0 * 2.0;
        for (let j = 0; j < sampleCount; j++) {
          const ddx = this.chargedSampleX[j] - ent.x;
          const ddz = this.chargedSampleZ[j] - ent.z;
          const dSq = ddx * ddx + ddz * ddz;
          if (dSq < nearSq) {
            nearSq = dSq;
            nearJ = j;
          }
        }
        const tx = ent.x;
        const ty = ent.y + ent.height * 0.55;
        const tz = ent.z;
        if (nearJ >= 0) {
          pushJaggedChain(
            this.chargedSampleX[nearJ], this.chargedSampleY[nearJ], this.chargedSampleZ[nearJ],
            tx, ty, tz,
            arcStep * 4.7 + ent.id,
            0.15, 0.12, 1.0,
          );
        } else {
          const a = timeSec * 28.0 + ent.id;
          pushJaggedChain(
            tx + Math.cos(a) * 0.38, ty - 0.3, tz + Math.sin(a) * 0.38,
            tx - Math.cos(a) * 0.38, ty + 0.35, tz - Math.sin(a) * 0.38,
            arcStep * 6.1 + ent.id,
            0.14, 0.1, 0.95,
          );
        }
      }
    }

    this.electricBoltMesh.count = boltCount;
    if (boltCount > 0) {
      this.electricBoltMesh.instanceMatrix.needsUpdate = true;
      if (this.electricBoltMesh.instanceColor) this.electricBoltMesh.instanceColor.needsUpdate = true;
    }
    if (eSamples > 0) {
      const eFlick = 0.7 + 0.3 * Math.abs(Math.sin(timeSec * 37.0));
      this.electricLight.position.set(eSumX / eSamples, eSumY / eSamples + 0.55, eSumZ / eSamples);
      this.electricLight.intensity = Math.min(6.0, 1.5 + eSamples * 0.08) * eFlick;
    } else {
      this.electricLight.intensity = 0;
    }

    // Dynamic flickering warm firelight + Noita-style dark charcoal smoke + crisp micro-sparks
    let fireCount = 0;
    let fSumX = 0;
    let fSumY = 0;
    let fSumZ = 0;
    let emberCount = 0;
    let smokeCount = 0;
    if (afCount > 0) {
      const fStride = Math.max(1, Math.floor(afCount / 160));
      const g = world.room.grid;
      for (let i = 0; i < afCount; i += fStride) {
        const idx = afList[i];
        if (getMat(g[idx]) !== MAT.FIRE) continue;
        const vy = Math.floor(idx / SLICE_STRIDE);
        const rem = idx - vy * SLICE_STRIDE;
        const vz = Math.floor(rem / ARENA_W);
        const vx = rem - vz * ARENA_W;
        const wx = (vx + 0.5) * VOXEL_SIZE_M;
        const wy = (vy + 0.5) * VOXEL_SIZE_M;
        const wz = (vz + 0.5) * VOXEL_SIZE_M;
        fireCount++;
        fSumX += wx;
        fSumY += wy;
        fSumZ += wz;

        if (smokeCount < 110 && (fireCount & 1) === 0) {
          const sCycle = (timeSec * 0.95 + idx * 0.17) % 1.0;
          const sx = wx + Math.sin(timeSec * 2.2 + idx) * 0.22 * sCycle;
          const sz = wz + Math.cos(timeSec * 1.9 + idx * 1.3) * 0.22 * sCycle;
          const sc = (0.65 + sCycle * 1.45) * (1.0 - sCycle * 0.65);
          this.dummy.position.set(sx, wy + 0.28 + sCycle * 1.65, sz);
          this.dummy.rotation.set(sCycle * 1.5, idx * 0.3 + timeSec, 0);
          this.dummy.scale.setScalar(sc);
          this.dummy.updateMatrix();
          this.fireSmokeMesh.setMatrixAt(smokeCount++, this.dummy.matrix);
        }

        if (emberCount < 110) {
          const cycle = (timeSec * 2.2 + (idx * 0.37)) % 1.0;
          const driftX = Math.sin(timeSec * 6.5 + idx) * 0.18 * cycle;
          const driftZ = Math.cos(timeSec * 5.7 + idx * 1.3) * 0.18 * cycle;
          const sc = (1.0 - cycle * 0.72) * (0.8 + 0.35 * Math.sin(timeSec * 20.0 + idx));
          this.dummy.position.set(wx + driftX, wy + 0.12 + cycle * 1.25, wz + driftZ);
          this.dummy.rotation.set(timeSec * 3.0 + idx, timeSec * 4.0, 0);
          this.dummy.scale.set(sc, sc * 1.25, sc);
          this.dummy.updateMatrix();
          this.fireEmberMesh.setMatrixAt(emberCount++, this.dummy.matrix);
        }
      }
    }
    // Constant smoldering embers rising off Floor Furnace Grates so they immediately read as scorching hot
    for (let ei = 0; ei < world.room.emitters.length; ei++) {
      const em = world.room.emitters[ei];
      if (em.kind !== 'vent') continue;
      const vx = (em.x + 0.5) * VOXEL_SIZE_M;
      const vy = em.y * VOXEL_SIZE_M + 0.22;
      const vz = (em.z + 0.5) * VOXEL_SIZE_M;
      for (let k = 0; k < 4 && emberCount < 128; k++) {
        const cyc = (timeSec * 1.6 + ei * 0.41 + k * 0.25) % 1.0;
        const ang = k * 1.57 + timeSec * 2.5;
        this.dummy.position.set(vx + Math.cos(ang) * 0.22, vy + cyc * 0.95, vz + Math.sin(ang) * 0.22);
        this.dummy.rotation.set(cyc * 4.0, ang, 0);
        this.dummy.scale.setScalar(0.9 * (1.0 - cyc * 0.7));
        this.dummy.updateMatrix();
        this.fireEmberMesh.setMatrixAt(emberCount++, this.dummy.matrix);
      }
    }
    this.fireSmokeMesh.count = smokeCount;
    if (smokeCount > 0) this.fireSmokeMesh.instanceMatrix.needsUpdate = true;
    this.fireEmberMesh.count = emberCount;
    if (emberCount > 0) this.fireEmberMesh.instanceMatrix.needsUpdate = true;
    if (fireCount > 0) {
      const flicker = 0.84 + 0.16 * Math.sin(timeSec * 29.0) + 0.08 * Math.cos(timeSec * 47.0);
      this.fireLight.position.set(fSumX / fireCount, fSumY / fireCount + 0.65, fSumZ / fireCount);
      this.fireLight.intensity = Math.min(7.5, 1.4 + fireCount * 0.14) * flicker;
    } else {
      this.fireLight.intensity = 0;
    }

    // Step volumetric Phase Explosions
    const recent = world.room.recentExplosions;
    for (let i = 0; i < recent.length; i++) {
      const ev = recent[i];
      const b = this.blasts[this.blastCursor];
      this.blastCursor = (this.blastCursor + 1) % MAX_BLASTS;

      b.age = 0;
      b.life = 0.62;
      b.radiusM = ev.radiusM;
      b.kind = ev.kind;
      b.coreMesh.position.set(ev.x, ev.y + 0.12, ev.z);
      b.coreMesh.rotation.set(ev.tick * 0.4, ev.tick * 0.7, 0);
      b.coreMat.color.setHex(ev.kind === 'cryo' ? 0xc8fbff : 0xffffff);
      b.coreMesh.visible = true;

      this.blastLight.position.set(ev.x, ev.y + 0.45, ev.z);
      this.blastLight.color.setHex(ev.kind === 'cryo' ? 0x7ef9ff : 0xf4f8ff);
      this.blastLightAge = 0;
      this.blastLightLife = 0.15;
      this.blastLightPeak = 4.5 + Math.min(3.5, ev.intensity * 0.6);

      const palette = ev.kind === 'cryo' ? CRYO_PALETTE : STEAM_PALETTE;
      const goldenAngle = 2.399963229728653;

      for (let v = 0; v < BLAST_VOXELS_PER_EVENT; v++) {
        const vox = b.voxels[v];
        const frac = (v + 0.5) / BLAST_VOXELS_PER_EVENT;
        const yDir =
          mode === GRAVITY_MODE.G0
            ? 1 - 2 * frac
            : mode === GRAVITY_MODE.GN1
              ? -0.85 * frac + 0.12
              : 0.88 * frac + 0.08;
        const horizR = Math.sqrt(Math.max(0.02, 1 - yDir * yDir));
        const theta = v * goldenAngle + (ev.tick & 31) * 0.21;
        const shellFactor =
          v < 48
            ? 0.78 + (v % 4) * 0.08
            : v < 78
              ? 0.46 + (v % 4) * 0.08
              : 0.18 + (v % 3) * 0.08;
        const speed = ev.radiusM * 5.6 * shellFactor;

        vox.x = ev.x + Math.cos(theta) * horizR * 0.1;
        vox.y = ev.y + Math.max(0.06, yDir * 0.1 + 0.08);
        vox.z = ev.z + Math.sin(theta) * horizR * 0.1;
        vox.vx = Math.cos(theta) * horizR * speed;
        vox.vy = yDir * speed;
        vox.vz = Math.sin(theta) * horizR * speed;
        vox.rx = theta;
        vox.ry = frac * Math.PI;
        vox.rotSpeed = (v & 1 ? 1 : -1) * (3.0 + (v % 4) * 1.2);
        vox.baseScale = 0.8 + (v % 3) * 0.15;
        vox.colorHex = palette[v % palette.length];
        vox.lifeScale = 0.78 + (v % 5) * 0.06;
      }
    }
    recent.length = 0;

    if (this.blastLightLife > 0) {
      this.blastLightAge += dt;
      if (this.blastLightAge >= this.blastLightLife) {
        this.blastLight.intensity = 0;
        this.blastLightLife = 0;
      } else {
        const lt = 1 - this.blastLightAge / this.blastLightLife;
        this.blastLight.intensity = this.blastLightPeak * lt * lt;
      }
    }

    let buoyantAccelY = 2.6;
    if (mode === GRAVITY_MODE.G0) buoyantAccelY = 0.0;
    else if (mode === GRAVITY_MODE.GN1) buoyantAccelY = -2.6;
    else if (mode === GRAVITY_MODE.G2) buoyantAccelY = 4.6;
    else if (mode === GRAVITY_MODE.G3) buoyantAccelY = 6.2;

    const drag = Math.exp(-5.5 * dt);
    let instanceCount = 0;
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i];
      if (b.life <= 0) continue;
      b.age += dt;
      if (b.age >= b.life) {
        b.life = 0;
        b.coreMesh.visible = false;
        continue;
      }
      const coreT = b.age / 0.1;
      if (coreT < 1) {
        b.coreMesh.visible = true;
        b.coreMesh.scale.setScalar(0.8 + 0.7 * coreT);
        b.coreMesh.rotation.y += 4.0 * dt;
        b.coreMat.opacity = 0.85 * (1 - coreT);
      } else {
        b.coreMesh.visible = false;
      }

      for (let v = 0; v < BLAST_VOXELS_PER_EVENT; v++) {
        const vox = b.voxels[v];
        const vt = b.age / (b.life * vox.lifeScale);
        if (vt >= 1) continue;
        vox.vx *= drag;
        vox.vz *= drag;
        vox.vy = vox.vy * drag + buoyantAccelY * dt;
        vox.x += vox.vx * dt;
        vox.y += vox.vy * dt;
        vox.z += vox.vz * dt;
        if (vox.y < 0.18) {
          vox.y = 0.18;
          if (vox.vy < 0) vox.vy = 0;
        }
        vox.rx += vox.rotSpeed * dt;
        vox.ry += vox.rotSpeed * 0.7 * dt;
        const env = vt < 0.28 ? 1.0 : Math.max(0, 1.0 - (vt - 0.28) / 0.72);
        const sc = vox.baseScale * env;
        if (sc <= 0.02) continue;

        this.tmpPos.set(vox.x, vox.y, vox.z);
        this.tmpEuler.set(vox.rx, vox.ry, 0);
        this.tmpQuat.setFromEuler(this.tmpEuler);
        this.tmpScale.setScalar(sc);
        this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.blastInstancedMesh.setMatrixAt(instanceCount, this.tmpMat4);
        this.tmpColor.setHex(vox.colorHex);
        this.blastInstancedMesh.setColorAt(instanceCount, this.tmpColor);
        instanceCount++;
      }
    }
    this.blastInstancedMesh.count = instanceCount;
    if (instanceCount > 0) {
      this.blastInstancedMesh.instanceMatrix.needsUpdate = true;
      if (this.blastInstancedMesh.instanceColor) this.blastInstancedMesh.instanceColor.needsUpdate = true;
    }

    // Step instanced shatter debris
    const debGrav = mode === GRAVITY_MODE.G0 ? 0 : mode === GRAVITY_MODE.GN1 ? 14 : -14;
    let debCount = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = this.debris[i];
      if (d.life <= 0) continue;
      d.age += dt;
      if (d.age >= d.life) {
        d.life = 0;
        continue;
      }
      d.vy += debGrav * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (d.y < 0.22) {
        d.y = 0.22;
        d.vy = Math.abs(d.vy) * 0.35;
        d.vx *= 0.7;
        d.vz *= 0.7;
      }
      d.rx += d.rotSpeed * dt;
      d.ry += d.rotSpeed * 0.8 * dt;
      const sc = d.scale * (1 - d.age / d.life);
      this.tmpPos.set(d.x, d.y, d.z);
      this.tmpEuler.set(d.rx, d.ry, 0);
      this.tmpQuat.setFromEuler(this.tmpEuler);
      this.tmpScale.setScalar(sc);
      this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.debrisMesh.setMatrixAt(debCount, this.tmpMat4);
      this.tmpColor.setHex(d.colorHex);
      this.debrisMesh.setColorAt(debCount, this.tmpColor);
      debCount++;
    }
    this.debrisMesh.count = debCount;
    if (debCount > 0) {
      this.debrisMesh.instanceMatrix.needsUpdate = true;
      if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    }

    // Update 3D Magnetic Lock-On Reticle
    const lock = world.lockOn;
    if (lock) {
      this.reticleGroup.visible = true;
      this.reticleGroup.position.set(lock.x, lock.y, lock.z);
      const s = lock.radiusM * (0.96 + 0.06 * Math.sin(timeSec * 10.0));
      this.reticleRing.scale.set(s, 1, s);
      this.reticleDiamond.rotation.y = timeSec * 2.6;
      this.reticleDiamond.rotation.x = timeSec * 1.4;
      const colorHex =
        lock.kind === 'alien'
          ? 0xff4d79
          : lock.kind === 'crate'
            ? 0xffbe55
            : lock.kind === 'vat'
              ? 0x5ef2d6
              : 0x58c4ff;
      this.reticleMat.color.setHex(colorHex);
    } else {
      this.reticleGroup.visible = false;
    }

    // Pneumatic Crescent Shockwave (fast forward wind-slash arc + tight parallel streaks, no cone)
    if (world.suit.airBurstFlashTicks === 6) {
      this.airBurstAge = 0;
      const p = world.player;
      this.airBurstOrigin.set(p.x, p.y + PLAYER_TORSO_OFFSET_M, p.z);
      this.airBurstDir
        .set(world.suit.aimDirX, world.suit.aimDirY, world.suit.aimDirZ)
        .normalize();
    }
    if (this.airBurstAge < 0.17) {
      this.airBurstAge += dt;
      const t = Math.min(1, this.airBurstAge / 0.17);
      const fwdZ = new THREE.Vector3(0, 0, 1);
      this.tmpQuat.setFromUnitVectors(fwdZ, this.airBurstDir);

      for (let i = 0; i < AIR_RING_COUNT; i++) {
        const waveT = Math.max(0, Math.min(1, t * 1.15 - i * 0.18));
        const blade = this.airRings[i];
        const mat = this.airRingMats[i];
        if (waveT <= 0 || waveT >= 1) {
          blade.visible = false;
          continue;
        }
        blade.visible = true;
        const dist = 0.55 + waveT * (AIR_BURST_RANGE_M - 0.8);
        blade.position.copy(this.airBurstOrigin).addScaledVector(this.airBurstDir, dist);
        blade.quaternion.copy(this.tmpQuat);
        const wScale = 0.85 + waveT * 0.95;
        blade.scale.set(wScale, 1.0, 0.75 + waveT * 0.45);
        mat.opacity = (i === 0 ? 0.82 : 0.48) * (1 - waveT);
      }

      const rx = -this.airBurstDir.z;
      const rz = this.airBurstDir.x;
      const rLen = Math.hypot(rx, rz);
      const bx = rLen > 1e-4 ? rx / rLen : 1;
      const bz = rLen > 1e-4 ? rz / rLen : 0;

      let fCount = 0;
      for (let f = 0; f < AIR_FLECK_COUNT; f++) {
        const lane = ((f / (AIR_FLECK_COUNT - 1)) - 0.5) * 1.35;
        const dist = 0.4 + t * (AIR_BURST_RANGE_M - 0.4) * (0.72 + (f % 3) * 0.14);
        const yOff = ((f % 3) - 1) * 0.14;
        this.tmpPos.copy(this.airBurstOrigin).addScaledVector(this.airBurstDir, dist);
        this.tmpPos.x += bx * lane;
        this.tmpPos.y += yOff;
        this.tmpPos.z += bz * lane;
        this.tmpScale.set(0.7, 0.7, 1.8 - t * 1.0);
        this.tmpMat4.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.airFleckMesh.setMatrixAt(fCount++, this.tmpMat4);
      }
      this.airFleckMesh.count = fCount;
      this.airFleckMesh.instanceMatrix.needsUpdate = true;
    } else {
      for (let i = 0; i < AIR_RING_COUNT; i++) this.airRings[i].visible = false;
      this.airFleckMesh.count = 0;
    }
  }
}
