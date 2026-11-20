import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CARGO_HOLD_DIMS,
  CARGO_POD_COUNT,
  DOOR_WIDTH_VOXELS,
  DOOR_Y_MAX,
  DOOR_Y_MIN,
  GRAVITY_MODE,
  MAT,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type MaterialId,
} from './balance.ts';
import { reseedActiveLists } from './fluids.ts';
import { hash32 } from './hash.ts';
import {
  cellIndex,
  chunkIndex,
  packVoxel,
  recomputeRoomLedgers,
  recountChunkFluids,
  resetRoomRuntimeTransient,
  type RoomState,
} from './types.ts';
import { createBroodPodEntity, createCrateEntity, type WorldState } from './world.ts';

function setInitCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  mat: MaterialId,
  tempByte: number,
): void {
  const idx = cellIndex(x, y, z);
  const shimmer = mat === MAT.AIR ? 0 : hash32(room.roomSeed, 0, idx) & 7;
  const slideDir =
    mat === MAT.WATER || mat === MAT.OIL || mat === MAT.CRYO || mat === MAT.ACID
      ? hash32(room.roomSeed, 1, idx) & 3
      : 0;
  room.grid[idx] = packVoxel(mat, tempByte, 0, 0, shimmer, slideDir, 0);
}

function fillBox(
  room: RoomState,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  mat: MaterialId,
  tempByte: number = TEMP_BYTE.AMBIENT,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        setInitCell(room, x, y, z, mat, tempByte);
      }
    }
  }
}

function buildGlassVatShell(
  room: RoomState,
  id: number,
  x0: number,
  y0: number,
  z0: number,
  w: number,
  h: number,
  d: number,
  fluidMat: MaterialId,
): void {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  const z1 = z0 + d - 1;
  const glassTemp = fluidMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  const fluidTemp = fluidMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const isShell =
          x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
        if (isShell) {
          setInitCell(room, x, y, z, MAT.GLASS_VAT, glassTemp);
        } else {
          setInitCell(room, x, y, z, fluidMat, fluidTemp);
        }
      }
    }
  }

  const interiorLiters = Math.max(0, w - 2) * Math.max(0, h - 2) * Math.max(0, d - 2);
  room.vats.push({
    id,
    mat: fluidMat,
    minX: x0,
    minY: y0,
    minZ: z0,
    maxX: x1,
    maxY: y1,
    maxZ: z1,
    centerX: (x0 + x1 + 1) * 0.5 * VOXEL_SIZE_M,
    centerY: (y0 + y1 + 1) * 0.5 * VOXEL_SIZE_M,
    centerZ: (z0 + z1 + 1) * 0.5 * VOXEL_SIZE_M,
    interiorLiters,
  });
}

