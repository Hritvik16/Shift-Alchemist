import * as THREE from 'three';
import {
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  MAT,
  MATERIAL_SPEC,
  MAX_ACTIVE_BALLISTIC,
  MAX_FLUID_CACHE_REBUILDS_PER_FRAME,
  MAX_RENDERED_GRID_FLUID,
  MAX_RENDERED_TOTAL_FLUID,
  SLICE_STRIDE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
} from '../core/balance.ts';
import {
  getMat,
  getShimmer,
  getTimerOrCharge,
  isFluidOrGasMat,
  type RoomState,
} from '../core/types.ts';

const TEMP_CHUNK_BUF = new Float32Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE * 4);

export class FluidRenderer {
  private readonly fluidCachePool = new Float32Array(MAX_RENDERED_GRID_FLUID * 4);
  private readonly chunkFluidOffset = new Int32Array(TOTAL_CHUNKS);
  private readonly chunkFluidCount = new Uint16Array(TOTAL_CHUNKS);
  private readonly chunkFluidCap = new Uint16Array(TOTAL_CHUNKS);
  private poolTail = 0;

  private readonly gpuInstanceData = new Float32Array(MAX_RENDERED_TOTAL_FLUID * 4);
  private readonly instanceAttr: THREE.InstancedBufferAttribute;
  private readonly instGeo: THREE.InstancedBufferGeometry;
  public readonly mesh: THREE.Mesh;

  private readonly dirtySortBuf: number[] = [];
  private readonly chunkDirtyAge = new Uint16Array(TOTAL_CHUNKS);
  public renderedGridCount = 0;
  public renderedBallisticCount = 0;
  public lastRebuiltChunks = 0;

  // Cosmetic viewer-only cryo sublimation vapor wisps (zero sim/ledger impact)
  private readonly vaporMax = 256;
  private readonly vaporPos = new Float32Array(256 * 3);
  private readonly vaporAge = new Float32Array(256);
  private readonly vaporLife = new Float32Array(256);
  private vaporCursor = 0;
  private readonly vaporMesh: THREE.InstancedMesh;
  private readonly vaporMat4 = new THREE.Matrix4();
  private readonly vaporPosVec = new THREE.Vector3();
  private readonly vaporScaleVec = new THREE.Vector3();
  private readonly vaporQuat = new THREE.Quaternion();
  private lastTimeSec = 0;

  constructor(scene: THREE.Scene) {
    const baseBox = new THREE.BoxGeometry(VOXEL_SIZE_M, VOXEL_SIZE_M, VOXEL_SIZE_M);
    this.instGeo = new THREE.InstancedBufferGeometry();
    this.instGeo.index = baseBox.index;
    this.instGeo.attributes.position = baseBox.attributes.position;
    this.instGeo.attributes.normal = baseBox.attributes.normal;

    this.instanceAttr = new THREE.InstancedBufferAttribute(this.gpuInstanceData, 4);
    this.instanceAttr.setUsage(THREE.DynamicDrawUsage);
    this.instGeo.setAttribute('aInstanceData', this.instanceAttr);
    this.instGeo.instanceCount = 0;

    const paletteVecs: THREE.Vector3[] = [];
    for (let i = 0; i < 13; i++) {
      const hex = MATERIAL_SPEC[i]?.colorHex ?? 0xffffff;
      paletteVecs.push(
        new THREE.Vector3(
          ((hex >> 16) & 255) / 255,
          ((hex >> 8) & 255) / 255,
          (hex & 255) / 255,
        ),
      );
    }

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPalette: { value: paletteVecs },
        uLightDir: { value: new THREE.Vector3(0.55, 0.72, 0.48).normalize() },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute vec4 aInstanceData;
        uniform vec3 uPalette[13];
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying vec3 vColor;
        varying float vMatId;
        varying float vElec;

        void main() {
          float pIdx = floor(aInstanceData.w + 0.5);
          float isElec = step(128.0, pIdx);
          float baseIdx = pIdx - isElec * 128.0;
          int matId = int(clamp(floor(baseIdx / 8.0), 0.0, 12.0));
          float shimmer = baseIdx - float(matId) * 8.0;

          vec3 baseCol = uPalette[matId];
          baseCol *= (0.88 + 0.032 * shimmer);
          vColor = baseCol;
          vMatId = float(matId);
          vElec = isElec;
          vNormal = normal;

          vec3 worldPos = position + aInstanceData.xyz;
          vWorldPos = worldPos;
          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uLightDir;
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying vec3 vColor;
        varying float vMatId;
        varying float vElec;

        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPos);
          float ndl = max(dot(N, uLightDir), 0.0);
          float hemi = 0.45 + 0.55 * (N.y * 0.5 + 0.5);
          float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.2);

