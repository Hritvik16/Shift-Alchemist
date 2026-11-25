import { applyStructuralDamage } from './types.ts';
import {
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  FIXED_DT,
  FUSE_TICKS,
  GRATE_MAX_RUN,
  GRAVITY_ACCEL_BY_MODE,
  GRAVITY_MODE,
  LIFT_0G_DRAG,
  LIFT_0G_STOP_SPEED,
  LIFT_0G_TICKS,
  MAT,
  MATERIAL_SPEC,
  MAX_ACTIVE_BALLISTIC,
  MAX_ACTIVE_GRID_FLUID,
  MAX_DEFERRED_FLUID,
  MAX_PRIMED_QUANTA,
  SLICE_STRIDE,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type MaterialId,
} from './balance.ts';
import { applyEntityStun } from './ai.ts';
import { triggerConduitWaterImpact, triggerElectricalPulseAt } from './electricity.ts';
import { hash32 } from './hash.ts';
import {
  BALLISTIC_FLAG,
  cellIndex,
  getMat,
  getShimmer,
  getSlideDir,
  getStepped,
  getTempByte,
  getTimerOrCharge,
  inRoomBounds,
  isBallisticAllowedMat,
  isFluidOrGasMat,
  isGasOrPlasmaMat,
  isLiquidMat,
  isSolidMat,
  isThermalSolidActiveEligible,
  moveCell,
  packVoxel,
  pushCombatEvent,
  queuePhaseExplosion,
  swapCells,
  transitionCell,
  wake26Neighbors,
  wakeCell,
  writeCell,
  type RoomState,
  type SerializedBallisticRecord,
} from './types.ts';
import { getEffectiveMassKg, type Entity, type WorldState } from './world.ts';

const BFS_MAX_RADIUS = 12;
const BFS_BOX_SPAN = BFS_MAX_RADIUS * 2 + 1; // 25
const BFS_BOX_VOL = BFS_BOX_SPAN * BFS_BOX_SPAN * BFS_BOX_SPAN; // 15,625
const bfsStampBuf = new Uint32Array(BFS_BOX_VOL);
const bfsQueueX = new Int16Array(BFS_BOX_VOL);
const bfsQueueY = new Int16Array(BFS_BOX_VOL);
const bfsQueueZ = new Int16Array(BFS_BOX_VOL);
const bfsQueueD = new Uint8Array(BFS_BOX_VOL);
let bfsEpoch = 1;

const subPassBufA = new Int32Array(MAX_ACTIVE_GRID_FLUID);
const subPassBufB = new Int32Array(MAX_ACTIVE_GRID_FLUID);

const centroidSumX = new Float32Array(TOTAL_CHUNKS * 4);
const centroidSumY = new Float32Array(TOTAL_CHUNKS * 4);
const centroidSumZ = new Float32Array(TOTAL_CHUNKS * 4);
const centroidCount = new Uint16Array(TOTAL_CHUNKS * 4);
const touchedCentroidSlots = new Int32Array(TOTAL_CHUNKS * 4);

const SLIDE_DX = [1, -1, 0, 0] as const;
const SLIDE_DZ = [0, 0, 1, -1] as const;
const DIR8_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DIR8_DZ = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const SLIDE_TO_DIR8 = [0, 4, 2, 6] as const;
const DIR8_TO_SLIDE = [0, 0, 2, 1, 1, 1, 3, 0] as const;
const FACE_DX = [1, -1, 0, 0, 0, 0] as const;
const FACE_DY = [0, 0, 1, -1, 0, 0] as const;
const FACE_DZ = [0, 0, 0, 0, 1, -1] as const;

function fireHasAdjacentFuelOrFloor(room: RoomState, x: number, y: number, z: number): boolean {
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  const isFuel = (m: number): boolean => m === MAT.OIL || m === MAT.WOOD_BARRIER;
  if (y > 0 && isSolidMat(getMat(g[idx - SLICE_STRIDE]))) return true;
  if (x > 0 && isFuel(getMat(g[idx - 1]))) return true;
  if (x + 1 < room.roomW && isFuel(getMat(g[idx + 1]))) return true;
  if (z > 0 && isFuel(getMat(g[idx - ARENA_W]))) return true;
  if (z + 1 < room.roomD && isFuel(getMat(g[idx + ARENA_W]))) return true;
  if (y > 0 && isFuel(getMat(g[idx - SLICE_STRIDE]))) return true;
  if (y + 1 < room.roomH && isFuel(getMat(g[idx + SLICE_STRIDE]))) return true;
  return false;
}

function liquidCentroidBucket(mat: number): number {
  if (mat === MAT.WATER) return 0;
  if (mat === MAT.OIL) return 1;
  if (mat === MAT.CRYO) return 2;
  if (mat === MAT.ACID) return 3;
  return -1;
}

export function voxelOverlapsEntity(
  e: Entity,
  vx: number,
  vy: number,
  vz: number,
): boolean {
  const minX = vx * VOXEL_SIZE_M;
  const maxX = minX + VOXEL_SIZE_M;
  const minY = vy * VOXEL_SIZE_M;
  const maxY = minY + VOXEL_SIZE_M;
  const minZ = vz * VOXEL_SIZE_M;
  const maxZ = minZ + VOXEL_SIZE_M;
  return (
    maxX > e.x - e.halfW &&
    minX < e.x + e.halfW &&
    maxY > e.y &&
    minY < e.y + e.height &&
    maxZ > e.z - e.halfD &&
    minZ < e.z + e.halfD
  );
}

function pointInsideEntity(e: Entity, x: number, y: number, z: number): boolean {
  return (
    x >= e.x - e.halfW &&
    x <= e.x + e.halfW &&
    y >= e.y &&
    y <= e.y + e.height &&
    z >= e.z - e.halfD &&
    z <= e.z + e.halfD
  );
}

export function spawnBallistic(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  packedVoxel: number,
  flags = 0,
  fuseTicks = 0,
): number {
  const bp = room.ballistic;
  if (bp.count >= MAX_ACTIVE_BALLISTIC) return -1;
  const mat = getMat(packedVoxel);
  if (!isBallisticAllowedMat(mat)) return -1;

  let slot = -1;
  let cursor = bp.freeScanCursor;
  for (let n = 0; n < MAX_ACTIVE_BALLISTIC; n++) {
    if (bp.active[cursor] === 0) {
      slot = cursor;
      bp.freeScanCursor = (cursor + 1) % MAX_ACTIVE_BALLISTIC;
      break;
    }
    cursor = (cursor + 1) % MAX_ACTIVE_BALLISTIC;
  }
  if (slot === -1) return -1;

  bp.active[slot] = 1;
  bp.x[slot] = x;
  bp.y[slot] = y;
  bp.z[slot] = z;
  bp.vx[slot] = vx;
  bp.vy[slot] = vy;
  bp.vz[slot] = vz;
  bp.packedVoxel[slot] = (packedVoxel & ~(1 << 22)) >>> 0;
  bp.flightTicks[slot] = 0;
  bp.fuseTicks[slot] = fuseTicks;
  bp.flags[slot] = flags;
  bp.count++;
  return slot;
}

export function deactivateBallistic(room: RoomState, slot: number): void {
  const bp = room.ballistic;
  if (bp.active[slot] === 0) return;
  bp.active[slot] = 0;
  bp.count--;
}

export function enqueueDeferredFluid(
  room: RoomState,
  mat: MaterialId,
  tempByte: number,
  chargeUnits: number,
  targetX: number,
  targetY: number,
  targetZ: number,
): boolean {
  const dq = room.deferredFluid;
  if (dq.count >= MAX_DEFERRED_FLUID) return false;
  const idx = dq.tail;
  dq.mat[idx] = mat;
  dq.tempByte[idx] = tempByte & 0xff;
  dq.chargeUnits[idx] = chargeUnits & 0x3f;
  dq.targetX[idx] = targetX;
  dq.targetY[idx] = targetY;
  dq.targetZ[idx] = targetZ;
  dq.tail = (idx + 1) % MAX_DEFERRED_FLUID;
  dq.count++;
  return true;
}

function canPlaceAtCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  mat: MaterialId,
  avoidEntity: Entity | null,
  requireOutsideEntity: boolean,
): boolean {
  if (!inRoomBounds(room, x, y, z)) return false;
  if (getMat(room.grid[cellIndex(x, y, z)]) !== MAT.AIR) return false;
  if (avoidEntity && (requireOutsideEntity || mat === MAT.ICE)) {
    if (voxelOverlapsEntity(avoidEntity, x, y, z)) return false;
  }
  return true;
}

function commitGridFluid(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  mat: MaterialId,
  tempByte: number,
  chargeUnits: number,
  simTick: number,
): void {
  const idx = cellIndex(x, y, z);
  const shimmer = hash32(room.roomSeed, 0, idx) & 7;
  const slideDir = isLiquidMat(mat) ? hash32(room.roomSeed, simTick, idx) & 3 : 0;
  const timer = mat === MAT.STEAM ? 45 : mat === MAT.FIRE ? 54 : chargeUnits & 0x3f;
  const val = packVoxel(mat, tempByte, timer, 0, shimmer, slideDir, 0);
  writeCell(room, x, y, z, val, simTick);
}

/**
 * Total off-grid -> grid placement helper (§3.2):
 * (1) target cell -> radius-2 spiral -> expanding Manhattan-shell BFS r=3..12 outside entity AABB
 * (2) promote to ballisticQuanta (v=0) if allowBallisticFallback
 * (3) append to deferredFluidQueue
 * Returns false if all capacity is exhausted without deleting any liter.
 */
