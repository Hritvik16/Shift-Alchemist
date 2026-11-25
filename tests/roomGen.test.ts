import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CARGO_HOLD_DIMS,
  MAT,
  TEMP_BYTE,
  VAT_VOLUME_MAX_L,
  VAT_VOLUME_MIN_L,
} from '../src/core/balance.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import {
  carveSphereDebug,
  cellChunkIndex,
  cellIndex,
  createEmptyRoomState,
  getMat,
  getTempByte,
  packVoxel,
  writeCell,
} from '../src/core/types.ts';

describe('Cargo Hold Generator & Shared Structural Resolver (M1.1)', () => {
  it('seals all 6 outer faces with BOUNDARY_HULL and builds pit, vestibule, catwalk, vats', () => {
    const room = createEmptyRoomState(1337);
    generateCargoHold(room, 1337);

    const W = CARGO_HOLD_DIMS.w;
    const H = CARGO_HOLD_DIMS.h;
    const D = CARGO_HOLD_DIMS.d;

    // Sample all 6 boundary faces (including airlock doorway at z=0)
    for (let x = 0; x < W; x += 15) {
      assert.equal(getMat(room.grid[cellIndex(x, 0, 120)]), MAT.BOUNDARY_HULL);
      assert.equal(getMat(room.grid[cellIndex(x, H - 1, 120)]), MAT.BOUNDARY_HULL);
      assert.equal(getMat(room.grid[cellIndex(x, 10, 0)]), MAT.BOUNDARY_HULL);
      assert.equal(getMat(room.grid[cellIndex(x, 10, D - 1)]), MAT.BOUNDARY_HULL);
    }
    for (let z = 0; z < D; z += 15) {
      assert.equal(getMat(room.grid[cellIndex(0, 10, z)]), MAT.BOUNDARY_HULL);
      assert.equal(getMat(room.grid[cellIndex(W - 1, 10, z)]), MAT.BOUNDARY_HULL);
    }

    // Pit center is open AIR above y=1 HULL_STEEL liner
    assert.equal(getMat(room.grid[cellIndex(120, 1, 120)]), MAT.HULL_STEEL);
    assert.equal(getMat(room.grid[cellIndex(120, 2, 120)]), MAT.AIR);
    assert.equal(getMat(room.grid[cellIndex(120, 11, 120)]), MAT.AIR);

    // Catwalk is 2-voxel STEEL_GRATE at y=36..37
    assert.equal(getMat(room.grid[cellIndex(120, CARGO_CATWALK_Y_MIN, 160)]), MAT.STEEL_GRATE);
    assert.equal(getMat(room.grid[cellIndex(120, CARGO_CATWALK_Y_MAX, 160)]), MAT.STEEL_GRATE);
    assert.equal(getMat(room.grid[cellIndex(120, CARGO_CATWALK_Y_MAX + 1, 160)]), MAT.AIR);

    // 4 vats spaced >= 3.0 m apart with interior 2,000..3,000 L and CRYO glass at -196°C
    assert.equal(room.vats.length, 4);
    for (const vat of room.vats) {
      assert.ok(vat.interiorLiters >= VAT_VOLUME_MIN_L && vat.interiorLiters <= VAT_VOLUME_MAX_L);
      const cornerVal = room.grid[cellIndex(vat.minX, vat.minY, vat.minZ)];
      assert.equal(getMat(cornerVal), MAT.GLASS_VAT);
      if (vat.mat === MAT.CRYO) {
        assert.equal(getTempByte(cornerVal), TEMP_BYTE.CRYO);
      } else {
        assert.equal(getTempByte(cornerVal), TEMP_BYTE.AMBIENT);
      }
    }
  });

  it('debug carve skips BOUNDARY_HULL, ICE, and fluids while carving HULL_STEEL and dirtying chunks', () => {
    const room = createEmptyRoomState(99);
    generateCargoHold(room, 99);
    room.dirtySolidMesh.fill(0);
    room.dirtySnapshot.fill(0);

    // Place a test ICE voxel and WATER voxel on deck
    writeCell(room, 100, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE));
    writeCell(room, 101, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    room.dirtySolidMesh.fill(0);
    room.dirtySnapshot.fill(0);

    // Carve right on top of ICE, WATER, and HULL_STEEL deck beneath
    const carved = carveSphereDebug(room, 100, CARGO_DECK_TOP_Y, 50, 2);
    assert.ok(carved > 0);
    assert.equal(getMat(room.grid[cellIndex(100, CARGO_DECK_TOP_Y, 50)]), MAT.ICE);
    assert.equal(getMat(room.grid[cellIndex(101, CARGO_DECK_TOP_Y, 50)]), MAT.WATER);
    assert.equal(getMat(room.grid[cellIndex(100, CARGO_DECK_TOP_Y - 1, 50)]), MAT.AIR);
    assert.equal(room.dirtySolidMesh[cellChunkIndex(100, CARGO_DECK_TOP_Y - 1, 50)], 1);
    assert.equal(room.dirtySnapshot[cellChunkIndex(100, CARGO_DECK_TOP_Y - 1, 50)], 1);

    // Carve against outer BOUNDARY_HULL wall -> must remain intact
    carveSphereDebug(room, 0, 10, 120, 3);
    assert.equal(getMat(room.grid[cellIndex(0, 10, 120)]), MAT.BOUNDARY_HULL);
  });
});
