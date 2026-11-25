import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  BRUISER_D_M,
  BRUISER_H_M,
  BRUISER_W_M,
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CRATE_SIZE_M,
  DOOR_WIDTH_VOXELS,
  DOOR_Y_MAX,
  DOOR_Y_MIN,
  FLOATER_D_M,
  FLOATER_HEIGHT_M,
  FLOATER_W_M,
  GRAVITY_MODE,
  MAT,
  SKITTERER_D_M,
  SKITTERER_H_M,
  SKITTERER_W_M,
  SPITTER_D_M,
  SPITTER_H_M,
  SPITTER_W_M,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  type MaterialId,
  type RoomDims,
} from './balance.ts';
import { getDoorSpawnPoint, getRoomDimsForNode, type DeckDoorLink, type DeckRoomNode } from './deckGen.ts';
import { reseedActiveLists } from './fluids.ts';
import { hash32 } from './hash.ts';
import { aabbOverlapsSolid } from './physics.ts';
import {
  cellIndex,
  chunkIndex,
  createDefaultWorkbenchState,
  getMat,
  inRoomBounds,
  packVoxel,
  recomputeRoomLedgers,
  recountChunkFluids,
  resetRoomRuntimeTransient,
  type DoorRecord,
  type RoomState,
  type SetpieceId,
} from './types.ts';
import {
  createBruiserEntity,
  createCrateEntity,
  createFloaterEntity,
  createSkittererEntity,
  createSpitterEntity,
  type WorldState,
} from './world.ts';

interface RectXZ {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const DECK_Y = CARGO_DECK_TOP_Y; // 12 (1.2 m)
const LOFT_HEIGHT_V = 22; // 2.2 m above deck -> 3.4 m top
const GANTRY_Y0 = CARGO_CATWALK_Y_MIN; // 36 (3.6 m underside)
const GANTRY_Y1 = CARGO_CATWALK_Y_MAX; // 37 (3.8 m top)

function setInitCell(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  mat: MaterialId,
  tempByte: number = TEMP_BYTE.AMBIENT,
  damage = 0,
): void {
  if (!inRoomBounds(room, x, y, z)) return;
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
): void {
  const ax0 = Math.max(1, Math.min(x0, x1));
  const ax1 = Math.min(room.roomW - 2, Math.max(x0, x1));
  const ay0 = Math.max(1, Math.min(y0, y1));
  const ay1 = Math.min(room.roomH - 2, Math.max(y0, y1));
  const az0 = Math.max(1, Math.min(z0, z1));
  const az1 = Math.min(room.roomD - 2, Math.max(z0, z1));
  for (let y = ay0; y <= ay1; y++) {
    for (let z = az0; z <= az1; z++) {
      for (let x = ax0; x <= ax1; x++) {
        setInitCell(room, x, y, z, mat, tempByte, 0);
      }
    }
  }
}

function fillBoundaryShell(room: RoomState, W: number, H: number, D: number): void {
  const fillRaw = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          setInitCell(room, x, y, z, MAT.BOUNDARY_HULL, TEMP_BYTE.AMBIENT, 0);
        }
      }
    }
  };
  fillRaw(0, 0, 0, W - 1, 0, D - 1);
  fillRaw(0, H - 1, 0, W - 1, H - 1, D - 1);
  fillRaw(0, 0, 0, W - 1, H - 1, 0);
  fillRaw(0, 0, D - 1, W - 1, H - 1, D - 1);
  fillRaw(0, 0, 0, 0, H - 1, D - 1);
  fillRaw(W - 1, 0, 0, W - 1, H - 1, D - 1);
}

function rectsOverlap(a: RectXZ, b: RectXZ, pad = 2): boolean {
  return !(
    a.x1 + pad < b.x0 ||
    a.x0 - pad > b.x1 ||
    a.z1 + pad < b.z0 ||
    a.z0 - pad > b.z1
  );
}

function isRectClear(rect: RectXZ, reserved: readonly RectXZ[], room: RoomState, pad = 2): boolean {
  if (rect.x0 < 4 || rect.x1 > room.roomW - 5 || rect.z0 < 4 || rect.z1 > room.roomD - 5) {
    return false;
  }
  for (let i = 0; i < reserved.length; i++) {
    if (rectsOverlap(rect, reserved[i], pad)) return false;
  }
  return true;
}

function makeDoorRecord(W: number, D: number, link: DeckDoorLink, locked: boolean): DoorRecord {
  const doorX0 = Math.floor((W - DOOR_WIDTH_VOXELS) / 2);
  const doorX1 = doorX0 + DOOR_WIDTH_VOXELS - 1;
  const doorZ0 = Math.floor((D - DOOR_WIDTH_VOXELS) / 2);
  const doorZ1 = doorZ0 + DOOR_WIDTH_VOXELS - 1;

  if (link.face === 'N') {
    return { face: 'N', minX: doorX0, maxX: doorX1, minY: DOOR_Y_MIN, maxY: DOOR_Y_MAX, minZ: 0, maxZ: 0, locked, targetRoomId: link.targetRoomId, targetFace: link.targetFace, isExtraction: link.isExtraction };
  }
  if (link.face === 'S') {
    return { face: 'S', minX: doorX0, maxX: doorX1, minY: DOOR_Y_MIN, maxY: DOOR_Y_MAX, minZ: D - 1, maxZ: D - 1, locked, targetRoomId: link.targetRoomId, targetFace: link.targetFace, isExtraction: link.isExtraction };
  }
  if (link.face === 'W') {
    return { face: 'W', minX: 0, maxX: 0, minY: DOOR_Y_MIN, maxY: DOOR_Y_MAX, minZ: doorZ0, maxZ: doorZ1, locked, targetRoomId: link.targetRoomId, targetFace: link.targetFace, isExtraction: link.isExtraction };
  }
  return { face: 'E', minX: W - 1, maxX: W - 1, minY: DOOR_Y_MIN, maxY: DOOR_Y_MAX, minZ: doorZ0, maxZ: doorZ1, locked, targetRoomId: link.targetRoomId, targetFace: link.targetFace, isExtraction: link.isExtraction };
}

