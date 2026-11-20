import * as THREE from 'three';
import {
  GRAVITY_MODE,
  MAX_ENTITIES,
  PLAYER_TORSO_OFFSET_M,
  TEMP_BYTE,
  VOXEL_SIZE_M,
} from '../core/balance.ts';
import type { ExplosionKind } from '../core/types.ts';
import type { WorldState } from '../core/world.ts';

interface EntityVisual {
  group: THREE.Group;
  mainMesh: THREE.Mesh;
  mainMat: THREE.MeshStandardMaterial;
  accentMesh: THREE.Mesh;
  accentMat: THREE.MeshStandardMaterial;
  hpBarBg: THREE.Mesh;
  hpBarFill: THREE.Mesh;
  kind: 'pod' | 'crate';
  baseColorHex: number;
  baseEmissiveHex: number;
  baseEmissiveIntensity: number;
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

interface VentVisual {
  group: THREE.Group;
  plumeMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  plumeMat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshStandardMaterial;
}

const MAX_BLASTS = 16;
const BLAST_VOXELS_PER_EVENT = 96;
const MAX_BLAST_INSTANCES = MAX_BLASTS * BLAST_VOXELS_PER_EVENT;

const STEAM_PALETTE = [0xffffff, 0xeef5fc, 0xd8e6f2, 0xc4d6e6] as const;
const CRYO_PALETTE = [0xf2ffff, 0xc7f8ff, 0x8ef0ff, 0x5be7ff] as const;

export class EntityRenderer {
  private readonly visuals = new Map<number, EntityVisual>();
  private readonly scene: THREE.Scene;

  private readonly podGeo: THREE.DodecahedronGeometry;
  private readonly podCoreGeo: THREE.SphereGeometry;
  private readonly crateGeo: THREE.BoxGeometry;
  private readonly crateTrimGeo: THREE.BoxGeometry;
  private readonly barGeo: THREE.PlaneGeometry;

  private readonly reticleGroup = new THREE.Group();
  private readonly reticleRing: THREE.LineLoop;
  private readonly reticleMat: THREE.LineBasicMaterial;
  private readonly reticleDiamond: THREE.LineSegments;

  private readonly airCone: THREE.Mesh;
  private readonly airConeMat: THREE.MeshBasicMaterial;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
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

  private readonly ventVisuals: VentVisual[] = [];
  private readonly ventCapGeo: THREE.BoxGeometry;
  private readonly ventPlumeGeo: THREE.CylinderGeometry;
  private readonly ventRingGeo: THREE.RingGeometry;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.podGeo = new THREE.DodecahedronGeometry(0.46, 0);
    this.podGeo.scale(1.0, 1.25, 1.0);
    this.podCoreGeo = new THREE.SphereGeometry(0.28, 10, 8);
    this.crateGeo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    this.crateTrimGeo = new THREE.BoxGeometry(1.01, 0.16, 1.01);
    this.barGeo = new THREE.PlaneGeometry(0.8, 0.09);

    this.ventCapGeo = new THREE.BoxGeometry(0.32, 0.06, 0.32);
    this.ventPlumeGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.0, 12, 1, true);
    this.ventRingGeo = new THREE.RingGeometry(0.14, 0.24, 16);
    this.ventRingGeo.rotateX(-Math.PI / 2);

    // 3D Magnetic Lock-On Reticle
    this.reticleMat = new THREE.LineBasicMaterial({
      color: 0xff595e,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });

    const ringPts: number[] = [];
    const segs = 24;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
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