export function generateCargoHold(room: RoomState, roomSeed: number): void {
  resetRoomRuntimeTransient(room);
  room.roomSeed = roomSeed >>> 0;
  room.roomW = CARGO_HOLD_DIMS.w;
  room.roomH = CARGO_HOLD_DIMS.h;
  room.roomD = CARGO_HOLD_DIMS.d;
  room.gravityMode = GRAVITY_MODE.G1;
  room.vats.length = 0;
  room.emitters.length = 0;
  room.doors.length = 0;
  room.ledgers = {
    water: 0,
    oil: 0,
    cryo: 0,
    acid: 0,
    oilCombusted: 0,
    cryoBoiledOff: 0,
    acidConsumed: 0,
  };

  room.grid.fill(packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT, 0, 0, 0, 0, 0));

  const W = room.roomW;
  const H = room.roomH;
  const D = room.roomD;

  fillBox(room, 0, 0, 0, W - 1, 0, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, H - 1, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, 0, W - 1, H - 1, 0, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, D - 1, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, 0, 0, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, W - 1, 0, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);

  fillBox(room, 1, H - 2, 1, W - 2, H - 2, D - 2, MAT.HULL_STEEL);
  fillBox(room, 1, 1, 1, W - 2, CARGO_DECK_TOP_Y - 1, D - 2, MAT.HULL_STEEL);

  const doorX0 = Math.floor((W - DOOR_WIDTH_VOXELS) / 2);
  const doorX1 = doorX0 + DOOR_WIDTH_VOXELS - 1;
  room.doors.push({
    face: 'N',
    minX: doorX0,
    maxX: doorX1,
    minY: DOOR_Y_MIN,
    maxY: DOOR_Y_MAX,
    minZ: 0,
    maxZ: 0,
    locked: false,
  });
  fillBox(room, doorX0, 2, 1, doorX1, CARGO_DECK_TOP_Y - 1, 20, MAT.AIR);
  for (let s = 0; s < 5; s++) {
    const zStart = 21 + s * 3;
    const zEnd = zStart + 2;
    const stepTopSolidY = 1 + (s + 1) * 2;
    if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
      fillBox(room, doorX0, stepTopSolidY + 1, zStart, doorX1, CARGO_DECK_TOP_Y - 1, zEnd, MAT.AIR);
    }
  }

  fillBox(room, 80, 2, 80, 159, CARGO_DECK_TOP_Y - 1, 159, MAT.AIR);
  for (let s = 0; s < 5; s++) {
    const xEnd = 94 - s * 3;
    const xStart = xEnd - 2;
    const topSolidY = 1 + (s + 1) * 2;
    fillBox(room, xStart, 2, 108, xEnd, topSolidY, 131, MAT.HULL_STEEL);
  }

  fillBox(room, 44, CARGO_CATWALK_Y_MIN, 144, 195, CARGO_CATWALK_Y_MAX, 175, MAT.STEEL_GRATE);
  fillBox(room, 144, CARGO_CATWALK_Y_MIN, 56, 175, CARGO_CATWALK_Y_MAX, 143, MAT.STEEL_GRATE);

  const pillars: readonly [number, number][] = [
    [46, 146],
    [46, 170],
    [190, 146],
    [190, 170],
    [146, 58],
    [170, 58],
  ];
  for (const [px, pz] of pillars) {
    fillBox(room, px, CARGO_DECK_TOP_Y, pz, px + 3, CARGO_CATWALK_Y_MIN - 1, pz + 3, MAT.HULL_STEEL);
  }

  for (let s = 0; s < 13; s++) {
    const zStart = 105 + s * 3;
    const zEnd = zStart + 2;
    const stepTopSolidY = CARGO_DECK_TOP_Y - 1 + (s + 1) * 2;
    const stepBottomY = Math.max(CARGO_DECK_TOP_Y, stepTopSolidY - 1);
    fillBox(room, 48, stepBottomY, zStart, 67, stepTopSolidY, zEnd, MAT.HULL_STEEL);
  }
  fillBox(room, 48, CARGO_DECK_TOP_Y, 138, 49, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);
  fillBox(room, 66, CARGO_DECK_TOP_Y, 138, 67, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);

  // 4 pre-filled GLASS_VAT shells: 2 WATER, 1 OIL, 1 CRYO (2,548 L each = 10,192 L total)
  // One WATER vat sits on the elevated STEEL_GRATE catwalk so shattering floods straight through the grate
  buildGlassVatShell(room, 0, 24, CARGO_DECK_TOP_Y, 44, 16, 15, 16, MAT.WATER);
  buildGlassVatShell(room, 1, 144, CARGO_CATWALK_Y_MAX + 1, 82, 16, 15, 16, MAT.WATER);
  buildGlassVatShell(room, 2, 196, CARGO_DECK_TOP_Y, 194, 16, 15, 16, MAT.OIL);
  buildGlassVatShell(room, 3, 24, CARGO_DECK_TOP_Y, 194, 16, 15, 16, MAT.CRYO);

  fillBox(room, 66, CARGO_DECK_TOP_Y, 64, 95, CARGO_DECK_TOP_Y + 19, 66, MAT.WOOD_BARRIER);
  fillBox(room, 174, CARGO_DECK_TOP_Y, 102, 176, CARGO_DECK_TOP_Y + 19, 131, MAT.WOOD_BARRIER);
  fillBox(room, 96, CARGO_DECK_TOP_Y, 188, 125, CARGO_DECK_TOP_Y + 19, 190, MAT.WOOD_BARRIER);

  // Thermal Steam Vent: 0.3 m (3-voxel) floor-mounted HULL_STEEL housing (+300C plume above, §9)
  fillBox(room, 157, CARGO_DECK_TOP_Y, 193, 159, CARGO_DECK_TOP_Y + 2, 195, MAT.HULL_STEEL);
  room.emitters.push({
    kind: 'vent',
    x: 158,
    y: CARGO_DECK_TOP_Y,
    z: 194,
    faceDir: '+Y',
    timer: 0,
    reserveL: 0,
  });

  reseedActiveLists(room, 1);

  const cxMax = W >> 4;
  const cyMax = H >> 4;
  const czMax = D >> 4;
  for (let cy = 0; cy < ARENA_H >> 4; cy++) {
    for (let cz = 0; cz < ARENA_D >> 4; cz++) {
      for (let cx = 0; cx < ARENA_W >> 4; cx++) {
        const cIdx = chunkIndex(cx, cy, cz);
        const oob = cx >= cxMax || cy >= cyMax || cz >= czMax;
        room.outOfBounds[cIdx] = oob ? 1 : 0;
        room.dirtySolidMesh[cIdx] = oob ? 0 : 1;
        room.dirtyFluidRender[cIdx] = oob ? 0 : 1;
        room.dirtyDecals[cIdx] = 0;
        room.dirtySnapshot[cIdx] = 0;
      }
    }
  }

  if (room.outOfBounds.length !== TOTAL_CHUNKS) {
    throw new Error('Chunk array mismatch');
  }

  recountChunkFluids(room);
  recomputeRoomLedgers(room);
}

