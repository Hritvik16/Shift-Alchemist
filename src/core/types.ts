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
  MAX_ACTIVE_BALLISTIC,
  MAX_ACTIVE_GRID_FLUID,
  MAX_ACTIVE_THERMAL_SOLIDS,
  MAX_DEFERRED_FLUID,
  SLICE_STRIDE,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type GravityMode,
  type MaterialId,
} from './balance.ts';
import { hash32 } from './hash.ts';

export const PERSIST_MASK = 0xfc3fffff >>> 0;
export const BITSET_WORDS = Math.ceil(ARENA_CELLS / 32); // 115,200

export const BALLISTIC_FLAG = {
  IGNITE_IN_FLIGHT: 1,
  FIRED_BY_PLAYER: 2,
  PRIMED: 4,
} as const;

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

export function isLiquidMat(mat: number): boolean {
  return mat === MAT.WATER || mat === MAT.OIL || mat === MAT.CRYO || mat === MAT.ACID;
}

export function isGasOrPlasmaMat(mat: number): boolean {
  return mat === MAT.STEAM || mat === MAT.FIRE;
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

export function isBallisticAllowedMat(mat: number): boolean {
  return (
    mat === MAT.WATER ||
    mat === MAT.OIL ||
    mat === MAT.CRYO ||
    mat === MAT.ICE ||
    mat === MAT.ACID
  );
}

export function isThermalSolidMat(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.STEEL_GRATE ||
    mat === MAT.ICE ||
    mat === MAT.WOOD_BARRIER
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

export interface BallisticPool {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  packedVoxel: Uint32Array;
  flightTicks: Uint16Array;
  fuseTicks: Uint16Array;
  flags: Uint8Array;
  active: Uint8Array;
  count: number;
  freeScanCursor: number;
}

export interface DeferredFluidQueue {
  mat: Uint8Array;
  tempByte: Uint8Array;
  chargeUnits: Uint8Array;
  targetX: Uint16Array;
  targetY: Uint16Array;
  targetZ: Uint16Array;
  head: number;
  tail: number;
  count: number;
}

export interface SerializedBallisticRecord {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  packedVoxel: number;
  flightTicks: number;
  fuseTicks: number;
  flags: number;
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
  chunkFluidVoxelCount: Uint16Array;
  dirtyDecals: Uint8Array;
  dirtySnapshot: Uint8Array;
  activeFluidCur: Int32Array;
  activeFluidNext: Int32Array;
  activeFluidCurCount: number;
  activeFluidNextCount: number;
  activeFluidBitsetCur: Uint32Array;
  activeFluidBitsetNext: Uint32Array;
  activeThermalCur: Int32Array;
  activeThermalNext: Int32Array;
  activeThermalCurCount: number;
  activeThermalNextCount: number;
  activeThermalBitsetCur: Uint32Array;
  activeThermalBitsetNext: Uint32Array;
  fluidOverflowFlag: Int32Array;
  thermalOverflowFlag: Int32Array;
  fluidOverflowCursor: number;
  thermalOverflowCursor: number;
  stage5Touched: Int32Array;
  stage5TouchedCount: number;
  ballistic: BallisticPool;
  deferredFluid: DeferredFluidQueue;
  pendingVatShatters: number[];
  sublimationEvents: Float32Array;
  sublimationEventCount: number;
  vats: VatRecord[];
  doors: DoorRecord[];
  ledgers: ConservationLedgers;
}

export function createBallisticPool(): BallisticPool {
  return {
    x: new Float32Array(MAX_ACTIVE_BALLISTIC),
    y: new Float32Array(MAX_ACTIVE_BALLISTIC),
    z: new Float32Array(MAX_ACTIVE_BALLISTIC),
    vx: new Float32Array(MAX_ACTIVE_BALLISTIC),
    vy: new Float32Array(MAX_ACTIVE_BALLISTIC),
    vz: new Float32Array(MAX_ACTIVE_BALLISTIC),
    packedVoxel: new Uint32Array(MAX_ACTIVE_BALLISTIC),
    flightTicks: new Uint16Array(MAX_ACTIVE_BALLISTIC),
    fuseTicks: new Uint16Array(MAX_ACTIVE_BALLISTIC),
    flags: new Uint8Array(MAX_ACTIVE_BALLISTIC),
    active: new Uint8Array(MAX_ACTIVE_BALLISTIC),
    count: 0,
    freeScanCursor: 0,
  };
}

export function createDeferredFluidQueue(): DeferredFluidQueue {
  return {
    mat: new Uint8Array(MAX_DEFERRED_FLUID),
    tempByte: new Uint8Array(MAX_DEFERRED_FLUID),
    chargeUnits: new Uint8Array(MAX_DEFERRED_FLUID),
    targetX: new Uint16Array(MAX_DEFERRED_FLUID),
    targetY: new Uint16Array(MAX_DEFERRED_FLUID),
    targetZ: new Uint16Array(MAX_DEFERRED_FLUID),
    head: 0,
    tail: 0,
    count: 0,
  };
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
    chunkFluidVoxelCount: new Uint16Array(TOTAL_CHUNKS),
    dirtyDecals: new Uint8Array(TOTAL_CHUNKS),
    dirtySnapshot: new Uint8Array(TOTAL_CHUNKS),
    activeFluidCur: new Int32Array(MAX_ACTIVE_GRID_FLUID),
    activeFluidNext: new Int32Array(MAX_ACTIVE_GRID_FLUID),
    activeFluidCurCount: 0,
    activeFluidNextCount: 0,
    activeFluidBitsetCur: new Uint32Array(BITSET_WORDS),
    activeFluidBitsetNext: new Uint32Array(BITSET_WORDS),
    activeThermalCur: new Int32Array(MAX_ACTIVE_THERMAL_SOLIDS),
    activeThermalNext: new Int32Array(MAX_ACTIVE_THERMAL_SOLIDS),
    activeThermalCurCount: 0,
    activeThermalNextCount: 0,
    activeThermalBitsetCur: new Uint32Array(BITSET_WORDS),
    activeThermalBitsetNext: new Uint32Array(BITSET_WORDS),
    fluidOverflowFlag: new Int32Array(TOTAL_CHUNKS),
    thermalOverflowFlag: new Int32Array(TOTAL_CHUNKS),
    fluidOverflowCursor: 0,
    thermalOverflowCursor: 0,
    stage5Touched: new Int32Array(MAX_ACTIVE_GRID_FLUID * 2),
    stage5TouchedCount: 0,
    ballistic: createBallisticPool(),
    deferredFluid: createDeferredFluidQueue(),
    pendingVatShatters: [],
    sublimationEvents: new Float32Array(128 * 3),
    sublimationEventCount: 0,
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

export function resetRoomRuntimeTransient(room: RoomState): void {
  for (let i = 0; i < room.activeFluidCurCount; i++) {
    const idx = room.activeFluidCur[i];
    room.activeFluidBitsetCur[idx >>> 5] &= ~(1 << (idx & 31));
  }
  for (let i = 0; i < room.activeFluidNextCount; i++) {
    const idx = room.activeFluidNext[i];
    room.activeFluidBitsetNext[idx >>> 5] &= ~(1 << (idx & 31));
  }
  for (let i = 0; i < room.activeThermalCurCount; i++) {
    const idx = room.activeThermalCur[i];
    room.activeThermalBitsetCur[idx >>> 5] &= ~(1 << (idx & 31));
  }
  for (let i = 0; i < room.activeThermalNextCount; i++) {
    const idx = room.activeThermalNext[i];
    room.activeThermalBitsetNext[idx >>> 5] &= ~(1 << (idx & 31));
  }
  room.activeFluidCurCount = 0;
  room.activeFluidNextCount = 0;
  room.activeThermalCurCount = 0;
  room.activeThermalNextCount = 0;
  room.fluidOverflowFlag.fill(0);
  room.thermalOverflowFlag.fill(0);
  room.fluidOverflowCursor = 0;
  room.thermalOverflowCursor = 0;
  room.stage5TouchedCount = 0;
  room.ballistic.active.fill(0);
  room.ballistic.count = 0;
  room.ballistic.freeScanCursor = 0;
  room.deferredFluid.head = 0;
  room.deferredFluid.tail = 0;
  room.deferredFluid.count = 0;
  room.pendingVatShatters.length = 0;
  room.sublimationEventCount = 0;
}

export function inRoomBounds(room: RoomState, x: number, y: number, z: number): boolean {
  return x >= 0 && x < room.roomW && y >= 0 && y < room.roomH && z >= 0 && z < room.roomD;
}

export function isExposedThermalSolid(
  room: RoomState,
  x: number,
  y: number,
  z: number,
): boolean {
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  if (x > 0 && !isSolidMat(getMat(g[idx - 1]))) return true;
  if (x + 1 < room.roomW && !isSolidMat(getMat(g[idx + 1]))) return true;
  if (z > 0 && !isSolidMat(getMat(g[idx - ARENA_W]))) return true;
  if (z + 1 < room.roomD && !isSolidMat(getMat(g[idx + ARENA_W]))) return true;
  if (y > 0 && !isSolidMat(getMat(g[idx - SLICE_STRIDE]))) return true;
  if (y + 1 < room.roomH && !isSolidMat(getMat(g[idx + SLICE_STRIDE]))) return true;
  return false;
}

export function isThermalSolidActiveEligible(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  val: number,
): boolean {
  const mat = getMat(val);
  if (!isThermalSolidMat(mat)) return false;
  if (!isExposedThermalSolid(room, x, y, z)) return false;
  const charge = getTimerOrCharge(val);
  if (charge > 0) return true;
  const temp = getTempByte(val);
  if (mat === MAT.ICE) return temp < TEMP_BYTE.FREEZE;
  return temp !== TEMP_BYTE.AMBIENT;
}

export function wakeCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  simTick = 1,
): void {
  if (!inRoomBounds(room, x, y, z)) return;
  const idx = cellIndex(x, y, z);
  const val = room.grid[idx];
  const mat = getMat(val);
  if (mat === MAT.AIR || mat === MAT.BOUNDARY_HULL || mat === MAT.GLASS_VAT) return;

  const word = idx >>> 5;
  const bit = 1 << (idx & 31);

  if (isFluidOrGasMat(mat)) {
    if ((room.activeFluidBitsetNext[word] & bit) !== 0) return;
    if (room.activeFluidNextCount < MAX_ACTIVE_GRID_FLUID) {
      room.activeFluidBitsetNext[word] |= bit;
      room.activeFluidNext[room.activeFluidNextCount++] = idx;
    } else {
      const cIdx = cellChunkIndex(x, y, z);
      if (room.fluidOverflowFlag[cIdx] === 0) {
        room.fluidOverflowFlag[cIdx] = simTick > 0 ? simTick : 1;
      }
    }
    return;
  }

  if (isThermalSolidActiveEligible(room, x, y, z, val)) {
    if ((room.activeThermalBitsetNext[word] & bit) !== 0) return;
    if (room.activeThermalNextCount < MAX_ACTIVE_THERMAL_SOLIDS) {
      room.activeThermalBitsetNext[word] |= bit;
      room.activeThermalNext[room.activeThermalNextCount++] = idx;
    } else {
      const cIdx = cellChunkIndex(x, y, z);
      if (room.thermalOverflowFlag[cIdx] === 0) {
        room.thermalOverflowFlag[cIdx] = simTick > 0 ? simTick : 1;
      }
    }
  }
}

export function wake6Neighbors(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  simTick = 1,
): void {
  if (x > 0) wakeCell(room, x - 1, y, z, simTick);
  if (x + 1 < room.roomW) wakeCell(room, x + 1, y, z, simTick);
  if (y > 0) wakeCell(room, x, y - 1, z, simTick);
  if (y + 1 < room.roomH) wakeCell(room, x, y + 1, z, simTick);
  if (z > 0) wakeCell(room, x, y, z - 1, simTick);
  if (z + 1 < room.roomD) wakeCell(room, x, y, z + 1, simTick);
}

export function wake26Neighbors(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  simTick = 1,
): void {
  const x0 = x > 0 ? x - 1 : 0;
  const x1 = x + 1 < room.roomW ? x + 1 : room.roomW - 1;
  const y0 = y > 0 ? y - 1 : 0;
  const y1 = y + 1 < room.roomH ? y + 1 : room.roomH - 1;
  const z0 = z > 0 ? z - 1 : 0;
  const z1 = z + 1 < room.roomD ? z + 1 : room.roomD - 1;
  for (let ny = y0; ny <= y1; ny++) {
    for (let nz = z0; nz <= z1; nz++) {
      for (let nx = x0; nx <= x1; nx++) {
        if (nx === x && ny === y && nz === z) continue;
        wakeCell(room, nx, ny, nz, simTick);
      }
    }
  }
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

export function markFluidRenderDirty(
  room: RoomState,
  x: number,
  y: number,
  z: number,
): void {
  const cIdx = cellChunkIndex(x, y, z);
  room.dirtyFluidRender[cIdx] = 1;
  markHalo(room, room.dirtyFluidRender, x, y, z);
}

export function markCellDirty(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  oldVal: number,
  newVal: number,
  simTick = 1,
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
  if (oldFluid !== newFluid) {
    if (newFluid) room.chunkFluidVoxelCount[cIdx]++;
    else if (room.chunkFluidVoxelCount[cIdx] > 0) room.chunkFluidVoxelCount[cIdx]--;
  }
  const oldElec = oldFluid && getTimerOrCharge(oldVal) > 0;
  const newElec = newFluid && getTimerOrCharge(newVal) > 0;
  if ((oldMat !== newMat && (oldFluid || newFluid)) || oldElec !== newElec) {
    markFluidRenderDirty(room, x, y, z);
  }

  wakeCell(room, x, y, z, simTick);
  wake6Neighbors(room, x, y, z, simTick);
}

export function writeCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  newVal: number,
  simTick = 1,
): void {
  const idx = cellIndex(x, y, z);
  const oldVal = room.grid[idx];
  let finalVal = newVal >>> 0;
  if (getMat(oldVal) === MAT.AIR && getMat(finalVal) !== MAT.AIR && getShimmer(finalVal) === 0) {
    const shimmer = hash32(room.roomSeed, 0, idx) & 7;
    finalVal = (finalVal | (shimmer << 23)) >>> 0;
  }
  if (oldVal === finalVal) return;
  room.grid[idx] = finalVal;
  markCellDirty(room, x, y, z, oldVal, finalVal, simTick);
}

export function moveCell(
  room: RoomState,
  sx: number,
  sy: number,
  sz: number,
  dx: number,
  dy: number,
  dz: number,
  simTick = 1,
): void {
  const sIdx = cellIndex(sx, sy, sz);
  const dIdx = cellIndex(dx, dy, dz);
  const srcVal = room.grid[sIdx];
  const oldDstVal = room.grid[dIdx];
  const airVal = packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT, 0, 0, 0, 0, 0);
  const movedVal = (srcVal | (1 << 22)) >>> 0;

  room.grid[sIdx] = airVal;
  room.grid[dIdx] = movedVal;

  markCellDirty(room, sx, sy, sz, srcVal, airVal, simTick);
  markCellDirty(room, dx, dy, dz, oldDstVal, movedVal, simTick);
  wake26Neighbors(room, sx, sy, sz, simTick);
}

export function swapCells(
  room: RoomState,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  simTick = 1,
): void {
  const aIdx = cellIndex(ax, ay, az);
  const bIdx = cellIndex(bx, by, bz);
  const oldA = room.grid[aIdx];
  const oldB = room.grid[bIdx];
  const newA = (oldB | (1 << 22)) >>> 0;
  const newB = (oldA | (1 << 22)) >>> 0;

  room.grid[aIdx] = newA;
  room.grid[bIdx] = newB;

  markCellDirty(room, ax, ay, az, oldA, newA, simTick);
  markCellDirty(room, bx, by, bz, oldB, newB, simTick);
  wake26Neighbors(room, ax, ay, az, simTick);
  wake26Neighbors(room, bx, by, bz, simTick);
}

export function recordStage5Touched(room: RoomState, idx: number): void {
  if (room.stage5TouchedCount < room.stage5Touched.length) {
    room.stage5Touched[room.stage5TouchedCount++] = idx;
  }
}

export function transitionCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  newMat: MaterialId,
  newTempByte: number,
  simTick = 1,
): void {
  const idx = cellIndex(x, y, z);
  const oldVal = room.grid[idx];
  const oldMat = getMat(oldVal);

  let temp = newTempByte < 0 ? 0 : newTempByte > 255 ? 255 : newTempByte | 0;
  let timerOrCharge = 0;
  let slideDir = 0;
  let shimmer = newMat === MAT.AIR ? 0 : getShimmer(oldVal);
  if (oldMat === MAT.AIR && newMat !== MAT.AIR) {
    shimmer = hash32(room.roomSeed, 0, idx) & 7;
  }

  if (newMat === MAT.ICE) {
    temp = Math.min(temp, TEMP_BYTE.FREEZE);
  } else if (newMat === MAT.STEAM) {
    temp = TEMP_BYTE.BOIL;
    timerOrCharge = 45;
  } else if (newMat === MAT.WATER) {
    if (oldMat === MAT.ICE) temp = Math.max(temp, TEMP_BYTE.MELT);
    else if (oldMat === MAT.STEAM) temp = Math.min(temp, TEMP_BYTE.STEAM_CONDENSE);
    slideDir = hash32(room.roomSeed, simTick, idx) & 3;
  } else if (newMat === MAT.FIRE) {
    temp = TEMP_BYTE.FIRE;
    timerOrCharge = 30;
  } else if (newMat === MAT.AIR) {
    temp = TEMP_BYTE.AMBIENT;
    shimmer = 0;
  }

  const nextVal = packVoxel(newMat, temp, timerOrCharge, 1, shimmer, slideDir, 0);
  room.grid[idx] = nextVal;
  recordStage5Touched(room, idx);

  if (isThermalSolidMat(oldMat) && !isThermalSolidMat(newMat)) {
    const word = idx >>> 5;
    const bit = 1 << (idx & 31);
    room.activeThermalBitsetNext[word] &= ~bit;
  }

  markCellDirty(room, x, y, z, oldVal, nextVal, simTick);
}

