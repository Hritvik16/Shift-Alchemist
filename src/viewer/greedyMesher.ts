import * as THREE from 'three';
import {
  CHUNK_SIZE,
  MAT,
  MATERIAL_SPEC,
  TEMP_BYTE,
  VOXEL_SIZE_M,
} from '../core/balance.ts';
import {
  cellIndex,
  getMat,
  getTempByte,
  inRoomBounds,
  isSolidMat,
  type RoomState,
} from '../core/types.ts';

export const SOLID_BUCKET = {
  OPAQUE: 0,
  TRANSPARENT: 1,
  GRATE: 2,
} as const;

export type SolidBucketId = (typeof SOLID_BUCKET)[keyof typeof SOLID_BUCKET];

// Viewer-only architectural material codes (all opaque except 101/102 glass)
const CODE_DIORAMA_CAP = 20;
const CODE_HAZARD_LEDGE = 21;
const CODE_WALL_STRIPE = 22;
const CODE_PIT_STEEL = 23;
const CODE_STAIR_STEEL = 24;
const CODE_UPPER_STEEL = 25;
const CODE_WALL_DARK = 26;
const CODE_WALL_PANEL = 27;

interface BucketAccumulator {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  vertexCount: number;
}

function createAcc(): BucketAccumulator {
  return { positions: [], normals: [], colors: [], indices: [], vertexCount: 0 };
}

function resetAcc(acc: BucketAccumulator): void {
  acc.positions.length = 0;
  acc.normals.length = 0;
  acc.colors.length = 0;
  acc.indices.length = 0;
  acc.vertexCount = 0;
}

// Module-level reusable scratch buffers (zero per-chunk GC allocations)
const maskScratch = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);
const bucketAccs: [BucketAccumulator, BucketAccumulator, BucketAccumulator] = [
  createAcc(),
  createAcc(),
  createAcc(),
];

// Stronger baked voxel AO curve for crisp wall/floor creases, stair risers & scaffold bases
const AO_CURVE = [0.42, 0.62, 0.82, 1.0] as const;

function isViewerCeilingCutaway(room: RoomState, y: number): boolean {
  return y >= room.roomH - 2;
}

function getSouthEastCurbTopY(room: RoomState, x: number, z: number): number {
  const defaultTop = room.roomH >= 64 ? 14 : 5;
  const isS = z === room.roomD - 1;
  const isE = x === room.roomW - 1;
  for (let i = 0; i < room.doors.length; i++) {
    const d = room.doors[i];
    if (isS && d.face === 'S' && x >= d.minX && x <= d.maxX) return 4;
    if (isE && d.face === 'E' && z >= d.minZ && z <= d.maxZ) return 4;
  }
  return defaultTop;
}

function isCellSolidRaw(room: RoomState, x: number, y: number, z: number): boolean {
  if (!inRoomBounds(room, x, y, z)) return false;
  return isSolidMat(getMat(room.grid[cellIndex(x, y, z)]));
}

function isHullDropLedge(room: RoomState, x: number, y: number, z: number): boolean {
  if (y < 4) return false;
  if (isCellSolidRaw(room, x, y + 1, z)) return false;
  // Require a >= 0.3 m (3-voxel) drop on a cardinal neighbor so 0.2 m stairs stay distinct from pit/chasm ledges
  const checkDrop = (nx: number, nz: number): boolean =>
    inRoomBounds(room, nx, y - 2, nz) &&
    !isCellSolidRaw(room, nx, y, nz) &&
    !isCellSolidRaw(room, nx, y - 1, nz) &&
    !isCellSolidRaw(room, nx, y - 2, nz);
  return (
    checkDrop(x + 1, z) ||
    checkDrop(x - 1, z) ||
    checkDrop(x, z + 1) ||
    checkDrop(x, z - 1)
  );
}

function isHullStairStep(room: RoomState, x: number, y: number, z: number): boolean {
  if (y < 2 || room.roomH < 64) return false;
  if (isCellSolidRaw(room, x, y + 1, z)) return false;
  if (y >= 2 && y <= 10) {
    const checkStep = (nx: number, nz: number): boolean =>
      inRoomBounds(room, nx, y - 2, nz) &&
      !isCellSolidRaw(room, nx, y, nz) &&
      !isCellSolidRaw(room, nx, y - 1, nz) &&
      isCellSolidRaw(room, nx, y - 2, nz);
    return (
      checkStep(x + 1, z) ||
      checkStep(x - 1, z) ||
      checkStep(x, z + 1) ||
      checkStep(x, z - 1)
    );
  }
  return false;
}