export function placeOrDeferFluid(
  room: RoomState,
  mat: MaterialId,
  tempByte: number,
  chargeUnits: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  allowBallisticFallback: boolean,
  avoidEntity: Entity | null,
  simTick = 1,
): boolean {
  const tx = Math.max(1, Math.min(room.roomW - 2, targetX | 0));
  const ty = Math.max(1, Math.min(room.roomH - 2, targetY | 0));
  const tz = Math.max(1, Math.min(room.roomD - 2, targetZ | 0));

  // Step 1a: Exact target cell
  if (canPlaceAtCell(room, tx, ty, tz, mat, avoidEntity, false)) {
    commitGridFluid(room, tx, ty, tz, mat, tempByte, chargeUnits, simTick);
    return true;
  }

  // Step 1b: Radius-2 spiral around target
  for (let r = 1; r <= 2; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const y = ty + dy;
      if (y < 1 || y >= room.roomH - 1) continue;
      for (let dz = -r; dz <= r; dz++) {
        const z = tz + dz;
        if (z < 1 || z >= room.roomD - 1) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const x = tx + dx;
          if (x < 1 || x >= room.roomW - 1) continue;
          if (canPlaceAtCell(room, x, y, z, mat, avoidEntity, false)) {
            commitGridFluid(room, x, y, z, mat, tempByte, chargeUnits, simTick);
            return true;
          }
        }
      }
    }
  }

  // Step 1c: Expanding Manhattan-shell BFS r=3..12 outside entity AABB
  bfsEpoch++;
  if (bfsEpoch === 0xffffffff) {
    bfsStampBuf.fill(0);
    bfsEpoch = 1;
  }
  const epoch = bfsEpoch;
  let qHead = 0;
  let qTail = 0;
  const centerIdx =
    BFS_MAX_RADIUS * BFS_BOX_SPAN * BFS_BOX_SPAN +
    BFS_MAX_RADIUS * BFS_BOX_SPAN +
    BFS_MAX_RADIUS;
  bfsStampBuf[centerIdx] = epoch;
  bfsQueueX[qTail] = 0;
  bfsQueueY[qTail] = 0;
  bfsQueueZ[qTail] = 0;
  bfsQueueD[qTail] = 0;
  qTail++;

  while (qHead < qTail) {
    const ox = bfsQueueX[qHead];
    const oy = bfsQueueY[qHead];
    const oz = bfsQueueZ[qHead];
    const dist = bfsQueueD[qHead];
    qHead++;

    if (dist >= 3) {
      const wx = tx + ox;
      const wy = ty + oy;
      const wz = tz + oz;
      if (canPlaceAtCell(room, wx, wy, wz, mat, avoidEntity, true)) {
        commitGridFluid(room, wx, wy, wz, mat, tempByte, chargeUnits, simTick);
        return true;
      }
    }

    if (dist >= BFS_MAX_RADIUS) continue;
    const nd = dist + 1;
    for (let f = 0; f < 6; f++) {
      const nx = ox + FACE_DX[f];
      const ny = oy + FACE_DY[f];
      const nz = oz + FACE_DZ[f];
      if (
        nx < -BFS_MAX_RADIUS ||
        nx > BFS_MAX_RADIUS ||
        ny < -BFS_MAX_RADIUS ||
        ny > BFS_MAX_RADIUS ||
        nz < -BFS_MAX_RADIUS ||
        nz > BFS_MAX_RADIUS
      ) {
        continue;
      }
      const wx = tx + nx;
      const wy = ty + ny;
      const wz = tz + nz;
      if (wx < 1 || wx >= room.roomW - 1 || wy < 1 || wy >= room.roomH - 1 || wz < 1 || wz >= room.roomD - 1) {
        continue;
      }
      const localIdx =
        (ny + BFS_MAX_RADIUS) * BFS_BOX_SPAN * BFS_BOX_SPAN +
        (nz + BFS_MAX_RADIUS) * BFS_BOX_SPAN +
        (nx + BFS_MAX_RADIUS);
      if (bfsStampBuf[localIdx] === epoch) continue;
      bfsStampBuf[localIdx] = epoch;
      bfsQueueX[qTail] = nx;
      bfsQueueY[qTail] = ny;
      bfsQueueZ[qTail] = nz;
      bfsQueueD[qTail] = nd;
      qTail++;
    }
  }

  // Step 2: Ballistic promotion fallback (tank/gland/emitter only; never for already-ballistic)
  if (allowBallisticFallback && isBallisticAllowedMat(mat)) {
    const packed = packVoxel(mat, tempByte, chargeUnits, 0, hash32(room.roomSeed, simTick, tx + ty * 256 + tz * 65536) & 7, 0, 0);
    const slot = spawnBallistic(
      room,
      (tx + 0.5) * VOXEL_SIZE_M,
      (ty + 0.5) * VOXEL_SIZE_M,
      (tz + 0.5) * VOXEL_SIZE_M,
      0,
      0,
      0,
      packed,
    );
    if (slot !== -1) return true;
  }

  // Step 3: Append to deferredFluidQueue
  return enqueueDeferredFluid(room, mat, tempByte, chargeUnits, tx, ty, tz);
}

/**
 * Canonical 26-neighbor N_same count in 3x3x3 excluding center and vacated origin cell (§6.3).
 */
export function countNSame(
  room: RoomState,
  cx: number,
  cy: number,
  cz: number,
  mat: MaterialId,
  excludeX: number,
  excludeY: number,
  excludeZ: number,
): number {
  const g = room.grid;
  const x0 = cx > 0 ? cx - 1 : 0;
  const x1 = cx + 1 < room.roomW ? cx + 1 : room.roomW - 1;
  const y0 = cy > 0 ? cy - 1 : 0;
  const y1 = cy + 1 < room.roomH ? cy + 1 : room.roomH - 1;
  const z0 = cz > 0 ? cz - 1 : 0;
  const z1 = cz + 1 < room.roomD ? cz + 1 : room.roomD - 1;
  let count = 0;

  for (let y = y0; y <= y1; y++) {
    const yOff = y * SLICE_STRIDE;
    for (let z = z0; z <= z1; z++) {
      const row = yOff + z * ARENA_W;
      for (let x = x0; x <= x1; x++) {
        if (x === cx && y === cy && z === cz) continue;
        if (x === excludeX && y === excludeY && z === excludeZ) continue;
        if (getMat(g[row + x]) === mat) count++;
      }
    }
  }
  return count;
}

function cryoHasSolidWarmingContact(room: RoomState, x: number, y: number, z: number): boolean {
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  const check = (nIdx: number): boolean => {
    const m = getMat(g[nIdx]);
    return (
      m === MAT.HULL_STEEL ||
      m === MAT.STEEL_GRATE ||
      m === MAT.ICE ||
      m === MAT.WOOD_BARRIER
    );
  };
  if (x > 0 && check(idx - 1)) return true;
  if (x + 1 < room.roomW && check(idx + 1)) return true;
  if (z > 0 && check(idx - ARENA_W)) return true;
  if (z + 1 < room.roomD && check(idx + ARENA_W)) return true;
  if (y > 0 && check(idx - SLICE_STRIDE)) return true;
  if (y + 1 < room.roomH && check(idx + SLICE_STRIDE)) return true;
  return false;
}

function cryoIsFloatingZeroG(room: RoomState, x: number, y: number, z: number): boolean {
  if (room.gravityMode !== GRAVITY_MODE.G0) return false;
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  if (x > 0 && isSolidMat(getMat(g[idx - 1]))) return false;
  if (x + 1 < room.roomW && isSolidMat(getMat(g[idx + 1]))) return false;
  if (z > 0 && isSolidMat(getMat(g[idx - ARENA_W]))) return false;
  if (z + 1 < room.roomD && isSolidMat(getMat(g[idx + ARENA_W]))) return false;
  if (y > 0 && isSolidMat(getMat(g[idx - SLICE_STRIDE]))) return false;
  if (y + 1 < room.roomH && isSolidMat(getMat(g[idx + SLICE_STRIDE]))) return false;
  return true;
}

function cryoHasAnyActiveWarmingPath(room: RoomState, x: number, y: number, z: number): boolean {
  if (cryoHasSolidWarmingContact(room, x, y, z)) return true;
  if (cryoIsFloatingZeroG(room, x, y, z)) return true;
  return false;
}

function cellShouldStayAwake(room: RoomState, x: number, y: number, z: number, val: number): boolean {
  const mat = getMat(val);
  if (mat === MAT.FIRE || mat === MAT.STEAM) return true;
  if (getTimerOrCharge(val) > 0) return true;
  if (mat === MAT.CRYO) return cryoHasAnyActiveWarmingPath(room, x, y, z);
  if (mat === MAT.WATER || mat === MAT.OIL || mat === MAT.ACID) {
    return getTempByte(val) !== TEMP_BYTE.AMBIENT;
  }
  return false;
}

/**
 * Room-Load Active-List Re-Seed (§4.2 step 3.5):
 * Wakes every fluid/gas cell 6-adjacent to AIR, STEEL_GRATE, or a different fluid/gas phase,
 * every FIRE/STEAM cell, every CRYO cell with an active warming path, and every eligible thermal solid.
 * Sealed, fully-filled single-material vat interiors remain asleep (0 simulation CPU).
 */
export function reseedActiveLists(room: RoomState, simTick = 1): void {
  const g = room.grid;
  const W = room.roomW;
  const H = room.roomH;
  const D = room.roomD;

  for (let y = 1; y < H - 1; y++) {
    const yOff = y * SLICE_STRIDE;
    for (let z = 1; z < D - 1; z++) {
      const row = yOff + z * ARENA_W;
      for (let x = 1; x < W - 1; x++) {
        const idx = row + x;
        const val = g[idx];
        const mat = getMat(val);
        if (mat === MAT.AIR || mat === MAT.BOUNDARY_HULL || mat === MAT.GLASS_VAT) continue;

        if (isFluidOrGasMat(mat)) {
          if (mat === MAT.FIRE || mat === MAT.STEAM || getTimerOrCharge(val) > 0) {
            wakeCell(room, x, y, z, simTick);
            continue;
          }
          if (mat === MAT.CRYO && cryoHasAnyActiveWarmingPath(room, x, y, z)) {
            wakeCell(room, x, y, z, simTick);
            continue;
          }
          let exposed = false;
          for (let f = 0; f < 6; f++) {
            const nm = getMat(g[cellIndex(x + FACE_DX[f], y + FACE_DY[f], z + FACE_DZ[f])]);
            if (nm === MAT.AIR || nm === MAT.STEEL_GRATE || (isFluidOrGasMat(nm) && nm !== mat)) {
              exposed = true;
              break;
            }
          }
          if (exposed) {
            wakeCell(room, x, y, z, simTick);
          }
        } else if (isThermalSolidActiveEligible(room, x, y, z, val)) {
          wakeCell(room, x, y, z, simTick);
        }
      }
    }
  }
}

