import {
  ARENA_CELLS,
  ARENA_D,
  ARENA_H,
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Z,
  GRAVITY_MODE,
  MAT,
  MATERIAL_SPEC,
  SLICE_STRIDE,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type GravityMode,
  type MaterialId,
} from './balance.ts';
import { hash32 } from './hash.ts';

// 32-bit Voxel Layout (§4.3)
// Bits 0..7   : MaterialID (0..12)
// Bits 8..15  : tempByte (0..255)
// Bits 16..21 : timerOrCharge (0..63)
// Bit  22     : steppedThisPass (0..1, transient)
// Bits 23..25 : shimmer (0..7)
// Bits 26..27 : slideDir (0..3)
// Bits 28..31 : damage (0..15)
export const PERSIST_MASK = 0xfc3fffff >>> 0;

export function packVoxel(
  mat: MaterialId,
  tempByte: number,
  timerOrCharge = 0,
  stepped = 0,
  shimmer = 0,
  slideDir = 0,
  damage = 0,
): number {
  return (
    ((mat & 0xff) |
      ((tempByte & 0xff) << 8) |
      ((timerOrCharge & 0x3f) << 16) |
      ((stepped & 1) << 22) |
      ((shimmer & 0x7) << 23) |
      ((slideDir & 0x3) << 26) |
      ((damage & 0xf) << 28)) >>>
    0
  );
}

export function getMat(v: number): MaterialId {
  return (v & 0xff) as MaterialId;
}

export function getTempByte(v: number): number {
  return (v >>> 8) & 0xff;
}

export function getTimerOrCharge(v: number): number {
  return (v >>> 16) & 0x3f;
}

export function getStepped(v: number): number {
  return (v >>> 22) & 1;
}

export function getShimmer(v: number): number {
  return (v >>> 23) & 0x7;
}

export function getSlideDir(v: number): number {
  return (v >>> 26) & 0x3;
}

export function getDamage(v: number): number {
  return (v >>> 28) & 0xf;
}

export function isSolidMat(mat: number): boolean {
  return (
    mat === MAT.ICE ||
    mat === MAT.GLASS_VAT ||
    mat === MAT.WOOD_BARRIER ||
    mat === MAT.HULL_STEEL ||
    mat === MAT.STEEL_GRATE ||
    mat === MAT.BOUNDARY_HULL
  );
}

export function isFluidOrGasMat(mat: number): boolean {
  return (
    mat === MAT.WATER ||
    mat === MAT.OIL ||
    mat === MAT.CRYO ||
    mat === MAT.STEAM ||
    mat === MAT.FIRE ||
    mat === MAT.ACID
  );
}

export function cellIndex(x: number, y: number, z: number): number {
  return y * SLICE_STRIDE + z * ARENA_W + x;
}

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return cy * (CHUNKS_X * CHUNKS_Z) + cz * CHUNKS_X + cx;
}

export function cellChunkIndex(x: number, y: number, z: number): number {
  return chunkIndex(x >> 4, y >> 4, z >> 4);
}

export interface VatRecord {
  id: number;
  mat: MaterialId;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  interiorLiters: number;
}

export interface DoorRecord {
  face: 'N' | 'S' | 'E' | 'W';
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  locked: boolean;
}

export interface ConservationLedgers {
  water: number;
  oil: number;
  cryo: number;
  acid: number;
  oilCombusted: number;
  cryoBoiledOff: number;
  acidConsumed: number;
}

export interface RoomState {
  roomSeed: number;
  roomW: number;
  roomH: number;
  roomD: number;
  gravityMode: GravityMode;
  grid: Uint32Array;
  outOfBounds: Uint8Array;
  dirtySolidMesh: Uint8Array;
  dirtyFluidRender: Uint8Array;
  dirtyDecals: Uint8Array;
  dirtySnapshot: Uint8Array;
  vats: VatRecord[];
  doors: DoorRecord[];
  ledgers: ConservationLedgers;
}

export function createEmptyRoomState(roomSeed = 1): RoomState {
  return {
    roomSeed: roomSeed >>> 0,
    roomW: ARENA_W,
    roomH: ARENA_H,
    roomD: ARENA_D,
    gravityMode: GRAVITY_MODE.G1,
    grid: new Uint32Array(ARENA_CELLS),
    outOfBounds: new Uint8Array(TOTAL_CHUNKS),
    dirtySolidMesh: new Uint8Array(TOTAL_CHUNKS),
    dirtyFluidRender: new Uint8Array(TOTAL_CHUNKS),
    dirtyDecals: new Uint8Array(TOTAL_CHUNKS),
    dirtySnapshot: new Uint8Array(TOTAL_CHUNKS),
    vats: [],
    doors: [],
    ledgers: {
      water: 0,
      oil: 0,
      cryo: 0,
      acid: 0,
      oilCombusted: 0,
      cryoBoiledOff: 0,
      acidConsumed: 0,
    },
  };
}

export function inRoomBounds(room: RoomState, x: number, y: number, z: number): boolean {
  return x >= 0 && x < room.roomW && y >= 0 && y < room.roomH && z >= 0 && z < room.roomD;
}