// Hand-authored Cargo Hold anchors (>= 1 m clear of vats, pillars, stairs, barriers)
const CARGO_POD_ANCHORS: readonly [number, number, number][] = [
  [5.2, 1.2, 7.6],     // West deck near WATER vat 0
  [18.8, 1.2, 5.2],    // North-East deck
  [12.0, 0.2, 12.0],   // Sunken pit center
  [18.6, 1.2, 15.2],   // East deck near OIL vat 2
  [6.0, 1.2, 20.4],    // South-West deck near CRYO vat 3
  [11.6, 3.8, 16.0],   // South STEEL_GRATE catwalk
  [16.0, 3.8, 11.4],   // East STEEL_GRATE catwalk
  [14.2, 1.2, 20.6],   // South-Central deck
  [21.2, 1.2, 11.4],   // Far-East deck
  [2.8, 1.2, 13.0],    // Far-West deck
];

const CARGO_CRATE_ANCHORS: readonly [number, number, number][] = [
  [10.8, 1.2, 4.8],    // North-Central deck (easy first punt)
  [15.4, 1.2, 4.6],    // North-East approach
  [6.2, 1.2, 18.2],    // South-West near CRYO vat
  [17.6, 1.2, 17.8],   // South-East near OIL vat
  [10.2, 0.2, 10.6],   // Inside sunken pit (buoyancy test)
  [8.4, 3.8, 16.0],    // On elevated STEEL_GRATE catwalk
  [19.2, 1.2, 8.2],    // East mid-deck
  [13.4, 1.2, 19.6],   // South deck
];

function deterministicShuffleIndices(count: number, seed: number, salt: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < count; i++) arr.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = hash32(seed, salt, i) % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Seeds 6 Brood Pods and 6 movable WOOD_CRATEs (including 1 Bio-Cache) onto
 * hand-authored Cargo Hold anchors deterministically from roomSeed (§9, §10.0).
 */
export function populateCargoHoldEntities(world: WorldState): void {
  world.entities.length = 0;
  world.nextEntityId = 1;
  world.lockOn = null;
  world.kills = 0;
  world.runCleared = false;
  world.clearTimeS = 0;

  const seed = world.room.roomSeed;
  const podOrder = deterministicShuffleIndices(CARGO_POD_ANCHORS.length, seed, 701);
  const podCount = Math.min(CARGO_POD_COUNT, CARGO_POD_ANCHORS.length);
  for (let i = 0; i < podCount; i++) {
    const [x, y, z] = CARGO_POD_ANCHORS[podOrder[i]];
    world.entities.push(createBroodPodEntity(world.nextEntityId++, x, y, z));
  }
  world.podsTotal = podCount;
  world.podsRemaining = podCount;

  const crateOrder = deterministicShuffleIndices(CARGO_CRATE_ANCHORS.length, seed, 709);
  const crateCount = 6;
  for (let i = 0; i < crateCount; i++) {
    const [x, y, z] = CARGO_CRATE_ANCHORS[crateOrder[i]];
    world.entities.push(createCrateEntity(world.nextEntityId++, x, y, z, i === 0));
  }
}
