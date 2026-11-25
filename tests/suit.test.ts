import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  DASH_CD_TICKS,
  DASH_DURATION_TICKS,
  DASH_EXHAUST_L,
  DASH_GRACE_TICKS,
  GRAVITY_MODE,
  MAT,
  MAX_ACTIVE_BALLISTIC,
  NOZZLE_TAP_BURST_L,
  NOZZLE_TAP_CD_TICKS,
  NOZZLE_TAP_WAIT_TICKS,
  PLAYER_DRY_MASS_KG,
  PLAYER_MAX_HP,
  TEMP_BYTE,
  siphonRateLPerTick,
  tankStarterCapL,
} from '../src/core/balance.ts';
import { spawnBallistic } from '../src/core/fluids.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import {
  BALLISTIC_FLAG,
  carveSphereDebug,
  packVoxel,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import {
  createEmptyInput,
  createWorldState,
  getActiveChamber,
  getEffectiveMassKg,
  setTankCapRank,
  type WorldState,
} from '../src/core/world.ts';

function makeCargoWorld(seed = 3101): WorldState {
  const world = createWorldState(seed);
  generateCargoHold(world.room, seed);
  recomputeRoomLedgers(world.room, world.playerTank);
  world.entryLedgers = { ...world.room.ledgers };
  return world;
}

