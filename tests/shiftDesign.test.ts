import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_BURST_DMG,
  GRAVITY_MODE,
  MAT,
  TEMP_BYTE,
} from '../src/core/balance.ts';
import { generateDeckGraph, getRoomDimsForNode, SHIFT_SETPIECES } from '../src/core/deckGen.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold, generateRoomFromNode, populateRoomEntities } from '../src/core/roomGen.ts';
import { createSnapshotStore, loadInitialDeckRoom, transitionRoomSync } from '../src/core/snapshot.ts';
import { cellIndex, getMat, recomputeRoomLedgers } from '../src/core/types.ts';
import {
  createEmptyInput,
  createFloaterEntity,
  createSkittererEntity,
  createWorldState,
} from '../src/core/world.ts';

describe('SHIFT-First Design — 0-Dmg Air Burst, Gas-Bladder Floater 2G Crush, Arrival Shift Gate & Vertical Arenas', () => {
  it('enforces 0 raw Air Burst HP damage on unfrozen enemies while shattering frozen targets for 45 dmg', () => {
    assert.equal(AIR_BURST_DMG, 0);
    const world = createWorldState(9701);
    generateCargoHold(world.room, 9701);
    world.entities.length = 0;
    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    const sk = createSkittererEntity(10, 8.2, 1.2, 5.0, MAT.OIL);
    world.entities.push(sk);
    world.room.entitiesRef = world.entities;

    const startHp = sk.hp;
    const burst = createEmptyInput();
    burst.aimX = 1;
    burst.aimZ = 0;
    burst.primaryHeld = true;
    stepWorldTick(world, burst);

    assert.equal(sk.hp, startHp, 'Unfrozen enemy takes 0 raw Air Burst HP damage');
    assert.ok(sk.vx > 5.0, 'Air Burst still imparts full kinetic shove velocity');

    // Now freeze the enemy -> Air Burst delivers 45 dmg 3x CRYO SHATTER
    sk.tempByte = TEMP_BYTE.EMBRITTLED;
    sk.x = 8.2;
    sk.vx = 0;
    world.suit.airBurstCdTicks = 0;
    stepWorldTick(world, burst);
    assert.ok(sk.hp <= startHp - 45, `Expected 45 dmg Cryo Shatter, got hp=${sk.hp}`);
  });

  it('keeps Gas-Bladder Floater hovering above floor in 1G and violently slams it with C (2G Crush)', () => {
    const world = createWorldState(9702);
    generateCargoHold(world.room, 9702);
    world.entities.length = 0;
    world.player.x = 4.0;
    world.player.y = 1.2;
    world.player.z = 5.0;

    const fl = createFloaterEntity(20, 9.5, 2.8, 5.0, MAT.OIL);
    world.entities.push(fl);
    world.room.entitiesRef = world.entities;

    // 30 ticks in 1G -> stays hovering well above the 1.2 m deck
    for (let t = 0; t < 30; t++) stepWorldTick(world, createEmptyInput());
    assert.ok(fl.y > 2.2, `Expected Floater to hover in 1G, got y=${fl.y}`);

    const hpBeforeCrush = fl.hp;
    // Press C (2G Crush) -> overwhelms gas bladder, slams Floater into 1.2 m deck for big damage + stun
    const pressC = createEmptyInput();
    pressC.pressC = true;
    stepWorldTick(world, pressC);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G2);

    for (let t = 0; t < 30; t++) stepWorldTick(world, createEmptyInput());
    assert.ok(fl.y <= 1.35, `Expected 2G Crush to slam Floater to deck, got y=${fl.y}`);
    assert.ok(fl.hp <= hpBeforeCrush - 25, `Expected heavy 2G Crush damage, dealt ${hpBeforeCrush - fl.hp}`);
    assert.ok(fl.stunTicks > 0 || fl.stunImmunityTicks > 0, '2G Crush stuns slammed Floater');
  });

  it('builds a 2.0 m Arrival Shift Gate wall blocking 1G walk-out while leaving 0G airspace open above', () => {
    const deck = generateDeckGraph(9703, false);
    const world = createWorldState(deck.runSeed);
    loadInitialDeckRoom(world, deck, 0, null);
    const room = world.room;
    const door = room.doors[0];

    // Check the gate wall voxel directly in front of the door is solid HULL_STEEL at y=10 (1.0 m) and AIR at y=28 (2.8 m)
    let gx = 40;
    let gz = 40;
    if (door.face === 'N') gz = 15;
    else if (door.face === 'S') gz = 64;
    else if (door.face === 'W') gx = 15;
    else gx = 65;

    assert.equal(getMat(room.grid[cellIndex(gx, 10, gz)]), MAT.HULL_STEEL, 'Shift Gate blocks 1G walking');
    assert.equal(getMat(room.grid[cellIndex(gx, 28, gz)]), MAT.AIR, 'Airspace above Shift Gate is open for 0G flight');
  });

  it('stitches all 3 Shift-Architecture setpieces across seeds, spawns Floaters, and keeps Drift = 0 across -1G inversion & RLE backtracking', () => {
    const seenShift = new Set<string>();
    let sawFloater = false;
    let testedFloodedSumpInvert = false;

    for (let s = 1; s <= 10; s++) {
      const deck = generateDeckGraph(9800 + s * 41, false);
      const world = createWorldState(deck.runSeed);
      for (const node of deck.nodes) {
        if (node.combatIndex === 0) continue;
        assert.ok((SHIFT_SETPIECES as readonly string[]).includes(node.setpieces[0]), 'Slot 0 must be a Shift setpiece');
        seenShift.add(node.setpieces[0]);
        generateRoomFromNode(world.room, node);
        populateRoomEntities(world, node);
        if (world.entities.some((e) => e.locomotion === 'floater')) sawFloater = true;

        if (!testedFloodedSumpInvert && node.setpieces[0] === 'flooded_sump') {
          testedFloodedSumpInvert = true;
          const store = createSnapshotStore();
          loadInitialDeckRoom(world, deck, node.id, node.doors[0].face);
          recomputeRoomLedgers(world.room, world.playerTank);
          const entry = { ...world.room.ledgers };

          // Press V (-1G) to invert the sub-floor sump upward through the STEEL_GRATE deck!
          const inv = createEmptyInput();
          inv.pressV = true;
          stepWorldTick(world, inv);
          for (let t = 0; t < 45; t++) stepWorldTick(world, createEmptyInput());

          recomputeRoomLedgers(world.room, world.playerTank);
          assert.equal(world.room.ledgers.water, entry.water);
          assert.equal(world.room.ledgers.oil, entry.oil);
          assert.equal(world.room.ledgers.cryo, entry.cryo);
          assert.equal(world.room.ledgers.acid, entry.acid);

          // Verify RLE airlock round-trip preserves Drift = 0
          const dims = getRoomDimsForNode(node);
          assert.equal(dims.w % 16, 0);
          transitionRoomSync(world, deck, store, 0, deck.nodes[0].doors[0].face);
          transitionRoomSync(world, deck, store, node.id, node.doors[0].face);
          recomputeRoomLedgers(world.room, world.playerTank);
          assert.equal(world.room.ledgers.water, entry.water);
          assert.equal(world.room.ledgers.oil, entry.oil);
          assert.equal(world.room.ledgers.cryo, entry.cryo);
          assert.equal(world.room.ledgers.acid, entry.acid);
        }
      }
    }

    assert.ok(seenShift.has('flooded_sump'));
    assert.ok(seenShift.has('split_chasm'));
    assert.ok(seenShift.has('ceiling_vats'));
    assert.ok(sawFloater, 'Parametric arenas must spawn hovering Floaters');
    assert.ok(testedFloodedSumpInvert, 'Flooded Sump -1G inversion must run');
  });
});
