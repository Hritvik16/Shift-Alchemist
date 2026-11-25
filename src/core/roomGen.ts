import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  ARRIVAL_DIMS,
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CARGO_HOLD_DIMS,
  CARGO_POD_COUNT,
  CORRIDOR_DIMS,
  DOOR_WIDTH_VOXELS,
  DOOR_Y_MAX,
  DOOR_Y_MIN,
  GRAVITY_MODE,
  MAT,
  REACTOR_DIMS,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type MaterialId,
  type RoomDims,
} from './balance.ts';
import {
  getDoorSpawnPoint,
  getRoomDimsForTemplate,
  type DeckDoorLink,
  type DeckRoomNode,
} from './deckGen.ts';
import { reseedActiveLists } from './fluids.ts';
import { generateParametricArena, populateParametricArenaEntities } from './setpieces.ts';
import { hash32 } from './hash.ts';
import {
  cellIndex,
  chunkIndex,
  createDefaultWorkbenchState,
  packVoxel,
  recomputeRoomLedgers,
  recountChunkFluids,
  resetRoomRuntimeTransient,
  type DoorRecord,
  type RoomState,
} from './types.ts';
import { createBroodPodEntity, createCrateEntity, createSkittererEntity, type WorldState } from './world.ts';

const DEFAULT_CARGO_DOOR: readonly DeckDoorLink[] = [
  { face: 'N', targetRoomId: null, targetFace: null, isExtraction: false },
];

function setInitCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  mat: MaterialId,
  tempByte: number,
  damage = 0,
): void {
  const idx = cellIndex(x, y, z);
  const shimmer = mat === MAT.AIR ? 0 : hash32(room.roomSeed, 0, idx) & 7;
  const slideDir =
    mat === MAT.WATER || mat === MAT.OIL || mat === MAT.CRYO || mat === MAT.ACID
      ? hash32(room.roomSeed, 1, idx) & 3
      : 0;
  room.grid[idx] = packVoxel(mat, tempByte, 0, 0, shimmer, slideDir, damage);
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
  damage = 0,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        setInitCell(room, x, y, z, mat, tempByte, damage);
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

function pickWeightedVatMat(roomSeed: number, slot: number): MaterialId {
  // §9 weights: WATER 2 : OIL 1 : CRYO 1
  const r = hash32(roomSeed, 521, slot) & 3;
  if (r <= 1) return MAT.WATER;
  return r === 2 ? MAT.OIL : MAT.CRYO;
}

function makeDoorRecord(
  W: number,
  D: number,
  link: DeckDoorLink,
  locked: boolean,
): DoorRecord {
  const doorX0 = Math.floor((W - DOOR_WIDTH_VOXELS) / 2);
  const doorX1 = doorX0 + DOOR_WIDTH_VOXELS - 1;
  const doorZ0 = Math.floor((D - DOOR_WIDTH_VOXELS) / 2);
  const doorZ1 = doorZ0 + DOOR_WIDTH_VOXELS - 1;

  if (link.face === 'N') {
    return {
      face: 'N',
      minX: doorX0,
      maxX: doorX1,
      minY: DOOR_Y_MIN,
      maxY: DOOR_Y_MAX,
      minZ: 0,
      maxZ: 0,
      locked,
      targetRoomId: link.targetRoomId,
      targetFace: link.targetFace,
      isExtraction: link.isExtraction,
    };
  }
  if (link.face === 'S') {
    return {
      face: 'S',
      minX: doorX0,
      maxX: doorX1,
      minY: DOOR_Y_MIN,
      maxY: DOOR_Y_MAX,
      minZ: D - 1,
      maxZ: D - 1,
      locked,
      targetRoomId: link.targetRoomId,
      targetFace: link.targetFace,
      isExtraction: link.isExtraction,
    };
  }
  if (link.face === 'W') {
    return {
      face: 'W',
      minX: 0,
      maxX: 0,
      minY: DOOR_Y_MIN,
      maxY: DOOR_Y_MAX,
      minZ: doorZ0,
      maxZ: doorZ1,
      locked,
      targetRoomId: link.targetRoomId,
      targetFace: link.targetFace,
      isExtraction: link.isExtraction,
    };
  }
  return {
    face: 'E',
    minX: W - 1,
    maxX: W - 1,
    minY: DOOR_Y_MIN,
    maxY: DOOR_Y_MAX,
    minZ: doorZ0,
    maxZ: doorZ1,
    locked,
    targetRoomId: link.targetRoomId,
    targetFace: link.targetFace,
    isExtraction: link.isExtraction,
  };
}

function initSealedShell(
  room: RoomState,
  dims: RoomDims,
  roomSeed: number,
  roomId: number,
  cleared: boolean,
  alcoveIndex: 0 | 1 | 2,
  floorSolidTopY: number,
): void {
  resetRoomRuntimeTransient(room);
  room.roomId = roomId;
  room.roomSeed = roomSeed >>> 0;
  room.setpieces = [];
  room.cleared = cleared;
  room.workbenchAlcoveIndex = alcoveIndex;
  room.workbenchTerminals.length = 0;
  room.workbenchState = createDefaultWorkbenchState();
  room.roomW = dims.w;
  room.roomH = dims.h;
  room.roomD = dims.d;
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

  const W = dims.w;
  const H = dims.h;
  const D = dims.d;

  // All 6 outer faces sealed with indestructible BOUNDARY_HULL (§4.2)
  fillBox(room, 0, 0, 0, W - 1, 0, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, H - 1, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, 0, W - 1, H - 1, 0, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, D - 1, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, 0, 0, 0, 0, H - 1, D - 1, MAT.BOUNDARY_HULL);
  fillBox(room, W - 1, 0, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);

  // Carvable interior ceiling + floor slab
  fillBox(room, 1, H - 2, 1, W - 2, H - 2, D - 2, MAT.HULL_STEEL);
  fillBox(room, 1, 1, 1, W - 2, floorSolidTopY, D - 2, MAT.HULL_STEEL);
}

function finalizeGeneratedRoom(room: RoomState): void {
  reseedActiveLists(room, 1);

  const cxMax = room.roomW >> 4;
  const cyMax = room.roomH >> 4;
  const czMax = room.roomD >> 4;
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

function addWorkbenchRowX(room: RoomState, startX: number, y: number, z: number): void {
  for (let i = 0; i < 4; i++) {
    room.workbenchTerminals.push({
      index: i as 0 | 1 | 2 | 3,
      x: startX + i * 0.6,
      y,
      z,
    });
  }
}

function addWorkbenchRowZ(room: RoomState, x: number, y: number, startZ: number): void {
  for (let i = 0; i < 4; i++) {
    room.workbenchTerminals.push({
      index: i as 0 | 1 | 2 | 3,
      x,
      y,
      z: startZ + i * 0.6,
    });
  }
}

function carveCargoVestibule(room: RoomState, door: DoorRecord): void {
  const W = room.roomW;
  const D = room.roomD;
  if (door.face === 'N') {
    fillBox(room, door.minX, 2, 1, door.maxX, CARGO_DECK_TOP_Y - 1, 20, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const zStart = 21 + s * 3;
      const zEnd = zStart + 2;
      const stepTopSolidY = 1 + (s + 1) * 2;
      if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
        fillBox(room, door.minX, stepTopSolidY + 1, zStart, door.maxX, CARGO_DECK_TOP_Y - 1, zEnd, MAT.AIR);
      }
    }
  } else if (door.face === 'S') {
    fillBox(room, door.minX, 2, D - 21, door.maxX, CARGO_DECK_TOP_Y - 1, D - 2, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const zEnd = D - 22 - s * 3;
      const zStart = zEnd - 2;
      const stepTopSolidY = 1 + (s + 1) * 2;
      if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
        fillBox(room, door.minX, stepTopSolidY + 1, zStart, door.maxX, CARGO_DECK_TOP_Y - 1, zEnd, MAT.AIR);
      }
    }
  } else if (door.face === 'W') {
    fillBox(room, 1, 2, door.minZ, 20, CARGO_DECK_TOP_Y - 1, door.maxZ, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const xStart = 21 + s * 3;
      const xEnd = xStart + 2;
      const stepTopSolidY = 1 + (s + 1) * 2;
      if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
        fillBox(room, xStart, stepTopSolidY + 1, door.minZ, xEnd, CARGO_DECK_TOP_Y - 1, door.maxZ, MAT.AIR);
      }
    }
  } else {
    fillBox(room, W - 21, 2, door.minZ, W - 2, CARGO_DECK_TOP_Y - 1, door.maxZ, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const xEnd = W - 22 - s * 3;
      const xStart = xEnd - 2;
      const stepTopSolidY = 1 + (s + 1) * 2;
      if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
        fillBox(room, xStart, stepTopSolidY + 1, door.minZ, xEnd, CARGO_DECK_TOP_Y - 1, door.maxZ, MAT.AIR);
      }
    }
  }
}

