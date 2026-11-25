import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CARGO_DECK_TOP_Y, MAT, TEMP_BYTE, VOXEL_SIZE_M } from '../src/core/balance.ts';
import { triggerConduitWaterImpact } from '../src/core/electricity.ts';
import { spawnBallistic } from '../src/core/fluids.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import {
  BALLISTIC_FLAG,
  cellIndex,
  getMat,
  getTimerOrCharge,
  packVoxel,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import { createEmptyInput, createWorldState, getActiveChamber } from '../src/core/world.ts';

describe('Patch A — Chaos & Feel: Crisp Electricity, Exact Cryo Shatter, Oil Flashover & Burning Wood', () => {
  it('shatters the exact elevated GLASS_VAT voxel hit by ballistic CRYO before 1G drop (0 drift)', () => {
    const world = createWorldState(9501);
    generateCargoHold(world.room, 9501);
    const room = world.room;
    const waterVat = room.vats[0];
    const hitY = waterVat.minY + 6;
    const hitZ = waterVat.minZ + 5;
    const glassX = waterVat.maxX;

    assert.equal(getMat(room.grid[cellIndex(glassX, hitY, hitZ)]), MAT.GLASS_VAT);
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    const packed = packVoxel(MAT.CRYO, TEMP_BYTE.CRYO);
    spawnBallistic(
      room,
      (glassX + 2.2) * VOXEL_SIZE_M,
      (hitY + 0.5) * VOXEL_SIZE_M,
      (hitZ + 0.5) * VOXEL_SIZE_M,
      -12.0,
      0,
      0,
      packed,
      BALLISTIC_FLAG.FIRED_BY_PLAYER,
    );
    recomputeRoomLedgers(room, world.playerTank);
    const startCryo = room.ledgers.cryo;

    for (let t = 0; t < 4; t++) stepWorldTick(world, createEmptyInput());

    assert.notEqual(
      getMat(room.grid[cellIndex(glassX, hitY, hitZ)]),
      MAT.GLASS_VAT,
      'ballistic CRYO must breach the exact elevated glass voxel on impact',
    );
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift');
    assert.equal(room.ledgers.cryo, startCryo, '0 cryo drift');
  });

  it('flashes fire back along a 1G Spark-Plug OIL dash ribbon via 2-voxel oil flashover with 0 drift', () => {
    const world = createWorldState(9502);
    generateCargoHold(world.room, 9502);
    const room = world.room;

    world.hasSparkPlug = true;
    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 3.0;
    world.player.grounded = true;
    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.OIL;
    ch.liters = 30;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    const dash = createEmptyInput();
    dash.moveX = 1;
    dash.pressDash = true;
    stepWorldTick(world, dash);
    for (let t = 0; t < 75; t++) stepWorldTick(world, createEmptyInput());

    assert.ok(
      room.ledgers.oilCombusted >= 8,
      `expected oil flashover to ignite across the dash trail, got oilCombusted=${room.ledgers.oilCombusted}`,
    );
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil drift across flashover');
  });

  it('ignites, spreads across, and burns away WOOD structures into AIR while preserving 0 fluid drift', () => {
    const world = createWorldState(9503);
    generateCargoHold(world.room, 9503);
    const room = world.room;

    for (let dx = 0; dx < 6; dx++) {
      writeCell(room, 100 + dx, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT));
    }
    writeCell(room, 99, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 40));

    recomputeRoomLedgers(room, world.playerTank);
    const startLedgers = { ...room.ledgers };

    for (let t = 0; t < 270; t++) stepWorldTick(world, createEmptyInput());

    let woodLeft = 0;
    for (let dx = 0; dx < 6; dx++) {
      if (getMat(room.grid[cellIndex(100 + dx, CARGO_DECK_TOP_Y, 50)]) === MAT.WOOD_BARRIER) woodLeft++;
    }
    assert.ok(woodLeft < 4, `expected fire to spread and burn away WOOD voxels, ${woodLeft}/6 left`);

    recomputeRoomLedgers(room, world.playerTank);
    assert.deepEqual(room.ledgers, startLedgers, 'burning WOOD preserves exact 0 drift across all fluid ledgers');
  });

  it('electrifies an entire connected puddle without gaps under repeated conduit impacts and decays cleanly in <= 25 ticks', () => {
    const world = createWorldState(9504);
    generateCargoHold(world.room, 9504);
    const room = world.room;

    room.emitters.push({
      kind: 'conduit',
      x: 100,
      y: CARGO_DECK_TOP_Y + 8,
      z: 50,
      faceDir: '+Z',
      timer: 20,
      reserveL: 0,
    });
    const cIdx = room.emitters.length - 1;

    for (let dz = 1; dz <= 5; dz++) {
      for (let dx = -5; dx <= 4; dx++) {
        writeCell(room, 100 + dx, CARGO_DECK_TOP_Y, 50 + dz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
      }
    }
    writeCell(room, 100, CARGO_DECK_TOP_Y + 8, 52, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));

    for (let t = 0; t < 5; t++) {
      triggerConduitWaterImpact(world, cIdx, 100, CARGO_DECK_TOP_Y + 8, 52, false);
      stepWorldTick(world, createEmptyInput());
    }

    let waterCells = 0;
    let chargedCells = 0;
    for (let dz = 1; dz <= 5; dz++) {
      for (let dx = -5; dx <= 4; dx++) {
        const v = room.grid[cellIndex(100 + dx, CARGO_DECK_TOP_Y, 50 + dz)];
        if (getMat(v) === MAT.WATER) {
          waterCells++;
          if (getTimerOrCharge(v) > 20) chargedCells++;
        }
      }
    }
    assert.ok(waterCells >= 30);
    assert.equal(chargedCells, waterCells, 'every connected water cell must be electrified with zero dark gaps');

    writeCell(room, 100, CARGO_DECK_TOP_Y + 8, 52, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT));
    for (let t = 0; t < 25; t++) stepWorldTick(world, createEmptyInput());

    let maxRemaining = 0;
    for (let dz = 1; dz <= 5; dz++) {
      for (let dx = -5; dx <= 4; dx++) {
        const v = room.grid[cellIndex(100 + dx, CARGO_DECK_TOP_Y, 50 + dz)];
        if (getMat(v) === MAT.WATER) {
          maxRemaining = Math.max(maxRemaining, getTimerOrCharge(v));
        }
      }
    }
    assert.equal(maxRemaining, 0, 'puddle charge must decay cleanly to 0 V within 25 ticks');
  });
});