describe('Milestone 3.1 — Starter Tank, Atomic Siphon, Loaded Nozzle & Plumbed Jetpack Dash', () => {
  it('siphons exact 2 + siphonRank L/tick nearest-first, respects cap & LOS, passes grates, and couples effectiveMassKg', () => {
    const world = makeCargoWorld();
    const room = world.room;

    // Place player on open deck facing +X
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    // Lay a 15-cell WATER line along +X (x=115..129 -> 1.5..2.9 m away) and OIL farther out (x=135..144)
    for (let x = 115; x <= 129; x++) {
      writeCell(room, x, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT, 40));
    }
    for (let x = 135; x <= 144; x++) {
      writeCell(room, x, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT));
    }
    // Also place ACID, FIRE, STEAM, ICE right in front (must be rejected)
    writeCell(room, 110, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.ACID, TEMP_BYTE.AMBIENT));
    writeCell(room, 111, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 30));
    writeCell(room, 112, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.STEAM, TEMP_BYTE.BOIL, 45));
    writeCell(room, 113, CARGO_DECK_TOP_Y + 3, 50, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE));

    recomputeRoomLedgers(room, world.playerTank);
    const startLedgers = { ...room.ledgers };

    // Rank 0 -> exact 2 L/tick, selecting nearest WATER and skipping ACID/FIRE/STEAM/ICE
    const inp = createEmptyInput();
    inp.aimX = 1;
    inp.aimY = 0;
    inp.aimZ = 0;
    inp.siphonHeld = true;
    stepWorldTick(world, inp);

    const ch = getActiveChamber(world.playerTank);
    assert.equal(ch.mat, MAT.WATER);
    assert.equal(ch.liters, siphonRateLPerTick(0));
    assert.equal(world.suit.siphonActive, true);
    assert.equal(ch.chargeUnits, 38, 'picked up 40 chargeUnits then decayed -2 in Stage 1');
    assert.equal(getEffectiveMassKg(world.player, world.playerTank), PLAYER_DRY_MASS_KG + 2.0);

    // Raise siphonRank to 2 -> exact 4 L/tick
    world.siphonRank = 2;
    stepWorldTick(world, inp);
    assert.equal(ch.liters, 2 + siphonRateLPerTick(2));

    // Verify zero drift across room + tank
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startLedgers.water);
    assert.equal(room.ledgers.oil, startLedgers.oil);
    assert.equal(room.ledgers.acid, startLedgers.acid);
  });

  it('blocks siphon LOS through intact GLASS_VAT and HULL_STEEL while passing STEEL_GRATE', () => {
    const world = makeCargoWorld();
    const room = world.room;

    // Stand directly next to intact WATER vat 0 (x=24..39, y=12..26, z=44..59) aiming into it
    world.player.x = 4.6;
    world.player.y = 1.2;
    world.player.z = 5.1;
    world.player.grounded = true;

    const aimVat = createEmptyInput();
    aimVat.aimX = -1;
    aimVat.aimY = 0;
    aimVat.aimZ = 0;
    aimVat.siphonHeld = true;
    stepWorldTick(world, aimVat);
    assert.equal(getActiveChamber(world.playerTank).liters, 0, 'intact GLASS_VAT blocks siphon LOS');

    // Place player on the STEEL_GRATE catwalk aiming down through the 2-voxel grate at WATER below
    world.player.x = 12.0;
    world.player.y = (CARGO_CATWALK_Y_MAX + 1) * 0.1;
    world.player.z = 16.0;
    world.player.grounded = true;
    writeCell(room, 120, CARGO_CATWALK_Y_MIN - 2, 160, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
    writeCell(room, 121, CARGO_CATWALK_Y_MIN - 2, 160, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));

    const aimDown = createEmptyInput();
    aimDown.aimX = 0;
    aimDown.aimY = -1;
    aimDown.aimZ = 0;
    aimDown.siphonHeld = true;
    stepWorldTick(world, aimDown);
    assert.equal(getActiveChamber(world.playerTank).liters, 2, 'siphon LOS passes through STEEL_GRATE');
  });

  it('respects Starter Tank cap ranks (120/150/180/210 L) and fires exact 5+5+5 L tap, partial 5+5+2 L, and 60 L/s hose', () => {
    const world = makeCargoWorld();
    const room = world.room;
    world.player.x = 11.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    setTankCapRank(world, 1);
    assert.equal(getActiveChamber(world.playerTank).capL, tankStarterCapL(1));

    // Pre-fill 30 L WATER directly into starter tank
    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.WATER;
    ch.liters = 30;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    // Tap LMB on tick 0, then release -> fires 5 L on ticks 0, 4, 8 (15 L total)
    const tap = createEmptyInput();
    tap.aimX = 1;
    tap.aimY = 0;
    tap.aimZ = 0;
    tap.primaryHeld = true;
    stepWorldTick(world, tap);
    assert.equal(ch.liters, 25, 'shot 1 (5 L) on tick 0');
    assert.equal(room.ballistic.count, 5);

    // Check FIRED_BY_PLAYER flag on spawned quanta
    let flagged = 0;
    for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
      if (room.ballistic.active[i] && (room.ballistic.flags[i] & BALLISTIC_FLAG.FIRED_BY_PLAYER)) {
        flagged++;
      }
    }
    assert.equal(flagged, 5);

    const idle = createEmptyInput();
    idle.aimX = 1;
    idle.aimZ = 0;
    // Ticks 1..3: spacing countdown
    stepWorldTick(world, idle);
    stepWorldTick(world, idle);
    stepWorldTick(world, idle);
    assert.equal(ch.liters, 25);
    // Tick 4: shot 2 (5 L)
    stepWorldTick(world, idle);
    assert.equal(ch.liters, 20, 'shot 2 (5 L) on tick 4');
    // Ticks 5..7
    stepWorldTick(world, idle);
    stepWorldTick(world, idle);
    stepWorldTick(world, idle);
    assert.equal(ch.liters, 20);
    // Tick 8: shot 3 (5 L)
    stepWorldTick(world, idle);
    assert.equal(ch.liters, 30 - NOZZLE_TAP_BURST_L, 'shot 3 (5 L) on tick 8');

    // Wait out tap CD, set tank to 12 L, hold LMB -> partial burst 5+5+2 L cleanly empties tank
    for (let t = 0; t < NOZZLE_TAP_CD_TICKS; t++) stepWorldTick(world, idle);
    ch.liters = 12;
    recomputeRoomLedgers(room, world.playerTank);
    const partialStart = room.ledgers.water;

    const hold = createEmptyInput();
    hold.aimX = 1;
    hold.aimZ = 0;
    hold.primaryHeld = true;
    stepWorldTick(world, hold);
    assert.equal(ch.liters, 7, 'partial shot 1: 5 L');
    for (let t = 0; t < 4; t++) stepWorldTick(world, hold);
    assert.equal(ch.liters, 2, 'partial shot 2: 5 L');
    for (let t = 0; t < 4; t++) stepWorldTick(world, hold);
    assert.equal(ch.liters, 0, 'partial shot 3: 2 L');
    assert.equal(ch.mat, MAT.AIR);

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, partialStart, 'zero water drift during partial burst');

    // Now test hold hose: fill 25 L, hold continuously past 18-tick tap CD -> 15 L tap + 1 L/tick hose
    for (let t = 0; t < NOZZLE_TAP_CD_TICKS; t++) stepWorldTick(world, idle);
    ch.mat = MAT.WATER;
    ch.liters = 25;
    for (let t = 0; t < 23; t++) {
      stepWorldTick(world, hold);
    }
    // Ticks 0..17 consume 15 L tap; ticks 18..22 (5 ticks) consume 5 L hose -> 5 L remaining
    assert.equal(ch.liters, 5, 'hose transitions at tick 18 and consumes 1 L/tick');
    assert.ok(startWater > 0);
  });

  it('never deletes tank liters when ballistic pool is full (nozzle wait/pause & dry-exhaust dash)', () => {
    const world = makeCargoWorld();
    const room = world.room;
    world.player.x = 11.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.OIL;
    ch.liters = 40;

    // Fill ballistic pool to exact 4,096 ceiling with stationary 0G-like quanta
    world.room.gravityMode = GRAVITY_MODE.G0;
    const dummy = packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT);
    for (let i = 0; i < MAX_ACTIVE_BALLISTIC; i++) {
      spawnBallistic(room, 18.0, 4.0, 4.0, 1.0, 0, 0, dummy);
    }
    assert.equal(room.ballistic.count, MAX_ACTIVE_BALLISTIC);

    // Attempt tap burst while full -> waits NOZZLE_TAP_WAIT_TICKS then cancels with 0 L consumed
    const fire = createEmptyInput();
    fire.aimX = 1;
    fire.aimZ = 0;
    fire.primaryHeld = true;
    for (let t = 0; t < NOZZLE_TAP_WAIT_TICKS + 2; t++) {
      // Keep pool pinned at MAX_ACTIVE_BALLISTIC
      while (room.ballistic.count < MAX_ACTIVE_BALLISTIC) {
        spawnBallistic(room, 18.0, 4.0, 4.0, 1.0, 0, 0, dummy);
      }
      stepWorldTick(world, fire);
    }
    assert.equal(ch.liters, 40, 'pool-full nozzle must never decrement tank');

    // Attempt plumbed dash while pool full -> player dashes at 14 m/s but consumes 0 L
    const dash = createEmptyInput();
    dash.aimX = 1;
    dash.aimZ = 0;
    dash.pressDash = true;
    while (room.ballistic.count < MAX_ACTIVE_BALLISTIC) {
      spawnBallistic(room, 18.0, 4.0, 4.0, 1.0, 0, 0, dummy);
    }
    stepWorldTick(world, dash);
    assert.equal(world.player.dashTimer, DASH_DURATION_TICKS - 1);
    assert.equal(ch.liters, 40, 'pool-full dash skips exhaust without deleting tank liters');
  });

  it('dashes 14 m/s for 24 ticks with 24 L exhaust, grants 0.15 s wall-splat grace, and lays 0G oil ribbon with 0 drift', () => {
    const world = makeCargoWorld();
    const room = world.room;

    // 1. Test wall-splat immunity during dash + 0.15 s grace by dashing straight into a wall
    world.player.x = 22.8;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;
    world.player.impulseTimer = 30;
    const wallDash = createEmptyInput();
    wallDash.moveX = 1;
    wallDash.pressDash = true;
    for (let t = 0; t < DASH_DURATION_TICKS + DASH_GRACE_TICKS; t++) {
      stepWorldTick(world, t === 0 ? wallDash : createEmptyInput());
    }
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'player is wall-splat immune during dash + grace');
    assert.ok(world.suit.dashCdTicks <= DASH_CD_TICKS - DASH_DURATION_TICKS);

    // 2. End-to-end M3.1 Playtest Gate: shatter OIL vat, siphon 120 L, toggle 0G, dash 24 L oil ribbon -> 0 drift
    const oilVat = room.vats[2];
    assert.equal(oilVat.mat, MAT.OIL);
    carveSphereDebug(room, oilVat.minX, oilVat.minY + 2, oilVat.minZ + 7, 4, world.simTick);
    for (let t = 0; t < 45; t++) stepWorldTick(world, createEmptyInput());

    // Position player facing the spilled OIL puddle and siphon full 120 L
    world.player.x = (oilVat.minX - 10) * 0.1;
    world.player.y = 1.2;
    world.player.z = (oilVat.minZ + 7) * 0.1;
    world.player.grounded = true;
    world.suit.dashCdTicks = 0;
    world.gravityPulse.cooldownTicks = 0;

    const siphonInp = createEmptyInput();
    siphonInp.aimX = 1;
    siphonInp.aimY = -0.35;
    siphonInp.aimZ = 0;
    siphonInp.siphonHeld = true;
    for (let t = 0; t < 80; t++) {
      stepWorldTick(world, siphonInp);
      if (getActiveChamber(world.playerTank).liters >= 120) break;
    }
    const ch = getActiveChamber(world.playerTank);
    assert.equal(ch.mat, MAT.OIL);
    assert.equal(ch.liters, 120, 'siphoned full 120 L OIL from broken vat');
    assert.equal(getEffectiveMassKg(world.player, world.playerTank), PLAYER_DRY_MASS_KG + 120 * 0.8);

    // Move to open deck, toggle 0G, and Jetpack Dash to lay a 24 L floating OIL ribbon
    world.player.x = 6.0;
    world.player.y = 2.6;
    world.player.z = 11.0;
    const qInp = createEmptyInput();
    qInp.pressQ = true;
    stepWorldTick(world, qInp);
    assert.equal(room.gravityMode, GRAVITY_MODE.G0);

    const dash0G = createEmptyInput();
    dash0G.aimX = 1;
    dash0G.aimY = 0;
    dash0G.aimZ = 0;
    dash0G.pressDash = true;
    stepWorldTick(world, dash0G);
    for (let t = 1; t < DASH_DURATION_TICKS; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(ch.liters, 120 - DASH_EXHAUST_L, '24 L OIL exhausted across 24-tick 0G dash');

    // Let 0G ribbon auto-reinsert into grid
    for (let t = 0; t < 20; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, world.entryLedgers.water, '0 water drift');
    assert.equal(room.ledgers.oil, world.entryLedgers.oil, '0 oil drift');
    assert.equal(room.ledgers.cryo, world.entryLedgers.cryo, '0 cryo drift');
    assert.equal(room.ledgers.acid, world.entryLedgers.acid, '0 acid drift');
  });
});