/**
 * Arrival Airlock (80 x 48 x 80, 75 chunks):
 * Diegetic onboarding — cracked WATER vat + starter puddle + separate wall-mounted Sparking Conduit (§4.2, §9).
 */
export function generateArrivalRoom(
  room: RoomState,
  roomSeed: number,
  doors: readonly DeckDoorLink[] = DEFAULT_CARGO_DOOR,
  roomId = 0,
): void {
  initSealedShell(room, ARRIVAL_DIMS, roomSeed, roomId, true, 0, 1);

  for (let i = 0; i < doors.length; i++) {
    room.doors.push(makeDoorRecord(ARRIVAL_DIMS.w, ARRIVAL_DIMS.d, doors[i], false));
  }

  // Cracked WATER vat in NW corner (clear of all 4 centered door bands x/z = 25..54)
  buildGlassVatShell(room, 0, 6, 2, 6, 16, 15, 16, MAT.WATER);
  // Pre-crack a 2x2 patch on the East glass wall (1 Air Burst shatters it)
  fillBox(room, 21, 5, 13, 21, 6, 14, MAT.GLASS_VAT, TEMP_BYTE.AMBIENT, 2);

  // Small non-electrified starter siphon puddle at SE corner of NW vat (clear of all 4 door Shift Gates)
  fillBox(room, 22, 2, 22, 27, 2, 27, MAT.WATER, TEMP_BYTE.AMBIENT);

  // 10-Second 0G SHIFT GATE: 2.0 m solid caution-rimmed bulkhead wrapping the exit door (open y=22..45 above!)
  // Forces the player to press [Q] (0G) + [E] (Ascend) to clear the wall within seconds of spawning
  for (let i = 0; i < room.doors.length; i++) {
    const d = room.doors[i];
    if (d.face === 'N') {
      fillBox(room, 24, 2, 15, 55, 21, 16, MAT.HULL_STEEL);
      fillBox(room, 24, 2, 1, 25, 21, 16, MAT.HULL_STEEL);
      fillBox(room, 54, 2, 1, 55, 21, 16, MAT.HULL_STEEL);
    } else if (d.face === 'S') {
      fillBox(room, 24, 2, 63, 55, 21, 64, MAT.HULL_STEEL);
      fillBox(room, 24, 2, 63, 25, 21, 78, MAT.HULL_STEEL);
      fillBox(room, 54, 2, 63, 55, 21, 78, MAT.HULL_STEEL);
    } else if (d.face === 'W') {
      fillBox(room, 15, 2, 24, 16, 21, 55, MAT.HULL_STEEL);
      fillBox(room, 1, 2, 24, 16, 21, 25, MAT.HULL_STEEL);
      fillBox(room, 1, 2, 54, 16, 21, 55, MAT.HULL_STEEL);
    } else if (d.face === 'E') {
      fillBox(room, 65, 2, 24, 66, 21, 55, MAT.HULL_STEEL);
      fillBox(room, 65, 2, 24, 78, 21, 25, MAT.HULL_STEEL);
      fillBox(room, 65, 2, 54, 78, 21, 55, MAT.HULL_STEEL);
    }
  }

  // Floor-level Tesla Power Node in NE quadrant (dry of starter puddle, effortless to bridge with water)
  fillBox(room, 58, 2, 13, 60, 4, 15, MAT.HULL_STEEL);
  room.emitters.push({
    kind: 'conduit',
    x: 59,
    y: 3,
    z: 14,
    faceDir: '+Z',
    timer: 0,
    reserveL: 0,
  });

  finalizeGeneratedRoom(room);
}

/**
 * Optional Salvage Side-Room (80 x 48 x 80, 75 chunks):
 * 1 seeded GLASS_VAT (2,016 L), no aliens, starts unlocked (§9).
 */
