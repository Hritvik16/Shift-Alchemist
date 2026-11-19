import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CARGO_HOLD_DIMS,
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
import { hash32 } from './hash.ts';
import {
  cellIndex,
  chunkIndex,
  packVoxel,
  recomputeRoomLedgers,
  type RoomState,
} from './types.ts';

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
  room.grid[idx] = packVoxel(mat, tempByte, 0, 0, shimmer, 0, 0);
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
  // §7: Only CRYO-filled vats init GLASS_VAT at -196°C; WATER/OIL init at +20°C
  const glassTemp = fluidMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const isShell =
          x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
        if (isShell) {
          setInitCell(room, x, y, z, MAT.GLASS_VAT, glassTemp);
        } else {
          // M1.1 keeps shells hollow; M2.1 pre-fills these interior voxels with fluidMat
          setInitCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT);
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
    centerX: ((x0 + x1 + 1) * 0.5) * VOXEL_SIZE_M,
    centerY: ((y0 + y1 + 1) * 0.5) * VOXEL_SIZE_M,
    centerZ: ((z0 + z1 + 1) * 0.5) * VOXEL_SIZE_M,
    interiorLiters,
  });
}

/**
 * Generates the canonical 240x64x240 Main Cargo Hold test room (§4.2 & M1.1).
 */