function classifyCell(room: RoomState, x: number, y: number, z: number): number {
  if (!inRoomBounds(room, x, y, z)) return 0;
  if (isViewerCeilingCutaway(room, y)) return 0;

  // Clean diorama cutaway: completely cull South/East walls above knee-height curb (zero milky foreground walls!)
  if (x === room.roomW - 1 || z === room.roomD - 1) {
    const curbTop = getSouthEastCurbTopY(room, x, z);
    if (y > curbTop) return 0;
    if (y === curbTop) return CODE_DIORAMA_CAP;
  }

  const val = room.grid[cellIndex(x, y, z)];
  const mat = getMat(val);
  if (!isSolidMat(mat)) return 0;

  if (mat === MAT.GLASS_VAT) {
    return getTempByte(val) <= TEMP_BYTE.EMBRITTLED ? 101 : 102;
  }

  if (mat === MAT.BOUNDARY_HULL) {
    if (y === 0) return CODE_WALL_DARK;
    const floorBase = room.roomH >= 64 ? 12 : 2;
    if (y <= floorBase + 5 || y >= room.roomH - 8) return CODE_WALL_DARK;
    if (y === floorBase + 6 || y === floorBase + 7) return CODE_WALL_STRIPE;
    const along = x === 0 ? z : x;
    if (along % 32 < 3) return CODE_WALL_DARK;
    return CODE_WALL_PANEL;
  }

  if (mat === MAT.HULL_STEEL) {
    if (isHullDropLedge(room, x, y, z)) return CODE_HAZARD_LEDGE;
    if (isHullStairStep(room, x, y, z)) return CODE_STAIR_STEEL;
    if (room.roomH >= 64 && y <= 2) return CODE_PIT_STEEL;
    if (y >= 16) return CODE_UPPER_STEEL;
    return MAT.HULL_STEEL;
  }

  return mat;
}

function codeBucket(code: number): SolidBucketId {
  if (code === MAT.STEEL_GRATE) return SOLID_BUCKET.GRATE;
  if (code === MAT.ICE || code === 101 || code === 102) {
    return SOLID_BUCKET.TRANSPARENT;
  }
  return SOLID_BUCKET.OPAQUE;
}

function isOpaqueCode(code: number): boolean {
  return code !== 0 && codeBucket(code) === SOLID_BUCKET.OPAQUE;
}

function isAoOccluder(room: RoomState, x: number, y: number, z: number): number {
  return isOpaqueCode(classifyCell(room, x, y, z)) ? 1 : 0;
}

function computeCornerAo(
  room: RoomState,
  nx: number,
  ny: number,
  nz: number,
  dux: number,
  duy: number,
  duz: number,
  dvx: number,
  dvy: number,
  dvz: number,
): number {
  const s1 = isAoOccluder(room, nx + dux, ny + duy, nz + duz);
  const s2 = isAoOccluder(room, nx + dvx, ny + dvy, nz + dvz);
  if (s1 && s2) return 0;
  const c = isAoOccluder(room, nx + dux + dvx, ny + duy + dvy, nz + duz + dvz);
  return 3 - (s1 + s2 + c);
}

function codeRGBA(code: number): [number, number, number, number] {
  if (code === 101) return [0.55, 0.96, 1.0, 0.34]; // CRYO vat frosted glass
  if (code === 102) return [0.65, 0.94, 0.88, 0.28]; // Ambient vat glass
  if (code === MAT.ICE) return [0.6, 0.91, 1.0, 0.78];

  if (code === CODE_DIORAMA_CAP) return [0.09, 0.12, 0.18, 1.0];
  if (code === CODE_HAZARD_LEDGE) return [0.92, 0.72, 0.14, 1.0]; // AO-invariant ratio r/b > 3.6 -> caution stripes
  if (code === CODE_WALL_STRIPE) return [0.18, 0.38, 0.46, 1.0];
  if (code === CODE_PIT_STEEL) return [0.17, 0.21, 0.28, 1.0];
  if (code === CODE_STAIR_STEEL) return [0.38, 0.44, 0.54, 1.0];
  if (code === CODE_UPPER_STEEL) return [0.39, 0.46, 0.57, 1.0];
  if (code === CODE_WALL_DARK) return [0.16, 0.20, 0.27, 1.0];
  if (code === CODE_WALL_PANEL) return [0.24, 0.29, 0.37, 1.0];

  const hex = MATERIAL_SPEC[code]?.colorHex ?? 0x808080;
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, 1.0];
}