export function generateSideRoom(
  room: RoomState,
  roomSeed: number,
  doors: readonly DeckDoorLink[] = DEFAULT_CARGO_DOOR,
  roomId = 0,
): void {
  initSealedShell(room, ARRIVAL_DIMS, roomSeed, roomId, true, 0, 1);

  for (let i = 0; i < doors.length; i++) {
    room.doors.push(makeDoorRecord(ARRIVAL_DIMS.w, ARRIVAL_DIMS.d, doors[i], false));
  }

  // Single 2,016 L vat in NW corner (16x14x14 -> 14x12x12 = 2,016 L), clear of all 4 doors
  const vatMat = pickWeightedVatMat(roomSeed, 0);
  buildGlassVatShell(room, 0, 6, 2, 6, 16, 14, 14, vatMat);

  finalizeGeneratedRoom(room);
}

/**
 * Tight Corridor (80 x 48 x 240, 225 chunks):
 * 2 GLASS_VATs (2,548 L each), 2 WOOD_BARRIER cover walls, optional Thermal Vent (§4.2, §9).
 */
export function generateCorridorRoom(
  room: RoomState,
  roomSeed: number,
  doors: readonly DeckDoorLink[] = DEFAULT_CARGO_DOOR,
  alcoveIndex: 0 | 1 | 2 = 0,
  roomId = 0,
  combatIndex = 1,
): void {
  initSealedShell(room, CORRIDOR_DIMS, roomSeed, roomId, false, alcoveIndex, 1);

  for (let i = 0; i < doors.length; i++) {
    room.doors.push(makeDoorRecord(CORRIDOR_DIMS.w, CORRIDOR_DIMS.d, doors[i], true));
  }

  // 2 vats spaced well apart and clear of N/S (x=25..54) & W/E (z=105..134) doors
  const mat0 = pickWeightedVatMat(roomSeed, 0);
  const mat1 = mat0 === MAT.WATER ? pickWeightedVatMat(roomSeed, 1) : MAT.WATER;
  buildGlassVatShell(room, 0, 6, 2, 54, 16, 15, 16, mat0);
  buildGlassVatShell(room, 1, 58, 2, 170, 16, 15, 16, mat1);

  // Staggered WOOD_BARRIER cover walls
  fillBox(room, 22, 2, 86, 48, 21, 88, MAT.WOOD_BARRIER);
  fillBox(room, 32, 2, 152, 58, 21, 154, MAT.WOOD_BARRIER);

  // Seeded Hazard Emitter from Combat Room 2 onward (Vent / Sparking Conduit / Leaking Cryo Pipe)
  if (combatIndex >= 2) {
    const kindPick = hash32(roomSeed, 563, combatIndex) % 3;
    if (kindPick === 0) {
      fillBox(room, 60, 2, 118, 62, 4, 120, MAT.HULL_STEEL);
      room.emitters.push({
        kind: 'vent',
        x: 61,
        y: 2,
        z: 119,
        faceDir: '+Y',
        timer: 0,
        reserveL: 0,
      });
    } else if (kindPick === 1) {
      fillBox(room, 76, 12, 62, 78, 14, 64, MAT.HULL_STEEL);
      room.emitters.push({
        kind: 'conduit',
        x: 77,
        y: 13,
        z: 63,
        faceDir: '-X',
        timer: 0,
        reserveL: 0,
      });
    } else {
      fillBox(room, 76, 12, 62, 78, 14, 64, MAT.HULL_STEEL);
      room.emitters.push({
        kind: 'cryo_pipe',
        x: 77,
        y: 13,
        z: 63,
        faceDir: '-X',
        timer: 0,
        reserveL: 500,
      });
    }
  }

  // Workbench alcove along West wall near North end (clear of N door, Vat 0, W door)
  if (alcoveIndex > 0) {
    addWorkbenchRowZ(room, 0.8, 0.2, 2.0);
  }

  finalizeGeneratedRoom(room);
}

/**
 * Vertical Reactor Shaft (160 x 64 x 160, 400 chunks):
 * 10 x 10 m central pit (y=2..11 open above y=1 liner) + 5-step exit stairs,
 * 3 perimeter deck GLASS_VATs overlooking the pit, optional Thermal Vent (§4.2, §9).
 */
