import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CARGO_DECK_TOP_Y, MAT, TEMP_BYTE } from '../src/core/balance.ts';
import { generateDeckGraph } from '../src/core/deckGen.ts';
import { triggerConduitWaterImpact, triggerElectricalPulseAt } from '../src/core/electricity.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import { loadInitialDeckRoom } from '../src/core/snapshot.ts';
import {
  cellIndex,
  getMat,
  getTimerOrCharge,
  packVoxel,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import {
  createEmptyInput,
  createSkittererEntity,
  createWorldState,
} from '../src/core/world.ts';

describe('Slice 2A — M2.2-full Electricity BFS, Spark Ignition, Glass Thermal Shock & Cryo Pipe', () => {
  it('keeps Arrival floor dry of charge until water touches the wall-mounted Sparking Conduit, then conducts +120 V & shocks entities', () => {
    const world = createWorldState(7101);
    const deck = generateDeckGraph(7101, false);
    loadInitialDeckRoom(world, deck, 0, null);
    const room = world.room;

    const conduit = room.emitters.find((e) => e.kind === 'conduit')!;
    assert.ok(conduit !== undefined);

    for (let t = 0; t < 40; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(getTimerOrCharge(room.grid[cellIndex(25, 2, 12)]), 0);

    for (let dz = 2; dz <= 9; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        writeCell(
          room,
          conduit.x + dx,
          2,
          conduit.z + dz,
          packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT),
          world.simTick,
        );
      }
    }
    const sk = createSkittererEntity(
      50,
      (conduit.x + 0.5) * 0.1,
      0.2,
      (conduit.z + 8.5) * 0.1,
      MAT.WATER,
    );
    world.entities.push(sk);
    world.room.entitiesRef = world.entities;
    const startHp = sk.hp;

    for (let t = 0; t < 10; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    const waterCharge = getTimerOrCharge(room.grid[cellIndex(conduit.x, 2, conduit.z + 2)]);
    assert.ok(waterCharge > 30, `expected electrified water, got charge=${waterCharge}`);
    assert.ok(sk.hp < startHp, 'electrified water deals shock DPS');
    assert.ok(sk.stunTicks > 0, 'electrified water stuns entity');
  });

  it('sparks adjacent OIL + AIR into FIRE via electrified conductor (>= +40 V) with 0 oil ledger drift', () => {
    const world = createWorldState(7102);
    generateCargoHold(world.room, 7102);
    const room = world.room;

    for (let dx = 0; dx < 4; dx++) {
      writeCell(room, 100 + dx, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    }
    writeCell(room, 104, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT));
    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    triggerElectricalPulseAt(room, 100, CARGO_DECK_TOP_Y, 50, 60, 1);
    for (let t = 0; t < 12; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.ok(room.ledgers.oilCombusted >= 1, 'electrical spark must ignite adjacent OIL + AIR');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil ledger drift across spark ignition');
  });

  it('shatters GLASS_VAT on >= 140 C thermal shock while keeping intact ambient/CRYO vats safe', () => {
    const world = createWorldState(7103);
    generateCargoHold(world.room, 7103);
    const room = world.room;

    for (let t = 0; t < 20; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    const waterVat = room.vats[0];
    const cryoVat = room.vats[3];
    assert.equal(
      getMat(room.grid[cellIndex(waterVat.maxX, waterVat.minY, waterVat.minZ + 5)]),
      MAT.GLASS_VAT,
    );
    assert.equal(
      getMat(room.grid[cellIndex(cryoVat.maxX, cryoVat.minY, cryoVat.minZ + 5)]),
      MAT.GLASS_VAT,
    );

    // Cold shock (-196 C CRYO against +20 C GLASS_VAT, |dT| = 216 C)
    writeCell(
      room,
      waterVat.maxX + 1,
      waterVat.minY,
      waterVat.minZ + 5,
      packVoxel(MAT.CRYO, TEMP_BYTE.CRYO),
    );
    // Hot shock (+200 C Pyro-Napalm against +20 C GLASS_VAT, |dT| = 180 C)
    writeCell(
      room,
      cryoVat.maxX + 1,
      cryoVat.minY,
      cryoVat.minZ + 5,
      packVoxel(MAT.OIL, TEMP_BYTE.PYRO_NAPALM),
    );

    for (let t = 0; t < 8; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.notEqual(
      getMat(room.grid[cellIndex(waterVat.maxX, waterVat.minY, waterVat.minZ + 5)]),
      MAT.GLASS_VAT,
      'CRYO thermally shocks and breaches ambient WATER GLASS_VAT',
    );
    assert.notEqual(
      getMat(room.grid[cellIndex(cryoVat.maxX, cryoVat.minY, cryoVat.minZ + 5)]),
      MAT.GLASS_VAT,
      'superheated +200 C OIL thermally shocks and breaches GLASS_VAT',
    );
  });

  it('emits CRYO from Leaking Cryo Pipe (15 L/s from finite 500 L reserve) with 0 cryo ledger drift', () => {
    const world = createWorldState(7104);
    generateCargoHold(world.room, 7104);
    const room = world.room;

    room.emitters.push({
      kind: 'cryo_pipe',
      x: 110,
      y: CARGO_DECK_TOP_Y + 6,
      z: 50,
      faceDir: '+X',
      timer: 0,
      reserveL: 500,
    });
    recomputeRoomLedgers(room, world.playerTank);
    const startCryo = room.ledgers.cryo;

    for (let t = 0; t < 60; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    const pipe = room.emitters.find((e) => e.kind === 'cryo_pipe')!;
    assert.equal(pipe.reserveL, 500 - 15);

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.cryo, startCryo);
  });

  it('arcs 1G conduit splash down into floor puddle below and backfeeds shock onto a hosing player', () => {
    const world = createWorldState(7105);
    const deck = generateDeckGraph(7105, false);
    loadInitialDeckRoom(world, deck, 0, null);
    const room = world.room;

    const conduitIdx = room.emitters.findIndex((e) => e.kind === 'conduit');
    const conduit = room.emitters[conduitIdx];
    assert.ok(conduit !== undefined);

    // Lay a floor water puddle directly beneath the high wall conduit (y = 2, conduit at y = 12)
    for (let dx = -2; dx <= 2; dx++) {
      writeCell(room, conduit.x + dx, 2, conduit.z + 2, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT), world.simTick);
    }
    // Splash water voxel at conduit height while player holds continuous water hose
    writeCell(room, conduit.x, conduit.y, conduit.z + 2, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT), world.simTick);
    world.suit.nozzleHoseActive = true;
    const startHp = world.player.hp;

    triggerConduitWaterImpact(world, conduitIdx, conduit.x, conduit.y, conduit.z + 2, true);
    for (let t = 0; t < 4; t++) stepWorldTick(world, createEmptyInput());

    let maxFloorCharge = 0;
    let chargedWaterCells = 0;
    for (let dz = 0; dz <= 5; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const val = room.grid[cellIndex(conduit.x + dx, 2, conduit.z + dz)];
        if (getMat(val) === MAT.WATER) {
          const ch = getTimerOrCharge(val);
          if (ch > maxFloorCharge) maxFloorCharge = ch;
          if (ch > 30) chargedWaterCells++;
        }
      }
    }
    assert.ok(maxFloorCharge > 30, `expected floor puddle below conduit to electrify, got ${maxFloorCharge}`);
    assert.ok(chargedWaterCells >= 4, `expected BFS spread across floor puddle, got ${chargedWaterCells} cells`);
    assert.ok(world.player.hp < startHp, 'continuous hose into live conduit shocks the player');
    assert.ok(world.player.shockTicks > 0, 'player receives visible shockTicks state');
  });

  it("propagates across an entire settled connected puddle even past already-charged cells and tracks all cells in chargedCells", () => {
    const world = createWorldState(7106);
    generateCargoHold(world.room, 7106);
    const room = world.room;

    // 24-voxel enclosed settled water trough along +X (walled so CA Rule 3 keeps all 24 cells settled)
    for (let dx = -1; dx <= 24; dx++) {
      writeCell(room, 90 + dx, CARGO_DECK_TOP_Y, 49, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
      writeCell(room, 90 + dx, CARGO_DECK_TOP_Y, 51, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
    }
    writeCell(room, 89, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
    writeCell(room, 114, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
    for (let dx = 0; dx < 24; dx++) {
      writeCell(room, 90 + dx, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    }
    // Pre-charge an intermediate cell at dx = 8 higher than what a wave passing through would initially see
    writeCell(room, 98, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT, 62));

    triggerElectricalPulseAt(room, 90, CARGO_DECK_TOP_Y, 50, 62, 1);
    for (let t = 0; t < 3; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    for (let dx = 0; dx < 24; dx++) {
      const ch = getTimerOrCharge(room.grid[cellIndex(90 + dx, CARGO_DECK_TOP_Y, 50)]);
      assert.ok(ch > 20, `expected full puddle cell dx=${dx} to stay charged, got ${ch}`);
    }
    assert.ok(room.chargedCellsCount >= 24, `expected >=24 tracked chargedCells, got ${room.chargedCellsCount}`);
  });
});
