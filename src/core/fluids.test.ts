import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  GRAVITY_MODE,
  MAT,
  MAX_ACTIVE_BALLISTIC,
  MAX_DEFERRED_FLUID,
  TEMP_BYTE,
} from './balance.ts';
import {
  countNSame,
  drainOrSerializeBallistics,
  placeOrDeferFluid,
  reseedActiveLists,
  spawnBallistic,
  stepFluidMovementStage4,
} from './fluids.ts';
import { stepWorldTick } from './physics.ts';
import { generateCargoHold } from './roomGen.ts';
import {
  carveSphereDebug,
  cellChunkIndex,
  cellIndex,
  chunkIndex,
  getMat,
  moveCell,
  packVoxel,
  recomputeRoomLedgers,
  resetRoomRuntimeTransient,
  writeCell,
} from './types.ts';
import { createEmptyInput, createWorldState, type WorldState } from './world.ts';

function makeCargoWorld(seed = 2026): WorldState {
  const world = createWorldState(seed);
  generateCargoHold(world.room, seed);
  world.entryLedgers = { ...world.room.ledgers };
  return world;
}

describe('Milestone 2.1 — Fluid CA, Ballistics, Grates, Halo & Conservation', () => {
  it('computes canonical 26-neighbor N_same excluding center and vacated origin cell', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Build a 3x3 WATER puddle at y=12, x=100..102, z=50..52
    for (let z = 50; z <= 52; z++) {
      for (let x = 100; x <= 102; x++) {
        writeCell(room, x, CARGO_DECK_TOP_Y, z, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
      }
    }
    // Center cell (101, 12, 51) has 8 same-material neighbors
    assert.equal(countNSame(room, 101, CARGO_DECK_TOP_Y, 51, MAT.WATER, 101, CARGO_DECK_TOP_Y, 51), 8);
    // Corner cell (100, 12, 50) has 3 neighbors; stepping outward to (99, 12, 50) excluding origin (100,12,50) drops to 1
    assert.equal(countNSame(room, 100, CARGO_DECK_TOP_Y, 50, MAT.WATER, 100, CARGO_DECK_TOP_Y, 50), 3);
    assert.equal(countNSame(room, 99, CARGO_DECK_TOP_Y, 50, MAT.WATER, 100, CARGO_DECK_TOP_Y, 50), 1);
  });

  it('marks dirtySnapshot, dirtyFluidRender, and chunk halo when fluid crosses a chunk face', () => {
    const world = makeCargoWorld();
    const room = world.room;
    room.dirtyFluidRender.fill(0);
    room.dirtySnapshot.fill(0);

    // Place WATER at x=15 (right on the East face of chunk cx=0, bordering cx=1)
    writeCell(room, 15, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    const cLeft = chunkIndex(0, CARGO_DECK_TOP_Y >> 4, 50 >> 4);
    const cRight = chunkIndex(1, CARGO_DECK_TOP_Y >> 4, 50 >> 4);
    assert.equal(room.dirtyFluidRender[cLeft], 1);
    assert.equal(room.dirtyFluidRender[cRight], 1, 'chunk halo must mark adjacent chunk');
    assert.equal(room.dirtySnapshot[cLeft], 1);

    room.dirtyFluidRender.fill(0);
    room.dirtySnapshot.fill(0);

    // Move cell from x=15 (chunk 0) to x=16 (chunk 1)
    moveCell(room, 15, CARGO_DECK_TOP_Y, 50, 16, CARGO_DECK_TOP_Y, 50, 2);
    assert.equal(room.dirtyFluidRender[cLeft], 1);
    assert.equal(room.dirtyFluidRender[cRight], 1);
    assert.equal(room.dirtySnapshot[cLeft], 1);
    assert.equal(room.dirtySnapshot[cRight], 1);
  });

  it('permeates 2-voxel STEEL_GRATE catwalk in 1 step for liquids/gases while ACID pools atop', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Place WATER, STEAM, and ACID around the 2-voxel STEEL_GRATE at y=36..37
    const gx = 100;
    const gz = 160;
    assert.equal(getMat(room.grid[cellIndex(gx, CARGO_CATWALK_Y_MIN, gz)]), MAT.STEEL_GRATE);
    assert.equal(getMat(room.grid[cellIndex(gx, CARGO_CATWALK_Y_MAX, gz)]), MAT.STEEL_GRATE);

    writeCell(room, gx, CARGO_CATWALK_Y_MAX + 1, gz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    writeCell(room, gx + 4, CARGO_CATWALK_Y_MAX + 1, gz, packVoxel(MAT.ACID, TEMP_BYTE.AMBIENT));
    writeCell(room, gx + 8, CARGO_CATWALK_Y_MIN - 1, gz, packVoxel(MAT.STEAM, TEMP_BYTE.BOIL, 45));

    stepFluidMovementStage4(world);

    assert.equal(getMat(room.grid[cellIndex(gx, CARGO_CATWALK_Y_MIN - 1, gz)]), MAT.WATER);
    assert.equal(getMat(room.grid[cellIndex(gx, CARGO_CATWALK_Y_MAX + 1, gz)]), MAT.AIR);
    assert.equal(getMat(room.grid[cellIndex(gx + 8, CARGO_CATWALK_Y_MAX + 1, gz)]), MAT.STEAM);
    // ACID does not permeate STEEL_GRATE
    assert.equal(getMat(room.grid[cellIndex(gx + 4, CARGO_CATWALK_Y_MIN - 1, gz)]), MAT.AIR);
  });

  it('keeps sealed vat interiors asleep on reseedActiveLists while waking exposed fluid/gas and hot solids', () => {
    const world = makeCargoWorld();
    const room = world.room;

    // Immediately after generateCargoHold, all 4 sealed vats (10,192 L) must be asleep
    assert.equal(room.activeFluidNextCount, 0);
    assert.equal(room.activeThermalNextCount, 0);
    assert.equal(room.ledgers.water, 5_096);
    assert.equal(room.ledgers.oil, 2_548);
    assert.equal(room.ledgers.cryo, 2_548);

    // Place an exposed WATER cell, a STEAM cell, and a hot exposed HULL_STEEL cell, then re-seed
    writeCell(room, 110, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    writeCell(room, 112, CARGO_DECK_TOP_Y + 5, 50, packVoxel(MAT.STEAM, TEMP_BYTE.BOIL, 45));
    writeCell(room, 114, CARGO_DECK_TOP_Y - 1, 50, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.BOIL));

    resetRoomRuntimeTransient(room);
    reseedActiveLists(room, 1);

    assert.equal(room.activeFluidNextCount, 2, 'only exposed water and steam wake; 10,192 L vats stay asleep');
    assert.equal(room.activeThermalNextCount, 1, 'hot exposed steel wakes');
  });

  it('satisfies Keep-Awake Contract: CRYO puddle on steel sublimates within ~49 s with zero outside wake', () => {
    const world = makeCargoWorld();
    const room = world.room;
    const x = 110;
    const y = CARGO_DECK_TOP_Y;
    const z = 50;

    writeCell(room, x, y, z, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
    recomputeRoomLedgers(room);
    const startCryo = room.ledgers.cryo;

    for (let t = 0; t < 3_060; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.equal(getMat(room.grid[cellIndex(x, y, z)]), MAT.AIR, 'CRYO puddle must sublimate on steel');
    assert.equal(room.ledgers.cryoBoiledOff, 1);
    recomputeRoomLedgers(room);
    assert.equal(room.ledgers.cryo, startCryo, 'CRYO ledger conserved through sublimation');
  });

  it('guarantees zero deletion under saturated ballistic pool + saturated deferred queue and airlock serialization fallback', () => {
    const world = makeCargoWorld();
    const room = world.room;

    // Surround (120, 20, 120) with solid HULL_STEEL box of radius 13 so r=0..12 has zero AIR cells
    for (let y = 7; y <= 33; y++) {
      for (let z = 107; z <= 133; z++) {
        for (let x = 107; x <= 133; x++) {
          writeCell(room, x, y, z, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
        }
      }
    }

    // Saturate ballistic pool (4,096) and deferred queue (4,096)
    const waterVal = packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT);
    for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
      const slot = spawnBallistic(room, 12.05, 2.05, 12.05, 0, 0, 0, waterVal);
      assert.notEqual(slot, -1);
    }
    assert.equal(room.ballistic.count, MAX_ACTIVE_BALLISTIC);

    for (let i = 0; i < MAX_DEFERRED_FLUID; i++) {
      const ok = placeOrDeferFluid(room, MAT.WATER, TEMP_BYTE.AMBIENT, 0, 120, 20, 120, true, null, 1);
      assert.equal(ok, true);
    }
    assert.equal(room.deferredFluid.count, MAX_DEFERRED_FLUID);

    // Next placement must cleanly return false without deleting any liter
    const overflowOk = placeOrDeferFluid(room, MAT.WATER, TEMP_BYTE.AMBIENT, 0, 120, 20, 120, true, null, 1);
    assert.equal(overflowOk, false);
    assert.equal(room.deferredFluid.count, MAX_DEFERRED_FLUID);
    assert.equal(room.ballistic.count, MAX_ACTIVE_BALLISTIC);

    // Pure airlock serialization fallback preserves all unplaceable ballistics
    const serialized = drainOrSerializeBallistics(world);
    assert.equal(serialized.length, MAX_ACTIVE_BALLISTIC);
  });

  it('shatters all 4 vats (10,192 L), lofts in 0G, and slams in 2G with 0 ledger drift', () => {
    const world = makeCargoWorld();
    const room = world.room;
    const entry = { ...room.ledgers };

    // Shatter the front faces of all 4 vats
    for (const vat of room.vats) {
      carveSphereDebug(room, vat.minX, vat.minY + 3, vat.minZ + 7, 4, world.simTick);
    }

    // Simulate 1G pour for 1.5 s (90 ticks)
    for (let t = 0; t < 90; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(room.activeFluidCurCount > 0 || room.ballistic.count > 0);
    assert.equal(room.dirtyFluidRender[cellChunkIndex(room.vats[0].minX, room.vats[0].minY, room.vats[0].minZ)], 1);

    // Toggle 0G to trigger 1G->0G lift and surface tension
    const pressQ = createEmptyInput();
    pressQ.pressQ = true;
    stepWorldTick(world, pressQ);
    assert.equal(room.gravityMode, GRAVITY_MODE.G0);
    for (let t = 0; t < 45; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    // Wait out CD and test 2G Crush sub-passes
    world.gravityPulse.cooldownTicks = 0;
    const pressC = createEmptyInput();
    pressC.pressC = true;
    stepWorldTick(world, pressC);
    assert.equal(room.gravityMode, GRAVITY_MODE.G2);
    for (let t = 0; t < 30; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    recomputeRoomLedgers(room);
    assert.equal(room.ledgers.water, entry.water, 'water ledger 0 drift');
    assert.equal(room.ledgers.oil, entry.oil, 'oil ledger 0 drift');
    assert.equal(room.ledgers.cryo, entry.cryo, 'cryo ledger 0 drift');
    assert.equal(room.ledgers.acid, entry.acid, 'acid ledger 0 drift');
  });
  it('never leaves bit 22 set after moves, falls completely through grate to pit, and wakes sleeping fluid on gravity shifts', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Drop a single WATER cell right above the STEEL_GRATE over the pit (x=150, y=38, z=115)
    writeCell(room, 150, CARGO_CATWALK_Y_MAX + 1, 115, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));

    for (let t = 0; t < 90; t++) {
      stepWorldTick(world, createEmptyInput());
      for (let i = 0; i < room.activeFluidNextCount; i++) {
        assert.equal((room.grid[room.activeFluidNext[i]] >>> 22) & 1, 0, 'bit 22 must be clear');
      }
    }

    // Must land on the pit floor (y=2), never stuck under the catwalk at y=35
    assert.equal(getMat(room.grid[cellIndex(150, 2, 115)]), MAT.WATER);
    assert.equal(getMat(room.grid[cellIndex(150, CARGO_CATWALK_Y_MIN - 1, 115)]), MAT.AIR);

    // Let it sleep, then trigger V (-1G): must wake and rise to ceiling (y=61)
    for (let t = 0; t < 5; t++) stepWorldTick(world, createEmptyInput());
    const pressV = createEmptyInput();
    pressV.pressV = true;
    stepWorldTick(world, pressV);
    for (let t = 0; t < 120; t++) stepWorldTick(world, createEmptyInput());
    assert.equal(getMat(room.grid[cellIndex(150, 2, 115)]), MAT.AIR);
    assert.equal(getMat(room.grid[cellIndex(150, 61, 115)]), MAT.WATER);
  });
  it('drains a vat through a single 1-voxel bottom hole with hydrostatic spread and 0 drift', () => {
    const world = makeCargoWorld();
    const room = world.room;
    const vat = room.vats[0]; // WATER vat at x=24..39, y=12..26, z=44..59
    const startWater = room.ledgers.water;

    // Punch a single 1-voxel hole at the bottom East wall (x=39, y=13, z=51)
    writeCell(room, vat.maxX, vat.minY + 1, Math.floor((vat.minZ + vat.maxZ) / 2), packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), 1);

    for (let t = 0; t < 360; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    // Count water still inside the vat vs spilled outside
    let inside = 0;
    for (let y = vat.minY + 1; y < vat.maxY; y++) {
      for (let z = vat.minZ + 1; z < vat.maxZ; z++) {
        for (let x = vat.minX + 1; x < vat.maxX; x++) {
          if (getMat(room.grid[cellIndex(x, y, z)]) === MAT.WATER) inside++;
        }
      }
    }
    const spilled = vat.interiorLiters - inside;
    assert.ok(spilled >= 200, `expected steady drain out of 1-voxel hole, spilled=${spilled}`);

    recomputeRoomLedgers(room);
    assert.equal(room.ledgers.water, startWater, '0 water ledger drift during 1-voxel drain');
  });
  it('lofts puddles room-wide across opposite corners in 0G via CA using 0 ballistic slots', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Place two distant 4x4 puddles on opposite corners of the 24x24 m Cargo Hold
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        writeCell(room, 60 + dx, CARGO_DECK_TOP_Y, 40 + dz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT), 1);
        writeCell(room, 180 + dx, CARGO_DECK_TOP_Y, 190 + dz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT), 1);
      }
    }
    recomputeRoomLedgers(room);
    const startWater = room.ledgers.water;

    const pressQ = createEmptyInput();
    pressQ.pressQ = true;
    stepWorldTick(world, pressQ);

    for (let t = 0; t < 45; t++) {
      assert.equal(room.ballistic.count, 0, '0G loft must use 0 ballistic slots');
      stepWorldTick(world, createEmptyInput());
    }

    let nwSumY = 0;
    let nwCount = 0;
    let seSumY = 0;
    let seCount = 0;
    for (let y = CARGO_DECK_TOP_Y; y < CARGO_DECK_TOP_Y + 20; y++) {
      for (let z = 36; z <= 48; z++) {
        for (let x = 56; x <= 68; x++) {
          if (getMat(room.grid[cellIndex(x, y, z)]) === MAT.WATER) {
            nwSumY += (y - CARGO_DECK_TOP_Y) * 0.1;
            nwCount++;
          }
        }
      }
      for (let z = 186; z <= 198; z++) {
        for (let x = 176; x <= 188; x++) {
          if (getMat(room.grid[cellIndex(x, y, z)]) === MAT.WATER) {
            seSumY += (y - CARGO_DECK_TOP_Y) * 0.1;
            seCount++;
          }
        }
      }
    }

    assert.equal(nwCount, 16);
    assert.equal(seCount, 16);
    const nwMean = nwSumY / nwCount;
    const seMean = seSumY / seCount;
    assert.ok(nwMean >= 0.55 && nwMean <= 1.1, `NW puddle loft out of range: ${nwMean}`);
    assert.ok(seMean >= 0.55 && seMean <= 1.1, `SE puddle loft out of range: ${seMean}`);

    recomputeRoomLedgers(room);
    assert.equal(room.ledgers.water, startWater, '0 water ledger drift during room-wide 0G loft');
  });

  it('lets water trapped in the intact bottom basin of a cracked vat settle to 0 active cells', () => {
    const world = makeCargoWorld();
    const room = world.room;
    const vat = room.vats[0]; // WATER vat y=12..26
    // Break only the upper rim (y=24) so the lower half stays trapped inside glass walls
    writeCell(room, vat.maxX, vat.maxY - 2, Math.floor((vat.minZ + vat.maxZ) / 2), packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), 1);
    for (let t = 0; t < 180; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(room.activeFluidCurCount, 0, `trapped vat water must sleep, active=${room.activeFluidCurCount}`);
    assert.equal(room.activeFluidNextCount, 0);
  });

  it('shatters ICE 1:1 to Ballistic(ICE) on qualifying wall-splat and preserves water when ballistic pool is full', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Place an ICE wall on the deck in front of the player
    writeCell(room, 110, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE), 1);
    writeCell(room, 110, CARGO_DECK_TOP_Y + 1, 50, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE), 1);
    recomputeRoomLedgers(room);
    const startWater = room.ledgers.water;

    // Slam player into the ICE wall with impulseTimer active and vx = 10 m/s
    world.player.x = 10.65;
    world.player.y = 1.2;
    world.player.z = 5.05;
    world.player.vx = 10.0;
    world.player.impulseTimer = 20;
    stepWorldTick(world, createEmptyInput());

    assert.equal(getMat(room.grid[cellIndex(110, CARGO_DECK_TOP_Y, 50)]), MAT.AIR, 'ICE shatters on wall-splat');
    assert.ok(room.ballistic.count >= 1, 'shattered ICE converts 1:1 to Ballistic(ICE)');
    recomputeRoomLedgers(room);
    assert.equal(room.ledgers.water, startWater, 'water ledger conserved on ICE shatter');
  });
  it('lifts a 2-layer open-deck puddle completely off the floor in -1G even when ballistic pool is nearly full', () => {
    const world = makeCargoWorld();
    const room = world.room;
    // Fill 4,080 of 4,096 ballistic slots elsewhere so pool saturates mid-lift
    const dummyWater = packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT);
    for (let i = 0; i < 4080; i++) {
      spawnBallistic(room, 19.0, 4.0, 4.0, 0, 0, 0, dummyWater);
    }
    // Build a 6x2x6 WATER puddle on open deck (x=100..105, y=12..13, z=45..50)
    for (let y = CARGO_DECK_TOP_Y; y <= CARGO_DECK_TOP_Y + 1; y++) {
      for (let z = 45; z <= 50; z++) {
        for (let x = 100; x <= 105; x++) {
          writeCell(room, x, y, z, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT), 1);
        }
      }
    }
    // Trigger -1G
    const pressV = createEmptyInput();
    pressV.pressV = true;
    stepWorldTick(world, pressV);
    for (let t = 0; t < 120; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    let groundedLeft = 0;
    for (let z = 45; z <= 50; z++) {
      for (let x = 100; x <= 105; x++) {
        if (getMat(room.grid[cellIndex(x, CARGO_DECK_TOP_Y, z)]) === MAT.WATER) groundedLeft++;
      }
    }
    assert.equal(groundedLeft, 0, `all open-deck puddle cells must obey -1G, groundedLeft=${groundedLeft}`);
  });
});
