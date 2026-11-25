import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAVITY_MODE,
  MAT,
  NOZZLE_LOBBER_SHOT_L,
  NOZZLE_MODE,
  NOZZLE_SCATTER_SHOT_L,
  SKITTERER_GLAND_CAP_L,
  TEMP_BYTE,
} from '../src/core/balance.ts';
import { generateDeckGraph } from '../src/core/deckGen.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { loadInitialDeckRoom } from '../src/core/snapshot.ts';
import { recomputeRoomLedgers } from '../src/core/types.ts';
import {
  createEmptyInput,
  createSkittererEntity,
  createWorldState,
  getActiveChamber,
} from '../src/core/world.ts';

describe('Active Combat & Nozzle Firing Modes — Skitterers, Interrupts, Bio-Siphon & 0 Drift', () => {
  it('cycles Stream -> Scatter (10 L) -> Lobber (12 L) via Tab with exact volume conservation', () => {
    const world = createWorldState(8801);
    const deck = generateDeckGraph(8801, false);
    loadInitialDeckRoom(world, deck, 0, null);

    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.WATER;
    ch.liters = 40;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    recomputeRoomLedgers(world.room, world.playerTank);
    const startWater = world.room.ledgers.water;

    assert.equal(world.suit.nozzleMode, NOZZLE_MODE.STREAM);

    // Cycle to SCATTER and fire 10 L shotgun fan
    const tab = createEmptyInput();
    tab.pressCycleNozzle = true;
    stepWorldTick(world, tab);
    assert.equal(world.suit.nozzleMode, NOZZLE_MODE.SCATTER);

    const fire = createEmptyInput();
    fire.aimX = 1;
    fire.aimZ = 0;
    fire.primaryHeld = true;
    stepWorldTick(world, fire);
    assert.equal(ch.liters, 40 - NOZZLE_SCATTER_SHOT_L);

    // Wait out scatter CD, cycle to LOBBER and fire 12 L cohesive glob
    for (let t = 0; t < 30; t++) stepWorldTick(world, createEmptyInput());
    stepWorldTick(world, tab);
    assert.equal(world.suit.nozzleMode, NOZZLE_MODE.LOBBER);

    stepWorldTick(world, fire);
    assert.equal(ch.liters, 40 - NOZZLE_SCATTER_SHOT_L - NOZZLE_LOBBER_SHOT_L);

    for (let t = 0; t < 30; t++) stepWorldTick(world, createEmptyInput());
    recomputeRoomLedgers(world.room, world.playerTank);
    assert.equal(world.room.ledgers.water, startWater, '0 water drift across Scatter + Lobber');
  });

  it('runs Skitterer chase -> telegraph -> Air Burst interrupt stun -> bio-siphon -> death gland burst with 0 drift', () => {
    const world = createWorldState(8802);
    const deck = generateDeckGraph(8802, false);
    loadInitialDeckRoom(world, deck, 0, null);

    // Spawn a Skitterer with 18 L OIL gland 2.5 m east of player
    world.entities.length = 0;
    world.player.x = 2.5;
    world.player.y = 0.2;
    world.player.z = 4.0;
    world.player.grounded = true;

    const sk = createSkittererEntity(99, 5.0, 0.2, 4.0, MAT.OIL);
    sk.attackCdTicks = 0;
    world.entities.push(sk);
    world.room.entitiesRef = world.entities;
    recomputeRoomLedgers(world.room, world.playerTank);
    const startOil = world.room.ledgers.oil;
    assert.equal(startOil, SKITTERER_GLAND_CAP_L);

    // Tick once -> Skitterer enters melee telegraph
    stepWorldTick(world, createEmptyInput());
    assert.equal(sk.aiState, 'telegraph');
    assert.equal(sk.aiAttackKind, 'melee');

    // Empty-tank Air Burst interrupts & stuns the charging Skitterer
    const burst = createEmptyInput();
    burst.aimX = 1;
    burst.aimZ = 0;
    burst.primaryHeld = true;
    stepWorldTick(world, burst);
    assert.ok(sk.stunTicks > 30, `expected interrupt stun, got ${sk.stunTicks}`);

    // Bio-siphon OIL directly from the stunned Skitterer gland
    const siphon = createEmptyInput();
    siphon.aimX = 1;
    siphon.aimZ = 0;
    siphon.siphonHeld = true;
    for (let t = 0; t < 3; t++) stepWorldTick(world, siphon);

    const ch = getActiveChamber(world.playerTank);
    assert.equal(ch.mat, MAT.OIL);
    assert.ok(ch.liters >= 2, `expected bio-siphoned oil, got ${ch.liters}`);
    assert.equal(sk.glands[0].liters + ch.liters, SKITTERER_GLAND_CAP_L);

    // Kill Skitterer -> remaining gland liters burst into world with 0 drift
    sk.hp = 0;
    stepWorldTick(world, createEmptyInput());
    for (let t = 0; t < 20; t++) stepWorldTick(world, createEmptyInput());

    recomputeRoomLedgers(world.room, world.playerTank);
    assert.equal(world.room.ledgers.oil, startOil, '0 oil drift across bio-siphon + death gland burst');
  });

  it('halts Skitterer attacks in 0G so gravity shifting leaves them helplessly tumbling', () => {
    const world = createWorldState(8803);
    const deck = generateDeckGraph(8803, false);
    loadInitialDeckRoom(world, deck, 0, null);

    world.entities.length = 0;
    const sk = createSkittererEntity(101, 5.0, 0.2, 4.0, MAT.WATER);
    sk.attackCdTicks = 0;
    world.entities.push(sk);
    world.room.entitiesRef = world.entities;

    world.room.gravityMode = GRAVITY_MODE.G0;
    sk.grounded = false;
    for (let t = 0; t < 20; t++) stepWorldTick(world, createEmptyInput());

    assert.equal(sk.aiState, 'idle', 'Skitterer cannot lunge or chase in 0G');
  });
});