    // Compressed Air Burst translucent cone flash (4.0 m melee reach)
    const coneGeo = new THREE.ConeGeometry(1.35, 3.2, 18, 1, true);
    coneGeo.translate(0, -1.6, 0);
    coneGeo.rotateX(Math.PI);
    this.airConeMat = new THREE.MeshBasicMaterial({
      color: 0xbef6ff,
      transparent: true,
      opacity: 0.36,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.airCone = new THREE.Mesh(coneGeo, this.airConeMat);
    this.airCone.visible = false;
    scene.add(this.airCone);

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

    // Brief dynamic PointLight flash for pressurized phase expansion
    this.blastLight = new THREE.PointLight(0xffffff, 0, 7.5, 2);
    scene.add(this.blastLight);

    // Pre-allocated volumetric blast pool (snappy pressure core + 28 voxel cubes each)
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
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          rx: 0,
          ry: 0,
          rotSpeed: 0,
          baseScale: 1,
          colorHex: 0xffffff,
          lifeScale: 1,
        });
      }

      this.blasts.push({
        coreMesh,
        coreMat,
        voxels,
        age: 0,
        life: 0,
        radiusM: 1.8,
        kind: 'steam',
      });
    }
  }

  private createVisual(kind: 'pod' | 'crate', bioCache: boolean): EntityVisual {
    const group = new THREE.Group();

    const baseColorHex = kind === 'pod' ? 0x6f1d45 : bioCache ? 0x3b5f66 : 0x8d6239;
    const baseEmissiveHex = kind === 'pod' ? 0x450d28 : bioCache ? 0x103038 : 0x000000;
    const baseEmissiveIntensity = kind === 'pod' ? 0.75 : bioCache ? 0.5 : 0.0;

    const mainMat = new THREE.MeshStandardMaterial({
      color: baseColorHex,
      emissive: baseEmissiveHex,
      emissiveIntensity: baseEmissiveIntensity,
      roughness: kind === 'pod' ? 0.48 : 0.76,
      metalness: kind === 'pod' ? 0.15 : 0.12,
    });

    const accentMat = new THREE.MeshStandardMaterial(
      kind === 'pod'
        ? {
            color: 0xff4d79,
            emissive: 0xff2a6d,
            emissiveIntensity: 1.15,
            roughness: 0.2,
            metalness: 0.1,
          }
        : {
            color: bioCache ? 0x5ef2d6 : 0x5c4026,
            emissive: bioCache ? 0x26d9b8 : 0x000000,
            emissiveIntensity: bioCache ? 0.85 : 0.0,
            roughness: 0.4,
            metalness: 0.45,
          },
    );

    const mainMesh = new THREE.Mesh(kind === 'pod' ? this.podGeo : this.crateGeo, mainMat);
    mainMesh.castShadow = true;
    mainMesh.receiveShadow = true;

    const accentMesh = new THREE.Mesh(
      kind === 'pod' ? this.podCoreGeo : this.crateTrimGeo,
      accentMat,
    );
    if (kind === 'pod') {
      accentMesh.position.set(0, 0.16, 0);
    }

    const hpBarBg = new THREE.Mesh(
      this.barGeo,
      new THREE.MeshBasicMaterial({ color: 0x10141c, side: THREE.DoubleSide }),
    );
    hpBarBg.position.set(0, kind === 'pod' ? 0.92 : 0.82, 0);
    hpBarBg.visible = false;

    const hpBarFill = new THREE.Mesh(
      this.barGeo,
      new THREE.MeshBasicMaterial({
        color: kind === 'pod' ? 0xff4d79 : 0xffbe55,
        side: THREE.DoubleSide,
      }),
    );
    hpBarFill.position.set(0, kind === 'pod' ? 0.92 : 0.82, 0.005);
    hpBarFill.visible = false;

    group.add(mainMesh, accentMesh, hpBarBg, hpBarFill);
    this.scene.add(group);
    return {
      group,
      mainMesh,
      mainMat,
      accentMesh,
      accentMat,
      hpBarBg,
      hpBarFill,
      kind,
      baseColorHex,
      baseEmissiveHex,
      baseEmissiveIntensity,
    };
  }

  private syncVents(world: WorldState, timeSec: number): void {
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
        emissiveIntensity: 1.4,
        roughness: 0.3,
        metalness: 0.4,
      });
      const cap = new THREE.Mesh(this.ventCapGeo, coreMat);
      cap.position.set(0, 0.31, 0);

      const plumeMat = new THREE.MeshBasicMaterial({
        color: 0xff8c42,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const plumeMesh = new THREE.Mesh(this.ventPlumeGeo, plumeMat);
      plumeMesh.position.set(0, 0.82, 0);

      const ringMesh = new THREE.Mesh(this.ventRingGeo, plumeMat);
      ringMesh.position.set(0, 0.45, 0);

      group.add(cap, plumeMesh, ringMesh);
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
      vis.coreMat.emissiveIntensity = 1.15 * pulse;
      vis.plumeMat.opacity = 0.16 + 0.12 * Math.sin(timeSec * 11.0 + i);
      const rise = (timeSec * 1.4 + i * 0.3) % 1.0;
      vis.ringMesh.position.y = 0.34 + rise * 0.95;
      const rScale = 0.7 + rise * 0.85;
      vis.ringMesh.scale.set(rScale, rScale, rScale);
    }
  }

  public reset(): void {
    for (const v of this.visuals.values()) {
      this.scene.remove(v.group);
      v.mainMat.dispose();
      v.accentMat.dispose();
      (v.hpBarBg.material as THREE.Material).dispose();
      (v.hpBarFill.material as THREE.Material).dispose();
    }
    this.visuals.clear();
    while (this.ventVisuals.length > 0) {
      const v = this.ventVisuals.pop()!;
      this.scene.remove(v.group);
      v.plumeMat.dispose();
      v.coreMat.dispose();
    }
    for (let i = 0; i < this.blasts.length; i++) {
      this.blasts[i].life = 0;
      this.blasts[i].coreMesh.visible = false;
    }
    this.blastInstancedMesh.count = 0;
    this.blastLight.intensity = 0;
    this.blastLightLife = 0;
    this.reticleGroup.visible = false;
    this.airCone.visible = false;
  }

  public update(world: WorldState, camera: THREE.Camera, timeSec: number, dt: number): void {
    this.seenIds.clear();
    this.syncVents(world, timeSec);

    const count = Math.min(world.entities.length, MAX_ENTITIES);
    for (let i = 0; i < count; i++) {
      const e = world.entities[i];
      if (e.hp <= 0 || e.deathHusk) continue;
      this.seenIds.add(e.id);

      let vis = this.visuals.get(e.id);
      if (!vis) {
        vis = this.createVisual(e.kind === 'alien' ? 'pod' : 'crate', e.bioCache);
        this.visuals.set(e.id, vis);
      }

      vis.group.position.set(e.x, e.y + e.height * 0.5, e.z);

      // Elemental status visual feedback (Burn / 3x Embrittled / Wet)
      if (e.burnTicks > 0) {
        vis.mainMat.color.setHex(0xff7b29);
        vis.mainMat.emissive.setHex(0xff4500);
        vis.mainMat.emissiveIntensity = 0.85 + 0.35 * Math.sin(timeSec * 22.0 + e.id);
      } else if (e.tempByte <= TEMP_BYTE.EMBRITTLED) {
        vis.mainMat.color.setHex(0x88f2ff);
        vis.mainMat.emissive.setHex(0x22b8cf);
        vis.mainMat.emissiveIntensity = 0.75;
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
      if (vis.kind === 'pod') {
        const pulse = 1.0 + 0.06 * Math.sin(timeSec * 4.5 + e.id * 1.7);
        vis.mainMesh.scale.set(pulse, 1.0 / Math.sqrt(pulse), pulse);
        vis.accentMesh.scale.setScalar(0.9 + 0.2 * Math.sin(timeSec * 7.0 + e.id));
        const damagedFlash = e.impactIFrames > 8 ? 1.8 : 1.0;
        vis.accentMat.emissiveIntensity = (0.75 + (1 - hpFrac) * 1.2) * damagedFlash;
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
        this.scene.remove(vis.group);
        vis.mainMat.dispose();
        vis.accentMat.dispose();
        (vis.hpBarBg.material as THREE.Material).dispose();
        (vis.hpBarFill.material as THREE.Material).dispose();
        this.visuals.delete(id);
      }
    }

    // Spawn gravity-aware volumetric steam/cryo voxel bursts for new Phase Explosions
    const mode = world.room.gravityMode;
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

      // Trigger brief dynamic PointLight flash at blast center
      this.blastLight.position.set(ev.x, ev.y + 0.45, ev.z);
      this.blastLight.color.setHex(ev.kind === 'cryo' ? 0x7ef9ff : 0xf4f8ff);
      this.blastLightAge = 0;
      this.blastLightLife = 0.15;
      this.blastLightPeak = 4.5 + Math.min(3.5, ev.intensity * 0.6);

      const palette = ev.kind === 'cryo' ? CRYO_PALETTE : STEAM_PALETTE;
      const goldenAngle = 2.399963229728653;

      for (let v = 0; v < BLAST_VOXELS_PER_EVENT; v++) {
        const vox = b.voxels[v];
        // Fibonacci sphere/hemisphere distribution so expansion fills the 1.8 m blast volume evenly
        const frac = (v + 0.5) / BLAST_VOXELS_PER_EVENT;
        const yDir =
          mode === GRAVITY_MODE.G0
            ? 1 - 2 * frac
            : mode === GRAVITY_MODE.GN1
              ? -0.85 * frac + 0.12
              : 0.88 * frac + 0.08;
        const horizR = Math.sqrt(Math.max(0.02, 1 - yDir * yDir));
        const theta = v * goldenAngle + (ev.tick & 31) * 0.21;

        // 3 concentric shells of true 0.1 m vapor voxels expanding out to ~1.8 m
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

    // Step dynamic PointLight flash
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

    // Buoyant drift per gravity mode: rises in 1G/2G/3G, hangs in 0G, sinks toward deck in -1G
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

      // 1. Snappy 0.10 s pressure core flash
      const coreT = b.age / 0.1;
      if (coreT < 1) {
        b.coreMesh.visible = true;
        const cs = 0.8 + 0.7 * coreT;
        b.coreMesh.scale.setScalar(cs);
        b.coreMesh.rotation.y += 4.0 * dt;
        b.coreMat.opacity = 0.85 * (1 - coreT);
      } else {
        b.coreMesh.visible = false;
      }

      // 2. Expanding volumetric steam/cryo voxel cubes
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

        // Swell rapidly during pressure expansion (0..0.32), then shrink cleanly to 0
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
      if (this.blastInstancedMesh.instanceColor) {
        this.blastInstancedMesh.instanceColor.needsUpdate = true;
      }
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

    // Update Compressed Air Burst cone flash
    const flash = world.suit.airBurstFlashTicks;
    if (flash > 0) {
      const p = world.player;
      const suit = world.suit;
      this.airCone.visible = true;
      this.airCone.position.set(p.x, p.y + PLAYER_TORSO_OFFSET_M, p.z);
      this.tmpDir.set(suit.aimDirX, suit.aimDirY, suit.aimDirZ).normalize();
      this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpDir);
      this.airCone.quaternion.copy(this.tmpQuat);
      const t = (7 - flash) / 6;
      const scale = 0.55 + 0.75 * t;
      this.airCone.scale.set(scale, scale, scale);
      this.airConeMat.opacity = 0.42 * (1 - t * 0.85);
    } else {
      this.airCone.visible = false;
    }
  }
}
