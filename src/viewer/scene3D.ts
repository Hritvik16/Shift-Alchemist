import * as THREE from 'three';
import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  CHUNK_SIZE,
  MATERIAL_SPEC,
  MAX_DAMAGE_DECALS,
  MAX_MESH_MEM_MB,
  MAX_REMESHES_PER_FRAME,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
} from '../core/balance.ts';
import {
  cellIndex,
  getDamage,
  getMat,
  isSolidMat,
  raycastSolidVoxel,
  type RoomState,
  type VoxelRayHit,
} from '../core/types.ts';
import { buildChunkSolidMeshes, SOLID_BUCKET } from './greedyMesher.ts';

interface BucketSlot {
  geoId: number;
  instId: number;
  verts: number;
  indices: number;
  bytes: number;
}

interface BucketPool {
  mesh: THREE.BatchedMesh;
  maxVerts: number;
  maxIndices: number;
  bytesPerVert: number;
  usedVerts: number;
  usedIndices: number;
  usedBytes: number;
  slots: Array<BucketSlot | null>;
}

const BUCKET_CONFIG = [
  { maxInstances: TOTAL_CHUNKS, maxVerts: 420_000, maxIndices: 630_000, bytesPerVert: 36 },
  { maxInstances: TOTAL_CHUNKS, maxVerts: 200_000, maxIndices: 300_000, bytesPerVert: 40 },
  { maxInstances: TOTAL_CHUNKS, maxVerts: 120_000, maxIndices: 180_000, bytesPerVert: 36 },
] as const;

export class Scene3D {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly focusPos = new THREE.Vector3(12.0, 1.2, 12.0);
  public zoomDist = 22.0;

  private readonly buckets: [BucketPool, BucketPool, BucketPool];
  private readonly chunkLastUsed = new Int32Array(TOTAL_CHUNKS);
  private frameCounter = 0;

