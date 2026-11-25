import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_BURST_DMG,
  CARGO_DECK_TOP_Y,
  GRAVITY_MODE,
  MAT,
  SKITTERER_MAX_HP,
  TEMP_BYTE,
  VOXEL_SIZE_M,
} from '../src/core/balance.ts';
import { generateDeckGraph, getRoomDimsForNode } from '../src/core/deckGen.ts';
import { triggerElectricalPulseAt } from '../src/core/electricity.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import { createSnapshotStore, loadInitialDeckRoom, transitionRoomSync } from '../src/core/snapshot.ts';
import {
  packVoxel,
  queuePhaseExplosion,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import {
  createBruiserEntity,
  createEmptyInput,
  createSkittererEntity,
  createSpitterEntity,
  createWorldState,
} from '../src/core/world.ts';

describe('Patch B — Anti-Brute-Force Enemies & Parametric Setpiece Arena Composer', () => {
  it('cuts raw Air Burst damage by 75% on Armored Carapace Bruiser and resists light stagger', () => {
    const world = createWorldState(9101);
    generateCargoHold(world.room, 9101);
    world.entities.length = 0;
    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 6.0;
    world.player.grounded = true;

    const bruiser = createBruiserEntity(10, 8.2, 1.2, 6.0, MAT.OIL);
    bruiser.aiState = 'telegraph';
    bruiser.aiTimer = 30;
    world.entities.push(bruiser);
    world.room.entitiesRef = world.entities;

    const startHp = bruiser.hp;
    const burst = createEmptyInput();
    burst.aimX = 1;
    burst.aimZ = 0;
    burst.primaryHeld = true;
    stepWorldTick(world, burst);

    const dealt = startHp - bruiser.hp;
    assert.ok(dealt <= Math.ceil(AIR_BURST_DMG * 0.25), `expected 75% mitigation, got dealt=${dealt}`);
    assert.equal(bruiser.stunTicks, 0, 'Armored Bruiser must resist light Air Burst interrupt');
  });

  it('counters Armored Bruiser via (1) Cryo Embrittled 3x shatter, (2) Phase Explosion bypass, (3) Electric stun-lock fry, and (4) Burning oil / 0G Vent', () => {
    // Counter 1: Cryo Freeze -> Embrittled 3x Shatter via Air Burst & 2G slam
    {
      const world = createWorldState(9102);
      generateCargoHold(world.room, 9102);
      world.entities.length = 0;
      world.player.x = 6.0;
      world.player.y = 1.2;
      world.player.z = 6.0;
      world.player.grounded = true;

      const bruiser = createBruiserEntity(11, 8.2, 1.2, 6.0, MAT.OIL);
      bruiser.tempByte = TEMP_BYTE.EMBRITTLED;
      world.entities.push(bruiser);
      world.room.entitiesRef = world.entities;

      const startHp = bruiser.hp;
      const burst = createEmptyInput();
      burst.aimX = 1;
      burst.aimZ = 0;
      burst.primaryHeld = true;
      stepWorldTick(world, burst);

      assert.ok(startHp - bruiser.hp >= 40, `expected Embrittled 3x shatter burst, got ${startHp - bruiser.hp}`);
      assert.ok(bruiser.stunTicks > 0, 'Embrittled shatter stuns Armored Bruiser');
    }

    // Counter 2: Steam/Cryo Phase Explosion bypasses armor & forces stun
    {
      const world = createWorldState(9103);
      generateCargoHold(world.room, 9103);
      world.entities.length = 0;
      const bruiser = createBruiserEntity(12, 10.0, 1.2, 10.0, MAT.OIL);
      world.entities.push(bruiser);
      world.room.entitiesRef = world.entities;

      const startHp = bruiser.hp;
      queuePhaseExplosion(world.room, 10.0, 1.8, 10.2, false, 'cryo');
      stepWorldTick(world, createEmptyInput());

      assert.ok(startHp - bruiser.hp >= 15, `expected unmitigated blast dmg, got ${startHp - bruiser.hp}`);
      assert.ok(bruiser.stunTicks > 0, 'Phase Explosion forces stun through Bruiser armor');
    }

    // Counter 3: Electrified Water forces stun-lock & conductive fry DPS
    {
      const world = createWorldState(9104);
      generateCargoHold(world.room, 9104);
      world.entities.length = 0;
      const bruiser = createBruiserEntity(13, 10.0, 1.2, 5.0, MAT.OIL);
      world.entities.push(bruiser);
      world.room.entitiesRef = world.entities;

      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          writeCell(world.room, 100 + dx, CARGO_DECK_TOP_Y, 50 + dz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
        }
      }
      triggerElectricalPulseAt(world.room, 100, CARGO_DECK_TOP_Y, 50, 62, 1);
      const startHp = bruiser.hp;
      for (let t = 0; t < 15; t++) stepWorldTick(world, createEmptyInput());

      assert.ok(startHp - bruiser.hp >= 5, `expected rapid conductive fry, got ${startHp - bruiser.hp}`);
      assert.ok(bruiser.stunTicks > 0, 'Electrified water forces stun-lock on Armored Bruiser');
    }

    // Counter 4: 0G full punt into burning pit / fire bypasses armor
    {
      const world = createWorldState(9105);
      generateCargoHold(world.room, 9105);
      world.entities.length = 0;
      world.room.gravityMode = GRAVITY_MODE.G0;
      world.player.x = 6.0;
      world.player.y = 1.6;
      world.player.z = 5.0;
      const bruiser = createBruiserEntity(14, 8.0, 1.6, 5.0, MAT.OIL);
      world.entities.push(bruiser);
      world.room.entitiesRef = world.entities;

      const burst = createEmptyInput();
      burst.aimX = 1;
      burst.aimZ = 0;
      burst.primaryHeld = true;
      stepWorldTick(world, burst);
      assert.ok(bruiser.vx >= 5.0, `expected full 0G punt velocity on Bruiser, got vx=${bruiser.vx}`);

      // Punt the Bruiser directly into a burning fire cloud ahead at torso height -> burns through armor
      const bvx = Math.floor((bruiser.x + 0.6) / VOXEL_SIZE_M);
      const bvy = Math.floor((bruiser.y + bruiser.height * 0.5) / VOXEL_SIZE_M);
      const bvz = Math.floor(bruiser.z / VOXEL_SIZE_M);
      for (let dx = -2; dx <= 4; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          writeCell(world.room, bvx + dx, bvy, bvz + dz, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 54));
        }
      }
      const hpBeforeBurn = bruiser.hp;
      for (let t = 0; t < 30; t++) stepWorldTick(world, createEmptyInput());
      assert.ok(bruiser.hp < hpBeforeBurn - 4, 'Burning fire/oil bypasses Armored Bruiser plating');
    }
  });

  it('perches High-Ground Scaffold Spitter on flammable WOOD_BARRIER and drops it when supports burn out (0 drift)', () => {
    const world = createWorldState(9106);
    generateCargoHold(world.room, 9106);
    world.entities.length = 0;
    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 6.0;

    // Build compact flammable WOOD perch at y=28..29 (1.6 m above 1.2 m deck)
    for (let x = 96; x <= 104; x++) {
      for (let z = 56; z <= 64; z++) {
        writeCell(world.room, x, 28, z, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT));
        writeCell(world.room, x, 29, z, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT));
      }
    }
    const spitter = createSpitterEntity(20, 10.0, 3.0, 6.0, MAT.OIL);
    spitter.attackCdTicks = 0;
    world.entities.push(spitter);
    world.room.entitiesRef = world.entities;
    recomputeRoomLedgers(world.room, world.playerTank);
    const startOil = world.room.ledgers.oil;

    // Step until Spitter winds up and fires a 6 L ranged volley from its perch
    for (let t = 0; t < 45; t++) stepWorldTick(world, createEmptyInput());
    assert.ok(spitter.glands[0].liters < 36, 'High-Ground Spitter fires ranged fluid volley');
    assert.ok(spitter.y >= 2.95, 'Spitter holds elevated perch instead of walking off');

    // Ignite the wooden perch directly beneath the Spitter -> burns out and drops Spitter
    for (let x = 96; x <= 104; x++) {
      for (let z = 56; z <= 64; z++) {
        writeCell(world.room, x, 28, z, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.FIRE));
        writeCell(world.room, x, 29, z, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.FIRE));
      }
    }
    for (let t = 0; t < 240; t++) stepWorldTick(world, createEmptyInput());

    assert.ok(spitter.y < 2.2, `expected burned wood perch to drop Spitter, still at y=${spitter.y}`);
    recomputeRoomLedgers(world.room, world.playerTank);
    assert.equal(world.room.ledgers.oil, startOil, '0 oil drift across Spitter volley + wood burn collapse');
  });

  it('validates Pack Skitterer 45 HP tuning and stitches all 4 Parametric Setpieces across seeds with RLE backtracking & 0 drift', () => {
    assert.equal(SKITTERER_MAX_HP, 45);
    const sk = createSkittererEntity(30, 5.0, 1.2, 5.0, MAT.OIL);
    assert.equal(sk.hp, 45);

    const seenSetpieces = new Set<string>();
    const seenDims = new Set<string>();
    for (let s = 1; s <= 12; s++) {
      const deck = generateDeckGraph(9500 + s * 37, false);
      const world = createWorldState(deck.runSeed);
      for (const node of deck.nodes) {
        if (node.combatIndex === 0) continue;
        const dims = getRoomDimsForNode(node);
        seenDims.add(`${dims.w}x${dims.d}`);
        assert.equal(dims.w % 16, 0);
        assert.equal(dims.d % 16, 0);
        assert.ok(dims.w >= 112 && dims.w <= 208 && dims.d >= 112 && dims.d <= 176);
        for (const sp of node.setpieces) seenSetpieces.add(sp);
      }
      // Verify full RLE airlock round-trip on first parametric combat room with Drift = 0
      if (s === 1) {
        const store = createSnapshotStore();
        loadInitialDeckRoom(world, deck, 1, deck.nodes[1].doors[0].face);
        recomputeRoomLedgers(world.room, world.playerTank);
        const entry = { ...world.room.ledgers };
        for (let t = 0; t < 20; t++) stepWorldTick(world, createEmptyInput());
        transitionRoomSync(world, deck, store, 0, deck.nodes[0].doors[0].face);
        transitionRoomSync(world, deck, store, 1, deck.nodes[1].doors[0].face);
        recomputeRoomLedgers(world.room, world.playerTank);
        assert.equal(world.room.ledgers.water, entry.water, '0 water drift across RLE backtracking');
        assert.equal(world.room.ledgers.oil, entry.oil, '0 oil drift across RLE backtracking');
        assert.equal(world.room.ledgers.cryo, entry.cryo, '0 cryo drift across RLE backtracking');
        assert.equal(world.room.ledgers.acid, entry.acid, '0 acid drift across RLE backtracking');
      }
    }

    assert.ok(seenSetpieces.has('tinderbox_loft'));
    assert.ok(seenSetpieces.has('tesla_pit'));
    assert.ok(seenSetpieces.has('cryo_spillway'));
    assert.ok(seenSetpieces.has('fuel_choke'));
    assert.ok(seenDims.size >= 4, `expected variable arena dimensions across seeds, got ${seenDims.size}`);
  });

  it("chills and freezes an Armored Bruiser directly via ballistic CRYO spray and slows it once frozen (0 drift)", () => {
    const world = createWorldState(9199);
    generateCargoHold(world.room, 9199);
    world.entities.length = 0;
    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 6.0;
    world.player.grounded = true;

    const bruiser = createBruiserEntity(77, 8.6, 1.2, 6.0, MAT.OIL);
    world.entities.push(bruiser);
    world.room.entitiesRef = world.entities;

    world.playerTank.chambers[0].mat = MAT.CRYO;
    world.playerTank.chambers[0].liters = 60;
    world.playerTank.chambers[0].tempByte = TEMP_BYTE.CRYO;
    recomputeRoomLedgers(world.room, world.playerTank);
    const startCryo = world.room.ledgers.cryo;

    const spray = createEmptyInput();
    spray.aimX = 1;
    spray.aimZ = 0;
    spray.primaryHeld = true;
    for (let t = 0; t < 25; t++) stepWorldTick(world, spray);

    assert.ok(bruiser.tempByte <= TEMP_BYTE.EMBRITTLED, `expected direct CRYO spray to freeze Bruiser, got tempByte=${bruiser.tempByte}`);
    recomputeRoomLedgers(world.room, world.playerTank);
    assert.equal(world.room.ledgers.cryo, startCryo, "0 cryo drift across direct Bruiser freeze");
  });
});