function emitQuad(
  acc: BucketAccumulator,
  hasAlpha: boolean,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  x3: number,
  y3: number,
  z3: number,
  nx: number,
  ny: number,
  nz: number,
  r: number,
  g: number,
  b: number,
  a: number,
  ao0: number,
  ao1: number,
  ao2: number,
  ao3: number,
  flipWinding: boolean,
): void {
  const base = acc.vertexCount;
  acc.positions.push(
    x0 * VOXEL_SIZE_M, y0 * VOXEL_SIZE_M, z0 * VOXEL_SIZE_M,
    x1 * VOXEL_SIZE_M, y1 * VOXEL_SIZE_M, z1 * VOXEL_SIZE_M,
    x2 * VOXEL_SIZE_M, y2 * VOXEL_SIZE_M, z2 * VOXEL_SIZE_M,
    x3 * VOXEL_SIZE_M, y3 * VOXEL_SIZE_M, z3 * VOXEL_SIZE_M,
  );
  acc.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);

  const l0 = AO_CURVE[ao0];
  const l1 = AO_CURVE[ao1];
  const l2 = AO_CURVE[ao2];
  const l3 = AO_CURVE[ao3];

  if (hasAlpha) {
    acc.colors.push(
      r * l0, g * l0, b * l0, a,
      r * l1, g * l1, b * l1, a,
      r * l2, g * l2, b * l2, a,
      r * l3, g * l3, b * l3, a,
    );
  } else {
    acc.colors.push(
      r * l0, g * l0, b * l0,
      r * l1, g * l1, b * l1,
      r * l2, g * l2, b * l2,
      r * l3, g * l3, b * l3,
    );
  }

  const flipDiag = ao1 + ao3 > ao0 + ao2;
  if (flipWinding) {
    if (flipDiag) {
      acc.indices.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
    } else {
      acc.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  } else {
    if (flipDiag) {
      acc.indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
    } else {
      acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  acc.vertexCount += 4;
}

export interface ChunkMeshResult {
  geometries: [THREE.BufferGeometry | null, THREE.BufferGeometry | null, THREE.BufferGeometry | null];
  vertexCounts: [number, number, number];
  indexCounts: [number, number, number];
}

/**
 * Greedy meshes a single 16^3 chunk in chunk-local meters [0..1.6]
 * into the 3 canonical solid BatchedMesh buckets with baked 4-corner Voxel AO
 * and automatic elevation/ledge architectural styling.
 */
export function buildChunkSolidMeshes(
  room: RoomState,
  cx: number,
  cy: number,
  cz: number,
): ChunkMeshResult {
  resetAcc(bucketAccs[0]);
  resetAcc(bucketAccs[1]);
  resetAcc(bucketAccs[2]);

  const ox = cx * CHUNK_SIZE;
  const oy = cy * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  const dims = [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE];
  const xLocal = [0, 0, 0];
  const q = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const euX = u === 0 ? 1 : 0;
    const euY = u === 1 ? 1 : 0;
    const euZ = u === 2 ? 1 : 0;
    const evX = v === 0 ? 1 : 0;
    const evY = v === 1 ? 1 : 0;
    const evZ = v === 2 ? 1 : 0;

    for (let dirSign = 1; dirSign >= -1; dirSign -= 2) {
      q[0] = 0;
      q[1] = 0;
      q[2] = 0;
      q[d] = dirSign;

      for (let slice = 0; slice < dims[d]; slice++) {
        let n = 0;
        let hasAny = false;
        xLocal[d] = slice;

        for (let j = 0; j < dims[v]; j++) {
          xLocal[v] = j;
          for (let i = 0; i < dims[u]; i++) {
            xLocal[u] = i;
            const wx = ox + xLocal[0];
            const wy = oy + xLocal[1];
            const wz = oz + xLocal[2];
            const aCode = classifyCell(room, wx, wy, wz);
            if (aCode === 0) {
              maskScratch[n++] = 0;
              continue;
            }
            const nx = wx + q[0];
            const ny = wy + q[1];
            const nz = wz + q[2];
            const bCode = classifyCell(room, nx, ny, nz);

            let visible = false;
            if (bCode === 0) {
              visible = true;
            } else if (aCode === bCode) {
              visible = false;
            } else if (!isOpaqueCode(bCode)) {
              visible = true;
            }

            if (visible) {
              let aoBits = 0xff;
              if (codeBucket(aCode) !== SOLID_BUCKET.TRANSPARENT) {
                const ao0 = computeCornerAo(room, nx, ny, nz, -euX, -euY, -euZ, -evX, -evY, -evZ);
                const ao1 = computeCornerAo(room, nx, ny, nz, euX, euY, euZ, -evX, -evY, -evZ);
                const ao2 = computeCornerAo(room, nx, ny, nz, euX, euY, euZ, evX, evY, evZ);
                const ao3 = computeCornerAo(room, nx, ny, nz, -euX, -euY, -euZ, evX, evY, evZ);
                aoBits = ao0 | (ao1 << 2) | (ao2 << 4) | (ao3 << 6);
              }
              maskScratch[n++] = (aCode << 8) | aoBits;
              hasAny = true;
            } else {
              maskScratch[n++] = 0;
            }
          }
        }

        if (!hasAny) continue;

        n = 0;
        for (let j = 0; j < dims[v]; j++) {
          for (let i = 0; i < dims[u]; ) {
            const key = maskScratch[n];
            if (key === 0) {
              i++;
              n++;
              continue;
            }

            const code = key >>> 8;
            const ao0 = key & 3;
            const ao1 = (key >>> 2) & 3;
            const ao2 = (key >>> 4) & 3;
            const ao3 = (key >>> 6) & 3;

            const canMergeU = ao0 === ao1 && ao3 === ao2;
            const canMergeV = ao0 === ao3 && ao1 === ao2;

            let w = 1;
            if (canMergeU) {
              while (i + w < dims[u] && maskScratch[n + w] === key) w++;
            }

            let h = 1;
            if (canMergeV) {
              let done = false;
              while (j + h < dims[v]) {
                for (let k = 0; k < w; k++) {
                  if (maskScratch[n + k + h * dims[u]] !== key) {
                    done = true;
                    break;
                  }
                }
                if (done) break;
                h++;
              }
            }

            for (let l = 0; l < h; l++) {
              for (let k = 0; k < w; k++) {
                maskScratch[n + k + l * dims[u]] = 0;
              }
            }

            const p = [0, 0, 0];
            p[d] = dirSign > 0 ? slice + 1 : slice;
            p[u] = i;
            p[v] = j;

            const du = [0, 0, 0];
            du[u] = w;
            const dv = [0, 0, 0];
            dv[v] = h;

            const bucket = codeBucket(code);
            const acc = bucketAccs[bucket];
            const [r, g, b, a] = codeRGBA(code);
            const hasAlpha = bucket === SOLID_BUCKET.TRANSPARENT;

            emitQuad(
              acc,
              hasAlpha,
              p[0], p[1], p[2],
              p[0] + du[0], p[1] + du[1], p[2] + du[2],
              p[0] + du[0] + dv[0], p[1] + du[1] + dv[1], p[2] + du[2] + dv[2],
              p[0] + dv[0], p[1] + dv[1], p[2] + dv[2],
              q[0], q[1], q[2],
              r, g, b, a,
              ao0, ao1, ao2, ao3,
              dirSign < 0,
            );

            i += w;
            n += w;
          }
        }
      }
    }
  }

  const geometries: [
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
  ] = [null, null, null];
  const vertexCounts: [number, number, number] = [0, 0, 0];
  const indexCounts: [number, number, number] = [0, 0, 0];

  for (let b = 0; b < 3; b++) {
    const acc = bucketAccs[b];
    if (acc.vertexCount === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(acc.normals, 3));
    const colorStride = b === SOLID_BUCKET.TRANSPARENT ? 4 : 3;
    geo.setAttribute('color', new THREE.Float32BufferAttribute(acc.colors, colorStride));
    geo.setIndex(acc.indices);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    geometries[b] = geo;
    vertexCounts[b] = acc.vertexCount;
    indexCounts[b] = acc.indices.length;
  }

  return { geometries, vertexCounts, indexCounts };
}
