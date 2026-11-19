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

function isViewerCeilingCutaway(room: RoomState, y: number): boolean {
  return y >= room.roomH - 2;
}

function isSouthEastUpperCutaway(room: RoomState, x: number, y: number, z: number): boolean {
  return (x === room.roomW - 1 || z === room.roomD - 1) && y >= 8 && y < room.roomH - 2;
}

function classifyCell(room: RoomState, x: number, y: number, z: number): number {
  if (!inRoomBounds(room, x, y, z)) return 0;
  if (isViewerCeilingCutaway(room, y)) return 0;
  const val = room.grid[cellIndex(x, y, z)];
  const mat = getMat(val);
  if (!isSolidMat(mat)) return 0;

  if (isSouthEastUpperCutaway(room, x, y, z)) {
    // Pack into transparent bucket with special cutaway tag (code 100)
    return 100;
  }
  if (mat === MAT.GLASS_VAT) {
    // Distinguish CRYO-chilled vat glass (code 101) from ambient glass (code 102)
    return getTempByte(val) <= TEMP_BYTE.EMBRITTLED ? 101 : 102;
  }
  return mat;
}

function codeBucket(code: number): SolidBucketId {
  if (code === MAT.STEEL_GRATE) return SOLID_BUCKET.GRATE;
  if (code === MAT.ICE || code === 100 || code === 101 || code === 102) {
    return SOLID_BUCKET.TRANSPARENT;
  }
  return SOLID_BUCKET.OPAQUE;
}

function isOpaqueCode(code: number): boolean {
  return code !== 0 && codeBucket(code) === SOLID_BUCKET.OPAQUE;
}

function codeRGBA(code: number): [number, number, number, number] {
  if (code === 100) return [0.32, 0.38, 0.48, 0.15]; // South/East bulkhead 0.15 opacity (§5)
  if (code === 101) return [0.55, 0.96, 1.0, 0.34]; // CRYO vat frosted glass
  if (code === 102) return [0.65, 0.94, 0.88, 0.28]; // Ambient vat glass
  if (code === MAT.ICE) return [0.6, 0.91, 1.0, 0.78];

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
  if (hasAlpha) {
    acc.colors.push(r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a);
  } else {
    acc.colors.push(r, g, b, r, g, b, r, g, b, r, g, b);
  }

  if (flipWinding) {
    acc.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  } else {
    acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
 * into the 3 canonical solid BatchedMesh buckets (ignoring damage bits).
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

  // Sweep 3 axes, 2 directions (+1 and -1) per axis
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    for (let dirSign = 1; dirSign >= -1; dirSign -= 2) {
      q[0] = 0;
      q[1] = 0;
      q[2] = 0;
      q[d] = dirSign;

      for (let slice = 0; slice < dims[d]; slice++) {
        // Fill 16x16 face visibility mask
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
            const bCode = classifyCell(room, wx + q[0], wy + q[1], wz + q[2]);

            // Face is visible if neighbor doesn't occlude it
            let visible = false;
            if (bCode === 0) {
              visible = true;
            } else if (aCode === bCode) {
              visible = false;
            } else if (!isOpaqueCode(bCode)) {
              visible = true;
            }

            if (visible) {
              maskScratch[n++] = aCode;
              hasAny = true;
            } else {
              maskScratch[n++] = 0;
            }
          }
        }

        if (!hasAny) continue;

        // Greedy rectangle merge across the 16x16 mask
        n = 0;
        for (let j = 0; j < dims[v]; j++) {
          for (let i = 0; i < dims[u]; ) {
            const code = maskScratch[n];
            if (code === 0) {
              i++;
              n++;
              continue;
            }

            let w = 1;
            while (i + w < dims[u] && maskScratch[n + w] === code) w++;

            let h = 1;
            let done = false;
            while (j + h < dims[v]) {
              for (let k = 0; k < w; k++) {
                if (maskScratch[n + k + h * dims[u]] !== code) {
                  done = true;
                  break;
                }
              }
              if (done) break;
              h++;
            }

            // Clear merged region
            for (let l = 0; l < h; l++) {
              for (let k = 0; k < w; k++) {
                maskScratch[n + k + l * dims[u]] = 0;
              }
            }

            // Emit quad in chunk-local voxel coordinates
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

            // Right-handed outward winding: (u x v) == +d for cyclic (d, u, v)
            emitQuad(
              acc,
              hasAlpha,
              p[0], p[1], p[2],
              p[0] + du[0], p[1] + du[1], p[2] + du[2],
              p[0] + du[0] + dv[0], p[1] + du[1] + dv[1], p[2] + du[2] + dv[2],
              p[0] + dv[0], p[1] + dv[1], p[2] + dv[2],
              q[0], q[1], q[2],
              r, g, b, a,
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