export function applyStructuralDamage(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  damageDelta: number,
  allowIceShatter = false,
  simTick = 1,
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
    if (mat === MAT.ICE) {
      // §7 & Stage 6: ICE shatters 1:1 to Ballistic(ICE) only if a slot exists; else stays at damage = HP-1
      const bp = room.ballistic;
      if (bp.count >= MAX_ACTIVE_BALLISTIC) {
        const clamped = ((val & 0x0fffffff) | (((spec.structHp - 1) & 0xf) << 28)) >>> 0;
        writeCell(room, x, y, z, clamped, simTick);
        return false;
      }
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
      if (slot === -1) {
        const clamped = ((val & 0x0fffffff) | (((spec.structHp - 1) & 0xf) << 28)) >>> 0;
        writeCell(room, x, y, z, clamped, simTick);
        return false;
      }
      bp.active[slot] = 1;
      bp.x[slot] = (x + 0.5) * VOXEL_SIZE_M;
      bp.y[slot] = (y + 0.5) * VOXEL_SIZE_M;
      bp.z[slot] = (z + 0.5) * VOXEL_SIZE_M;
      bp.vx[slot] = 0;
      bp.vy[slot] = 0;
      bp.vz[slot] = 0;
      bp.packedVoxel[slot] = (val & ~(1 << 22)) >>> 0;
      bp.flightTicks[slot] = 0;
      bp.fuseTicks[slot] = 0;
      bp.flags[slot] = 0;
      bp.count++;
      transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
      return true;
    }
    transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
    if (mat === MAT.GLASS_VAT) {
      room.pendingVatShatters.push(idx);
    }
    return true;
  }

  const updated = ((val & 0x0fffffff) | ((nextDamage & 0xf) << 28)) >>> 0;
  writeCell(room, x, y, z, updated, simTick);
  return false;
}

