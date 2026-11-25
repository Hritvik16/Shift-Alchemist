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

  // Cosmetic viewer-only cryo cold mist & sublimation vapor wisps (zero sim/ledger impact)
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
  private lastCryoMistStep = -1;

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
        uLightDir: { value: new THREE.Vector3(0.55, 0.78, 0.42).normalize() },
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
        varying float vShimmer;

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
          vShimmer = shimmer;
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
        varying float vShimmer;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uLightDir);
          vec3 H = normalize(L + V);
          float ndl = max(dot(N, L), 0.0);
          float ndv = clamp(max(dot(N, V), 0.0), 0.0, 1.0);
          float hemi = 0.44 + 0.56 * (N.y * 0.5 + 0.5);
          float fresnel = pow(1.0 - ndv, 2.3);
          float spec = pow(max(dot(N, H), 0.0), 36.0);

          vec3 cellId = floor(vWorldPos * 10.0);
          vec3 col = vColor * (0.64 * hemi + 0.46 * ndl);
          float alpha = 0.96;

          if (vMatId > 0.5 && vMatId < 1.5) {
            // WATER: calm, clean translucent cerulean liquid (no boiling spots or vertical stripes)
            float gentleGlint = 0.5 + 0.5 * sin(uTime * 0.85 + vWorldPos.x * 1.4 + vWorldPos.z * 1.1);
            vec3 deepWater = vec3(0.09, 0.36, 0.64);
            vec3 brightWater = vec3(0.20, 0.58, 0.86);
            col = mix(deepWater, brightWater, 0.52 * hemi + 0.36 * ndl) * (0.95 + 0.014 * vShimmer);
            col += vec3(0.45, 0.82, 0.98) * fresnel * (0.34 + 0.06 * gentleGlint);
            col += vec3(0.88, 0.96, 1.0) * spec * 0.65;
            alpha = clamp(0.64 + 0.24 * fresnel + spec * 0.14, 0.62, 0.90);
          } else if (vMatId > 1.5 && vMatId < 2.5) {
            // OIL: unmistakable glossy dark pitch-black crude with subtle petrol sheen strictly on highlights/rims
            float slickPhase = ndv * 7.5 + (vWorldPos.x * 0.9 - vWorldPos.z * 0.7);
            vec3 irid = 0.5 + 0.5 * cos(slickPhase + vec3(0.0, 2.0, 4.1));
            float oilSpec = pow(max(dot(N, H), 0.0), 56.0);
            vec3 crudeBase = vec3(0.045, 0.042, 0.048) * (0.75 + 0.55 * hemi + 0.35 * ndl) * (0.92 + 0.02 * vShimmer);
            col = crudeBase + mix(vec3(0.14, 0.10, 0.18), irid, 0.45) * (fresnel * 0.24 + oilSpec * 0.32);
            col += vec3(0.68, 0.70, 0.76) * oilSpec * 0.55;
            alpha = 0.97;
          } else if (vMatId > 2.5 && vMatId < 3.5) {
            // CRYO: luminous cryogenic cyan liquid, semi-translucent with icy core glow
            float pulse = 0.5 + 0.5 * sin(uTime * 3.5 + vShimmer * 0.9);
            col = mix(vec3(0.14, 0.68, 0.88), vec3(0.56, 0.96, 1.0), 0.45 + 0.35 * fresnel + 0.15 * pulse);
            col += vec3(0.75, 0.98, 1.0) * (0.14 + spec * 0.75);
            alpha = clamp(0.78 + 0.18 * fresnel, 0.76, 0.96);
          } else if (vMatId > 3.5 && vMatId < 4.5) {
            // STEAM: soft translucent billowing vapor
            col = mix(vec3(0.72, 0.80, 0.88), vec3(0.96, 0.98, 1.0), hemi);
            alpha = clamp(0.42 + 0.18 * fresnel, 0.38, 0.64);
          } else if (vMatId > 4.5 && vMatId < 5.5) {
            // FIRE: pure Noita-style quantized per-voxel combustion flicker (zero diagonal stripes!)
            float stepTime = floor(uTime * 11.0);
            float h = hash31(cellId + vec3(stepTime * 0.37, stepTime * 0.71, stepTime * 0.19));
            float hNext = hash31(cellId + vec3((stepTime + 1.0) * 0.37, (stepTime + 1.0) * 0.71, (stepTime + 1.0) * 0.19));
            float heat = mix(h, hNext, fract(uTime * 11.0) * 0.35);
            vec3 crimsonTip = vec3(0.82, 0.12, 0.02);
            vec3 orangeBody = vec3(1.0, 0.42, 0.04);
            vec3 yellowCore = vec3(1.0, 0.93, 0.42);
            col = heat < 0.45
              ? mix(crimsonTip, orangeBody, heat / 0.45)
              : mix(orangeBody, yellowCore, (heat - 0.45) / 0.55);
            col *= 1.18 + 0.28 * fresnel;
            alpha = clamp(0.84 + 0.12 * heat, 0.80, 0.96);
          } else if (vMatId > 5.5 && vMatId < 6.5) {
            // Ballistic ICE shards: crisp crystalline translucency
            col = mix(vec3(0.55, 0.88, 1.0), vec3(0.92, 0.99, 1.0), fresnel * 0.75) + vec3(0.9, 0.98, 1.0) * spec * 0.8;
            alpha = clamp(0.72 + 0.24 * fresnel, 0.70, 0.96);
          } else if (vMatId > 10.5 && vMatId < 11.5) {
            // ACID: toxic luminous green with bubbling surface highlights
            float bub = hash31(cellId + floor(uTime * 6.0) * 0.23);
            col = mix(vec3(0.24, 0.72, 0.08), vec3(0.72, 1.0, 0.24), 0.45 + 0.4 * bub + 0.25 * fresnel);
            alpha = 0.86;
          }

          if (vElec > 0.5) {
            // Pure electric blue + crisp arc-white surface crackles (zero yellow)
            float eStep = floor(uTime * 16.0);
            float eHash = hash31(cellId + vec3(eStep * 0.41, 1.7, eStep * 0.29));
            float whiteArc = step(0.955, eHash);
            float cyanFlick = step(0.89, eHash) * (1.0 - whiteArc);
            col = mix(col, vec3(0.12, 0.46, 0.98), 0.28);
            col += vec3(0.26, 0.72, 1.0) * fresnel * 0.42;
            col = mix(col, vec3(0.55, 0.92, 1.0), cyanFlick * 0.65);
            col = mix(col, vec3(0.95, 0.99, 1.0), whiteArc * 0.92);
            alpha = max(alpha, 0.74 + whiteArc * 0.22);
          }

          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(this.instGeo, material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    const vaporGeo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
    const vaporMat = new THREE.MeshBasicMaterial({
      color: 0xcdf7ff,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    this.vaporMesh = new THREE.InstancedMesh(vaporGeo, vaporMat, this.vaporMax);
    this.vaporMesh.renderOrder = 5;
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
    this.vaporLife.fill(0);
    this.vaporMesh.count = 0;
  }

  private spawnVaporWisp(x: number, y: number, z: number, life = 0.85): void {
    const slot = this.vaporCursor;
    this.vaporCursor = (this.vaporCursor + 1) % this.vaporMax;
    const vb = slot * 3;
    this.vaporPos[vb] = x;
    this.vaporPos[vb + 1] = y;
    this.vaporPos[vb + 2] = z;
    this.vaporAge[slot] = 0;
    this.vaporLife[slot] = life;
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
      if (victim === -1) return false;
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

    // Update cosmetic cryo sublimation + ambient cold mist wisps
    const dt = this.lastTimeSec > 0 ? Math.min(0.05, Math.max(0, timeSec - this.lastTimeSec)) : 0.016;
    this.lastTimeSec = timeSec;

    for (let e = 0; e < room.sublimationEventCount; e++) {
      const eb = e * 3;
      this.spawnVaporWisp(
        room.sublimationEvents[eb],
        room.sublimationEvents[eb + 1] + 0.04,
        room.sublimationEvents[eb + 2],
        0.85,
      );
    }
    room.sublimationEventCount = 0;

    // Ambient low-lying cold mist rising gently from active exposed CRYO cells (~18 Hz)
    const mistStep = Math.floor(timeSec * 18);
    if (mistStep !== this.lastCryoMistStep && room.activeFluidCurCount > 0) {
      this.lastCryoMistStep = mistStep;
      const g = room.grid;
      const af = room.activeFluidCur;
      const cnt = room.activeFluidCurCount;
      const stride = Math.max(1, Math.floor(cnt / 24));
      let spawned = 0;
      for (let i = mistStep % stride; i < cnt && spawned < 2; i += stride) {
        const idx = af[i];
        if (getMat(g[idx]) !== MAT.CRYO) continue;
        const vy = Math.floor(idx / SLICE_STRIDE);
        const rem = idx - vy * SLICE_STRIDE;
        const vz = Math.floor(rem / ARENA_W);
        const vx = rem - vz * ARENA_W;
        this.spawnVaporWisp((vx + 0.5) * VOXEL_SIZE_M, (vy + 0.8) * VOXEL_SIZE_M, (vz + 0.5) * VOXEL_SIZE_M, 0.72);
        spawned++;
      }
    }

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
      this.vaporPos[vb + 1] += 0.58 * dt;
      const t = this.vaporAge[i] / life;
      const s = 0.6 + 1.3 * Math.sin(t * Math.PI);
      this.vaporPosVec.set(this.vaporPos[vb], this.vaporPos[vb + 1], this.vaporPos[vb + 2]);
      this.vaporScaleVec.set(s, s * 0.9, s);
      this.vaporMat4.compose(this.vaporPosVec, this.vaporQuat, this.vaporScaleVec);
      this.vaporMesh.setMatrixAt(activeVapor++, this.vaporMat4);
    }
    this.vaporMesh.count = activeVapor;
    if (activeVapor > 0) this.vaporMesh.instanceMatrix.needsUpdate = true;

    return Math.max(0, this.dirtySortBuf.length - cleared);
  }
}