export function generateReactorRoom(
  room: RoomState,
  roomSeed: number,
  doors: readonly DeckDoorLink[] = DEFAULT_CARGO_DOOR,
  alcoveIndex: 0 | 1 | 2 = 0,
  roomId = 0,
  combatIndex = 1,
): void {
  initSealedShell(room, REACTOR_DIMS, roomSeed, roomId, false, alcoveIndex, CARGO_DECK_TOP_Y - 1);

  // 10 m x 10 m central reactor pit cutout (x=30..129, z=30..129, y=2..11 AIR)
  fillBox(room, 30, 2, 30, 129, CARGO_DECK_TOP_Y - 1, 129, MAT.AIR);

  // Level y=2 doorway tunnels opening straight into the 10x10 m pit
  for (let i = 0; i < doors.length; i++) {
    const d = makeDoorRecord(REACTOR_DIMS.w, REACTOR_DIMS.d, doors[i], true);
    room.doors.push(d);
    if (d.face === 'N') {
      fillBox(room, d.minX, 2, 1, d.maxX, CARGO_DECK_TOP_Y - 1, 29, MAT.AIR);
    } else if (d.face === 'S') {
      fillBox(room, d.minX, 2, 130, d.maxX, CARGO_DECK_TOP_Y - 1, 158, MAT.AIR);
    } else if (d.face === 'W') {
      fillBox(room, 1, 2, d.minZ, 29, CARGO_DECK_TOP_Y - 1, d.maxZ, MAT.AIR);
    } else {
      fillBox(room, 130, 2, d.minZ, 158, CARGO_DECK_TOP_Y - 1, d.maxZ, MAT.AIR);
    }
  }

  // Two 5-step walkable stairs climbing out of the pit onto the y=12 perimeter deck (clear of all doors)
  for (let s = 0; s < 5; s++) {
    const topSolidY = 1 + (s + 1) * 2;
    // West climb at z=32..51
    const wxEnd = 44 - s * 3;
    const wxStart = wxEnd - 2;
    fillBox(room, wxStart, 2, 32, wxEnd, topSolidY, 51, MAT.HULL_STEEL);
    // East climb at z=108..127
    const exStart = 115 + s * 3;
    const exEnd = exStart + 2;
    fillBox(room, exStart, 2, 108, exEnd, topSolidY, 127, MAT.HULL_STEEL);
  }

  // 3 perimeter corner GLASS_VATs overlooking the pit (2,548 L each)
  const vatCorners: readonly [number, number][] = [
    [8, 8],
    [136, 8],
    [8, 136],
    [136, 136],
  ];
  const skipCorner = hash32(roomSeed, 541, 0) & 3;
  let vatId = 0;
  for (let c = 0; c < vatCorners.length; c++) {
    if (c === skipCorner) continue;
    const [vx, vz] = vatCorners[c];
    const mat = vatId === 0 ? MAT.WATER : pickWeightedVatMat(roomSeed, vatId);
    buildGlassVatShell(room, vatId++, vx, CARGO_DECK_TOP_Y, vz, 16, 15, 16, mat);
  }

  // 2 WOOD_BARRIER cover walls inside the pit
  fillBox(room, 58, 2, 52, 82, 21, 54, MAT.WOOD_BARRIER);
  fillBox(room, 78, 2, 106, 102, 21, 108, MAT.WOOD_BARRIER);

  // Central Reactor Thermal Steam Vent on pit floor + wall-mounted Conduit/Cryo Pipe on East deck
  if (combatIndex >= 2) {
    fillBox(room, 79, 2, 79, 81, 4, 81, MAT.HULL_STEEL);
    room.emitters.push({
      kind: 'vent',
      x: 80,
      y: 2,
      z: 80,
      faceDir: '+Y',
      timer: 0,
      reserveL: 0,
    });
  }
  if (combatIndex >= 3) {
    const isPipe = (hash32(roomSeed, 569, combatIndex) & 1) === 1;
    fillBox(room, 156, 22, 42, 158, 24, 44, MAT.HULL_STEEL);
    room.emitters.push({
      kind: isPipe ? 'cryo_pipe' : 'conduit',
      x: 157,
      y: 23,
      z: 43,
      faceDir: '-X',
      timer: 0,
      reserveL: isPipe ? 500 : 0,
    });
  }

  // Workbench alcove on North perimeter deck (between NW vat x<=23 and N door x>=65)
  if (alcoveIndex > 0) {
    addWorkbenchRowX(room, 3.5, 1.2, 0.8);
  }

  finalizeGeneratedRoom(room);
}

/**
 * Main Cargo Hold (240 x 64 x 240, 900 chunks):
 * Preserves exact Tier A layout when called as generateCargoHold(room, seed).
 */