function markHalo(
  room: RoomState,
  flags: Uint8Array,
  x: number,
  y: number,
  z: number,
): void {
  const cx = x >> 4;
  const cy = y >> 4;
  const cz = z >> 4;
  const lx = x & 15;
  const ly = y & 15;
  const lz = z & 15;
  if (lx === 0 && cx > 0) flags[chunkIndex(cx - 1, cy, cz)] = 1;
  else if (lx === 15 && (cx + 1) * 16 < room.roomW) flags[chunkIndex(cx + 1, cy, cz)] = 1;
  if (ly === 0 && cy > 0) flags[chunkIndex(cx, cy - 1, cz)] = 1;
  else if (ly === 15 && (cy + 1) * 16 < room.roomH) flags[chunkIndex(cx, cy + 1, cz)] = 1;
  if (lz === 0 && cz > 0) flags[chunkIndex(cx, cy, cz - 1)] = 1;
  else if (lz === 15 && (cz + 1) * 16 < room.roomD) flags[chunkIndex(cx, cy, cz + 1)] = 1;
}

/**
 * Single grid-write choke point (§4.4).
 * Enforces dirtySnapshot, dirtySolidMesh + halo, dirtyDecals, and dirtyFluidRender + halo.
 */
export function markCellDirty(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  oldVal: number,
  newVal: number,
): void {
  const cIdx = cellChunkIndex(x, y, z);
  room.dirtySnapshot[cIdx] = 1;

  const oldMat = getMat(oldVal);
  const newMat = getMat(newVal);
  const oldSolid = isSolidMat(oldMat);
  const newSolid = isSolidMat(newMat);

  if (oldSolid !== newSolid || (oldSolid && oldMat !== newMat)) {
    room.dirtySolidMesh[cIdx] = 1;
    markHalo(room, room.dirtySolidMesh, x, y, z);
  }

  if (getDamage(oldVal) !== getDamage(newVal) || (oldSolid && !newSolid && getDamage(oldVal) > 0)) {
    room.dirtyDecals[cIdx] = 1;
  }

  const oldFluid = isFluidOrGasMat(oldMat);
  const newFluid = isFluidOrGasMat(newMat);
  const oldElec = oldFluid && getTimerOrCharge(oldVal) > 0;
  const newElec = newFluid && getTimerOrCharge(newVal) > 0;
  if ((oldMat !== newMat && (oldFluid || newFluid)) || oldElec !== newElec) {
    room.dirtyFluidRender[cIdx] = 1;
    markHalo(room, room.dirtyFluidRender, x, y, z);
  }
}

export function writeCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  newVal: number,
): void {
  const idx = cellIndex(x, y, z);
  const oldVal = room.grid[idx];
  if (oldVal === (newVal >>> 0)) return;
  let finalVal = newVal >>> 0;
  // Transitions/placements out of AIR seed deterministic shimmer (§4.3)
  if (getMat(oldVal) === MAT.AIR && getMat(finalVal) !== MAT.AIR && getShimmer(finalVal) === 0) {
    const shimmer = hash32(room.roomSeed, 0, idx) & 7;
    finalVal = (finalVal | (shimmer << 23)) >>> 0;
  }
  room.grid[idx] = finalVal;
  markCellDirty(room, x, y, z, oldVal, finalVal);
}

/**
 * Shared structural damage resolver (M1.1 minimal core; extended in M1.3 / M2.2).
 * Returns true if the cell was destroyed/carved to AIR.
 */
export function applyStructuralDamage(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  damageDelta: number,
  allowIceShatter = false,
): boolean {
  if (!inRoomBounds(room, x, y, z) || damageDelta <= 0) return false;
  const idx = cellIndex(x, y, z);
  const val = room.grid[idx];
  const mat = getMat(val);
  if (!isSolidMat(mat) || mat === MAT.BOUNDARY_HULL) return false;
  if (mat === MAT.ICE && !allowIceShatter) return false;

  const spec = MATERIAL_SPEC[mat];
  const nextDamage = Math.min(15, getDamage(val) + damageDelta);
  if (nextDamage >= spec.structHp) {
    writeCell(room, x, y, z, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT, 0, 0, 0, 0, 0));
    return true;
  }

  const updated = ((val & 0x0fffffff) | ((nextDamage & 0xf) << 28)) >>> 0;
  writeCell(room, x, y, z, updated);
  return false;
}

/**
 * Debug carve hotkey (1..6): carves a sphere of radius 1..6 voxels through
 * the shared structural resolver, strictly skipping BOUNDARY_HULL, ICE, and fluids.
 */