  private readonly cutawayUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uFocusPos: { value: new THREE.Vector3(12.0, 1.2, 12.0) },
  };

  private readonly hoverBox: THREE.LineSegments;
  private readonly hoverNormalLine: THREE.Line;
  private readonly hoverNormalPositions = new Float32Array(6);
  private readonly focusMarker: THREE.Mesh;
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly decalPositionsByChunk: Array<number[]> = Array.from(
    { length: TOTAL_CHUNKS },
    () => [],
  );
  private decalCount = 0;
  private totalDecalCandidates = 0;
  private readonly lastDecalSortPos = new THREE.Vector3(-999, -999, -999);
  private readonly doorMesh: THREE.Mesh;

  private readonly tmpMat4 = new THREE.Matrix4();
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouseNdc = new THREE.Vector2();
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly aimHit = new THREE.Vector3();
  private dirtySortBuf: number[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f17);

    const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(36, aspect, 0.5, 120);

    const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x3b4254, 0.95);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1dc, 1.55);
    sun.position.set(22, 34, 18);
    sun.target.position.set(12, 1.2, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 75;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun);
    this.scene.add(sun.target);

    const opaqueMat = this.createVoxelMaterial({
      transparent: false,
      roughness: 0.78,
      metalness: 0.28,
      isGrate: false,
      enableCutaway: true,
    });
    const transMat = this.createVoxelMaterial({
      transparent: true,
      roughness: 0.16,
      metalness: 0.1,
      isGrate: false,
      enableCutaway: false,
    });
    const grateMat = this.createVoxelMaterial({
      transparent: false,
      roughness: 0.52,
      metalness: 0.65,
      isGrate: true,
      enableCutaway: true,
    });

    this.buckets = [
      this.createBucketPool(SOLID_BUCKET.OPAQUE, opaqueMat, true, true, false),
      this.createBucketPool(SOLID_BUCKET.TRANSPARENT, transMat, false, false, true),
      this.createBucketPool(SOLID_BUCKET.GRATE, grateMat, true, true, false),
    ];

    const decalGeo = new THREE.BoxGeometry(0.105, 0.105, 0.105);
    const decalMat = new THREE.MeshBasicMaterial({
      color: 0x120a08,
      wireframe: false,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    this.decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, MAX_DAMAGE_DECALS);
    this.decalMesh.count = 0;
    this.decalMesh.frustumCulled = false;
    this.scene.add(this.decalMesh);

    const markerGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.5, 16);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0x3be8b0,
      emissive: 0x115544,
      roughness: 0.35,
      metalness: 0.4,
    });
    this.focusMarker = new THREE.Mesh(markerGeo, markerMat);
    this.focusMarker.castShadow = true;
    this.focusMarker.visible = false;
    this.scene.add(this.focusMarker);

    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.11, 0.11, 0.11));
    this.hoverBox = new THREE.LineSegments(
      boxEdges,
      new THREE.LineBasicMaterial({ color: 0xffd166 }),
    );
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    const normGeo = new THREE.BufferGeometry();
    normGeo.setAttribute('position', new THREE.BufferAttribute(this.hoverNormalPositions, 3));
    this.hoverNormalLine = new THREE.Line(
      normGeo,
      new THREE.LineBasicMaterial({ color: 0xff595e }),
    );
    this.hoverNormalLine.visible = false;
    this.scene.add(this.hoverNormalLine);

    const doorGeo = new THREE.BoxGeometry(3.0, 2.8, 0.14);
    const doorMat = new THREE.MeshStandardMaterial({
      color: 0x263244,
      emissive: 0x144d2a,
      emissiveIntensity: 0.45,
      roughness: 0.4,
      metalness: 0.7,
    });
    this.doorMesh = new THREE.Mesh(doorGeo, doorMat);
    this.doorMesh.position.set(12.0, 1.6, 0.08);
    this.scene.add(this.doorMesh);

    this.updateCamera();
  }

  private createBucketPool(
    idx: number,
    material: THREE.Material,
    castShadow: boolean,
    receiveShadow: boolean,
    sortObjects: boolean,
  ): BucketPool {
    const cfg = BUCKET_CONFIG[idx];
    const mesh = new THREE.BatchedMesh(
      cfg.maxInstances,
      cfg.maxVerts,
      cfg.maxIndices,
      material,
    );
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.sortObjects = sortObjects;
    mesh.perObjectFrustumCulled = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    return {
      mesh,
      maxVerts: cfg.maxVerts,
      maxIndices: cfg.maxIndices,
      bytesPerVert: cfg.bytesPerVert,
      usedVerts: 0,
      usedIndices: 0,
      usedBytes: 0,
      slots: new Array<BucketSlot | null>(TOTAL_CHUNKS).fill(null),
    };
  }

  private createVoxelMaterial(opts: {
    transparent: boolean;
    roughness: number;
    metalness: number;
    isGrate: boolean;
    enableCutaway: boolean;
  }): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: opts.roughness,
      metalness: opts.metalness,
      transparent: opts.transparent,
      depthWrite: !opts.transparent,
      side: THREE.FrontSide,
    });

    const uniforms = this.cutawayUniforms;
    const isGrate = opts.isGrate;
    const enableCutaway = opts.enableCutaway;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCamPos = uniforms.uCamPos;
      shader.uniforms.uFocusPos = uniforms.uFocusPos;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vVoxelWorldPos;
           varying vec3 vVoxelWorldNormal;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec4 customWp = vec4( transformed, 1.0 );
           #ifdef USE_BATCHING
             customWp = batchingMatrix * customWp;
           #endif
           #ifdef USE_INSTANCING
             customWp = instanceMatrix * customWp;
           #endif
           customWp = modelMatrix * customWp;
           vVoxelWorldPos = customWp.xyz;
           vVoxelWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uCamPos;
           uniform vec3 uFocusPos;
           varying vec3 vVoxelWorldPos;
           varying vec3 vVoxelWorldNormal;

           float voxelHash(vec3 p) {
             p = fract(p * 0.1031);
             p += dot(p, p.yzx + 33.33);
             return fract((p.x + p.y) * p.z);
           }

           float bayer4(vec2 coord) {
             int x = int(mod(coord.x, 4.0));
             int y = int(mod(coord.y, 4.0));
             int idx = y * 4 + x;
             if (idx == 0) return 0.0 / 16.0;
             if (idx == 1) return 8.0 / 16.0;
             if (idx == 2) return 2.0 / 16.0;
             if (idx == 3) return 10.0 / 16.0;
             if (idx == 4) return 12.0 / 16.0;
             if (idx == 5) return 4.0 / 16.0;
             if (idx == 6) return 14.0 / 16.0;
             if (idx == 7) return 6.0 / 16.0;
             if (idx == 8) return 3.0 / 16.0;
             if (idx == 9) return 11.0 / 16.0;
             if (idx == 10) return 1.0 / 16.0;
             if (idx == 11) return 9.0 / 16.0;
             if (idx == 12) return 15.0 / 16.0;
             if (idx == 13) return 7.0 / 16.0;
             if (idx == 14) return 13.0 / 16.0;
             return 5.0 / 16.0;
           }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           vec3 cellCoord = floor(vVoxelWorldPos * 10.0 - vVoxelWorldNormal * 0.05);
           float sh = voxelHash(cellCoord);
           diffuseColor.rgb *= (0.92 + 0.16 * sh);
           ${
             isGrate
               ? `
           if (abs(vVoxelWorldNormal.y) > 0.5) {
             vec2 gSub = fract(vVoxelWorldPos.xz * 15.0);
             if (gSub.x > 0.24 && gSub.x < 0.76 && gSub.y > 0.24 && gSub.y < 0.76) {
               discard;
             }
           }`
               : ''
           }
           ${
             enableCutaway
               ? `
           if (vVoxelWorldPos.y > uFocusPos.y + 1.55) {
             vec3 toFocus = (uFocusPos + vec3(0.0, 0.8, 0.0)) - uCamPos;
             float rayLen = length(toFocus);
             vec3 rayDir = toFocus / max(rayLen, 0.001);
             vec3 toFrag = vVoxelWorldPos - uCamPos;
             float proj = dot(toFrag, rayDir);
             if (proj > 0.5 && proj < rayLen - 0.35) {
               vec3 closest = uCamPos + rayDir * proj;
               float perpDist = length(vVoxelWorldPos - closest);
               if (perpDist < 2.1) {
                 float fade = smoothstep(1.1, 2.1, perpDist);
                 if (bayer4(gl_FragCoord.xy) > fade) {
                   discard;
                 }
               }
             }
           }`
               : ''
           }`,
        );
    };

    mat.customProgramCacheKey = () =>
      `voxel_${opts.transparent ? 1 : 0}_${opts.isGrate ? 1 : 0}_${opts.enableCutaway ? 1 : 0}`;
    return mat;
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public updateCamera(): void {
    const pitchRad = (48 * Math.PI) / 180;
    const dy = this.zoomDist * Math.sin(pitchRad);
    const dh = this.zoomDist * Math.cos(pitchRad);
    const dXZ = dh * Math.SQRT1_2;

    this.camera.position.set(
      this.focusPos.x + dXZ,
      this.focusPos.y + 0.8 + dy,
      this.focusPos.z + dXZ,
    );
    this.camera.lookAt(this.focusPos.x, this.focusPos.y + 0.8, this.focusPos.z);

    this.cutawayUniforms.uCamPos.value.copy(this.camera.position);
    this.cutawayUniforms.uFocusPos.value.copy(this.focusPos);
    this.focusMarker.position.set(this.focusPos.x, this.focusPos.y + 0.75, this.focusPos.z);
  }

  public getTotalMeshMemMB(): number {
    const bytes =
      this.buckets[0].usedBytes + this.buckets[1].usedBytes + this.buckets[2].usedBytes;
    return bytes / (1024 * 1024);
  }

  public getMeshedChunkCount(): number {
    let count = 0;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (
        this.buckets[0].slots[c] !== null ||
        this.buckets[1].slots[c] !== null ||
        this.buckets[2].slots[c] !== null
      ) {
        count++;
      }
    }
    return count;
  }

  public getDecalCount(): number {
    return this.decalCount;
  }

  private removeChunkFromBucket(pool: BucketPool, cIdx: number): void {
    const slot = pool.slots[cIdx];
    if (!slot) return;
    pool.mesh.deleteInstance(slot.instId);
    pool.mesh.deleteGeometry(slot.geoId);
    pool.usedVerts -= slot.verts;
    pool.usedIndices -= slot.indices;
    pool.usedBytes -= slot.bytes;
    pool.slots[cIdx] = null;
  }

  private evictFarthestChunk(room: RoomState, protectedChunk: number): boolean {
    let victim = -1;
    let bestDistSq = -1;
    let oldestUsed = 0x7fffffff;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (c === protectedChunk) continue;
      const hasMesh =
        this.buckets[0].slots[c] !== null ||
        this.buckets[1].slots[c] !== null ||
        this.buckets[2].slots[c] !== null;
      if (!hasMesh) continue;
      const dSq = this.chunkDistSq(c);
      const lastUsed = this.chunkLastUsed[c];
      if (
        dSq > bestDistSq + 1.0 ||
        (Math.abs(dSq - bestDistSq) <= 1.0 && lastUsed < oldestUsed)
      ) {
        bestDistSq = dSq;
        oldestUsed = lastUsed;
        victim = c;
      }
    }
    if (victim === -1) return false;
    for (let b = 0; b < 3; b++) {
      this.removeChunkFromBucket(this.buckets[b], victim);
    }
    room.dirtySolidMesh[victim] = 1;
    return true;
  }

  private uploadBucketGeometry(
    room: RoomState,
    bIdx: number,
    cIdx: number,
    cx: number,
    cy: number,
    cz: number,
    geo: THREE.BufferGeometry | null,
    verts: number,
    indices: number,
  ): void {
    const pool = this.buckets[bIdx];
    this.removeChunkFromBucket(pool, cIdx);
    if (!geo || verts === 0) return;

    const bytes = verts * pool.bytesPerVert + indices * 4;
    const capBytes = MAX_MESH_MEM_MB * 1024 * 1024;

    let guard = 0;
    while (
      guard < 64 &&
      (this.buckets[0].usedBytes +
        this.buckets[1].usedBytes +
        this.buckets[2].usedBytes +
        bytes >
        capBytes ||
        pool.usedVerts + verts > pool.maxVerts ||
        pool.usedIndices + indices > pool.maxIndices)
    ) {
      if (!this.evictFarthestChunk(room, cIdx)) break;
      guard++;
    }

    let geoId: number;
    try {
      geoId = pool.mesh.addGeometry(geo);
    } catch {
      pool.mesh.optimize();
      geoId = pool.mesh.addGeometry(geo);
    }

    const instId = pool.mesh.addInstance(geoId);
    this.tmpMat4.makeTranslation(
      cx * CHUNK_SIZE * VOXEL_SIZE_M,
      cy * CHUNK_SIZE * VOXEL_SIZE_M,
      cz * CHUNK_SIZE * VOXEL_SIZE_M,
    );
    pool.mesh.setMatrixAt(instId, this.tmpMat4);

    pool.usedVerts += verts;
    pool.usedIndices += indices;
    pool.usedBytes += bytes;
    pool.slots[cIdx] = { geoId, instId, verts, indices, bytes };

    geo.dispose();
  }

  private chunkDistSq(cIdx: number): number {
    const plane = CHUNKS_X * CHUNKS_Z;
    const cy = Math.floor(cIdx / plane);
    const rem = cIdx - cy * plane;
    const cz = Math.floor(rem / CHUNKS_X);
    const cx = rem - cz * CHUNKS_X;
    const mx = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const my = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const mz = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const dx = mx - this.focusPos.x;
    const dy = my - this.focusPos.y;
    const dz = mz - this.focusPos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  public processDirtyMeshes(room: RoomState, maxRemeshes = MAX_REMESHES_PER_FRAME, timeBudgetMs = 0): number {
    this.frameCounter++;
    this.dirtySortBuf.length = 0;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (room.dirtySolidMesh[c] && !room.outOfBounds[c]) {
        this.dirtySortBuf.push(c);
      }
    }

    if (this.dirtySortBuf.length === 0) return 0;

    this.dirtySortBuf.sort((a, b) => this.chunkDistSq(a) - this.chunkDistSq(b));

    const startMs = performance.now();
    let budgetedCount = 0;
    let attempted = 0;
    const plane = CHUNKS_X * CHUNKS_Z;

    for (let i = 0; i < this.dirtySortBuf.length; i++) {
      if (timeBudgetMs > 0) {
        if (budgetedCount > 0 && performance.now() - startMs >= timeBudgetMs) break;
      } else if (budgetedCount >= maxRemeshes) {
        break;
      }

      const cIdx = this.dirtySortBuf[i];
      const cy = Math.floor(cIdx / plane);
      const rem = cIdx - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;

      const res = buildChunkSolidMeshes(room, cx, cy, cz);
      const hadFaces =
        res.vertexCounts[0] > 0 || res.vertexCounts[1] > 0 || res.vertexCounts[2] > 0;

      for (let b = 0; b < 3; b++) {
        this.uploadBucketGeometry(
          room,
          b,
          cIdx,
          cx,
          cy,
          cz,
          res.geometries[b],
          res.vertexCounts[b],
          res.indexCounts[b],
        );
      }

      room.dirtySolidMesh[cIdx] = 0;
      this.chunkLastUsed[cIdx] = this.frameCounter;
      attempted++;
      if (hadFaces || timeBudgetMs === 0) {
        budgetedCount++;
      }
    }

    return Math.max(0, this.dirtySortBuf.length - attempted);
  }

  public processDirtyDecals(room: RoomState): void {
    let anyDirty = false;
    const plane = CHUNKS_X * CHUNKS_Z;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (!room.dirtyDecals[c]) continue;
      anyDirty = true;
      room.dirtyDecals[c] = 0;
      const list = this.decalPositionsByChunk[c];
      list.length = 0;
      if (room.outOfBounds[c]) continue;

      const cy = Math.floor(c / plane);
      const rem = c - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;
      const x0 = cx * CHUNK_SIZE;
      const y0 = cy * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;

      for (let y = y0; y < y0 + CHUNK_SIZE && y < room.roomH; y++) {
        for (let z = z0; z < z0 + CHUNK_SIZE && z < room.roomD; z++) {
          for (let x = x0; x < x0 + CHUNK_SIZE && x < room.roomW; x++) {
            const val = room.grid[cellIndex(x, y, z)];
            if (isSolidMat(getMat(val)) && getDamage(val) > 0) {
              list.push(
                (x + 0.5) * VOXEL_SIZE_M,
                (y + 0.5) * VOXEL_SIZE_M,
                (z + 0.5) * VOXEL_SIZE_M,
              );
            }
          }
        }
      }
    }

    const movedFar = this.focusPos.distanceToSquared(this.lastDecalSortPos) > 1.0;
    if (!anyDirty && !(movedFar && this.totalDecalCandidates > MAX_DAMAGE_DECALS)) return;

    const all: Array<{ x: number; y: number; z: number; dSq: number; c: number }> = [];
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      const list = this.decalPositionsByChunk[c];
      for (let i = 0; i < list.length; i += 3) {
        const x = list[i];
        const y = list[i + 1];
        const z = list[i + 2];
        const dx = x - this.focusPos.x;
        const dy = y - this.focusPos.y;
        const dz = z - this.focusPos.z;
        all.push({ x, y, z, dSq: dx * dx + dy * dy + dz * dz, c });
      }
    }

    this.totalDecalCandidates = all.length;
    this.lastDecalSortPos.copy(this.focusPos);

    if (all.length > MAX_DAMAGE_DECALS) {
      all.sort((a, b) => a.dSq - b.dSq);
      for (let i = MAX_DAMAGE_DECALS; i < all.length; i++) {
        room.dirtyDecals[all[i].c] = 1;
      }
    }

    const count = Math.min(all.length, MAX_DAMAGE_DECALS);
    for (let i = 0; i < count; i++) {
      this.tmpMat4.makeTranslation(all[i].x, all[i].y, all[i].z);
      this.decalMesh.setMatrixAt(i, this.tmpMat4);
    }
    this.decalMesh.count = count;
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.decalCount = count;
  }

  public pickVoxel(
    room: RoomState,
    clientX: number,
    clientY: number,
  ): VoxelRayHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const hit = raycastSolidVoxel(
      room,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      80,
      true,
    );

    if (hit) {
      const cx = (hit.x + 0.5) * VOXEL_SIZE_M;
      const cy = (hit.y + 0.5) * VOXEL_SIZE_M;
      const cz = (hit.z + 0.5) * VOXEL_SIZE_M;
      this.hoverBox.visible = true;
      this.hoverBox.position.set(cx, cy, cz);
      this.hoverNormalPositions[0] = cx + hit.nx * 0.05;
      this.hoverNormalPositions[1] = cy + hit.ny * 0.05;
      this.hoverNormalPositions[2] = cz + hit.nz * 0.05;
      this.hoverNormalPositions[3] = cx + hit.nx * 0.35;
      this.hoverNormalPositions[4] = cy + hit.ny * 0.35;
      this.hoverNormalPositions[5] = cz + hit.nz * 0.35;
      (this.hoverNormalLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.hoverNormalLine.visible = true;
    } else {
      this.hoverBox.visible = false;
      this.hoverNormalLine.visible = false;
    }
    return hit;
  }

  public computeTorsoAimDirection(
    playerX: number,
    playerY: number,
    playerZ: number,
    clientX: number,
    clientY: number,
  ): [number, number, number] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);

    const torsoY = playerY + 0.8;
    this.aimPlane.constant = -torsoY;
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.aimHit);
    if (!hit) return [0, 0, 1];

    const dx = this.aimHit.x - playerX;
    const dz = this.aimHit.z - playerZ;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-4) return [0, 0, 1];

    const qx = Math.round((dx / len) * 1024) / 1024;
    const qz = Math.round((dz / len) * 1024) / 1024;
    return [qx, 0, qz];
  }

  public describeHit(hit: VoxelRayHit | null): string {
    if (!hit) return 'none';
    const name = MATERIAL_SPEC[hit.mat]?.name ?? `#${hit.mat}`;
    return `${name} (${hit.x},${hit.y},${hit.z})`;
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public getRoomBoundsM(): { w: number; h: number; d: number } {
    return {
      w: ARENA_W * VOXEL_SIZE_M,
      h: ARENA_H * VOXEL_SIZE_M,
      d: ARENA_D * VOXEL_SIZE_M,
    };
  }
}

export function getChunkCountCheck(): number {
  return CHUNKS_X * CHUNKS_Y * CHUNKS_Z;
}