export function generateCargoHold(
  room: RoomState,
  roomSeed: number,
  doors: readonly DeckDoorLink[] = DEFAULT_CARGO_DOOR,
  alcoveIndex: 0 | 1 | 2 = 0,
  roomId = 0,
  seededVats = false,
): void {
  initSealedShell(room, CARGO_HOLD_DIMS, roomSeed, roomId, false, alcoveIndex, CARGO_DECK_TOP_Y - 1);

  const W = room.roomW;
  const D = room.roomD;

  for (let i = 0; i < doors.length; i++) {
    const locked = doors.length > 1 || doors[i].targetRoomId !== null || doors[i].isExtraction;
    const d = makeDoorRecord(W, D, doors[i], locked);
    room.doors.push(d);
    carveCargoVestibule(room, d);
  }

  // 8x8 m sunken pit + 5 walkable exit steps on West edge
  fillBox(room, 80, 2, 80, 159, CARGO_DECK_TOP_Y - 1, 159, MAT.AIR);
  for (let s = 0; s < 5; s++) {
    const xEnd = 94 - s * 3;
    const xStart = xEnd - 2;
    const topSolidY = 1 + (s + 1) * 2;
    fillBox(room, xStart, 2, 108, xEnd, topSolidY, 131, MAT.HULL_STEEL);
  }

  // L-shaped STEEL_GRATE catwalk at y=36..37 (2.4 m below & above)
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

  // 13-step catwalk stairs (1.2 m -> 3.8 m)
  for (let s = 0; s < 13; s++) {
    const zStart = 105 + s * 3;
    const zEnd = zStart + 2;
    const stepTopSolidY = CARGO_DECK_TOP_Y - 1 + (s + 1) * 2;
    const stepBottomY = Math.max(CARGO_DECK_TOP_Y, stepTopSolidY - 1);
    fillBox(room, 48, stepBottomY, zStart, 67, stepTopSolidY, zEnd, MAT.HULL_STEEL);
  }
  fillBox(room, 48, CARGO_DECK_TOP_Y, 138, 49, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);
  fillBox(room, 66, CARGO_DECK_TOP_Y, 138, 67, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);

  // 4 pre-filled GLASS_VAT shells (2,548 L each = 10,192 L total)
  const v0Mat = seededVats ? MAT.WATER : MAT.WATER;
  const v1Mat = seededVats ? pickWeightedVatMat(roomSeed, 1) : MAT.WATER;
  const v2Mat = seededVats ? pickWeightedVatMat(roomSeed, 2) : MAT.OIL;
  const v3Mat = seededVats ? pickWeightedVatMat(roomSeed, 3) : MAT.CRYO;
  buildGlassVatShell(room, 0, 24, CARGO_DECK_TOP_Y, 44, 16, 15, 16, v0Mat);
  buildGlassVatShell(room, 1, 144, CARGO_CATWALK_Y_MAX + 1, 82, 16, 15, 16, v1Mat);
  buildGlassVatShell(room, 2, 196, CARGO_DECK_TOP_Y, 194, 16, 15, 16, v2Mat);
  buildGlassVatShell(room, 3, 24, CARGO_DECK_TOP_Y, 194, 16, 15, 16, v3Mat);

  fillBox(room, 66, CARGO_DECK_TOP_Y, 64, 95, CARGO_DECK_TOP_Y + 19, 66, MAT.WOOD_BARRIER);
  fillBox(room, 174, CARGO_DECK_TOP_Y, 102, 176, CARGO_DECK_TOP_Y + 19, 131, MAT.WOOD_BARRIER);
  fillBox(room, 96, CARGO_DECK_TOP_Y, 188, 125, CARGO_DECK_TOP_Y + 19, 190, MAT.WOOD_BARRIER);

  // Thermal Steam Vent housing (+300C collar & plume)
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

  if (alcoveIndex > 0) {
    addWorkbenchRowX(room, 6.0, 1.2, 0.8);
  }

  finalizeGeneratedRoom(room);
}

/**
 * Generates any room template directly from a DeckRoomNode (§9).
 */
export function generateRoomFromNode(room: RoomState, node: DeckRoomNode): void {
  switch (node.template) {
    case 'arrival':
      generateArrivalRoom(room, node.roomSeed, node.doors, node.id);
      return;
    case 'side':
      generateSideRoom(room, node.roomSeed, node.doors, node.id);
      return;
    case 'corridor':
    case 'reactor':
    case 'cargo':
      generateParametricArena(room, node);
      return;
    case 'boss':
      generateCargoHold(
        room,
        node.roomSeed,
        node.doors,
        node.alcoveIndex,
        node.id,
        true,
      );
      return;
  }
}