function carveCompactVestibule(room: RoomState, door: DoorRecord, reserved: RectXZ[]): void {
  const W = room.roomW;
  const D = room.roomD;
  if (door.face === 'N') {
    fillBox(room, door.minX, 2, 1, door.maxX, DECK_Y - 1, 14, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const z0 = 15 + s * 2;
      const topSolid = 1 + (s + 1) * 2;
      if (topSolid < DECK_Y - 1) fillBox(room, door.minX, topSolid + 1, z0, door.maxX, DECK_Y - 1, z0 + 1, MAT.AIR);
    }
    reserved.push({ x0: door.minX - 2, z0: 1, x1: door.maxX + 2, z1: 26 });
  } else if (door.face === 'S') {
    fillBox(room, door.minX, 2, D - 15, door.maxX, DECK_Y - 1, D - 2, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const z1 = D - 16 - s * 2;
      const topSolid = 1 + (s + 1) * 2;
      if (topSolid < DECK_Y - 1) fillBox(room, door.minX, topSolid + 1, z1 - 1, door.maxX, DECK_Y - 1, z1, MAT.AIR);
    }
    reserved.push({ x0: door.minX - 2, z0: D - 27, x1: door.maxX + 2, z1: D - 2 });
  } else if (door.face === 'W') {
    fillBox(room, 1, 2, door.minZ, 14, DECK_Y - 1, door.maxZ, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const x0 = 15 + s * 2;
      const topSolid = 1 + (s + 1) * 2;
      if (topSolid < DECK_Y - 1) fillBox(room, x0, topSolid + 1, door.minZ, x0 + 1, DECK_Y - 1, door.maxZ, MAT.AIR);
    }
    reserved.push({ x0: 1, z0: door.minZ - 2, x1: 26, z1: door.maxZ + 2 });
  } else {
    fillBox(room, W - 15, 2, door.minZ, W - 2, DECK_Y - 1, door.maxZ, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const x1 = W - 16 - s * 2;
      const topSolid = 1 + (s + 1) * 2;
      if (topSolid < DECK_Y - 1) fillBox(room, x1 - 1, topSolid + 1, door.minZ, x1, DECK_Y - 1, door.maxZ, MAT.AIR);
    }
    reserved.push({ x0: W - 27, z0: door.minZ - 2, x1: W - 2, z1: door.maxZ + 2 });
  }
}