export function carveSphereDebug(
  room: RoomState,
  cx: number,
  cy: number,
  cz: number,
  radiusVoxels: number,
): number {
  const r = Math.max(1, Math.min(6, radiusVoxels | 0));
  const rSq = r * r;
  let carved = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= room.roomH) continue;
    for (let dz = -r; dz <= r; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= room.roomD) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > rSq) continue;
        const x = cx + dx;
        if (x < 0 || x >= room.roomW) continue;
        const mat = getMat(room.grid[cellIndex(x, y, z)]);
        if (!isSolidMat(mat) || mat === MAT.BOUNDARY_HULL || mat === MAT.ICE) continue;
        if (applyStructuralDamage(room, x, y, z, 15, false)) {
          carved++;
        }
      }
    }
  }
  return carved;
}

export interface VoxelRayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  mat: MaterialId;
  distM: number;
}

/**
 * 3D Amanatides-Woo DDA raycast in world meters against solid voxels.
 * Skips ceiling/South-East visual cutaway voxels when skipVisualCutaway is true.
 */
export function raycastSolidVoxel(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistM: number,
  skipVisualCutaway = false,
): VoxelRayHit | null {
  const ox = oxM / VOXEL_SIZE_M;
  const oy = oyM / VOXEL_SIZE_M;
  const oz = ozM / VOXEL_SIZE_M;
  const maxDistV = maxDistM / VOXEL_SIZE_M;

  // Clip ray to room AABB [0, roomW] x [0, roomH] x [0, roomD]
  let tMin = 0;
  let tMax = maxDistV;
  const invX = dx !== 0 ? 1 / dx : Infinity;
  const invY = dy !== 0 ? 1 / dy : Infinity;
  const invZ = dz !== 0 ? 1 / dz : Infinity;

  const tx1 = (0 - ox) * invX;
  const tx2 = (room.roomW - ox) * invX;
  tMin = Math.max(tMin, Math.min(tx1, tx2));
  tMax = Math.min(tMax, Math.max(tx1, tx2));

  const ty1 = (0 - oy) * invY;
  const ty2 = (room.roomH - oy) * invY;
  tMin = Math.max(tMin, Math.min(ty1, ty2));
  tMax = Math.min(tMax, Math.max(ty1, ty2));

  const tz1 = (0 - oz) * invZ;
  const tz2 = (room.roomD - oz) * invZ;
  tMin = Math.max(tMin, Math.min(tz1, tz2));
  tMax = Math.min(tMax, Math.max(tz1, tz2));

  if (tMax < tMin || tMax < 0) return null;

  const startT = Math.max(0, tMin + 1e-4);
  let x = Math.floor(ox + dx * startT);
  let y = Math.floor(oy + dy * startT);
  let z = Math.floor(oz + dz * startT);

  const stepX = dx >= 0 ? 1 : -1;
  const stepY = dy >= 0 ? 1 : -1;
  const stepZ = dz >= 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  const nextVoxelX = stepX > 0 ? x + 1 : x;
  const nextVoxelY = stepY > 0 ? y + 1 : y;
  const nextVoxelZ = stepZ > 0 ? z + 1 : z;

  let tMaxX = dx !== 0 ? (nextVoxelX - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? (nextVoxelY - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? (nextVoxelZ - oz) / dz : Infinity;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = startT;

  for (let steps = 0; steps < 1024 && t <= tMax; steps++) {
    if (inRoomBounds(room, x, y, z)) {
      const isCeilingCutaway = y >= room.roomH - 2;
      const isSECutaway = (x === room.roomW - 1 || z === room.roomD - 1) && y >= 8;
      if (!skipVisualCutaway || (!isCeilingCutaway && !isSECutaway)) {
        const mat = getMat(room.grid[cellIndex(x, y, z)]);
        if (isSolidMat(mat)) {
          return { x, y, z, nx, ny, nz, mat, distM: t * VOXEL_SIZE_M };
        }
      }
    }

    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
        nx = -stepX;
        ny = 0;
        nz = 0;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        nx = 0;
        ny = 0;
        nz = -stepZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
        nx = 0;
        ny = -stepY;
        nz = 0;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        nx = 0;
        ny = 0;
        nz = -stepZ;
      }
    }
  }

  return null;
}

export function countChunksForDims(w: number, h: number, d: number): number {
  return (w / 16) * (h / 16) * (d / 16);
}

export function recomputeRoomLedgers(room: RoomState): void {
  let water = 0;
  let oil = 0;
  let cryo = 0;
  let acid = 0;
  const g = room.grid;
  for (let y = 0; y < room.roomH; y++) {
    const yOff = y * SLICE_STRIDE;
    for (let z = 0; z < room.roomD; z++) {
      const row = yOff + z * ARENA_W;
      for (let x = 0; x < room.roomW; x++) {
        const mat = getMat(g[row + x]);
        if (mat === MAT.WATER || mat === MAT.ICE || mat === MAT.STEAM) water++;
        else if (mat === MAT.OIL) oil++;
        else if (mat === MAT.CRYO) cryo++;
        else if (mat === MAT.ACID) acid++;
      }
    }
  }
  room.ledgers.water = water;
  room.ledgers.oil = oil + room.ledgers.oilCombusted;
  room.ledgers.cryo = cryo + room.ledgers.cryoBoiledOff;
  room.ledgers.acid = acid + room.ledgers.acidConsumed;
}