// Hand-authored Cargo Hold anchors (>= 1 m clear of vats, pillars, stairs, barriers, vestibules)
const CARGO_POD_ANCHORS: readonly [number, number, number][] = [
  [5.2, 1.2, 7.6],
  [18.8, 1.2, 5.2],
  [12.0, 0.2, 12.0],
  [18.0, 1.2, 15.8],
  [6.0, 1.2, 20.4],
  [11.6, 3.8, 16.0],
  [16.0, 3.8, 11.4],
  [14.2, 1.2, 20.6],
  [21.2, 1.2, 8.0],
  [2.8, 1.2, 15.8],
];

const CARGO_CRATE_ANCHORS: readonly [number, number, number][] = [
  [10.8, 1.2, 4.8],
  [15.4, 1.2, 4.6],
  [6.2, 1.2, 18.2],
  [17.6, 1.2, 17.8],
  [10.2, 0.2, 10.6],
  [8.4, 3.8, 16.0],
  [19.2, 1.2, 8.2],
  [14.0, 1.2, 19.6],
];

const ARRIVAL_CRATE_ANCHORS: readonly [number, number, number][] = [
  [6.2, 0.2, 6.2],
  [1.8, 0.2, 6.2],
  [6.2, 0.2, 2.0],
];

const SIDE_CRATE_ANCHORS: readonly [number, number, number][] = [
  [6.2, 0.2, 1.6],
  [6.2, 0.2, 6.2],
  [1.6, 0.2, 6.2],
  [4.0, 0.2, 4.0],
  [5.0, 0.2, 5.0],
  [3.0, 0.2, 5.2],
];

const CORRIDOR_POD_ANCHORS: readonly [number, number, number][] = [
  [5.4, 0.2, 6.4],
  [2.6, 0.2, 10.4],
  [4.0, 0.2, 12.4],
  [5.4, 0.2, 14.0],
  [2.4, 0.2, 18.0],
  [5.6, 0.2, 20.0],
];

const CORRIDOR_CRATE_ANCHORS: readonly [number, number, number][] = [
  [5.6, 0.2, 4.2],
  [2.6, 0.2, 7.6],
  [5.4, 0.2, 10.0],
  [2.4, 0.2, 14.4],
  [2.4, 0.2, 16.4],
  [5.6, 0.2, 21.4],
];

const REACTOR_POD_ANCHORS: readonly [number, number, number][] = [
  [6.2, 0.2, 7.4],
  [9.8, 0.2, 8.6],
  [6.4, 0.2, 10.0],
  [10.0, 0.2, 6.2],
  [1.8, 1.2, 4.6],
  [14.2, 1.2, 11.4],
  [11.4, 1.2, 1.8],
  [4.6, 1.2, 14.2],
];