export function generateCargoHold(room: RoomState, roomSeed: number): void {
  room.roomSeed = roomSeed >>> 0;
  room.roomW = CARGO_HOLD_DIMS.w;
  room.roomH = CARGO_HOLD_DIMS.h;
  room.roomD = CARGO_HOLD_DIMS.d;
  room.gravityMode = GRAVITY_MODE.G1;
  room.vats.length = 0;
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

  // Clear entire grid to AIR (+20°C)
  room.grid.fill(packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT, 0, 0, 0, 0, 0));

  const W = room.roomW;
  const H = room.roomH;
  const D = room.roomD;

  // 1. Sealed outer perimeter faces: BOUNDARY_HULL (ID 12) on all 6 faces
  fillBox(room, 0, 0, 0, W - 1, 0, D - 1, MAT.BOUNDARY_HULL); // y = 0
  fillBox(room, 0, H - 1, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL); // y = 63
  fillBox(room, 0, 0, 0, W - 1, H - 1, 0, MAT.BOUNDARY_HULL); // z = 0 (North)
  fillBox(room, 0, 0, D - 1, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL); // z = 239 (South)
  fillBox(room, 0, 0, 0, 0, H - 1, D - 1, MAT.BOUNDARY_HULL); // x = 0 (West)
  fillBox(room, W - 1, 0, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL); // x = 239 (East)

  // 2. Interior ceiling liner (y = 62) & base foundation slab (y = 1..11, deck top 1.2 m)
  fillBox(room, 1, H - 2, 1, W - 2, H - 2, D - 2, MAT.HULL_STEEL);
  fillBox(room, 1, 1, 1, W - 2, CARGO_DECK_TOP_Y - 1, D - 2, MAT.HULL_STEEL);

  // 3. North airlock doorway (30x28 at y=2..29, sealed in-core by BOUNDARY_HULL on z=0)
  //    + 2.0 m-deep vestibule trench (z=1..20, y=2..11 open AIR) + 5 walkable stairs (z=21..35)
  const doorX0 = Math.floor((W - DOOR_WIDTH_VOXELS) / 2); // 105
  const doorX1 = doorX0 + DOOR_WIDTH_VOXELS - 1; // 134
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
    const stepTopSolidY = 1 + (s + 1) * 2; // 3, 5, 7, 9, 11 -> top 0.4..1.2 m
    if (stepTopSolidY < CARGO_DECK_TOP_Y - 1) {
      fillBox(room, doorX0, stepTopSolidY + 1, zStart, doorX1, CARGO_DECK_TOP_Y - 1, zEnd, MAT.AIR);
    }
  }

  // 4. Central 8 m x 8 m sunken pit (x=80..159, z=80..159, y=2..11 open AIR above y=1 liner)
  //    with 5 walkable exit steps along the West pit edge (x=80..94, z=108..131)
  fillBox(room, 80, 2, 80, 159, CARGO_DECK_TOP_Y - 1, 159, MAT.AIR);
  for (let s = 0; s < 5; s++) {
    // s=0 at x=92..94 (top 0.4 m) climbing westward to s=4 at x=80..82 (top 1.2 m)
    const xEnd = 94 - s * 3;
    const xStart = xEnd - 2;
    const topSolidY = 1 + (s + 1) * 2; // 3, 5, 7, 9, 11
    fillBox(room, xStart, 2, 108, xEnd, topSolidY, 131, MAT.HULL_STEEL);
  }

  // 5. Elevated 0.2 m-thick STEEL_GRATE catwalk at y=36..37 (underside 3.6 m, top 3.8 m)
  //    giving 2.4 m clear below (1.2..3.6 m) and 2.4 m clear above (3.8..6.2 m)
  fillBox(room, 44, CARGO_CATWALK_Y_MIN, 144, 195, CARGO_CATWALK_Y_MAX, 175, MAT.STEEL_GRATE);
  // North-South spur crossing the eastern half of the pit for dramatic vertical sightlines
  fillBox(room, 144, CARGO_CATWALK_Y_MIN, 56, 175, CARGO_CATWALK_Y_MAX, 143, MAT.STEEL_GRATE);

  // Structural HULL_STEEL support columns (4x4 voxels, y=12..35)
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

  // 13 walkable catwalk stairs (0.2 m rise x 0.3 m tread = 3.9 m run, z=105..143)
  // Climbing from deck top y=12 (1.2 m) up to catwalk top y=38 (3.8 m)
  for (let s = 0; s < 13; s++) {
    const zStart = 105 + s * 3;
    const zEnd = zStart + 2;
    const stepTopSolidY = CARGO_DECK_TOP_Y - 1 + (s + 1) * 2; // 13, 15, ..., 37
    const stepBottomY = Math.max(CARGO_DECK_TOP_Y, stepTopSolidY - 1);
    fillBox(room, 48, stepBottomY, zStart, 67, stepTopSolidY, zEnd, MAT.HULL_STEEL);
  }
  // Stair side support stringers on West/East edges down to deck at bottom & top
  fillBox(room, 48, CARGO_DECK_TOP_Y, 138, 49, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);
  fillBox(room, 66, CARGO_DECK_TOP_Y, 138, 67, CARGO_CATWALK_Y_MIN - 1, 143, MAT.HULL_STEEL);

  // 6. Four destructible GLASS_VAT hollow shells (16x15x16 outer -> 14x13x14 = 2,548 L interior)
  //    Spaced >= 3.0 m apart: 2 WATER, 1 OIL, 1 CRYO
  buildGlassVatShell(room, 0, 24, CARGO_DECK_TOP_Y, 44, 16, 15, 16, MAT.WATER);
  buildGlassVatShell(room, 1, 196, CARGO_DECK_TOP_Y, 44, 16, 15, 16, MAT.WATER);
  buildGlassVatShell(room, 2, 196, CARGO_DECK_TOP_Y, 194, 16, 15, 16, MAT.OIL);
  buildGlassVatShell(room, 3, 24, CARGO_DECK_TOP_Y, 194, 16, 15, 16, MAT.CRYO);

  // 7. Destructible WOOD_BARRIER tactical cover walls (HP 12, 0.3 m thick, 2.0 m tall)
  fillBox(room, 66, CARGO_DECK_TOP_Y, 64, 95, CARGO_DECK_TOP_Y + 19, 66, MAT.WOOD_BARRIER);
  fillBox(room, 174, CARGO_DECK_TOP_Y, 102, 176, CARGO_DECK_TOP_Y + 19, 131, MAT.WOOD_BARRIER);
  fillBox(room, 96, CARGO_DECK_TOP_Y, 188, 125, CARGO_DECK_TOP_Y + 19, 190, MAT.WOOD_BARRIER);

  // 8. Chunk flags: mark in-bounds chunks dirtySolidMesh, clear snapshot/decal/fluid flags
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
        room.dirtyFluidRender[cIdx] = 0;
        room.dirtyDecals[cIdx] = 0;
        room.dirtySnapshot[cIdx] = 0;
      }
    }
  }

  // Ensure TOTAL_CHUNKS invariant is consistent
  if (room.outOfBounds.length !== TOTAL_CHUNKS) {
    throw new Error('Chunk array mismatch');
  }

  recomputeRoomLedgers(room);
}