/**
 * Vat Shatter radial promotion (§6.2):
 * Breaking a GLASS_VAT voxel promotes up to 32 exposed adjacent fluid cells within 0.8 m
 * at 3.0-5.0 m/s outward + hash32 jitter, and wakes all newly exposed interior fluid cells.
 */
export function processPendingVatShatters(world: WorldState): void {
  const room = world.room;
  if (room.pendingVatShatters.length === 0) return;

  // Per-vat 32-cell promotion cap within spec 0.8 m (r = 8 voxels) (§6.2)
  const promotedByVat = new Int32Array(Math.max(1, room.vats.length + 1));
  const maxPromotionsPerVat = 32;

  for (let s = 0; s < room.pendingVatShatters.length; s++) {
    const breakIdx = room.pendingVatShatters[s];
    const by = Math.floor(breakIdx / SLICE_STRIDE);
    const rem = breakIdx - by * SLICE_STRIDE;
    const bz = Math.floor(rem / ARENA_W);
    const bx = rem - bz * ARENA_W;

    let originX = bx;
    let originY = by;
    let originZ = bz;
    let vatSlot = room.vats.length;
    for (let v = 0; v < room.vats.length; v++) {
      const vat = room.vats[v];
      if (
        bx >= vat.minX && bx <= vat.maxX &&
        by >= vat.minY && by <= vat.maxY &&
        bz >= vat.minZ && bz <= vat.maxZ
      ) {
        originX = (vat.minX + vat.maxX) * 0.5;
        originY = (vat.minY + vat.maxY) * 0.5;
        originZ = (vat.minZ + vat.maxZ) * 0.5;
        vatSlot = v;
        break;
      }
    }

    const r = 8; // 0.8 m
    const rSq = r * r;
    for (let dy = -r; dy <= r; dy++) {
      const y = by + dy;
      if (y < 1 || y >= room.roomH - 1) continue;
      for (let dz = -r; dz <= r; dz++) {
        const z = bz + dz;
        if (z < 1 || z >= room.roomD - 1) continue;
        for (let dx = -r; dx <= r; dx++) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 === 0 || d2 > rSq) continue;
          const x = bx + dx;
          if (x < 1 || x >= room.roomW - 1) continue;
          const idx = cellIndex(x, y, z);
          const val = room.grid[idx];
          const mat = getMat(val);
          if (!isLiquidMat(mat)) continue;

          wakeCell(room, x, y, z, world.simTick);

          if (promotedByVat[vatSlot] >= maxPromotionsPerVat || room.ballistic.count >= MAX_ACTIVE_BALLISTIC) {
            continue;
          }

          let hasAirNeighbor = false;
          for (let f = 0; f < 6; f++) {
            const nx = x + FACE_DX[f];
            const ny = y + FACE_DY[f];
            const nz = z + FACE_DZ[f];
            if (inRoomBounds(room, nx, ny, nz) && getMat(room.grid[cellIndex(nx, ny, nz)]) === MAT.AIR) {
              hasAirNeighbor = true;
              break;
            }
          }
          if (!hasAirNeighbor) continue;

          const h = hash32(room.roomSeed, world.simTick, idx);
          let dirX = bx - originX;
          let dirY = Math.max(-0.4, Math.min(0.2, (by - originY) * 0.2));
          let dirZ = bz - originZ;
          const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
          if (len > 1e-4) {
            dirX /= len;
            dirY /= len;
            dirZ /= len;
          } else {
            dirX = 1;
            dirY = 0;
            dirZ = 0;
          }
          const speed = 3.0 + 1.6 * ((h & 1023) / 1023);
          const jx = (((h >>> 10) & 255) / 255 - 0.5) * 0.6;
          const jy = (((h >>> 18) & 255) / 255 - 0.5) * 0.4;
          const jz = (((h >>> 24) & 255) / 255 - 0.5) * 0.6;

          const slot = spawnBallistic(
            room,
            (x + 0.5) * VOXEL_SIZE_M,
            (y + 0.5) * VOXEL_SIZE_M,
            (z + 0.5) * VOXEL_SIZE_M,
            dirX * speed + jx,
            dirY * speed + jy,
            dirZ * speed + jz,
            val,
          );
          if (slot !== -1) {
            writeCell(room, x, y, z, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), world.simTick);
            wake26Neighbors(room, x, y, z, world.simTick);
            promotedByVat[vatSlot]++;
          }
        }
      }
    }
  }
  room.pendingVatShatters.length = 0;
}

function countAndDetonateOldestPrimedIfOverCap(world: WorldState): void {
  const bp = world.room.ballistic;
  let primedCount = 0;
  let oldestSlot = -1;
  let oldestFlight = -1;
  for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
    if (bp.active[i] === 0) continue;
    if ((bp.flags[i] & BALLISTIC_FLAG.PRIMED) === 0) continue;
    primedCount++;
    if (bp.flightTicks[i] > oldestFlight) {
      oldestFlight = bp.flightTicks[i];
      oldestSlot = i;
    }
  }
  if (primedCount >= MAX_PRIMED_QUANTA && oldestSlot >= 0) {
    const tx = Math.floor(bp.x[oldestSlot] / VOXEL_SIZE_M);
    const ty = Math.floor(bp.y[oldestSlot] / VOXEL_SIZE_M);
    const tz = Math.floor(bp.z[oldestSlot] / VOXEL_SIZE_M);
    applyBallisticImpactTransitionOrPlace(world, oldestSlot, tx, ty, tz, true);
  }
}

export function detonatePrimedInRadius(
  world: WorldState,
  cx: number,
  cy: number,
  cz: number,
  radiusM: number,
): void {
  const bp = world.room.ballistic;
  if (bp.count === 0) return;
  const rSq = radiusM * radiusM;
  for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
    if (bp.active[i] === 0) continue;
    if ((bp.flags[i] & BALLISTIC_FLAG.PRIMED) === 0) continue;
    const dx = bp.x[i] - cx;
    const dy = bp.y[i] - cy;
    const dz = bp.z[i] - cz;
    if (dx * dx + dy * dy + dz * dz <= rSq) {
      const tx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
      const ty = Math.floor(bp.y[i] / VOXEL_SIZE_M);
      const tz = Math.floor(bp.z[i] / VOXEL_SIZE_M);
      applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz, true);
    }
  }
}

function isPrimedNearFire(room: RoomState, vx: number, vy: number, vz: number): boolean {
  const g = room.grid;
  if (inRoomBounds(room, vx, vy, vz) && getMat(g[cellIndex(vx, vy, vz)]) === MAT.FIRE) return true;
  for (let f = 0; f < 6; f++) {
    const nx = vx + FACE_DX[f];
    const ny = vy + FACE_DY[f];
    const nz = vz + FACE_DZ[f];
    if (inRoomBounds(room, nx, ny, nz) && getMat(g[cellIndex(nx, ny, nz)]) === MAT.FIRE) {
      return true;
    }
  }
  return false;
}