const REACTOR_CRATE_ANCHORS: readonly [number, number, number][] = [
  [5.0, 0.2, 7.0],
  [11.0, 0.2, 9.0],
  [8.0, 0.2, 4.2],
  [8.0, 0.2, 11.8],
  [1.8, 1.2, 11.4],
  [14.2, 1.2, 4.6],
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

function filterClearOfDoors(
  anchors: readonly [number, number, number][],
  node: DeckRoomNode,
  minDistM: number,
): [number, number, number][] {
  const dims = getRoomDimsForTemplate(node.template);
  const spawns = node.doors.map((d) => getDoorSpawnPoint(dims, d.face));
  const minDistSq = minDistM * minDistM;
  const out: [number, number, number][] = [];
  for (let i = 0; i < anchors.length; i++) {
    const [ax, ay, az] = anchors[i];
    let ok = true;
    for (let s = 0; s < spawns.length; s++) {
      const dx = ax - spawns[s].x;
      const dz = az - spawns[s].z;
      if (dx * dx + dz * dz < minDistSq) {
        ok = false;
        break;
      }
    }
    if (ok) out.push([ax, ay, az]);
  }
  return out;
}

/**
 * Seeds 6 Brood Pods and 6 movable WOOD_CRATEs (including 1 Bio-Cache) onto
 * hand-authored Cargo Hold anchors deterministically from roomSeed (§9, §10.0).
 * Preserved for single-room Tier A tests.
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

/**
 * Populates a generated deck room with deterministic hostiles (Brood Pods in M4.2-lite)
 * and crates/Bio-Caches per §9, keeping doorway spawn zones clear.
 */
export function populateRoomEntities(world: WorldState, node: DeckRoomNode): void {
  world.entities.length = 0;
  world.lockOn = null;

  const seed = node.roomSeed;

  if (node.template === 'arrival') {
    const clearCrates = filterClearOfDoors(ARRIVAL_CRATE_ANCHORS, node, 1.8);
    const order = deterministicShuffleIndices(clearCrates.length, seed, 711);
    const count = Math.min(2, clearCrates.length);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = clearCrates[order[i]];
      world.entities.push(createCrateEntity(world.nextEntityId++, x, y, z, false));
    }
    world.podsTotal = 0;
    world.podsRemaining = 0;
    world.room.entitiesRef = world.entities;
    recomputeRoomLedgers(world.room, world.playerTank);
    return;
  }

  if (node.template === 'side') {
    // §9: 2 Bio-Cache crates + 2..4 plain crates, 0 aliens
    const clearCrates = filterClearOfDoors(SIDE_CRATE_ANCHORS, node, 1.8);
    const order = deterministicShuffleIndices(clearCrates.length, seed, 719);
    const desired = 4 + (hash32(seed, 720, 0) % 3); // 4..6
    const count = Math.min(desired, clearCrates.length);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = clearCrates[order[i]];
      world.entities.push(createCrateEntity(world.nextEntityId++, x, y, z, i < 2));
    }
    world.podsTotal = 0;
    world.podsRemaining = 0;
    world.room.entitiesRef = world.entities;
    recomputeRoomLedgers(world.room, world.playerTank);
    return;
  }

  if (node.combatIndex > 0 && (node.template === 'corridor' || node.template === 'reactor' || node.template === 'cargo')) {
    populateParametricArenaEntities(world, node);
    return;
  }

  const rawPods =
    node.template === 'corridor'
      ? CORRIDOR_POD_ANCHORS
      : node.template === 'reactor'
        ? REACTOR_POD_ANCHORS
        : CARGO_POD_ANCHORS;
  const rawCrates =
    node.template === 'corridor'
      ? CORRIDOR_CRATE_ANCHORS
      : node.template === 'reactor'
        ? REACTOR_CRATE_ANCHORS
        : CARGO_CRATE_ANCHORS;

  const clearPods = filterClearOfDoors(rawPods, node, 3.0);
  const clearCrates = filterClearOfDoors(rawCrates, node, 2.2);

  // §9: 2..4 hostiles per combat room (scaling gently with combatIndex)
  const targetPods = Math.min(
    clearPods.length,
    node.combatIndex <= 2
      ? 2 + (hash32(seed, 731, 0) & 1) // 2..3
      : 3 + (hash32(seed, 731, 0) & 1), // 3..4
  );
  const podOrder = deterministicShuffleIndices(clearPods.length, seed, 733);
  const skittererTarget = Math.max(1, Math.ceil(targetPods * 0.6));
  for (let i = 0; i < targetPods; i++) {
    const [x, y, z] = clearPods[podOrder[i]];
    if (i < skittererTarget) {
      const glandMat = (hash32(seed, 751, i) & 1) === 0 ? MAT.OIL : MAT.WATER;
      world.entities.push(createSkittererEntity(world.nextEntityId++, x, y, z, glandMat));
    } else {
      const pod = createBroodPodEntity(world.nextEntityId++, x, y, z);
      const podMat = (hash32(seed, 757, i) & 1) === 0 ? MAT.OIL : MAT.CRYO;
      pod.glands.push({
        mat: podMat,
        liters: 12,
        capL: 12,
        tempByte: podMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT,
        chargeUnits: 0,
      });
      world.entities.push(pod);
    }
  }
  world.podsTotal = targetPods;
  world.podsRemaining = targetPods;

  // §9: 4..6 crates per combat room including 1 Bio-Cache
  const targetCrates = Math.min(clearCrates.length, 4 + (hash32(seed, 739, 0) % 3));
  const crateOrder = deterministicShuffleIndices(clearCrates.length, seed, 743);
  for (let i = 0; i < targetCrates; i++) {
    const [x, y, z] = clearCrates[crateOrder[i]];
    world.entities.push(createCrateEntity(world.nextEntityId++, x, y, z, i === 0));
  }
  world.room.entitiesRef = world.entities;
  recomputeRoomLedgers(world.room, world.playerTank);
}
