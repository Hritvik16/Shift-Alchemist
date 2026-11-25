import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARGO_DECK_TOP_Y,
  GRAVITY_MODE,
  MAT,
  MAX_EXPLOSION_QUEUE,
  TEMP_BYTE,
} from '../src/core/balance.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import {
  cellIndex,
  getDamage,
  getMat,
  getTempByte,
  packVoxel,
  queuePhaseExplosion,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import {
  createBroodPodEntity,
  createEmptyInput,
  createWorldState,
  type WorldState,
} from '../src/core/world.ts';

function makeWorld(seed = 2201): WorldState {
  const world = createWorldState(seed);
  generateCargoHold(world.room, seed);
  recomputeRoomLedgers(world.room, world.playerTank);
  world.entryLedgers = { ...world.room.ledgers };
  return world;
}

describe('Milestone 2.2-lite — Thermal Conduction, Fire/Oil/Steam/Cryo Reactions & Phase Explosions', () => {
  it('keeps 0C ICE stable on +20C steel (|55-50|<8) and melts 1:1 to WATER beside +32C conductor with 0 drift', () => {
    const world = makeWorld();
    const room = world.room;
    const x = 100;
    const y = CARGO_DECK_TOP_Y;
    const z = 50;

    writeCell(room, x, y, z, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE));
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    // 1.0 s on ambient +20C (byte 55) HULL_STEEL: |55 - 50| = 5 < 8 -> ICE stays frozen
    for (let t = 0; t < 60; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(getMat(room.grid[cellIndex(x, y, z)]), MAT.ICE);
    assert.equal(getTempByte(room.grid[cellIndex(x, y, z)]), TEMP_BYTE.FREEZE);

    // Heat supporting steel cell to +32C (byte 58): 58 - 50 = 8 -> delta = 1 -> ICE reaches +4C (51) and melts
    writeCell(room, x, y - 1, z, packVoxel(MAT.HULL_STEEL, 58));
    for (let t = 0; t < 8; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.notEqual(getMat(room.grid[cellIndex(x, y, z)]), MAT.ICE, 'ICE melts at >= +4C');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water ledger drift across ICE -> WATER melt');
  });

  it('ignites a 0G OIL trail via the Thermal Steam Vent (+300C), burns a pod, requires AIR, and preserves OIL ledger', () => {
    const world = makeWorld();
    const room = world.room;
    room.gravityMode = GRAVITY_MODE.G0;

    const vent = room.emitters.find((e) => e.kind === 'vent');
    assert.ok(vent !== undefined, 'Cargo Hold must contain a Thermal Steam Vent');

    // Lay a 5-cell floating OIL ribbon extending out of the vent plume (y = vent.y + 4)
    const ry = vent.y + 4;
    for (let dx = 0; dx < 5; dx++) {
      writeCell(room, vent.x + dx, ry, vent.z, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT));
    }
    // Also seal a superheated OIL cell inside solid HULL_STEEL (no adjacent AIR -> must NOT ignite)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          writeCell(room, 110 + dx, 20 + dy, 50 + dz, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
        }
      }
    }
    writeCell(room, 110, 20, 50, packVoxel(MAT.OIL, TEMP_BYTE.PYRO_NAPALM));

    // Place a Brood Pod overlapping the vent plume to verify burnTicks + fire DOT
    const pod = createBroodPodEntity(1, (vent.x + 0.5) * 0.1, (vent.y + 3) * 0.1, (vent.z + 0.5) * 0.1);
    world.entities.push(pod);

    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    for (let t = 0; t < 80; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.ok(room.ledgers.oilCombusted >= 2, `vent must ignite oil ribbon, combusted=${room.ledgers.oilCombusted}`);
    assert.equal(getMat(room.grid[cellIndex(110, 20, 50)]), MAT.OIL, 'sealed OIL without adjacent AIR never ignites');
    assert.ok(pod.burnTicks > 0 && pod.hp < pod.maxHp, 'pod takes fire burn DOT');

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil ledger drift across combustion');
  });

  it('enforces pairwise WATER + FIRE dousing (1:1, no explosion) and STEAM condensation back to WATER (0 drift)', () => {
    const world = makeWorld();
    const room = world.room;

    // Enclose a 3x1x1 corridor on the deck so Stage 4 cannot separate WATER from the 2 FIRE cells before tick 4
    for (let x = 98; x <= 102; x++) {
      for (let z = 49; z <= 51; z++) {
        writeCell(room, x, CARGO_DECK_TOP_Y + 1, z, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
        if (z !== 50 || x === 98 || x === 102) {
          writeCell(room, x, CARGO_DECK_TOP_Y, z, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
        }
      }
    }
    writeCell(room, 99, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 30));
    writeCell(room, 100, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    writeCell(room, 101, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 30));

    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    // Advance to simTick = 4 (first 15 Hz reaction tick)
    for (let t = 0; t < 4; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.equal(getMat(room.grid[cellIndex(100, CARGO_DECK_TOP_Y, 50)]), MAT.STEAM, 'WATER transitions to STEAM');
    const leftMat = getMat(room.grid[cellIndex(99, CARGO_DECK_TOP_Y, 50)]);
    const rightMat = getMat(room.grid[cellIndex(101, CARGO_DECK_TOP_Y, 50)]);
    assert.equal(
      (leftMat === MAT.AIR ? 1 : 0) + (rightMat === MAT.AIR ? 1 : 0),
      1,
      'pairwise dousing removes at most ONE adjacent FIRE cell per WATER cell',
    );
    assert.equal(room.explosionQueue.length, 0, 'dousing STEAM never queues a Phase Explosion');

    // Next 15 Hz tick (simTick = 8): STEAM touching <= +80C steel roof condenses 1:1 back to WATER
    for (let t = 0; t < 4; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(getMat(room.grid[cellIndex(100, CARGO_DECK_TOP_Y, 50)]), MAT.WATER);
    assert.ok(getTempByte(room.grid[cellIndex(100, CARGO_DECK_TOP_Y, 50)]) <= TEMP_BYTE.STEAM_CONDENSE);

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift across douse -> STEAM -> condense');
  });

  it('bounds explosionQueue at 32, deduplicates 26 rays by idx (6 dmg / 3x embrittled), and gates entity damage by LOS', () => {
    const world = makeWorld();
    const room = world.room;

    // 1. Cap check: queue 40 well-separated explosions -> capped strictly at 32
    for (let i = 0; i < 40; i++) {
      const gx = 2.0 + (i % 10) * 2.0;
      const gz = 2.0 + Math.floor(i / 10) * 2.0;
      queuePhaseExplosion(room, gx, 2.0, gz, false);
    }
    assert.equal(room.explosionQueue.length, MAX_EXPLOSION_QUEUE);
    room.explosionQueue.length = 0;

    // 2. 26-ray idx deduplication + 3x embrittled wood shatter + LOS-gated entity damage
    // Ambient WOOD at (105, 15, 50), embrittled WOOD at (95, 15, 50)
    writeCell(room, 105, 15, 50, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT));
    writeCell(room, 95, 15, 50, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.EMBRITTLED));

    // Steel shield wall at z = 54 blocking podBlocked at (10.05, 1.2, 5.8), while podOpen at (10.05, 1.2, 4.1) has LOS
    for (let y = 12; y <= 26; y++) {
      for (let x = 94; x <= 106; x++) {
        writeCell(room, x, y, 54, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
      }
    }
    const podOpen = createBroodPodEntity(1, 10.05, 1.2, 4.1);
    const podBlocked = createBroodPodEntity(2, 10.05, 1.2, 5.8);
    world.entities.push(podOpen, podBlocked);

    queuePhaseExplosion(room, 10.05, 1.55, 5.05, false);
    stepWorldTick(world, createEmptyInput());

    assert.equal(getDamage(room.grid[cellIndex(105, 15, 50)]), 6, 'ambient WOOD takes exactly 6 dmg (deduped)');
    assert.equal(getMat(room.grid[cellIndex(95, 15, 50)]), MAT.AIR, 'embrittled WOOD takes 3x (18 >= 12) and shatters');
    assert.ok(podOpen.hp < podOpen.maxHp && Math.abs(podOpen.vz) > 1.0, 'LOS-clear pod takes explosion dmg + impulse');
    assert.equal(podBlocked.hp, podBlocked.maxHp, 'steel wall blocks explosion LOS');
  });

  it('freezes WATER via CRYO (+32C), boils CRYO explosively on >= +100C contact, chills pods, and extinguishes with WATER', () => {
    const world = makeWorld();
    const room = world.room;
    room.gravityMode = GRAVITY_MODE.G0;

    // 1. CRYO adjacent to WATER freezes WATER -> ICE and warms CRYO by +8 bytes (+32C)
    writeCell(room, 100, 20, 50, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
    writeCell(room, 101, 20, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    // Box them in so 0G surface tension doesn't pull them apart before tick 4
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;
    const startCryo = room.ledgers.cryo;

    for (let t = 0; t < 4; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(getMat(room.grid[cellIndex(101, 20, 50)]), MAT.ICE, 'CRYO freezes adjacent WATER to ICE');
    assert.ok(getTempByte(room.grid[cellIndex(100, 20, 50)]) >= TEMP_BYTE.CRYO + 8, 'CRYO warms +32C per freeze');

    // 2. CRYO touching >= +100C steel triggers instant Boil-Off Phase Explosion
    writeCell(room, 120, 20, 50, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.BOIL));
    writeCell(room, 121, 20, 50, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
    recomputeRoomLedgers(room, world.playerTank);
    const cryoBeforeBoil = room.ledgers.cryo;
    const prevBoiled = room.ledgers.cryoBoiledOff;

    for (let t = 0; t < 4; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(getMat(room.grid[cellIndex(121, 20, 50)]), MAT.AIR);
    assert.equal(room.ledgers.cryoBoiledOff, prevBoiled + 1);
    assert.ok(room.recentExplosions.length >= 1, 'hot-contact CRYO queues Boil-Off Phase Explosion');

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift');
    assert.equal(room.ledgers.cryo, cryoBeforeBoil, '0 cryo drift');
    assert.ok(startCryo > 0);

    // 3. Entity sampling: CRYO chills pod to embrittlement, WATER extinguishes burnTicks
    room.gravityMode = GRAVITY_MODE.G1;
    const pod = createBroodPodEntity(5, 13.05, 1.2, 5.05);
    world.entities.push(pod);
    writeCell(room, 130, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
    for (let t = 0; t < 28; t++) {
      // Refresh CRYO cell at pod feet to measure sustained chilling
      if (getMat(room.grid[cellIndex(130, CARGO_DECK_TOP_Y, 50)]) !== MAT.CRYO) {
        writeCell(room, 130, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
      }
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(pod.tempByte <= TEMP_BYTE.EMBRITTLED, `CRYO chills pod to embrittled, tempByte=${pod.tempByte}`);
    assert.ok(pod.hp < pod.maxHp, 'CRYO applies 8 DPS');

    pod.burnTicks = 180;
    writeCell(room, 130, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    stepWorldTick(world, createEmptyInput());
    assert.equal(pod.burnTicks, 0, 'WATER extinguishes burnTicks immediately');
    assert.equal(pod.wetTicks, 120, 'WATER sets wetTicks = 120');
  });

  it('chain-ignites a 1G floor OIL puddle touching the Thermal Steam Vent base collar with 0 oil drift', () => {
    const world = makeWorld(2209);
    const room = world.room;
    const vent = room.emitters.find((e) => e.kind === 'vent')!;

    // Lay a 1-voxel-deep 8x3 OIL slick on the deck (y=12) right beside the vent base (x=vent.x+2..vent.x+9)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = 2; dx <= 9; dx++) {
        writeCell(room, vent.x + dx, CARGO_DECK_TOP_Y, vent.z + dz, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT));
      }
    }
    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    for (let t = 0; t < 240; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(room.ledgers.oilCombusted >= 18, `expected roaring chain-ignition across oil slick, comb=${room.ledgers.oilCombusted}`);
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil ledger drift across full puddle burn');
  });
});