function applyBallisticImpactTransitionOrPlace(
  world: WorldState,
  slot: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  forceDetonate = false,
): boolean {
  const room = world.room;
  const bp = room.ballistic;
  const val = bp.packedVoxel[slot];
  const mat = getMat(val);
  const temp = getTempByte(val);
  const charge = getTimerOrCharge(val);
  const flags = bp.flags[slot];
  const firedByPlayer = (flags & BALLISTIC_FLAG.FIRED_BY_PLAYER) !== 0;

  // Phase-Lock Fuse (Ranks 1-2, §9): prime reactive firedByPlayer quanta on impact instead of immediate transition
  const willTransition =
    (mat === MAT.OIL && temp >= TEMP_BYTE.OIL_IGNITE) ||
    (mat === MAT.WATER && temp >= TEMP_BYTE.BOIL) ||
    (mat === MAT.CRYO && temp >= TEMP_BYTE.FREEZE);
  if (
    !forceDetonate &&
    willTransition &&
    firedByPlayer &&
    world.fuseRank >= 1 &&
    (flags & BALLISTIC_FLAG.IGNITE_IN_FLIGHT) === 0 &&
    (flags & BALLISTIC_FLAG.PRIMED) === 0
  ) {
    countAndDetonateOldestPrimedIfOverCap(world);
    bp.flags[slot] |= BALLISTIC_FLAG.PRIMED;
    bp.fuseTicks[slot] = FUSE_TICKS[Math.min(2, world.fuseRank)];
    bp.x[slot] = (targetX + 0.5) * VOXEL_SIZE_M;
    bp.y[slot] = (targetY + 0.5) * VOXEL_SIZE_M;
    bp.z[slot] = (targetZ + 0.5) * VOXEL_SIZE_M;
    bp.vx[slot] = 0;
    bp.vy[slot] = 0;
    bp.vz[slot] = 0;
    return true;
  }

  // Base impact phase transition rule (§3.1)
  if (mat === MAT.OIL && temp >= TEMP_BYTE.OIL_IGNITE) {
    const ok = placeOrDeferFluid(
      room,
      MAT.FIRE,
      TEMP_BYTE.FIRE,
      0,
      targetX,
      targetY,
      targetZ,
      false,
      world.player,
      world.simTick,
    );
    if (ok) {
      room.ledgers.oilCombusted++;
      deactivateBallistic(room, slot);
      return true;
    }
    return false;
  }

  if (mat === MAT.WATER && temp >= TEMP_BYTE.BOIL) {
    const ok = placeOrDeferFluid(
      room,
      MAT.STEAM,
      TEMP_BYTE.BOIL,
      0,
      targetX,
      targetY,
      targetZ,
      false,
      world.player,
      world.simTick,
    );
    if (ok) {
      const playerOnly = (bp.flags[slot] & BALLISTIC_FLAG.FIRED_BY_PLAYER) !== 0;
      queuePhaseExplosion(
        room,
        (targetX + 0.5) * VOXEL_SIZE_M,
        (targetY + 0.5) * VOXEL_SIZE_M,
        (targetZ + 0.5) * VOXEL_SIZE_M,
        playerOnly,
      );
      deactivateBallistic(room, slot);
      return true;
    }
    return false;
  }

  if (mat === MAT.CRYO && temp >= TEMP_BYTE.FREEZE) {
    room.ledgers.cryoBoiledOff++;
    if (temp >= TEMP_BYTE.BOIL) {
      const playerOnly = (bp.flags[slot] & BALLISTIC_FLAG.FIRED_BY_PLAYER) !== 0;
      queuePhaseExplosion(
        room,
        (targetX + 0.5) * VOXEL_SIZE_M,
        (targetY + 0.5) * VOXEL_SIZE_M,
        (targetZ + 0.5) * VOXEL_SIZE_M,
        playerOnly,
        'cryo',
      );
    }
    deactivateBallistic(room, slot);
    return true;
  }

  if (mat === MAT.ICE) {
    const placeMat = temp <= TEMP_BYTE.FREEZE ? MAT.ICE : MAT.WATER;
    const placeTemp = placeMat === MAT.WATER ? Math.max(temp, TEMP_BYTE.MELT) : temp;
    const ok = placeOrDeferFluid(
      room,
      placeMat,
      placeTemp,
      0,
      targetX,
      targetY,
      targetZ,
      false,
      world.player,
      world.simTick,
    );
    if (ok) {
      deactivateBallistic(room, slot);
      return true;
    }
    return false;
  }

  // Cryo-Expansion Nozzle (§9): chilled WATER (<= 0 C) freezes 1:1 into solid ICE on impact
  const placeMat =
    firedByPlayer && mat === MAT.WATER && temp <= TEMP_BYTE.FREEZE ? MAT.ICE : mat;
  const ok = placeOrDeferFluid(
    room,
    placeMat,
    temp,
    placeMat === MAT.ICE ? 0 : charge,
    targetX,
    targetY,
    targetZ,
    false,
    world.player,
    world.simTick,
  );
  if (ok) {
    // Instant ballistic GLASS_VAT thermal shock (|dT| >= 140 C breaches the exact impacted glass face before 1G drop)
    if (
      placeMat === MAT.WATER ||
      placeMat === MAT.OIL ||
      placeMat === MAT.CRYO ||
      placeMat === MAT.STEAM ||
      placeMat === MAT.FIRE ||
      placeMat === MAT.ACID
    ) {
      const g = room.grid;
      for (let f = 0; f < 6; f++) {
        const nx = targetX + FACE_DX[f];
        const ny = targetY + FACE_DY[f];
        const nz = targetZ + FACE_DZ[f];
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const nVal = g[cellIndex(nx, ny, nz)];
        if (getMat(nVal) !== MAT.GLASS_VAT) continue;
        if (Math.abs(temp - getTempByte(nVal)) >= 35) {
          applyStructuralDamage(room, nx, ny, nz, 4, false, world.simTick);
        }
      }
    }

    // Live Sparking Conduit contact: splash-down arc to puddle below + continuous hose backfeed
    if (placeMat === MAT.WATER || placeMat === MAT.ACID) {
      for (let ei = 0; ei < room.emitters.length; ei++) {
        const em = room.emitters[ei];
        if (em.kind !== 'conduit') continue;
        if (
          Math.abs(targetX - em.x) <= 2 &&
          Math.abs(targetY - em.y) <= 2 &&
          Math.abs(targetZ - em.z) <= 2
        ) {
          triggerConduitWaterImpact(world, ei, targetX, targetY, targetZ, firedByPlayer);
          break;
        }
      }
    }

    // Piezo-Arc Coil (§9): charged fired/dashed WATER triggers local BFS pulse on landing (0.5 s CD)
    if (
      firedByPlayer &&
      placeMat === MAT.WATER &&
      charge >= 40 &&
      world.suit.piezoArcCdTicks === 0
    ) {
      if (triggerElectricalPulseAt(room, targetX, targetY, targetZ, 60, world.simTick)) {
        world.suit.piezoArcCdTicks = 30;
      }
    }
    deactivateBallistic(room, slot);
    return true;
  }
  return false;
}

/**
 * Stage 3: Ballistic Quanta Integration & Swept 3D DDA (§6.1, §6.2).
 */