function buildGlassVat(
  room: RoomState,
  x0: number,
  y0: number,
  z0: number,
  w: number,
  h: number,
  d: number,
  fluidMat: MaterialId,
  reserved: RectXZ[],
  ignoreReserved = false,
): boolean {
  const rect: RectXZ = { x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 };
  if (!ignoreReserved && !isRectClear(rect, reserved, room, 1)) return false;
  if (x0 < 3 || x0 + w - 1 > room.roomW - 4 || z0 < 3 || z0 + d - 1 > room.roomD - 4) return false;
  if (y0 < 2 || y0 + h - 1 > room.roomH - 4) return false;

  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  const z1 = z0 + d - 1;
  const glassTemp = fluidMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  const fluidTemp = fluidMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const isShell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
        setInitCell(room, x, y, z, isShell ? MAT.GLASS_VAT : fluidMat, isShell ? glassTemp : fluidTemp);
      }
    }
  }

  const interiorLiters = Math.max(0, w - 2) * Math.max(0, h - 2) * Math.max(0, d - 2);
  room.vats.push({
    id: room.vats.length,
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
  if (!ignoreReserved) reserved.push(rect);
  return true;
}

function tryPlaceVatInCandidates(
  room: RoomState,
  candidates: readonly [number, number][],
  y0: number,
  fluidMat: MaterialId,
  reserved: RectXZ[],
): boolean {
  for (let i = 0; i < candidates.length; i++) {
    const [vx, vz] = candidates[i];
    if (buildGlassVat(room, vx, y0, vz, 16, 14, 14, fluidMat, reserved)) {
      return true;
    }
  }
  return false;
}

function getCornerVatCandidates(W: number, D: number, seed: number): [number, number][] {
  const corners: [number, number][] = [
    [W - 24, 8],
    [8, D - 22],
    [W - 24, D - 22],
    [8, 8],
    [W - 24, Math.floor(D * 0.5) - 24],
    [8, Math.floor(D * 0.5) + 12],
  ];
  const rot = hash32(seed, 853, 0) % 4;
  return corners.slice(rot, 4).concat(corners.slice(0, rot), corners.slice(4));
}

// ============================================================================
// SLOT A: SHIFT-MANDATORY VERTICAL ARCHITECTURES (Q 0G / C 2G / V -1G)
// ============================================================================

/**
 * 1. FLOODED SUMP (Built for [V] -1G Inversion + [C] 2G Crush):
 * A broad STEEL_GRATE combat deck over a flooded lower sump of OIL or WATER.
 * Press [V] (-1G) to rain the sub-floor reservoir UPWARD through the grates onto enemies & igniters!
 */
function stampFloodedSump(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
): void {
  const cx = W >> 1;
  const cz = D >> 1;
  const halfX = Math.min(24, Math.max(18, Math.floor((W - 60) * 0.36)));
  const halfZ = Math.min(24, Math.max(18, Math.floor((D - 60) * 0.36)));
  const x0 = cx - halfX;
  const x1 = cx + halfX - 1;
  const z0 = cz - halfZ;
  const z1 = cz + halfZ - 1;

  // Hollow sub-floor basin (y=2..9 AIR) capped by permeable 2-voxel STEEL_GRATE combat deck (y=10..11)
  fillBox(room, x0, 2, z0, x1, DECK_Y - 3, z1, MAT.AIR);
  fillBox(room, x0, DECK_Y - 2, z0, x1, DECK_Y - 1, z1, MAT.STEEL_GRATE);

  // Fill sub-floor sump with OIL or WATER (~500-700 L ready to invert upward through the grates!)
  const sumpMat: MaterialId = (hash32(seed, 881, 0) & 1) === 0 ? MAT.OIL : MAT.WATER;
  for (let z = z0 + 2; z <= z1 - 2; z++) {
    for (let x = x0 + 2; x <= x1 - 2; x++) {
      if ((x + z) % 2 === 0 || (x >= cx - 8 && x <= cx + 8 && z >= cz - 8 && z <= cz + 8)) {
        setInitCell(room, x, 2, z, sumpMat, TEMP_BYTE.AMBIENT);
      }
    }
  }

  // Place the matching catalyst right on the sump's grate rim (Furnace Grate for OIL, Tesla Pylon for WATER)
  const catX = Math.min(W - 10, x1 + 3);
  const catZ = cz;
  const catRect: RectXZ = { x0: catX - 2, z0: catZ - 2, x1: catX + 2, z1: catZ + 2 };
  if (isRectClear(catRect, reserved, room, 1)) {
    fillBox(room, catX - 1, DECK_Y, catZ - 1, catX + 1, DECK_Y + 2, catZ + 1, MAT.HULL_STEEL);
    room.emitters.push({
      kind: sumpMat === MAT.OIL ? 'vent' : 'conduit',
      x: catX,
      y: sumpMat === MAT.OIL ? DECK_Y : DECK_Y + 1,
      z: catZ,
      faceDir: sumpMat === MAT.OIL ? '+Y' : '-X',
      timer: 0,
      reserveL: 0,
    });
    reserved.push(catRect);
  }
}

/**
 * 2. SPLIT-DECK CHASM (Built for [Q] 0G Traversal & 0G Hazard Punts):
 * Carves a caution-rimmed central hazard trench across the arena + a stairless 2.2 m elevated sniper balcony.
 * Shift to [Q] (0G) to cross/ascend or punt Bruisers & Floaters straight into the chasm hazards!
 */
function stampSplitChasm(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
): void {
  const cx = W >> 1;
  const cz = D >> 1;
  const horizontal = (hash32(seed, 887, 0) & 1) === 0;

  if (horizontal) {
    // East-West chasm spanning the middle (leaving clear perimeter margins for doors)
    const x0 = 28;
    const x1 = W - 29;
    const z0 = cz - 14;
    const z1 = cz + 13;
    fillBox(room, x0, 2, z0, x1, DECK_Y - 1, z1, MAT.AIR);

    // 5-step safety exit stairs on west end so player can climb out in 1G if needed
    for (let s = 0; s < 5; s++) {
      const sx1 = x0 + 9 - s * 2;
      fillBox(room, sx1 - 1, 2, cz - 5, sx1, 1 + (s + 1) * 2, cz + 5, MAT.HULL_STEEL);
    }

    // Chasm floor hazard: water + oil strip + center Furnace Grate (dry 4-voxel buffer so oil awaits player action)
    for (let x = x0 + 12; x <= x1 - 4; x++) {
      for (let z = z0 + 3; z <= z1 - 3; z++) {
        if (Math.abs(x - cx) <= 4 && Math.abs(z - cz) <= 4) continue;
        if ((x + z) % 2 === 0) {
          setInitCell(room, x, 2, z, x < cx ? MAT.OIL : MAT.WATER, TEMP_BYTE.AMBIENT);
        }
      }
    }
    fillBox(room, cx - 1, 2, cz - 1, cx + 1, 4, cz + 1, MAT.HULL_STEEL);
    room.emitters.push({ kind: 'vent', x: cx, y: 2, z: cz, faceDir: '+Y', timer: 0, reserveL: 0 });
  } else {
    // North-South chasm spanning the middle
    const x0 = cx - 14;
    const x1 = cx + 13;
    const z0 = 28;
    const z1 = D - 29;
    fillBox(room, x0, 2, z0, x1, DECK_Y - 1, z1, MAT.AIR);

    for (let s = 0; s < 5; s++) {
      const sz1 = z0 + 9 - s * 2;
      fillBox(room, cx - 5, 2, sz1 - 1, cx + 5, 1 + (s + 1) * 2, sz1, MAT.HULL_STEEL);
    }

    for (let z = z0 + 12; z <= z1 - 4; z++) {
      for (let x = x0 + 3; x <= x1 - 3; x++) {
        if (Math.abs(x - cx) <= 4 && Math.abs(z - cz) <= 4) continue;
        if ((x + z) % 2 === 0) {
          setInitCell(room, x, 2, z, z < cz ? MAT.OIL : MAT.WATER, TEMP_BYTE.AMBIENT);
        }
      }
    }
    fillBox(room, cx - 1, 2, cz - 1, cx + 1, 4, cz + 1, MAT.HULL_STEEL);
    room.emitters.push({ kind: 'vent', x: cx, y: 2, z: cz, faceDir: '+Y', timer: 0, reserveL: 0 });
  }

  // Stairless elevated 2.0 m tactical balcony (requires [Q] 0G to reach)
  const bx0 = Math.max(28, W - 48);
  const bz0 = Math.max(28, 28);
  const bRect: RectXZ = { x0: bx0, z0: bz0, x1: bx0 + 18, z1: bz0 + 18 };
  if (isRectClear(bRect, reserved, room, 2)) {
    fillBox(room, bx0, DECK_Y, bz0, bx0 + 18, DECK_Y + 19, bz0 + 18, MAT.HULL_STEEL);
    reserved.push(bRect);
  }
}

/**
 * 3. CEILING VATS & SUSPENDED GANTRIES (Built for [V] -1G & [Q] 0G Aerial Alchemy):
 * Suspends permeable STEEL_GRATE gantries at y = 36..37 (3.8 m) carrying overhead CRYO/WATER/OIL vats!
 * Shatter them to rain elemental floods through the grates onto enemies below, or hit [V] (-1G) to yank enemies upward!
 */
function stampCeilingVats(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
): void {
  const cx = W >> 1;
  const cz = D >> 1;
  const gx0 = Math.max(26, cx - 26);
  const gx1 = Math.min(W - 27, cx + 25);
  const gz0 = Math.max(26, cz - 10);
  const gz1 = Math.min(D - 27, cz + 9);

  // Elevated 2-voxel STEEL_GRATE bridge at y=36..37 (2.4 m clear below & above)
  fillBox(room, gx0, GANTRY_Y0, gz0, gx1, GANTRY_Y1, gz1, MAT.STEEL_GRATE);

  // 4 slender steel support columns anchoring the gantry corners
  const cols: readonly [number, number][] = [
    [gx0, gz0],
    [gx1 - 2, gz0],
    [gx0, gz1 - 2],
    [gx1 - 2, gz1 - 2],
  ];
  for (const [px, pz] of cols) {
    fillBox(room, px, DECK_Y, pz, px + 2, GANTRY_Y0 - 1, pz + 2, MAT.HULL_STEEL);
  }

  // Mount 2 suspended GLASS_VATs directly atop the STEEL_GRATE gantry (drain straight through grates on shatter!)
  const matA: MaterialId = (hash32(seed, 893, 0) & 1) === 0 ? MAT.CRYO : MAT.WATER;
  const matB: MaterialId = matA === MAT.WATER ? MAT.OIL : MAT.WATER;
  buildGlassVat(room, gx0 + 3, GANTRY_Y1 + 1, gz0 + 3, 16, 14, 14, matA, reserved, true);
  if (gx1 - gx0 >= 40) {
    buildGlassVat(room, gx1 - 19, GANTRY_Y1 + 1, gz0 + 3, 16, 14, 14, matB, reserved, true);
  }
}

// ============================================================================
// SLOT B: ALCHEMY-TRAP SETPIECES (PAIR CLEANLY WITH SLOT A)
// ============================================================================

function stampTinderboxLoft(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
  avoidCenterPit: boolean,
): void {
  const cx = W >> 1;
  const cz = D >> 1;
  const sideX = (hash32(seed, 861, 0) & 1) === 0 ? -1 : 1;
  const loftW = 22;
  const loftD = 20;
  let lx0 = cx + (avoidCenterPit ? sideX * 22 : sideX * 8) - (loftW >> 1);
  let lz0 = cz - 14;
  lx0 = Math.max(26, Math.min(W - 26 - loftW, lx0));
  lz0 = Math.max(26, Math.min(D - 26 - loftD, lz0));
  const lx1 = lx0 + loftW - 1;
  const lz1 = lz0 + loftD - 1;
  const platY0 = DECK_Y + LOFT_HEIGHT_V - 2;
  const platY1 = DECK_Y + LOFT_HEIGHT_V - 1;

  const legCoords: readonly [number, number][] = [
    [lx0, lz0],
    [lx1 - 2, lz0],
    [lx0, lz1 - 2],
    [lx1 - 2, lz1 - 2],
  ];
  for (const [gx, gz] of legCoords) {
    let baseY = DECK_Y;
    while (baseY > 2 && getMat(room.grid[cellIndex(gx + 1, baseY - 1, gz + 1)]) === MAT.AIR) {
      baseY--;
    }
    fillBox(room, gx, baseY, gz, gx + 2, platY0 - 1, gz + 2, MAT.WOOD_BARRIER);
  }

  fillBox(room, lx0, platY0, lz0, lx1, platY1, lz1, MAT.WOOD_BARRIER);
  fillBox(room, lx0, platY1 + 1, lz0, lx1, platY1 + 5, lz0 + 1, MAT.WOOD_BARRIER);

  for (let z = lz0 - 2; z <= lz1 + 3; z++) {
    for (let x = lx0 - 2; x <= lx1 + 2; x++) {
      if (getMat(room.grid[cellIndex(x, DECK_Y, z)]) === MAT.AIR && getMat(room.grid[cellIndex(x, DECK_Y - 1, z)]) === MAT.HULL_STEEL) {
        if ((x - lx0) % 2 === 0 || (z - lz0) % 2 === 0) {
          setInitCell(room, x, DECK_Y, z, MAT.OIL, TEMP_BYTE.AMBIENT);
        }
      }
    }
  }

  const ventX = Math.max(28, Math.min(W - 30, lx0 + (loftW >> 1)));
  const ventZ = Math.max(28, Math.min(D - 30, lz1 + 9));
  const ventRect: RectXZ = { x0: ventX - 2, z0: ventZ - 2, x1: ventX + 2, z1: ventZ + 2 };
  if (isRectClear(ventRect, reserved, room, 1) && getMat(room.grid[cellIndex(ventX, DECK_Y - 1, ventZ)]) === MAT.HULL_STEEL) {
    fillBox(room, ventX - 1, DECK_Y, ventZ - 1, ventX + 1, DECK_Y + 2, ventZ + 1, MAT.HULL_STEEL);
    room.emitters.push({ kind: 'vent', x: ventX, y: DECK_Y, z: ventZ, faceDir: '+Y', timer: 0, reserveL: 0 });
    reserved.push(ventRect);
  }

  const oilVatCands: [number, number][] = [
    [lx0 - 18, lz0],
    [lx1 + 3, lz0],
    ...getCornerVatCandidates(W, D, seed + 17),
  ];
  tryPlaceVatInCandidates(room, oilVatCands, DECK_Y, MAT.OIL, reserved);
}

function stampTeslaPit(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
  hasCenterChasmOrSump: boolean,
): void {
  const cx = W >> 1;
  const cz = D >> 1;

  if (!hasCenterChasmOrSump) {
    const halfSpanX = Math.min(22, Math.max(16, Math.floor((W - 60) * 0.34)));
    const halfSpanZ = Math.min(22, Math.max(16, Math.floor((D - 60) * 0.34)));
    const px0 = cx - halfSpanX;
    const px1 = cx + halfSpanX - 1;
    const pz0 = cz - halfSpanZ;
    const pz1 = cz + halfSpanZ - 1;

    fillBox(room, px0, 2, pz0, px1, DECK_Y - 1, pz1, MAT.AIR);
    for (let s = 0; s < 5; s++) {
      const sx1 = px0 + 10 - s * 2;
      fillBox(room, sx1 - 1, 2, cz - 6, sx1, 1 + (s + 1) * 2, cz + 6, MAT.HULL_STEEL);
    }
    fillBox(room, px0, DECK_Y - 2, cz - 5, px1, DECK_Y - 1, cz + 5, MAT.STEEL_GRATE);
    fillBox(room, cx - 5, DECK_Y - 2, pz0, cx + 5, DECK_Y - 1, pz1, MAT.STEEL_GRATE);

    for (let z = pz0 + 4; z <= pz1 - 4; z++) {
      for (let x = px0 + 12; x <= px1 - 4; x++) {
        if (getMat(room.grid[cellIndex(x, 2, z)]) === MAT.AIR) {
          setInitCell(room, x, 2, z, MAT.WATER, TEMP_BYTE.AMBIENT);
        }
      }
    }
  }

  // Floor-level Tesla Power Node on the rim (dry until splashed/bridged with water!)
  const condX = Math.min(W - 10, cx + 22);
  const condZ = Math.min(D - 28, Math.max(28, cz + (hasCenterChasmOrSump ? 16 : 0)));
  const condRect: RectXZ = { x0: condX - 2, z0: condZ - 2, x1: condX + 2, z1: condZ + 2 };
  if (isRectClear(condRect, reserved, room, 1) && getMat(room.grid[cellIndex(condX, DECK_Y - 1, condZ)]) === MAT.HULL_STEEL) {
    fillBox(room, condX - 1, DECK_Y, condZ - 1, condX + 1, DECK_Y + 2, condZ + 1, MAT.HULL_STEEL);
    room.emitters.push({
      kind: 'conduit',
      x: condX,
      y: DECK_Y + 1,
      z: condZ,
      faceDir: '-X',
      timer: 0,
      reserveL: 0,
    });
    reserved.push(condRect);
  }

  const waterCands: [number, number][] = [
    ...getCornerVatCandidates(W, D, seed + 31),
  ];
  tryPlaceVatInCandidates(room, waterCands, DECK_Y, MAT.WATER, reserved);
}

function stampCryoSpillway(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
): void {
  const cx = W >> 1;
  const cz = D >> 1;
  const laneX0 = Math.max(28, cx - 18);
  const laneX1 = Math.min(W - 29, cx + 18);
  const laneZ0 = Math.max(28, cz + 8);
  const laneZ1 = Math.min(D - 29, cz + 22);

  for (let z = laneZ0; z <= laneZ1; z++) {
    for (let x = laneX0; x <= laneX1; x++) {
      if (getMat(room.grid[cellIndex(x, DECK_Y, z)]) === MAT.AIR && getMat(room.grid[cellIndex(x, DECK_Y - 1, z)]) === MAT.HULL_STEEL) {
        if ((x + z) % 2 === 0) setInitCell(room, x, DECK_Y, z, MAT.WATER, TEMP_BYTE.AMBIENT);
      }
    }
  }

  const pipeX = Math.min(W - 8, laneX1 + 4);
  const pipeZ = Math.floor((laneZ0 + laneZ1) * 0.5);
  const pipeRect: RectXZ = { x0: pipeX - 2, z0: pipeZ - 2, x1: pipeX + 2, z1: pipeZ + 2 };
  if (isRectClear(pipeRect, reserved, room, 1)) {
    fillBox(room, pipeX - 1, DECK_Y, pipeZ - 1, pipeX + 1, DECK_Y + 9, pipeZ + 1, MAT.HULL_STEEL);
    room.emitters.push({
      kind: 'cryo_pipe',
      x: pipeX,
      y: DECK_Y + 8,
      z: pipeZ,
      faceDir: '-X',
      timer: 0,
      reserveL: 500,
    });
    reserved.push(pipeRect);
  }

  tryPlaceVatInCandidates(room, getCornerVatCandidates(W, D, seed + 53), DECK_Y, MAT.CRYO, reserved);
}

function stampFuelChoke(
  room: RoomState,
  W: number,
  D: number,
  seed: number,
  reserved: RectXZ[],
): void {
  const cx = W >> 1;
  const cz = D >> 1;

  const wall1X0 = Math.max(28, cx - 22);
  const wall1X1 = Math.max(wall1X0 + 8, cx - 5);
  const wall1Z = Math.max(30, cz - 12);
  if (getMat(room.grid[cellIndex(wall1X0 + 4, DECK_Y - 1, wall1Z)]) === MAT.HULL_STEEL) {
    fillBox(room, wall1X0, DECK_Y, wall1Z, wall1X1, DECK_Y + 15, wall1Z + 2, MAT.WOOD_BARRIER);
    reserved.push({ x0: wall1X0, z0: wall1Z, x1: wall1X1, z1: wall1Z + 2 });
  }

  const wall2X0 = Math.min(W - 36, cx + 5);
  const wall2X1 = Math.min(W - 28, cx + 22);
  const wall2Z = Math.min(D - 32, cz + 12);
  if (getMat(room.grid[cellIndex(wall2X0 + 4, DECK_Y - 1, wall2Z)]) === MAT.HULL_STEEL) {
    fillBox(room, wall2X0, DECK_Y, wall2Z, wall2X1, DECK_Y + 15, wall2Z + 2, MAT.WOOD_BARRIER);
    reserved.push({ x0: wall2X0, z0: wall2Z, x1: wall2X1, z1: wall2Z + 2 });
  }

  const cands = getCornerVatCandidates(W, D, seed + 79);
  tryPlaceVatInCandidates(room, cands, DECK_Y, MAT.OIL, reserved);
  tryPlaceVatInCandidates(room, cands.slice().reverse(), DECK_Y, MAT.WATER, reserved);
}

/**
 * Generates a variable-dimension (112x64x112 .. 208x64x176) SHIFT-First Parametric Arena
 * stitching 1 Shift-Architecture setpiece + 1 Alchemy-Trap setpiece per combat room.
 */
export function generateParametricArena(room: RoomState, node: DeckRoomNode): void {
  const dims: RoomDims = getRoomDimsForNode(node);
  const W = dims.w;
  const H = dims.h;
  const D = dims.d;
  const setpieces: SetpieceId[] =
    node.setpieces.length === 2 ? [node.setpieces[0], node.setpieces[1]] : ['flooded_sump', 'tinderbox_loft'];

  resetRoomRuntimeTransient(room);
  room.roomId = node.id;
  room.roomSeed = node.roomSeed >>> 0;
  room.setpieces = setpieces;
  room.cleared = false;
  room.workbenchAlcoveIndex = node.alcoveIndex;
  room.workbenchTerminals.length = 0;
  room.workbenchState = createDefaultWorkbenchState();
  room.roomW = W;
  room.roomH = H;
  room.roomD = D;
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
  fillBoundaryShell(room, W, H, D);
  fillBox(room, 1, H - 2, 1, W - 2, H - 2, D - 2, MAT.HULL_STEEL);
  fillBox(room, 1, 1, 1, W - 2, DECK_Y - 1, D - 2, MAT.HULL_STEEL);

  const reserved: RectXZ[] = [];

  for (let i = 0; i < node.doors.length; i++) {
    const d = makeDoorRecord(W, D, node.doors[i], true);
    room.doors.push(d);
    carveCompactVestibule(room, d, reserved);
  }

  if (node.alcoveIndex > 0) {
    for (let i = 0; i < 4; i++) {
      room.workbenchTerminals.push({
        index: i as 0 | 1 | 2 | 3,
        x: 1.4 + i * 0.6,
        y: DECK_Y * VOXEL_SIZE_M,
        z: 0.8,
      });
    }
    reserved.push({ x0: 8, z0: 2, x1: 38, z1: 20 });
  }

  // Slot A: Shift-Architecture first
  const hasCenterCarve = setpieces.includes('flooded_sump') || setpieces.includes('split_chasm');
  if (setpieces.includes('flooded_sump')) stampFloodedSump(room, W, D, node.roomSeed, reserved);
  if (setpieces.includes('split_chasm')) stampSplitChasm(room, W, D, node.roomSeed, reserved);
  if (setpieces.includes('ceiling_vats')) stampCeilingVats(room, W, D, node.roomSeed, reserved);

  // Slot B: Alchemy-Trap overlay
  if (setpieces.includes('tesla_pit')) stampTeslaPit(room, W, D, node.roomSeed, reserved, hasCenterCarve);
  if (setpieces.includes('tinderbox_loft')) stampTinderboxLoft(room, W, D, node.roomSeed, reserved, hasCenterCarve || setpieces.includes('tesla_pit'));
  if (setpieces.includes('cryo_spillway')) stampCryoSpillway(room, W, D, node.roomSeed, reserved);
  if (setpieces.includes('fuel_choke')) stampFuelChoke(room, W, D, node.roomSeed, reserved);

  // Guarantee at least 2 vats in every arena
  while (room.vats.length < 2) {
    const cands = getCornerVatCandidates(W, D, node.roomSeed + 101 + room.vats.length * 19);
    const needMat = room.vats.some((v) => v.mat === MAT.WATER) ? MAT.OIL : MAT.WATER;
    if (!tryPlaceVatInCandidates(room, cands, DECK_Y, needMat, reserved)) break;
  }

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
  if (room.outOfBounds.length !== TOTAL_CHUNKS) throw new Error('Chunk array mismatch');

  recountChunkFluids(room);
  recomputeRoomLedgers(room);
}

function findSafeFloorSpawn(
  world: WorldState,
  node: DeckRoomNode,
  preferX: number,
  preferZ: number,
  halfW: number,
  height: number,
  halfD: number,
  minDoorDistM = 2.6,
  elevOffsetM = 0,
): { x: number; y: number; z: number } | null {
  const room = world.room;
  const dims = getRoomDimsForNode(node);
  const doorSpawns = node.doors.map((d) => getDoorSpawnPoint(dims, d.face));
  const minDoorSq = minDoorDistM * minDoorDistM;
  const spawnYM = DECK_Y * VOXEL_SIZE_M + elevOffsetM;

  for (let r = 0; r <= 48; r += 2) {
    const steps = r === 0 ? 1 : 8;
    for (let k = 0; k < steps; k++) {
      const angIdx = (k + (r >> 1)) & 7;
      const dxV = [1, 1, 0, -1, -1, -1, 0, 1][angIdx] * r;
      const dzV = [0, 1, 1, 1, 0, -1, -1, -1][angIdx] * r;
      const vx = Math.max(8, Math.min(room.roomW - 9, preferX + dxV));
      const vz = Math.max(8, Math.min(room.roomD - 9, preferZ + dzV));
      const wx = (vx + 0.5) * VOXEL_SIZE_M;
      const wz = (vz + 0.5) * VOXEL_SIZE_M;

      let tooCloseDoor = false;
      for (let d = 0; d < doorSpawns.length; d++) {
        const ddx = wx - doorSpawns[d].x;
        const ddz = wz - doorSpawns[d].z;
        if (ddx * ddx + ddz * ddz < minDoorSq) {
          tooCloseDoor = true;
          break;
        }
      }
      if (tooCloseDoor) continue;

      if (elevOffsetM === 0) {
        const floorMat = getMat(room.grid[cellIndex(vx, DECK_Y - 1, vz)]);
        if (floorMat !== MAT.HULL_STEEL && floorMat !== MAT.STEEL_GRATE) continue;
      }
      if (aabbOverlapsSolid(room, wx, spawnYM, wz, halfW, height, halfD)) continue;

      let overlapsEntity = false;
      for (let i = 0; i < world.entities.length; i++) {
        const o = world.entities[i];
        if (
          Math.abs(wx - o.x) < halfW + o.halfW + 0.25 &&
          Math.abs(wz - o.z) < halfD + o.halfD + 0.25 &&
          Math.abs(spawnYM - o.y) < 1.2
        ) {
          overlapsEntity = true;
          break;
        }
      }
      if (overlapsEntity) continue;

      return { x: wx, y: spawnYM, z: wz };
    }
  }
  return null;
}

function findHighGroundSpawn(
  room: RoomState,
  halfW: number,
  height: number,
  halfD: number,
  targetTopY: number,
  mat: MaterialId,
): { x: number; y: number; z: number } | null {
  const platYM = targetTopY * VOXEL_SIZE_M;
  for (let z = 24; z < room.roomD - 24; z += 2) {
    for (let x = 24; x < room.roomW - 24; x += 2) {
      if (getMat(room.grid[cellIndex(x, targetTopY - 1, z)]) !== mat) continue;
      if (
        getMat(room.grid[cellIndex(x - 2, targetTopY - 1, z - 2)]) !== mat ||
        getMat(room.grid[cellIndex(x + 2, targetTopY - 1, z + 2)]) !== mat
      ) {
        continue;
      }
      const wx = (x + 0.5) * VOXEL_SIZE_M;
      const wz = (z + 0.5) * VOXEL_SIZE_M;
      if (!aabbOverlapsSolid(room, wx, platYM, wz, halfW, height, halfD)) {
        return { x: wx, y: platYM, z: wz };
      }
    }
  }
  return null;
}

/**
 * Populates a SHIFT-First Parametric Arena:
 * - 1..2 Hovering Gas-Bladder Floaters (2G Crush / 0G Punt targets)
 * - 1 Armored Carapace Bruiser (Alchemy / 0G Punt / Cryo Shatter target)
 * - 1 High-Ground Scaffold Spitter (perched on Tinderbox Loft, Split Chasm balcony, or Ceiling Gantry)
 * - 2..3 Flanking Pack Skitterers
 * - 4..5 dynamic wooden crates including strictly 1 Bio-Cache.
 */
export function populateParametricArenaEntities(world: WorldState, node: DeckRoomNode): void {
  world.entities.length = 0;
  world.lockOn = null;

  const room = world.room;
  const W = room.roomW;
  const D = room.roomD;
  const cx = W >> 1;
  const cz = D >> 1;
  const seed = node.roomSeed;
  let hostiles = 0;

  // 1. High-Ground Spitter perched on Tinderbox Loft, Split Chasm balcony, or Ceiling Gantry
  const spitterMat: MaterialId = room.setpieces.includes('cryo_spillway')
    ? MAT.CRYO
    : room.setpieces.includes('tesla_pit')
      ? MAT.WATER
      : MAT.OIL;
  const highPos =
    (room.setpieces.includes('tinderbox_loft')
      ? findHighGroundSpawn(room, SPITTER_W_M * 0.5, SPITTER_H_M, SPITTER_D_M * 0.5, DECK_Y + LOFT_HEIGHT_V, MAT.WOOD_BARRIER)
      : null) ??
    (room.setpieces.includes('split_chasm')
      ? findHighGroundSpawn(room, SPITTER_W_M * 0.5, SPITTER_H_M, SPITTER_D_M * 0.5, DECK_Y + 20, MAT.HULL_STEEL)
      : null) ??
    (room.setpieces.includes('ceiling_vats')
      ? findHighGroundSpawn(room, SPITTER_W_M * 0.5, SPITTER_H_M, SPITTER_D_M * 0.5, GANTRY_Y1 + 1, MAT.STEEL_GRATE)
      : null) ??
    findSafeFloorSpawn(world, node, cx + 18, cz - 14, SPITTER_W_M * 0.5, SPITTER_H_M, SPITTER_D_M * 0.5);

  if (highPos) {
    world.entities.push(createSpitterEntity(world.nextEntityId++, highPos.x, highPos.y, highPos.z, spitterMat));
    hostiles++;
  }

  // 2. 1..2 Hovering Gas-Bladder Floaters (force [C] 2G Crush & [Q] 0G play!)
  const floaterCount = room.setpieces.includes('flooded_sump') || room.setpieces.includes('ceiling_vats') ? 2 : 1;
  const floaterOffsets: readonly [number, number][] = [
    [-12, -8],
    [14, 10],
  ];
  for (let f = 0; f < floaterCount; f++) {
    const [fx, fz] = floaterOffsets[f];
    const fPos = findSafeFloorSpawn(
      world,
      node,
      cx + fx,
      cz + fz,
      FLOATER_W_M * 0.5,
      FLOATER_HEIGHT_M,
      FLOATER_D_M * 0.5,
      2.6,
      1.55,
    );
    if (!fPos) continue;
    const fMat: MaterialId = f === 0 ? MAT.OIL : (hash32(seed, 907, f) & 1) === 0 ? MAT.CRYO : MAT.WATER;
    const fl = createFloaterEntity(world.nextEntityId++, fPos.x, fPos.y, fPos.z, fMat);
    fl.attackCdTicks = 30 + f * 24;
    world.entities.push(fl);
    hostiles++;
  }

  // 3. Armored Carapace Bruiser patrolling the deck
  const bruiserPos = findSafeFloorSpawn(
    world,
    node,
    cx,
    cz + 14,
    BRUISER_W_M * 0.5,
    BRUISER_H_M,
    BRUISER_D_M * 0.5,
    3.0,
  );
  if (bruiserPos) {
    const bMat = (hash32(seed, 901, 0) & 1) === 0 ? MAT.OIL : MAT.CRYO;
    world.entities.push(createBruiserEntity(world.nextEntityId++, bruiserPos.x, bruiserPos.y, bruiserPos.z, bMat));
    hostiles++;
  }

  // 4. 2..3 Flanking Pack Skitterers (total room hostiles cleanly in 5..7)
  const packSize = floaterCount >= 2 ? 2 : 3;
  const packOffsets: readonly [number, number][] = [
    [-18, 14],
    [18, -14],
    [-16, -16],
  ];
  for (let i = 0; i < packSize; i++) {
    const [ox, oz] = packOffsets[i];
    const pos = findSafeFloorSpawn(
      world,
      node,
      cx + ox,
      cz + oz,
      SKITTERER_W_M * 0.5,
      SKITTERER_H_M,
      SKITTERER_D_M * 0.5,
      2.8,
    );
    if (!pos) continue;
    const gMat = (hash32(seed, 911, i) & 1) === 0 ? MAT.OIL : MAT.WATER;
    const sk = createSkittererEntity(world.nextEntityId++, pos.x, pos.y, pos.z, gMat);
    sk.attackCdTicks = 15 + i * 14;
    world.entities.push(sk);
    hostiles++;
  }

  world.podsTotal = hostiles;
  world.podsRemaining = hostiles;

  // 5. 4..5 movable crates including strictly 1 Bio-Cache
  const crateTargets: readonly [number, number][] = [
    [cx - 24, cz],
    [cx + 24, cz - 8],
    [cx, cz - 24],
    [cx - 10, cz + 22],
    [cx + 18, cz + 20],
  ];
  const desiredCrates = 4 + (hash32(seed, 929, 0) & 1);
  let placedCrates = 0;
  for (let i = 0; i < crateTargets.length && placedCrates < desiredCrates; i++) {
    const [tx, tz] = crateTargets[i];
    const pos = findSafeFloorSpawn(
      world,
      node,
      tx,
      tz,
      CRATE_SIZE_M * 0.5,
      CRATE_SIZE_M,
      CRATE_SIZE_M * 0.5,
      2.2,
    );
    if (!pos) continue;
    world.entities.push(createCrateEntity(world.nextEntityId++, pos.x, pos.y, pos.z, placedCrates === 0));
    placedCrates++;
  }

  room.entitiesRef = world.entities;
  recomputeRoomLedgers(room, world.playerTank);
}
