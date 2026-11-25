import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_BURST_RECOIL_0G,
  BACKFIRE_SELF_DMG,
  CARGO_DECK_TOP_Y,
  GRAVITY_MODE,
  MAT,
  PLAYER_MAX_HP,
  TEMP_BYTE,
} from '../src/core/balance.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold } from '../src/core/roomGen.ts';
import {
  BALLISTIC_FLAG,
  getMat,
  getTimerOrCharge,
  packVoxel,
  queuePhaseExplosion,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import { upgradeToBaffledTank } from '../src/core/workbench.ts';
import {
  createEmptyInput,
  createWorldState,
  getActiveChamber,
} from '../src/core/world.ts';

describe('Slice 2B — M3.2 Tank Volatility, Displacement Spills, Attachments & Hazard Tracks', () => {
  it('displaces incompatible non-hazardous fluid via expanding BFS around feetY with 0 ledger drift', () => {
    const world = createWorldState(9101);
    generateCargoHold(world.room, 9101);
    const room = world.room;

    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.WATER;
    ch.liters = 15;
    ch.tempByte = TEMP_BYTE.AMBIENT;

    // Lay OIL in front of player and siphon -> displaces 15 L WATER around feetY, then pulls OIL
    for (let x = 112; x <= 122; x++) {
      writeCell(room, x, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT));
    }
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;
    const startOil = room.ledgers.oil;

    const inp = createEmptyInput();
    inp.aimX = 1;
    inp.aimZ = 0;
    inp.siphonHeld = true;
    stepWorldTick(world, inp);

    assert.equal(ch.mat, MAT.OIL, 'chamber switches to OIL after atomic displacement');
    assert.equal(ch.liters, 2);
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'non-hazardous displacement deals 0 backfire dmg');

    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift on displacement spill');
    assert.equal(room.ledgers.oil, startOil, '0 oil drift on displacement spill');
  });

  it('triggers Starter Tank thermal backfire (>= +100 C WATER) while Baffled Tank safely holds +200 C Pyro-Napalm (0 drift)', () => {
    const world = createWorldState(9102);
    generateCargoHold(world.room, 9102);
    const room = world.room;

    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    // Place hot +100 C WATER right in front of Starter Tank -> immediate backfire (-25 HP, spilled, 0 drift)
    writeCell(room, 112, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.BOIL));
    writeCell(room, 113, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.WATER, TEMP_BYTE.BOIL));
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    const sip = createEmptyInput();
    sip.aimX = 1;
    sip.aimZ = 0;
    sip.siphonHeld = true;
    stepWorldTick(world, sip);

    assert.equal(world.player.hp, PLAYER_MAX_HP - BACKFIRE_SELF_DMG);
    assert.equal(getActiveChamber(world.playerTank).liters, 0, 'backfire spills chamber');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift across backfire spill');

    // Now upgrade to Baffled Tank and siphon +200 C Pyro-Napalm -> safe!
    upgradeToBaffledTank(world);
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 7.0;
    world.player.vx = 0;
    world.player.vy = 0;
    world.player.vz = 0;
    world.player.hp = PLAYER_MAX_HP;

    writeCell(room, 112, CARGO_DECK_TOP_Y, 70, packVoxel(MAT.OIL, TEMP_BYTE.PYRO_NAPALM));
    writeCell(room, 113, CARGO_DECK_TOP_Y, 70, packVoxel(MAT.OIL, TEMP_BYTE.PYRO_NAPALM));
    stepWorldTick(world, sip);
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'Baffled Tank safely holds +200 C Pyro-Napalm');
    assert.equal(getActiveChamber(world.playerTank).mat, MAT.OIL);
    assert.equal(getActiveChamber(world.playerTank).liters, 2);

    // Siphoning CRYO into a Baffled chamber holding >= +100 C fluid still triggers Cryo Thermal-Shock Backfire
    writeCell(room, 112, CARGO_DECK_TOP_Y, 70, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
    stepWorldTick(world, sip);
    assert.equal(world.player.hp, PLAYER_MAX_HP - BACKFIRE_SELF_DMG, 'Cryo shock backfires even in Baffled Tank');
  });

  it('activates Spark-Plug Igniter, Piezo-Arc Coil, Cryo-Expansion Nozzle, Gyro Stabilizer, and Ablative Plating', () => {
    const world = createWorldState(9103);
    generateCargoHold(world.room, 9103);
    const room = world.room;

    // 1. Spark-Plug Igniter: dash with OIL ignites the final liter in flight -> oilCombusted++
    world.hasSparkPlug = true;
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;
    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.OIL;
    ch.liters = 14;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    const dash = createEmptyInput();
    dash.moveX = 1;
    dash.pressDash = true;
    stepWorldTick(world, dash);
    for (let t = 0; t < 24; t++) stepWorldTick(world, createEmptyInput());
    assert.ok(room.ledgers.oilCombusted >= 1, 'Spark-Plug Igniter auto-ignites final OIL dash liter');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil drift with Spark-Plug');

    // 2. Cryo-Expansion Nozzle: fired WATER freezes 1:1 into solid ICE on impact (0 drift)
    world.hasCryoNozzle = true;
    world.hasSparkPlug = false;
    ch.mat = MAT.WATER;
    ch.liters = 15;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    const fire = createEmptyInput();
    fire.aimX = 1;
    fire.aimY = -0.5;
    fire.aimZ = 0;
    fire.primaryHeld = true;
    stepWorldTick(world, fire);
    for (let t = 0; t < 35; t++) stepWorldTick(world, createEmptyInput());

    let iceCount = 0;
    for (let i = 0; i < room.grid.length; i++) {
      if (getMat(room.grid[i]) === MAT.ICE) iceCount++;
    }
    assert.ok(iceCount >= 5, `Cryo-Expansion Nozzle freezes fired WATER into ICE, got ${iceCount}`);
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, startWater, '0 water drift with Cryo-Expansion');

    // 3. Piezo-Arc Coil: fired WATER carries +120 V charge and electrifies landing puddle
    world.hasCryoNozzle = false;
    world.hasPiezoArc = true;
    world.suit.nozzleTapCdTicks = 0;
    world.suit.nozzleTapBurstShotsLeft = 0;
    world.suit.prevPrimaryHeld = false;
    ch.mat = MAT.WATER;
    ch.liters = 15;
    ch.tempByte = TEMP_BYTE.AMBIENT;
    stepWorldTick(world, fire);
    let maxElec = 0;
    for (let t = 0; t < 25; t++) {
      stepWorldTick(world, createEmptyInput());
      for (let i = 0; i < room.activeFluidCurCount; i++) {
        const q = getTimerOrCharge(room.grid[room.activeFluidCur[i]]);
        if (q > maxElec) maxElec = q;
      }
    }
    assert.ok(maxElec >= 40, `Piezo-Arc Coil electrifies landing water, maxElec=${maxElec}`);

    // 4. Gyro Stabilizer halves 0G Air Burst recoil
    world.hasGyroStabilizer = true;
    ch.liters = 0;
    ch.mat = MAT.AIR;
    world.suit.airBurstCdTicks = 0;
    world.suit.nozzleTapBurstShotsLeft = 0;
    room.gravityMode = GRAVITY_MODE.G0;
    world.player.vx = 0;
    world.player.vy = 0;
    world.player.vz = 0;
    const ab = createEmptyInput();
    ab.aimX = 1;
    ab.aimZ = 0;
    ab.primaryHeld = true;
    stepWorldTick(world, ab);
    assert.ok(
      Math.abs(world.player.vx + AIR_BURST_RECOIL_0G * 0.5) < 0.35,
      `Gyro Stabilizer halves 0G recoil, vx=${world.player.vx}`,
    );

    // 5. Ablative Plating reduces player Wall-Splat damage by 30%
    room.gravityMode = GRAVITY_MODE.G1;
    const runWallImpact = (ablative: boolean): number => {
      world.hasAblativePlating = ablative;
      world.player.x = 23.55;
      world.player.y = 1.4;
      world.player.z = 5.0;
      world.player.vx = 14.0;
      world.player.vy = 0;
      world.player.vz = 0;
      world.player.grounded = false;
      world.player.impulseTimer = 30;
      world.player.impactIFrames = 0;
      world.player.dashTimer = 0;
      world.player.dashGraceTimer = 0;
      world.player.hp = PLAYER_MAX_HP;
      for (let t = 0; t < 3; t++) stepWorldTick(world, createEmptyInput());
      return PLAYER_MAX_HP - world.player.hp;
    };
    const dmgBase = runWallImpact(false);
    const dmgAblative = runWallImpact(true);
    assert.ok(dmgBase > 10, `expected baseline wall-splat > 10, got ${dmgBase}`);
    assert.equal(dmgAblative, Math.max(1, Math.round(dmgBase * 0.7)));
  });

  it('activates Hazard Lining Ranks 1-3 and Phase-Lock Fuse Rank 1 delayed detonation (0 drift)', () => {
    const world = createWorldState(9104);
    generateCargoHold(world.room, 9104);
    const room = world.room;

    // 1. Hazard Lining Rank 1: playerOnly Phase Explosion deals 0 dmg to player
    world.liningRank = 1;
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.hp = PLAYER_MAX_HP;
    queuePhaseExplosion(room, 10.5, 1.5, 5.0, true, 'steam');
    stepWorldTick(world, createEmptyInput());
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'Hazard Lining Rk 1 blocks own-blast damage');

    // 2. Hazard Lining Rank 2 (burn immune) & Rank 3 (frost embrittlement immune, tempByte >= 39)
    world.liningRank = 3;
    writeCell(room, 100, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 30));
    stepWorldTick(world, createEmptyInput());
    assert.equal(world.player.burnTicks, 0, 'Hazard Lining Rk 2 blocks burnTicks');

    world.player.x = 12.05;
    world.player.z = 5.05;
    for (let t = 0; t < 40; t++) {
      writeCell(room, 120, CARGO_DECK_TOP_Y, 50, packVoxel(MAT.CRYO, TEMP_BYTE.CRYO));
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(world.player.tempByte >= TEMP_BYTE.EMBRITTLED + 1, 'Hazard Lining Rk 3 prevents embrittlement');

    // 3. Phase-Lock Fuse Rank 1: fired +200 C Pyro-Napalm primes on impact for 30 ticks, then ignites
    world.fuseRank = 1;
    upgradeToBaffledTank(world);
    const ch = getActiveChamber(world.playerTank);
    ch.mat = MAT.OIL;
    ch.liters = 15;
    ch.tempByte = TEMP_BYTE.PYRO_NAPALM;
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 7.0;
    world.player.grounded = true;
    recomputeRoomLedgers(room, world.playerTank);
    const startOil = room.ledgers.oil;

    const fire = createEmptyInput();
    fire.aimX = 1;
    fire.aimY = -0.6;
    fire.aimZ = 0;
    fire.primaryHeld = true;
    stepWorldTick(world, fire);

    // Wait 12 ticks for impact -> quanta should be PRIMED (still in ballistic pool, oilCombusted === 0)
    for (let t = 0; t < 12; t++) stepWorldTick(world, createEmptyInput());
    let primedCount = 0;
    for (let i = 0; i < room.ballistic.active.length; i++) {
      if (room.ballistic.active[i] && (room.ballistic.flags[i] & BALLISTIC_FLAG.PRIMED)) {
        primedCount++;
      }
    }
    assert.ok(primedCount >= 1, `expected primed Pyro-Napalm quanta, got ${primedCount}`);

    // Advance 35 more ticks -> fuse hits 0 and detonates into FIRE with 0 oil drift
    for (let t = 0; t < 35; t++) stepWorldTick(world, createEmptyInput());
    assert.ok(room.ledgers.oilCombusted >= 5, 'primed Pyro-Napalm detonates after 30-tick fuse');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.oil, startOil, '0 oil drift across Phase-Lock Fuse detonation');
  });
});