export function stepBallisticsStage3(world: WorldState): void {
  const room = world.room;
  const bp = room.ballistic;
  if (bp.count === 0) return;

  const mode = room.gravityMode;
  const isZeroG = mode === GRAVITY_MODE.G0;
  const gAccel = GRAVITY_ACCEL_BY_MODE[mode];
  const stopSq = LIFT_0G_STOP_SPEED * LIFT_0G_STOP_SPEED;
  const player = world.player;
  const playerMass = getEffectiveMassKg(player, world.playerTank);

  for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
    if (bp.active[i] === 0) continue;

    bp.flightTicks[i]++;
    const val = bp.packedVoxel[i];
    const mat = getMat(val);
    const temp = getTempByte(val);
    const flags = bp.flags[i];

    // Phase-Lock Fuse primed quanta hold in place until fuse hits 0 or adjacent FIRE triggers chain ignition (§9)
    if ((flags & BALLISTIC_FLAG.PRIMED) !== 0) {
      const cx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
      const cy = Math.floor(bp.y[i] / VOXEL_SIZE_M);
      const cz = Math.floor(bp.z[i] / VOXEL_SIZE_M);
      if (bp.fuseTicks[i] > 0) bp.fuseTicks[i]--;
      if (bp.fuseTicks[i] === 0 || isPrimedNearFire(room, cx, cy, cz)) {
        applyBallisticImpactTransitionOrPlace(world, i, cx, cy, cz, true);
      }
      continue;
    }

    // Spark-Plug Igniter in-flight exception (§3.1)
    if (
      (flags & BALLISTIC_FLAG.IGNITE_IN_FLIGHT) !== 0 &&
      bp.flightTicks[i] === 2 &&
      mat === MAT.OIL &&
      temp >= TEMP_BYTE.OIL_IGNITE
    ) {
      const cx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
      const cy = Math.floor(bp.y[i] / VOXEL_SIZE_M);
      const cz = Math.floor(bp.z[i] / VOXEL_SIZE_M);
      if (applyBallisticImpactTransitionOrPlace(world, i, cx, cy, cz)) continue;
    }

    let vx = bp.vx[i];
    let vy = bp.vy[i];
    let vz = bp.vz[i];

    if (isZeroG) {
      if (vx * vx + vy * vy + vz * vz < stopSq) {
        const cx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
        const cy = Math.floor(bp.y[i] / VOXEL_SIZE_M);
        const cz = Math.floor(bp.z[i] / VOXEL_SIZE_M);
        applyBallisticImpactTransitionOrPlace(world, i, cx, cy, cz);
        continue;
      }
    } else {
      vy += gAccel * FIXED_DT;
      bp.vy[i] = vy;
    }

    const ox = bp.x[i];
    const oy = bp.y[i];
    const oz = bp.z[i];
    const dxM = vx * FIXED_DT;
    const dyM = vy * FIXED_DT;
    const dzM = vz * FIXED_DT;

    if (isZeroG) {
      bp.vx[i] = vx * LIFT_0G_DRAG;
      bp.vy[i] = vy * LIFT_0G_DRAG;
      bp.vz[i] = vz * LIFT_0G_DRAG;
    }
    const distM = Math.sqrt(dxM * dxM + dyM * dyM + dzM * dzM);

    let lastAirX = Math.floor(ox / VOXEL_SIZE_M);
    let lastAirY = Math.floor(oy / VOXEL_SIZE_M);
    let lastAirZ = Math.floor(oz / VOXEL_SIZE_M);
    let hasLastAir =
      inRoomBounds(room, lastAirX, lastAirY, lastAirZ) &&
      getMat(room.grid[cellIndex(lastAirX, lastAirY, lastAirZ)]) === MAT.AIR;

    if (distM < 1e-6) {
      applyBallisticImpactTransitionOrPlace(world, i, lastAirX, lastAirY, lastAirZ);
      continue;
    }

    const rdx = dxM / distM;
    const rdy = dyM / distM;
    const rdz = dzM / distM;

    const maxT = distM / VOXEL_SIZE_M;
    const oxV = ox / VOXEL_SIZE_M;
    const oyV = oy / VOXEL_SIZE_M;
    const ozV = oz / VOXEL_SIZE_M;

    let gx = Math.floor(oxV);
    let gy = Math.floor(oyV);
    let gz = Math.floor(ozV);

    const stepX = rdx >= 0 ? 1 : -1;
    const stepY = rdy >= 0 ? 1 : -1;
    const stepZ = rdz >= 0 ? 1 : -1;

    const tDeltaX = rdx !== 0 ? Math.abs(1 / rdx) : Infinity;
    const tDeltaY = rdy !== 0 ? Math.abs(1 / rdy) : Infinity;
    const tDeltaZ = rdz !== 0 ? Math.abs(1 / rdz) : Infinity;

    let tMaxX = rdx !== 0 ? ((stepX > 0 ? gx + 1 : gx) - oxV) / rdx : Infinity;
    let tMaxY = rdy !== 0 ? ((stepY > 0 ? gy + 1 : gy) - oyV) / rdy : Infinity;
    let tMaxZ = rdz !== 0 ? ((stepZ > 0 ? gz + 1 : gz) - ozV) / rdz : Infinity;

    let t = 0;
    let resolved = false;
    let curVal = val;
    let curMat = mat;

    for (let steps = 0; steps < 64 && t <= maxT; steps++) {
      const sampleX = ox + rdx * t * VOXEL_SIZE_M;
      const sampleY = oy + rdy * t * VOXEL_SIZE_M;
      const sampleZ = oz + rdz * t * VOXEL_SIZE_M;

      // Precedence 1: Entity hit (player + crates/aliens)
      let hitEntity: Entity | null = null;
      const skipPlayer = (flags & BALLISTIC_FLAG.FIRED_BY_PLAYER) !== 0 && bp.flightTicks[i] <= 4;
      if (!skipPlayer && pointInsideEntity(player, sampleX, sampleY, sampleZ)) {
        hitEntity = player;
      } else {
        for (let ei = 0; ei < world.entities.length; ei++) {
          const cand = world.entities[ei];
          if (cand.hp <= 0 || cand.deathHusk) continue;
          if (pointInsideEntity(cand, sampleX, sampleY, sampleZ)) {
            hitEntity = cand;
            break;
          }
        }
      }
      if (hitEntity !== null) {
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > 1e-4) {
          const mass = hitEntity === player ? playerMass : getEffectiveMassKg(hitEntity);
          const dv = (MATERIAL_SPEC[curMat].densityKgPerL * speed) / Math.max(1, mass);
          hitEntity.vx += (vx / speed) * dv;
          hitEntity.vy += (vy / speed) * dv;
          hitEntity.vz += (vz / speed) * dv;
          if (hitEntity !== player && dv > 0.2) hitEntity.impulseTimer = 36;
          if (curMat === MAT.ICE && hitEntity !== player && speed >= 4.0) {
            const brittleMult = hitEntity.tempByte <= TEMP_BYTE.EMBRITTLED ? 3 : 1;
            hitEntity.hp = Math.max(0, hitEntity.hp - 4 * brittleMult);
          }
          if (curMat === MAT.CRYO && hitEntity !== player) {
            const wasFrozen = hitEntity.tempByte <= TEMP_BYTE.EMBRITTLED;
            hitEntity.tempByte = Math.max(TEMP_BYTE.CRYO, hitEntity.tempByte - 4);
            hitEntity.hp = Math.max(0, hitEntity.hp - 1);
            if (!wasFrozen && hitEntity.tempByte <= TEMP_BYTE.EMBRITTLED) {
              pushCombatEvent(room, {
                kind: 'shatter',
                entityId: hitEntity.id,
                x: hitEntity.x,
                y: hitEntity.y + hitEntity.height + 0.15,
                z: hitEntity.z,
                value: 0,
                colorHex: 0x7ef9ff,
                label: 'FROZEN! (3x SHATTER)',
              });
            }
          } else if (curMat === MAT.WATER && hitEntity !== player) {
            hitEntity.wetTicks = 120;
            hitEntity.burnTicks = 0;
            if (getTimerOrCharge(curVal) > 0 && hitEntity.carapace !== 'insulated') {
              hitEntity.shockTicks = 18;
              hitEntity.hp = Math.max(0, hitEntity.hp - (hitEntity.carapace === 'armored' ? 4 : 2));
              if (hitEntity.kind === 'alien') applyEntityStun(room, hitEntity, 45, false, true);
            }
          } else if (curMat === MAT.OIL && hitEntity !== player && hitEntity.burnTicks > 0) {
            hitEntity.burnTicks = Math.max(hitEntity.burnTicks, 240);
          }
        }
        const tx = hasLastAir ? lastAirX : gx;
        const ty = hasLastAir ? lastAirY : gy;
        const tz = hasLastAir ? lastAirZ : gz;
        applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz);
        resolved = true;
        break;
      }

      if (!inRoomBounds(room, gx, gy, gz)) {
        const tx = hasLastAir ? lastAirX : Math.max(1, Math.min(room.roomW - 2, gx));
        const ty = hasLastAir ? lastAirY : Math.max(1, Math.min(room.roomH - 2, gy));
        const tz = hasLastAir ? lastAirZ : Math.max(1, Math.min(room.roomD - 2, gz));
        applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz);
        resolved = true;
        break;
      }

      const cellIdx = cellIndex(gx, gy, gz);
      const cellVal = room.grid[cellIdx];
      const cellMat = getMat(cellVal);

      if (cellMat === MAT.AIR) {
        lastAirX = gx;
        lastAirY = gy;
        lastAirZ = gz;
        hasLastAir = true;
      } else if (cellMat === MAT.STEEL_GRATE) {
        // Precedence 2: STEEL_GRATE passes WATER/OIL/CRYO (never updating lastAir); solid for ICE/ACID
        if (curMat === MAT.ICE || curMat === MAT.ACID) {
          const tx = hasLastAir ? lastAirX : gx;
          const ty = hasLastAir ? lastAirY : gy;
          const tz = hasLastAir ? lastAirZ : gz;
          applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz);
          resolved = true;
          break;
        }
      } else if (isSolidMat(cellMat)) {
        // Precedence 3: Solid hit
        const tx = hasLastAir ? lastAirX : gx;
        const ty = hasLastAir ? lastAirY : gy;
        const tz = hasLastAir ? lastAirZ : gz;
        applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz);
        resolved = true;
        break;
      } else if (cellMat === MAT.FIRE) {
        // Precedence 4a: FIRE reaction (§6.1 Stage 3)
        if (curMat === MAT.WATER) {
          const tx = hasLastAir ? lastAirX : gx;
          const ty = hasLastAir ? lastAirY : gy;
          const tz = hasLastAir ? lastAirZ : gz;
          const ok = placeOrDeferFluid(
            room,
            MAT.STEAM,
            TEMP_BYTE.BOIL,
            0,
            tx,
            ty,
            tz,
            false,
            player,
            world.simTick,
          );
          if (ok) {
            transitionCell(room, gx, gy, gz, MAT.AIR, TEMP_BYTE.AMBIENT, world.simTick);
            deactivateBallistic(room, i);
          }
          resolved = true;
          break;
        } else if (curMat === MAT.OIL) {
          writeCell(
            room,
            gx,
            gy,
            gz,
            packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 30, 0, getShimmer(cellVal), 0, 0),
            world.simTick,
          );
          room.ledgers.oilCombusted++;
          deactivateBallistic(room, i);
          resolved = true;
          break;
        } else if (curMat === MAT.CRYO) {
          room.ledgers.cryoBoiledOff++;
          deactivateBallistic(room, i);
          resolved = true;
          break;
        } else if (curMat === MAT.ICE) {
          const tx = hasLastAir ? lastAirX : gx;
          const ty = hasLastAir ? lastAirY : gy;
          const tz = hasLastAir ? lastAirZ : gz;
          const ok = placeOrDeferFluid(
            room,
            MAT.WATER,
            TEMP_BYTE.MELT,
            0,
            tx,
            ty,
            tz,
            false,
            player,
            world.simTick,
          );
          if (ok) deactivateBallistic(room, i);
          resolved = true;
          break;
        }
        // ACID passes through FIRE without reaction
      } else if (cellMat === MAT.STEAM) {
        // Precedence 4b: Pass through STEAM without swapping
      } else if (steps === 0 && cellMat === curMat && bp.flightTicks[i] <= 8) {
        // Launching quantum clearing its own spawn voxel while another cell stepped behind it
      } else if (
        isBallisticAllowedMat(cellMat) &&
        MATERIAL_SPEC[cellMat].densityKgPerL < MATERIAL_SPEC[curMat].densityKgPerL
      ) {
        // Precedence 5: Lighter ballistic-allowed fluid swap (single swap per tick, snap & damp)
        writeCell(room, gx, gy, gz, (curVal & ~(1 << 22)) >>> 0, world.simTick);
        bp.packedVoxel[i] = (cellVal & ~(1 << 22)) >>> 0;
        bp.x[i] = (gx + 0.5) * VOXEL_SIZE_M;
        bp.y[i] = (gy + 0.5) * VOXEL_SIZE_M;
        bp.z[i] = (gz + 0.5) * VOXEL_SIZE_M;
        bp.vx[i] *= 0.5;
        bp.vy[i] *= 0.5;
        bp.vz[i] *= 0.5;
        resolved = true;
        break;
      } else {
        // Precedence 6: Same or heavier fluid -> horizontal spread around lastAir first
        const tx = hasLastAir ? lastAirX : gx;
        const ty = hasLastAir ? lastAirY : gy;
        const tz = hasLastAir ? lastAirZ : gz;

        let spreadDone = false;
        if (hasLastAir && isLiquidMat(curMat) && temp < TEMP_BYTE.BOIL) {
          const startDir = hash32(room.roomSeed, world.simTick, i) & 3;
          for (let k = 0; k < 4; k++) {
            const d = (startDir + k) & 3;
            const hx = tx + SLIDE_DX[d];
            const hz = tz + SLIDE_DZ[d];
            if (inRoomBounds(room, hx, ty, hz) && getMat(room.grid[cellIndex(hx, ty, hz)]) === MAT.AIR) {
              commitGridFluid(room, hx, ty, hz, curMat, temp, getTimerOrCharge(curVal), world.simTick);
              deactivateBallistic(room, i);
              spreadDone = true;
              break;
            }
          }
        }
        if (!spreadDone) {
          applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz);
        }
        resolved = true;
        break;
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          tMaxX += tDeltaX;
          gx += stepX;
        } else {
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          gz += stepZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          t = tMaxY;
          tMaxY += tDeltaY;
          gy += stepY;
        } else {
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          gz += stepZ;
        }
      }
    }

    if (!resolved) {
      bp.x[i] = Math.max(VOXEL_SIZE_M, Math.min((room.roomW - 1) * VOXEL_SIZE_M - 1e-4, ox + dxM));
      bp.y[i] = Math.max(VOXEL_SIZE_M, Math.min((room.roomH - 1) * VOXEL_SIZE_M - 1e-4, oy + dyM));
      bp.z[i] = Math.max(VOXEL_SIZE_M, Math.min((room.roomD - 1) * VOXEL_SIZE_M - 1e-4, oz + dzM));
    }
  }
}

/**
 * Swap current/next active lists and sort activeFluidCur ascending (§4.4).
 */