export function carveSphereDebug(
  room: RoomState,
  cx: number,
  cy: number,
  cz: number,
  radiusVoxels: number,
  simTick = 1,
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
        if (applyStructuralDamage(room, x, y, z, 15, false, simTick)) {
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

export function recountChunkFluids(room: RoomState): void {
  room.chunkFluidVoxelCount.fill(0);
  const g = room.grid;
  for (let y = 0; y < room.roomH; y++) {
    const yOff = y * SLICE_STRIDE;
    const cyOff = (y >> 4) * (CHUNKS_X * CHUNKS_Z);
    for (let z = 0; z < room.roomD; z++) {
      const row = yOff + z * ARENA_W;
      const czOff = cyOff + (z >> 4) * CHUNKS_X;
      for (let x = 0; x < room.roomW; x++) {
        if (isFluidOrGasMat(getMat(g[row + x]))) {
          room.chunkFluidVoxelCount[czOff + (x >> 4)]++;
        }
      }
    }
  }
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

  const bp = room.ballistic;
  if (bp.count > 0) {
    for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
      if (bp.active[i] === 0) continue;
      const mat = getMat(bp.packedVoxel[i]);
      if (mat === MAT.WATER || mat === MAT.ICE) water++;
      else if (mat === MAT.OIL) oil++;
      else if (mat === MAT.CRYO) cryo++;
      else if (mat === MAT.ACID) acid++;
    }
  }

  const dq = room.deferredFluid;
  for (let n = 0; n < dq.count; n++) {
    const slot = (dq.head + n) % MAX_DEFERRED_FLUID;
    const mat = dq.mat[slot];
    if (mat === MAT.WATER || mat === MAT.ICE || mat === MAT.STEAM) water++;
    else if (mat === MAT.OIL) oil++;
    else if (mat === MAT.CRYO) cryo++;
    else if (mat === MAT.ACID) acid++;
  }

  room.ledgers.water = water;
  room.ledgers.oil = oil + room.ledgers.oilCombusted;
  room.ledgers.cryo = cryo + room.ledgers.cryoBoiledOff;
  room.ledgers.acid = acid + room.ledgers.acidConsumed;
}