          vec3 col = vColor * (0.68 * hemi + 0.48 * ndl);

          // Material-specific rim tint (Noita/Teardown legibility without alpha sorting)
          if (vMatId > 0.5 && vMatId < 1.5) {
            col += vec3(0.28, 0.62, 0.92) * fresnel * 0.55;
          } else if (vMatId > 1.5 && vMatId < 2.5) {
            col += vec3(0.55, 0.38, 0.16) * fresnel * 0.65;
          } else if (vMatId > 2.5 && vMatId < 3.5) {
            col += vec3(0.35, 0.92, 1.0) * (0.18 + fresnel * 0.6);
          } else if (vMatId > 4.5 && vMatId < 5.5) {
            col = vColor * 1.25 + vec3(1.0, 0.85, 0.25) * fresnel * 0.5;
          } else if (vMatId > 5.5 && vMatId < 6.5) {
            col += vec3(0.75, 0.95, 1.0) * fresnel * 0.7;
          } else if (vMatId > 10.5 && vMatId < 11.5) {
            col += vec3(0.55, 1.0, 0.25) * (0.15 + fresnel * 0.5);
          }

          if (vElec > 0.5) {
            float pulse = 0.65 + 0.35 * sin(uTime * 28.0 + vWorldPos.x * 12.0 + vWorldPos.z * 12.0);
            col = mix(col, vec3(0.75, 0.96, 1.0), 0.55 * pulse);
          }

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(this.instGeo, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    const vaporGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    const vaporMat = new THREE.MeshBasicMaterial({
      color: 0xc8f6ff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.vaporMesh = new THREE.InstancedMesh(vaporGeo, vaporMat, this.vaporMax);
    this.vaporMesh.count = 0;
    this.vaporMesh.frustumCulled = false;
    scene.add(this.vaporMesh);
  }

  public resetAll(): void {
    this.chunkFluidOffset.fill(0);
    this.chunkFluidCount.fill(0);
    this.chunkFluidCap.fill(0);
    this.chunkDirtyAge.fill(0);
    this.poolTail = 0;
    this.instGeo.instanceCount = 0;
    this.renderedGridCount = 0;
    this.renderedBallisticCount = 0;
  }

  private chunkDistSq(cIdx: number, focusPos: THREE.Vector3): number {
    const plane = CHUNKS_X * CHUNKS_Z;
    const cy = Math.floor(cIdx / plane);
    const rem = cIdx - cy * plane;
    const cz = Math.floor(rem / CHUNKS_X);
    const cx = rem - cz * CHUNKS_X;
    const mx = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const my = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const mz = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const dx = mx - focusPos.x;
    const dy = my - focusPos.y;
    const dz = mz - focusPos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  private compactPool(excludeChunk: number): void {
    const live: number[] = [];
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (c === excludeChunk || this.chunkFluidCount[c] === 0) {
        this.chunkFluidCount[c] = 0;
        this.chunkFluidCap[c] = 0;
        this.chunkFluidOffset[c] = 0;
      } else {
        live.push(c);
      }
    }
    // Sort by ascending pool offset so write <= off holds strictly (zero overwrite corruption)
    live.sort((a, b) => this.chunkFluidOffset[a] - this.chunkFluidOffset[b]);
    let write = 0;
    for (let i = 0; i < live.length; i++) {
      const c = live[i];
      const cnt = this.chunkFluidCount[c];
      const off = this.chunkFluidOffset[c];
      if (off !== write) {
        this.fluidCachePool.copyWithin(write * 4, off * 4, (off + cnt) * 4);
        this.chunkFluidOffset[c] = write;
      }
      this.chunkFluidCap[c] = cnt;
      write += cnt;
    }
    this.poolTail = write;
  }

  private rebuildChunkSlice(
    room: RoomState,
    cIdx: number,
    focusPos: THREE.Vector3,
  ): boolean {
    const plane = CHUNKS_X * CHUNKS_Z;
    const cy = Math.floor(cIdx / plane);
    const rem = cIdx - cy * plane;
    const cz = Math.floor(rem / CHUNKS_X);
    const cx = rem - cz * CHUNKS_X;

    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const x1 = Math.min(room.roomW, x0 + CHUNK_SIZE);
    const y1 = Math.min(room.roomH, y0 + CHUNK_SIZE);
    const z1 = Math.min(room.roomD, z0 + CHUNK_SIZE);

    const g = room.grid;
    const W = room.roomW;
    const H = room.roomH;
    const D = room.roomD;

    let count = 0;
    for (let y = y0; y < y1; y++) {
      const yOff = y * SLICE_STRIDE;
      for (let z = z0; z < z1; z++) {
        const row = yOff + z * ARENA_W;
        for (let x = x0; x < x1; x++) {
          const idx = row + x;
          const val = g[idx];
          const mat = getMat(val);
          if (!isFluidOrGasMat(mat)) continue;

          // 6-face same-fluid interior culling (§4.4)
          if (
            x > 0 &&
            x + 1 < W &&
            y > 0 &&
            y + 1 < H &&
            z > 0 &&
            z + 1 < D &&
            getMat(g[idx - 1]) === mat &&
            getMat(g[idx + 1]) === mat &&
            getMat(g[idx - ARENA_W]) === mat &&
            getMat(g[idx + ARENA_W]) === mat &&
            getMat(g[idx - SLICE_STRIDE]) === mat &&
            getMat(g[idx + SLICE_STRIDE]) === mat
          ) {
            continue;
          }

          const isElec = getTimerOrCharge(val) > 0 && (mat === MAT.WATER || mat === MAT.ACID) ? 128 : 0;
          const paletteIndex = mat * 8 + getShimmer(val) + isElec;
          const base = count * 4;
          TEMP_CHUNK_BUF[base] = (x + 0.5) * VOXEL_SIZE_M;
          TEMP_CHUNK_BUF[base + 1] = (y + 0.5) * VOXEL_SIZE_M;
          TEMP_CHUNK_BUF[base + 2] = (z + 0.5) * VOXEL_SIZE_M;
          TEMP_CHUNK_BUF[base + 3] = paletteIndex;
          count++;
        }
      }
    }

    if (count === 0) {
      this.chunkFluidCount[cIdx] = 0;
      return true;
    }

    // Allocation strategy (§4.4): in-place -> append -> compact once -> drop farthest chunks
    if (count <= this.chunkFluidCap[cIdx]) {
      const off = this.chunkFluidOffset[cIdx];
      this.fluidCachePool.set(TEMP_CHUNK_BUF.subarray(0, count * 4), off * 4);
      this.chunkFluidCount[cIdx] = count;
      return true;
    }

    if (this.poolTail + count <= MAX_RENDERED_GRID_FLUID) {
      this.chunkFluidOffset[cIdx] = this.poolTail;
      this.chunkFluidCap[cIdx] = count;
      this.chunkFluidCount[cIdx] = count;
      this.fluidCachePool.set(TEMP_CHUNK_BUF.subarray(0, count * 4), this.poolTail * 4);
      this.poolTail += count;
      return true;
    }

    this.compactPool(cIdx);
    if (this.poolTail + count <= MAX_RENDERED_GRID_FLUID) {
      this.chunkFluidOffset[cIdx] = this.poolTail;
      this.chunkFluidCap[cIdx] = count;
      this.chunkFluidCount[cIdx] = count;
      this.fluidCachePool.set(TEMP_CHUNK_BUF.subarray(0, count * 4), this.poolTail * 4);
      this.poolTail += count;
      return true;
    }

    // Drop farthest chunks until this closer chunk fits
    const targetDistSq = this.chunkDistSq(cIdx, focusPos);
    while (this.poolTail + count > MAX_RENDERED_GRID_FLUID) {
      let victim = -1;
      let victimDistSq = targetDistSq;
      for (let c = 0; c < TOTAL_CHUNKS; c++) {
        if (c === cIdx || this.chunkFluidCount[c] === 0) continue;
        const dSq = this.chunkDistSq(c, focusPos);
        if (dSq > victimDistSq) {
          victimDistSq = dSq;
          victim = c;
        }
      }
      if (victim === -1) {
        return false;
      }
      this.chunkFluidCount[victim] = 0;
      this.chunkFluidCap[victim] = 0;
      room.dirtyFluidRender[victim] = 1;
      this.compactPool(cIdx);
    }

    this.chunkFluidOffset[cIdx] = this.poolTail;
    this.chunkFluidCap[cIdx] = count;
    this.chunkFluidCount[cIdx] = count;
    this.fluidCachePool.set(TEMP_CHUNK_BUF.subarray(0, count * 4), this.poolTail * 4);
    this.poolTail += count;
    return true;
  }

  public update(
    room: RoomState,
    focusPos: THREE.Vector3,
    timeSec: number,
    maxRebuilds = MAX_FLUID_CACHE_REBUILDS_PER_FRAME,
    timeBudgetMs = 0,
  ): number {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = timeSec;

    this.dirtySortBuf.length = 0;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (!room.dirtyFluidRender[c] || room.outOfBounds[c]) {
        this.chunkDirtyAge[c] = 0;
        continue;
      }
      // O(1) empty-chunk clear: never waste a rebuild slot scanning 4,096 empty cells
      if (room.chunkFluidVoxelCount[c] === 0) {
        this.chunkFluidCount[c] = 0;
        room.dirtyFluidRender[c] = 0;
        this.chunkDirtyAge[c] = 0;
        continue;
      }
      if (this.chunkDirtyAge[c] < 65535) this.chunkDirtyAge[c]++;
      this.dirtySortBuf.push(c);
    }

    if (this.dirtySortBuf.length > 1) {
      // Distance-prioritized with aging boost so farther moving puddles never starve mid-air
      this.dirtySortBuf.sort((a, b) => {
        const ageA = this.chunkDirtyAge[a];
        const ageB = this.chunkDirtyAge[b];
        if (ageA >= 3 !== ageB >= 3) return ageB - ageA;
        return this.chunkDistSq(a, focusPos) - this.chunkDistSq(b, focusPos);
      });
    }

    const startMs = performance.now();
    let rebuilt = 0;
    let cleared = 0;
    for (let i = 0; i < this.dirtySortBuf.length; i++) {
      if (timeBudgetMs > 0) {
        if (rebuilt > 0 && performance.now() - startMs >= timeBudgetMs) break;
      } else if (rebuilt >= maxRebuilds) {
        break;
      }
      const cIdx = this.dirtySortBuf[i];
      const ok = this.rebuildChunkSlice(room, cIdx, focusPos);
      if (ok) {
        room.dirtyFluidRender[cIdx] = 0;
        this.chunkDirtyAge[cIdx] = 0;
        cleared++;
      }
      rebuilt++;
    }
    this.lastRebuiltChunks = cleared;

    // Pack visible cached grid fluid + active ballisticQuanta into 4-float GPU buffer
    let writeCount = 0;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      const cnt = this.chunkFluidCount[c];
      if (cnt === 0) continue;
      const take = Math.min(cnt, MAX_RENDERED_GRID_FLUID - writeCount);
      if (take <= 0) break;
      const off = this.chunkFluidOffset[c];
      this.gpuInstanceData.set(
        this.fluidCachePool.subarray(off * 4, (off + take) * 4),
        writeCount * 4,
      );
      writeCount += take;
    }
    this.renderedGridCount = writeCount;

    const bp = room.ballistic;
    let ballisticWritten = 0;
    if (bp.count > 0) {
      for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
        if (bp.active[i] === 0) continue;
        if (writeCount >= MAX_RENDERED_TOTAL_FLUID) break;
        const val = bp.packedVoxel[i];
        const mat = getMat(val);
        const isElec =
          getTimerOrCharge(val) > 0 && (mat === MAT.WATER || mat === MAT.ACID) ? 128 : 0;
        const paletteIndex = mat * 8 + getShimmer(val) + isElec;
        const base = writeCount * 4;
        this.gpuInstanceData[base] = bp.x[i];
        this.gpuInstanceData[base + 1] = bp.y[i];
        this.gpuInstanceData[base + 2] = bp.z[i];
        this.gpuInstanceData[base + 3] = paletteIndex;
        writeCount++;
        ballisticWritten++;
      }
    }
    this.renderedBallisticCount = ballisticWritten;