function swapActiveListsAtStage4(room: RoomState): void {
  // Clear old Cur bitsets strictly in O(active)
  for (let i = 0; i < room.activeFluidCurCount; i++) {
    const idx = room.activeFluidCur[i];
    room.activeFluidBitsetCur[idx >>> 5] &= ~(1 << (idx & 31));
  }
  for (let i = 0; i < room.activeThermalCurCount; i++) {
    const idx = room.activeThermalCur[i];
    room.activeThermalBitsetCur[idx >>> 5] &= ~(1 << (idx & 31));
  }

  // Swap Fluid buffers
  const tmpF = room.activeFluidCur;
  room.activeFluidCur = room.activeFluidNext;
  room.activeFluidNext = tmpF;
  const tmpFB = room.activeFluidBitsetCur;
  room.activeFluidBitsetCur = room.activeFluidBitsetNext;
  room.activeFluidBitsetNext = tmpFB;
  room.activeFluidCurCount = room.activeFluidNextCount;
  room.activeFluidNextCount = 0;

  // Swap Thermal buffers
  const tmpT = room.activeThermalCur;
  room.activeThermalCur = room.activeThermalNext;
  room.activeThermalNext = tmpT;
  const tmpTB = room.activeThermalBitsetCur;
  room.activeThermalBitsetCur = room.activeThermalBitsetNext;
  room.activeThermalBitsetNext = tmpTB;
  room.activeThermalCurCount = room.activeThermalNextCount;
  room.activeThermalNextCount = 0;

  if (room.activeFluidCurCount > 1) {
    room.activeFluidCur.subarray(0, room.activeFluidCurCount).sort();
  }
}

