import * as THREE from 'three';
import { MAX_ENTITIES, PLAYER_TORSO_OFFSET_M } from '../core/balance.ts';
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
}

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
  private readonly seenIds = new Set<number>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.podGeo = new THREE.DodecahedronGeometry(0.46, 0);
    this.podGeo.scale(1.0, 1.25, 1.0);
    this.podCoreGeo = new THREE.SphereGeometry(0.28, 10, 8);
    this.crateGeo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    this.crateTrimGeo = new THREE.BoxGeometry(1.01, 0.16, 1.01);
    this.barGeo = new THREE.PlaneGeometry(0.8, 0.09);

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

    // Compressed Air Burst translucent cone flash
    const coneGeo = new THREE.ConeGeometry(1.45, 4.4, 18, 1, true);
    coneGeo.translate(0, -2.2, 0);
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
  }

  private createVisual(kind: 'pod' | 'crate', bioCache: boolean): EntityVisual {
    const group = new THREE.Group();

    const mainMat = new THREE.MeshStandardMaterial(
      kind === 'pod'
        ? {
            color: 0x6f1d45,
            emissive: 0x450d28,
            emissiveIntensity: 0.75,
            roughness: 0.48,
            metalness: 0.15,
          }
        : {
            color: bioCache ? 0x3b5f66 : 0x8d6239,
            emissive: bioCache ? 0x103038 : 0x000000,
            emissiveIntensity: bioCache ? 0.5 : 0.0,
            roughness: 0.76,
            metalness: 0.12,
          },
    );

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
    return { group, mainMesh, mainMat, accentMesh, accentMat, hpBarBg, hpBarFill, kind };
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
    this.reticleGroup.visible = false;
    this.airCone.visible = false;
  }

  public update(world: WorldState, camera: THREE.Camera, timeSec: number): void {
    this.seenIds.clear();

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

    // Remove despawned visuals
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