    this.instGeo.instanceCount = writeCount;
    this.instanceAttr.needsUpdate = true;

    // Update cosmetic cryo sublimation vapor wisps
    const dt = this.lastTimeSec > 0 ? Math.min(0.05, Math.max(0, timeSec - this.lastTimeSec)) : 0.016;
    this.lastTimeSec = timeSec;

    for (let e = 0; e < room.sublimationEventCount; e++) {
      const slot = this.vaporCursor;
      this.vaporCursor = (this.vaporCursor + 1) % this.vaporMax;
      const eb = e * 3;
      const vb = slot * 3;
      this.vaporPos[vb] = room.sublimationEvents[eb];
      this.vaporPos[vb + 1] = room.sublimationEvents[eb + 1] + 0.04;
      this.vaporPos[vb + 2] = room.sublimationEvents[eb + 2];
      this.vaporAge[slot] = 0;
      this.vaporLife[slot] = 0.85;
    }
    room.sublimationEventCount = 0;

    let activeVapor = 0;
    for (let i = 0; i < this.vaporMax; i++) {
      const life = this.vaporLife[i];
      if (life <= 0) continue;
      this.vaporAge[i] += dt;
      if (this.vaporAge[i] >= life) {
        this.vaporLife[i] = 0;
        continue;
      }
      const vb = i * 3;
      this.vaporPos[vb + 1] += 0.9 * dt;
      const t = this.vaporAge[i] / life;
      const s = 0.7 + 1.4 * Math.sin(t * Math.PI);
      this.vaporPosVec.set(this.vaporPos[vb], this.vaporPos[vb + 1], this.vaporPos[vb + 2]);
      this.vaporScaleVec.set(s, s * 1.15, s);
      this.vaporMat4.compose(this.vaporPosVec, this.vaporQuat, this.vaporScaleVec);
      this.vaporMesh.setMatrixAt(activeVapor++, this.vaporMat4);
    }
    this.vaporMesh.count = activeVapor;
    if (activeVapor > 0) this.vaporMesh.instanceMatrix.needsUpdate = true;

    return Math.max(0, this.dirtySortBuf.length - cleared);
  }
}