function stepSingleFluidSubPass(
  world: WorldState,
  list: Int32Array,
  count: number,
  ascending: boolean,
  writeDestinations: Int32Array | null,
): number {
  const room = world.room;
  const g = room.grid;
  const mode = room.gravityMode;
  const isZeroG = mode === GRAVITY_MODE.G0;
  const dirY = mode === GRAVITY_MODE.GN1 ? 1 : -1;
  const gAccel = GRAVITY_ACCEL_BY_MODE[mode];
  const simTick = world.simTick;

  let touchedCentroids = 0;
  if (isZeroG) {
    for (let i = 0; i < count; i++) {
      const idx = list[i];
      const mat = getMat(g[idx]);
      const bucket = liquidCentroidBucket(mat);
      if (bucket < 0) continue;
      const y = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - y * SLICE_STRIDE;
      const z = Math.floor(rem / ARENA_W);
      const x = rem - z * ARENA_W;
      const cIdx = (y >> 4) * (CHUNKS_X * CHUNKS_Z) + (z >> 4) * CHUNKS_X + (x >> 4);
      const slot = cIdx * 4 + bucket;
      if (centroidCount[slot] === 0) {
        touchedCentroidSlots[touchedCentroids++] = slot;
      }
      centroidSumX[slot] += x;
      centroidSumY[slot] += y;
      centroidSumZ[slot] += z;
      centroidCount[slot]++;
    }
  }

  let writeCount = 0;
  const start = ascending ? 0 : count - 1;
  const end = ascending ? count : -1;
  const step = ascending ? 1 : -1;

  for (let i = start; i !== end; i += step) {
    const idx = list[i];
    const val = g[idx];
    if (getStepped(val) !== 0) continue;
    const mat = getMat(val);
    if (!isFluidOrGasMat(mat)) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    let movedToIdx = -1;

    if (isZeroG) {
      if (isGasOrPlasmaMat(mat)) {
        const fireAnchored =
          mat === MAT.FIRE &&
          ((getTimerOrCharge(val) > 20 && fireHasAdjacentFuelOrFloor(room, x, y, z)) || (simTick & 1) !== 0);
        if (!fireAnchored) {
        // Isotropic seeded 6-neighbor step in 0G
        const startFace = hash32(room.roomSeed, simTick, idx) % 6;
        for (let k = 0; k < 6; k++) {
          const f = (startFace + k) % 6;
          const nx = x + FACE_DX[f];
          const ny = y + FACE_DY[f];
          const nz = z + FACE_DZ[f];
          if (!inRoomBounds(room, nx, ny, nz)) continue;
          const nMat = getMat(g[cellIndex(nx, ny, nz)]);
          if (nMat === MAT.AIR) {
            moveCell(room, x, y, z, nx, ny, nz, simTick);
            movedToIdx = cellIndex(nx, ny, nz);
            break;
          }
        }
        }
      } else if (world.zeroGLoftTicksLeft > 0) {
        // CA-driven room-wide 0G loft (§6.2, D6): 0 ballistic slots consumed
        const liftDir = world.zeroGLoftDirY;
        const threshold = Math.floor((world.zeroGLoftTicksLeft / LIFT_0G_TICKS) * 460);
        const h = hash32(room.roomSeed, simTick, idx) & 1023;
        const ny = y + liftDir;
        if (h < threshold && ny >= 1 && ny < room.roomH - 1) {
          if (getMat(g[cellIndex(x, ny, z)]) === MAT.AIR) {
            moveCell(room, x, y, z, x, ny, z, simTick);
            movedToIdx = cellIndex(x, ny, z);
          }
        }
        // Keep liquid awake across the loft window so every cell rolls each tick
        if (movedToIdx === -1) {
          wakeCell(room, x, y, z, simTick);
        }
      } else {
        // 0G Surface Tension (§6.3): interior cells early-exit
        let allSixMatch = true;
        for (let f = 0; f < 6; f++) {
          const nx = x + FACE_DX[f];
          const ny = y + FACE_DY[f];
          const nz = z + FACE_DZ[f];
          if (!inRoomBounds(room, nx, ny, nz) || getMat(g[cellIndex(nx, ny, nz)]) !== mat) {
            allSixMatch = false;
            break;
          }
        }
        if (!allSixMatch) {
          const curN = countNSame(room, x, y, z, mat, x, y, z);
          const bucket = liquidCentroidBucket(mat);
          const cIdx = (y >> 4) * (CHUNKS_X * CHUNKS_Z) + (z >> 4) * CHUNKS_X + (x >> 4);
          const slot = cIdx * 4 + bucket;
          const invC = centroidCount[slot] > 0 ? 1 / centroidCount[slot] : 0;
          const centX = centroidSumX[slot] * invC;
          const centY = centroidSumY[slot] * invC;
          const centZ = centroidSumZ[slot] * invC;
          const curDistSq =
            (x - centX) * (x - centX) +
            (y - centY) * (y - centY) +
            (z - centZ) * (z - centZ);

          let bestX = -1;
          let bestY = -1;
          let bestZ = -1;
          let bestN = curN;
          let bestDistSq = curDistSq;

          const startFace = hash32(room.roomSeed, simTick, idx) % 6;
          for (let k = 0; k < 6; k++) {
            const f = (startFace + k) % 6;
            const nx = x + FACE_DX[f];
            const ny = y + FACE_DY[f];
            const nz = z + FACE_DZ[f];
            if (!inRoomBounds(room, nx, ny, nz)) continue;
            if (getMat(g[cellIndex(nx, ny, nz)]) !== MAT.AIR) continue;
            const candN = countNSame(room, nx, ny, nz, mat, x, y, z);
            const candDistSq =
              (nx - centX) * (nx - centX) +
              (ny - centY) * (ny - centY) +
              (nz - centZ) * (nz - centZ);
            if (candN > bestN || (candN === bestN && candDistSq + 1e-4 < bestDistSq)) {
              bestN = candN;
              bestDistSq = candDistSq;
              bestX = nx;
              bestY = ny;
              bestZ = nz;
            }
          }
          if (bestX !== -1) {
            moveCell(room, x, y, z, bestX, bestY, bestZ, simTick);
            movedToIdx = cellIndex(bestX, bestY, bestZ);
          }
        }
      }
    } else if (isGasOrPlasmaMat(mat)) {
      const fireAnchored =
        mat === MAT.FIRE &&
        ((getTimerOrCharge(val) > 20 && fireHasAdjacentFuelOrFloor(room, x, y, z)) || (simTick & 1) !== 0);
      if (!fireAnchored) {
      // Rule 1B: Explicit Upward Buoyancy (-dirY), Grate Permeation (GRATE_MAX_RUN=2), Gas/Liquid Swaps
      const upY = y - dirY;
      if (upY >= 1 && upY < room.roomH - 1) {
        let targetY = upY;
        let targetMat = getMat(g[cellIndex(x, targetY, z)]);

        if (targetMat === MAT.STEEL_GRATE) {
          let run = 1;
          while (
            run <= GRATE_MAX_RUN &&
            y - (run + 1) * dirY >= 1 &&
            y - (run + 1) * dirY < room.roomH - 1 &&
            getMat(g[cellIndex(x, y - (run + 1) * dirY, z)]) === MAT.STEEL_GRATE
          ) {
            run++;
          }
          const beyondY = y - (run + 1) * dirY;
          if (run <= GRATE_MAX_RUN && beyondY >= 1 && beyondY < room.roomH - 1) {
            targetY = beyondY;
            targetMat = getMat(g[cellIndex(x, targetY, z)]);
          }
        }

        if (targetMat === MAT.AIR) {
          moveCell(room, x, y, z, x, targetY, z, simTick);
          movedToIdx = cellIndex(x, targetY, z);
        } else if (
          (mat === MAT.FIRE && targetMat === MAT.STEAM) ||
          (mat === MAT.STEAM && isLiquidMat(targetMat))
        ) {
          swapCells(room, x, y, z, x, targetY, z, simTick);
          movedToIdx = cellIndex(x, targetY, z);
        }
      }

      if (movedToIdx === -1) {
        // Horizontal gas drift
        const d = hash32(room.roomSeed, simTick, idx) & 3;
        const hx = x + SLIDE_DX[d];
        const hz = z + SLIDE_DZ[d];
        if (inRoomBounds(room, hx, y, hz) && getMat(g[cellIndex(hx, y, hz)]) === MAT.AIR) {
          moveCell(room, x, y, z, hx, y, hz, simTick);
          movedToIdx = cellIndex(hx, y, hz);
        }
      }
      }
    } else {
      // Liquids (WATER, OIL, CRYO, ACID)
      const ny1 = y + dirY;
      const ny2 = y + 2 * dirY;

      // Free-fall promotion before Rule 1A (§6.1 Stage 4 & §6.2)
      if (
        ny1 >= 1 &&
        ny1 < room.roomH - 1 &&
        ny2 >= 1 &&
        ny2 < room.roomH - 1 &&
        getMat(g[cellIndex(x, ny1, z)]) === MAT.AIR &&
        getMat(g[cellIndex(x, ny2, z)]) === MAT.AIR &&
        room.ballistic.count < MAX_ACTIVE_BALLISTIC
      ) {
        const slot = spawnBallistic(
          room,
          (x + 0.5) * VOXEL_SIZE_M,
          (y + 0.5) * VOXEL_SIZE_M,
          (z + 0.5) * VOXEL_SIZE_M,
          0,
          gAccel * FIXED_DT,
          0,
          val,
        );
        if (slot !== -1) {
          writeCell(room, x, y, z, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), simTick);
          wake26Neighbors(room, x, y, z, simTick);
          continue;
        }
      }

      // Rule 1A: Vertical Step, Contiguous Grate Permeation (GRATE_MAX_RUN=2), Archimedes & Gas Swaps
      if (ny1 >= 1 && ny1 < room.roomH - 1) {
        let targetY = ny1;
        let targetMat = getMat(g[cellIndex(x, targetY, z)]);

        if (targetMat === MAT.STEEL_GRATE && mat !== MAT.ACID) {
          let run = 1;
          while (
            run <= GRATE_MAX_RUN &&
            y + (run + 1) * dirY >= 1 &&
            y + (run + 1) * dirY < room.roomH - 1 &&
            getMat(g[cellIndex(x, y + (run + 1) * dirY, z)]) === MAT.STEEL_GRATE
          ) {
            run++;
          }
          const beyondY = y + (run + 1) * dirY;
          if (run <= GRATE_MAX_RUN && beyondY >= 1 && beyondY < room.roomH - 1) {
            targetY = beyondY;
            targetMat = getMat(g[cellIndex(x, targetY, z)]);
          }
        }

        if (targetMat === MAT.AIR) {
          moveCell(room, x, y, z, x, targetY, z, simTick);
          movedToIdx = cellIndex(x, targetY, z);
        } else if (
          isGasOrPlasmaMat(targetMat) ||
          (isLiquidMat(targetMat) &&
            MATERIAL_SPEC[targetMat].densityKgPerL < MATERIAL_SPEC[mat].densityKgPerL)
        ) {
          swapCells(room, x, y, z, x, targetY, z, simTick);
          movedToIdx = cellIndex(x, targetY, z);
        }
      }

      // Rule 2: Diagonal Collapse biased by slideDir
      if (movedToIdx === -1 && ny1 >= 1 && ny1 < room.roomH - 1) {
        const sDir = getSlideDir(val);
        for (let k = 0; k < 4; k++) {
          const d = (sDir + k) & 3;
          const dx = x + SLIDE_DX[d];
          const dz = z + SLIDE_DZ[d];
          if (!inRoomBounds(room, dx, ny1, dz)) continue;
          const dMat = getMat(g[cellIndex(dx, ny1, dz)]);
          if (dMat === MAT.AIR) {
            moveCell(room, x, y, z, dx, ny1, dz, simTick);
            movedToIdx = cellIndex(dx, ny1, dz);
            break;
          } else if (
            isGasOrPlasmaMat(dMat) ||
            (isLiquidMat(dMat) &&
              MATERIAL_SPEC[dMat].densityKgPerL < MATERIAL_SPEC[mat].densityKgPerL)
          ) {
            swapCells(room, x, y, z, dx, ny1, dz, simTick);
            movedToIdx = cellIndex(dx, ny1, dz);
            break;
          }
        }
      }

      // Rule 3: 8-Direction Viscosity Dispersion & Canonical 3x3x3 Shoreline Cohesion (§6.3)
      if (movedToIdx === -1) {
        const visc = MATERIAL_SPEC[mat].viscositySteps;
        const aboveY = y - dirY;
        const belowY = y + dirY;
        const hasSameAbove =
          aboveY >= 0 &&
          aboveY < room.roomH &&
          getMat(g[cellIndex(x, aboveY, z)]) === mat;
        const hasSameBelow =
          belowY >= 0 &&
          belowY < room.roomH &&
          getMat(g[cellIndex(x, belowY, z)]) === mat;

        // Outward push away from cardinal stacked columns (which Rule 2 collapses into),
        // fanning across that cardinal direction and its two 45-deg diagonals
        let pushDirMask8 = 0;
        if (!hasSameAbove && aboveY >= 0 && aboveY < room.roomH) {
          for (let k = 0; k < 4; k++) {
            const nx = x - SLIDE_DX[k];
            const nz = z - SLIDE_DZ[k];
            if (
              inRoomBounds(room, nx, aboveY, nz) &&
              getMat(g[cellIndex(nx, y, nz)]) === mat &&
              getMat(g[cellIndex(nx, aboveY, nz)]) === mat
            ) {
              const d8 = SLIDE_TO_DIR8[k];
              pushDirMask8 |= (1 << d8) | (1 << ((d8 + 1) & 7)) | (1 << ((d8 + 7) & 7));
            }
          }
        }

        const sDir = getSlideDir(val);
        const base8 = SLIDE_TO_DIR8[sDir];
        const hDir = hash32(room.roomSeed, simTick, idx);

        if (!hasSameAbove && pushDirMask8 === 0 && hasSameBelow) {
          // Acyclic 3-way forward fan (sDir and its two 45-deg flanking diagonals)
          // Eliminates cardinal + arms while strictly terminating in enclosed basins
          const fan0 = base8;
          const fan1 = (base8 + 1) & 7;
          const fan2 = (base8 + 7) & 7;
          const pick = hDir % 3;
          const order0 = pick === 0 ? fan0 : pick === 1 ? fan1 : fan2;
          const order1 = pick === 0 ? fan1 : pick === 1 ? fan2 : fan0;
          const order2 = pick === 0 ? fan2 : pick === 1 ? fan0 : fan1;
          const fan = [order0, order1, order2];

          for (let f = 0; f < 3; f++) {
            const d8 = fan[f];
            const stepDx = DIR8_DX[d8];
            const stepDz = DIR8_DZ[d8];
            let bestX = -1;
            let bestZ = -1;
            const maxSteps = stepDx !== 0 && stepDz !== 0 ? Math.max(1, visc - 1) : visc;
            for (let s = 1; s <= maxSteps; s++) {
              const tx = x + stepDx * s;
              const tz = z + stepDz * s;
              if (!inRoomBounds(room, tx, y, tz)) break;
              if (getMat(g[cellIndex(tx, y, tz)]) !== MAT.AIR) break;
              bestX = tx;
              bestZ = tz;
            }
            if (bestX !== -1) {
              moveCell(room, x, y, z, bestX, y, bestZ, simTick);
              movedToIdx = cellIndex(bestX, y, bestZ);
              break;
            }
          }
        } else {
          const curNSame = hasSameAbove ? 0 : countNSame(room, x, y, z, mat, x, y, z);
          const start8 = (base8 + (hDir & 7)) & 7;

          for (let attempt = 0; attempt < 8; attempt++) {
            const d8 = (start8 + attempt) & 7;
            const stepDx = DIR8_DX[d8];
            const stepDz = DIR8_DZ[d8];
            const pushedThisDir = (pushDirMask8 & (1 << d8)) !== 0;

            let bestX = -1;
            let bestZ = -1;
            const maxSteps = stepDx !== 0 && stepDz !== 0 ? Math.max(1, visc - 1) : visc;
            for (let s = 1; s <= maxSteps; s++) {
              const tx = x + stepDx * s;
              const tz = z + stepDz * s;
              if (!inRoomBounds(room, tx, y, tz)) break;
              if (getMat(g[cellIndex(tx, y, tz)]) !== MAT.AIR) break;

              if (hasSameAbove || pushedThisDir || countNSame(room, tx, y, tz, mat, x, y, z) > curNSame) {
                bestX = tx;
                bestZ = tz;
              }
            }

            if (bestX !== -1) {
              const newSDir = DIR8_TO_SLIDE[d8];
              if (newSDir !== sDir) {
                const updatedDir = ((val & ~(3 << 26)) | (newSDir << 26)) >>> 0;
                writeCell(room, x, y, z, updatedDir, simTick);
              }
              moveCell(room, x, y, z, bestX, y, bestZ, simTick);
              movedToIdx = cellIndex(bestX, y, bestZ);
              break;
            }
          }
        }
      }
    }

    if (movedToIdx !== -1) {
      if (writeDestinations && writeCount < writeDestinations.length) {
        writeDestinations[writeCount++] = movedToIdx;
      }
    } else if (cellShouldStayAwake(room, x, y, z, g[idx])) {
      wakeCell(room, x, y, z, simTick);
    }
  }

  // Clear touched 0G centroid slots
  for (let i = 0; i < touchedCentroids; i++) {
    const slot = touchedCentroidSlots[i];
    centroidSumX[slot] = 0;
    centroidSumY[slot] = 0;
    centroidSumZ[slot] = 0;
    centroidCount[slot] = 0;
  }

  for (let i = 0; i < count; i++) {
    g[list[i]] &= ~(1 << 22);
  }
  for (let i = 0; i < room.activeFluidNextCount; i++) {
    g[room.activeFluidNext[i]] &= ~(1 << 22);
  }
  if (writeDestinations) {
    for (let i = 0; i < writeCount; i++) {
      g[writeDestinations[i]] &= ~(1 << 22);
    }
  }

  return writeCount;
}

/**
 * Stage 4: 60 Hz Fluid & Gas Movement CA (1/2/3 sub-passes for 1G/2G/3G/-1G/0G).
 */
export function stepFluidMovementStage4(world: WorldState): void {
  const room = world.room;
  swapActiveListsAtStage4(room);

  const mode = room.gravityMode;
  const count = room.activeFluidCurCount;
  if (count === 0) {
    if (mode === GRAVITY_MODE.G0 && world.zeroGLoftTicksLeft > 0) {
      world.zeroGLoftTicksLeft--;
    }
    return;
  }

  const passes = mode === GRAVITY_MODE.G3 ? 3 : mode === GRAVITY_MODE.G2 ? 2 : 1;
  const ascending =
    mode === GRAVITY_MODE.G0 && world.zeroGLoftTicksLeft > 0
      ? world.zeroGLoftDirY < 0
      : mode !== GRAVITY_MODE.GN1;

  if (passes === 1) {
    stepSingleFluidSubPass(world, room.activeFluidCur, count, ascending, null);
    if (mode === GRAVITY_MODE.G0 && world.zeroGLoftTicksLeft > 0) {
      world.zeroGLoftTicksLeft--;
    }
    return;
  }

  let nextCount = stepSingleFluidSubPass(world, room.activeFluidCur, count, ascending, subPassBufA);
  if (nextCount > 0 && passes >= 2) {
    nextCount = stepSingleFluidSubPass(
      world,
      subPassBufA,
      nextCount,
      true,
      passes === 3 ? subPassBufB : null,
    );
  }
  if (nextCount > 0 && passes === 3) {
    stepSingleFluidSubPass(world, subPassBufB, nextCount, true, null);
  }
}

/**
 * M2.1 minimal CRYO finite warming (paths 4 & 5: 1 Hz solid contact, 5 s 0G floating -> 0°C sublimation)
 * so the Keep-Awake Contract holds before full Stage 5 lands in M2.2.
 */
export function stepMinimalCryoWarming(world: WorldState): void {
  const room = world.room;
  const simTick = world.simTick;
  const doSolidWarm = simTick % 60 === 0;
  const doZeroGWarm = room.gravityMode === GRAVITY_MODE.G0 && simTick % 300 === 0;
  if (!doSolidWarm && !doZeroGWarm) return;

  const g = room.grid;
  const count = room.activeFluidNextCount;
  for (let i = 0; i < count; i++) {
    const idx = room.activeFluidNext[i];
    const val = g[idx];
    if (getMat(val) !== MAT.CRYO) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    const solidContact = cryoHasSolidWarmingContact(room, x, y, z);
    let warm = false;
    if (doSolidWarm && solidContact) {
      warm = true;
    } else if (doZeroGWarm && cryoIsFloatingZeroG(room, x, y, z)) {
      warm = true;
    }

    if (warm) {
      const nextTemp = getTempByte(val) + 1;
      if (nextTemp >= TEMP_BYTE.FREEZE) {
        transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
        room.ledgers.cryoBoiledOff++;
        if (room.sublimationEventCount < 128) {
          const b = room.sublimationEventCount * 3;
          room.sublimationEvents[b] = (x + 0.5) * VOXEL_SIZE_M;
          room.sublimationEvents[b + 1] = (y + 0.5) * VOXEL_SIZE_M;
          room.sublimationEvents[b + 2] = (z + 0.5) * VOXEL_SIZE_M;
          room.sublimationEventCount++;
        }
      } else {
        const updated = ((val & ~(0xff << 8)) | ((nextTemp & 0xff) << 8)) >>> 0;
        writeCell(room, x, y, z, updated, simTick);
      }
    }
  }
}

function scanOverflowChunks(
  world: WorldState,
  flags: Int32Array,
  isFluid: boolean,
): void {
  const room = world.room;
  const px = world.player.x;
  const py = world.player.y;
  const pz = world.player.z;

  for (let scans = 0; scans < 2; scans++) {
    if (isFluid && room.activeFluidNextCount >= MAX_ACTIVE_GRID_FLUID) return;
    if (!isFluid && room.activeThermalNextCount >= room.activeThermalNext.length) return;

    let bestChunk = -1;
    let bestTick = 0x7fffffff;
    let bestDistSq = Infinity;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      const t = flags[c];
      if (t === 0 || room.outOfBounds[c]) continue;
      const plane = CHUNKS_X * CHUNKS_Z;
      const cy = Math.floor(c / plane);
      const rem = c - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;
      const mx = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const my = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const mz = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const dSq = (mx - px) * (mx - px) + (my - py) * (my - py) + (mz - pz) * (mz - pz);

      if (t < bestTick || (t === bestTick && dSq < bestDistSq)) {
        bestTick = t;
        bestDistSq = dSq;
        bestChunk = c;
      }
    }

    if (bestChunk === -1) return;

    flags[bestChunk] = 0;
    if (isFluid) room.fluidOverflowCursor = bestChunk;
    else room.thermalOverflowCursor = bestChunk;

    const plane = CHUNKS_X * CHUNKS_Z;
    const cy = Math.floor(bestChunk / plane);
    const rem = bestChunk - cy * plane;
    const cz = Math.floor(rem / CHUNKS_X);
    const cx = rem - cz * CHUNKS_X;

    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const x1 = Math.min(room.roomW, x0 + CHUNK_SIZE);
    const y1 = Math.min(room.roomH, y0 + CHUNK_SIZE);
    const z1 = Math.min(room.roomD, z0 + CHUNK_SIZE);

    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const mat = getMat(room.grid[cellIndex(x, y, z)]);
          if (isFluid) {
            if (!isFluidOrGasMat(mat)) continue;
            if (room.activeFluidNextCount >= MAX_ACTIVE_GRID_FLUID) {
              flags[bestChunk] = bestTick;
              return;
            }
            wakeCell(room, x, y, z, world.simTick);
          } else {
            if (room.activeThermalNextCount >= room.activeThermalNext.length) {
              flags[bestChunk] = bestTick;
              return;
            }
            wakeCell(room, x, y, z, world.simTick);
          }
        }
      }
    }
  }
}

/**
 * Stage 8 fluid duties: deferred queue retries (16/tick), overflow scanners (2 chunks/tick each),
 * and every-tick bit-22 clear (§6.1).
 */
export function stepFluidStage8(world: WorldState): void {
  const room = world.room;
  const dq = room.deferredFluid;

  // Retry up to 16 items/tick from deferredFluidQueue
  const attempts = Math.min(16, dq.count);
  for (let n = 0; n < attempts; n++) {
    const slot = dq.head;
    const mat = dq.mat[slot] as MaterialId;
    const temp = dq.tempByte[slot];
    const charge = dq.chargeUnits[slot];
    const tx = dq.targetX[slot];
    const ty = dq.targetY[slot];
    const tz = dq.targetZ[slot];

    dq.head = (dq.head + 1) % MAX_DEFERRED_FLUID;
    dq.count--;

    const placed = placeOrDeferFluid(
      room,
      mat,
      temp,
      charge,
      tx,
      ty,
      tz,
      false,
      world.player,
      world.simTick,
    );
    if (!placed) {
      // Should not occur because we just popped 1 slot, but guard anyway
      enqueueDeferredFluid(room, mat, temp, charge, tx, ty, tz);
    }
  }

  // Independent age-ordered overflow scanners (<= 2 oldest chunks/tick each)
  scanOverflowChunks(world, room.fluidOverflowFlag, true);
  scanOverflowChunks(world, room.thermalOverflowFlag, false);

  // Every-tick bit-22 clear (Stage 5(i), §4.3 & §6.1)
  const g = room.grid;
  for (let i = 0; i < room.activeFluidCurCount; i++) {
    g[room.activeFluidCur[i]] &= ~(1 << 22);
  }
  for (let i = 0; i < room.activeFluidNextCount; i++) {
    g[room.activeFluidNext[i]] &= ~(1 << 22);
  }
  for (let i = 0; i < room.activeThermalCurCount; i++) {
    g[room.activeThermalCur[i]] &= ~(1 << 22);
  }
  for (let i = 0; i < room.stage5TouchedCount; i++) {
    g[room.stage5Touched[i]] &= ~(1 << 22);
  }
  room.stage5TouchedCount = 0;
}

/**
 * Pure core airlock transition fallback (§4.4, M2.1):
 * Re-inserts every active ballistic via placeOrDeferFluid(); any quantum that cannot be
 * placed because the deferred queue is full is returned as a fixed serialized record.
 */
export function drainOrSerializeBallistics(
  world: WorldState,
): SerializedBallisticRecord[] {
  const room = world.room;
  const bp = room.ballistic;
  const fallback: SerializedBallisticRecord[] = [];

  for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
    if (bp.active[i] === 0) continue;
    if ((bp.flags[i] & BALLISTIC_FLAG.PRIMED) !== 0) {
      const tx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
      const ty = Math.floor(bp.y[i] / VOXEL_SIZE_M);
      const tz = Math.floor(bp.z[i] / VOXEL_SIZE_M);
      applyBallisticImpactTransitionOrPlace(world, i, tx, ty, tz, true);
      if (bp.active[i] === 0) continue;
    }
    const val = bp.packedVoxel[i];
    const mat = getMat(val);
    const temp = getTempByte(val);
    const charge = getTimerOrCharge(val);
    const tx = Math.floor(bp.x[i] / VOXEL_SIZE_M);
    const ty = Math.floor(bp.y[i] / VOXEL_SIZE_M);
    const tz = Math.floor(bp.z[i] / VOXEL_SIZE_M);

    const ok = placeOrDeferFluid(
      room,
      mat,
      temp,
      charge,
      tx,
      ty,
      tz,
      false,
      world.player,
      world.simTick,
    );
    if (ok) {
      deactivateBallistic(room, i);
    } else {
      fallback.push({
        x: bp.x[i],
        y: bp.y[i],
        z: bp.z[i],
        vx: bp.vx[i],
        vy: bp.vy[i],
        vz: bp.vz[i],
        packedVoxel: val,
        flightTicks: bp.flightTicks[i],
        fuseTicks: bp.fuseTicks[i],
        flags: bp.flags[i],
      });
    }
  }
  return fallback;
}
