import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_ROOM_DIMS,
  ARENA_CELLS,
  ARENA_D,
  ARENA_H,
  ARENA_W,
  BOSS_GRATE_Y_MAX,
  BOSS_GRATE_Y_MIN,
  BOSS_HEIGHT_M,
  CARGO_CATWALK_Y_MAX,
  CARGO_CATWALK_Y_MIN,
  CARGO_DECK_TOP_Y,
  CHUNK_SIZE,
  CRUSHER_HEIGHT_M,
  DECK_MAX_DEGREE,
  DECK_ROOMS_MAX,
  DECK_ROOMS_MIN,
  DOOR_Y_MAX,
  DOOR_Y_MIN,
  FLOATER_HEIGHT_M,
  GRAV_CD_MIN,
  LIFT_0G_VEL_MAX,
  LIFT_0G_VEL_MIN,
  MAT,
  MATERIAL_SPEC,
  MAX_UPGRADE_RANK,
  NOZZLE_TAP_BURST_L,
  PLAYER_AABB_H,
  TALL_CEILING_UNDERSIDE_Y,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  byteToTempC,
  computeBaffledAutoSplit,
  gravCooldownS,
  simulateZeroGLoft,
  siphonRateLPerTick,
  siphonRateLps,
  tankBaffledChamberCapL,
  tankBaffledTotalCapL,
  tankStarterCapL,
  tempCToByte,
} from './balance.ts';
import { hash32 } from './hash.ts';
import {
  getDamage,
  getMat,
  getShimmer,
  getSlideDir,
  getStepped,
  getTempByte,
  getTimerOrCharge,
  packVoxel,
} from './types.ts';

describe('Master Constants & Balance Invariants (§2 / M1.1)', () => {
  it('enforces exact 16^3 chunk divisibility across arena and all 5 room templates', () => {
    assert.equal(ARENA_W % CHUNK_SIZE, 0);
    assert.equal(ARENA_H % CHUNK_SIZE, 0);
    assert.equal(ARENA_D % CHUNK_SIZE, 0);
    assert.equal(ARENA_CELLS, 3_686_400);
    assert.equal(TOTAL_CHUNKS, 900);

    for (const dims of ALL_ROOM_DIMS) {
      assert.equal(dims.w % CHUNK_SIZE, 0);
      assert.equal(dims.h % CHUNK_SIZE, 0);
      assert.equal(dims.d % CHUNK_SIZE, 0);
      assert.equal((dims.w / CHUNK_SIZE) * (dims.h / CHUNK_SIZE) * (dims.d / CHUNK_SIZE), dims.chunks);
    }
  });

  it('maps exact 4°C quantized thermal bytes cleanly across all reference temperatures', () => {
    const pairs: readonly [number, number][] = [
      [-200, TEMP_BYTE.MIN],
      [-196, TEMP_BYTE.CRYO],
      [-48, TEMP_BYTE.EMBRITTLED],
      [0, TEMP_BYTE.FREEZE],
      [4, TEMP_BYTE.MELT],
      [20, TEMP_BYTE.AMBIENT],
      [80, TEMP_BYTE.STEAM_CONDENSE],
      [100, TEMP_BYTE.BOIL],
      [180, TEMP_BYTE.OIL_IGNITE],
      [200, TEMP_BYTE.PYRO_NAPALM],
      [220, TEMP_BYTE.WOOD_IGNITE],
      [240, TEMP_BYTE.BAFFLED_SAFE_MAX],
      [300, TEMP_BYTE.THERMAL_VENT],
      [648, TEMP_BYTE.FIRE],
      [820, TEMP_BYTE.MAX],
    ];
    for (const [tempC, expectedByte] of pairs) {
      assert.equal(tempCToByte(tempC), expectedByte, `tempC ${tempC}`);
      assert.equal(byteToTempC(expectedByte), tempC, `byte ${expectedByte}`);
    }
    // 4°C freeze/melt hysteresis band
    assert.equal(TEMP_BYTE.MELT - TEMP_BYTE.FREEZE, 1);
    assert.equal(byteToTempC(TEMP_BYTE.MELT) - byteToTempC(TEMP_BYTE.FREEZE), 4);
  });

  it('guarantees 15 L burst divisibility across all starter and baffled tank ranks', () => {
    const expectedStarter = [120, 150, 180, 210];
    const expectedChamber = [90, 105, 120, 135];
    for (let rank = 0; rank <= MAX_UPGRADE_RANK; rank++) {
      const sCap = tankStarterCapL(rank);
      const bCap = tankBaffledChamberCapL(rank);
      assert.equal(sCap, expectedStarter[rank]);
      assert.equal(bCap, expectedChamber[rank]);
      assert.equal(sCap % NOZZLE_TAP_BURST_L, 0);
      assert.equal(bCap % NOZZLE_TAP_BURST_L, 0);
      assert.equal(tankBaffledTotalCapL(rank), 2 * bCap);
    }
  });

  it('guarantees zero-overflow Starter -> Baffled auto-split with >= 60 L spare in Chamber B', () => {
    for (let rank = 0; rank <= MAX_UPGRADE_RANK; rank++) {
      const fullStarter = tankStarterCapL(rank);
      const chamberCap = tankBaffledChamberCapL(rank);
      const { toA, toB, spareB } = computeBaffledAutoSplit(fullStarter, rank);
      assert.equal(toA + toB, fullStarter);
      assert.ok(toA <= chamberCap);
      assert.ok(toB <= chamberCap);
      assert.ok(spareB >= 60, `rank ${rank} spareB=${spareB}`);
    }
  });

  it('maintains exact integer siphon rates (2..5 L/tick = 120..300 L/s)', () => {
    for (let rank = 0; rank <= MAX_UPGRADE_RANK; rank++) {
      assert.equal(siphonRateLPerTick(rank), 2 + rank);
      assert.equal(siphonRateLps(rank), siphonRateLPerTick(rank) * 60);
    }
  });

  it('produces 0G loft heights within [0.62, 1.02] m over [0.60, 0.75] s', () => {
    const low = simulateZeroGLoft(LIFT_0G_VEL_MIN);
    const high = simulateZeroGLoft(LIFT_0G_VEL_MAX);
    assert.ok(low.heightM >= 0.61 && low.heightM <= 0.63, `low=${low.heightM}`);
    assert.ok(high.heightM >= 1.01 && high.heightM <= 1.03, `high=${high.heightM}`);
    assert.ok(low.durationS >= 0.59 && low.durationS <= 0.62, `lowT=${low.durationS}`);
    assert.ok(high.durationS >= 0.74 && high.durationS <= 0.76, `highT=${high.durationS}`);
  });

  it('satisfies doorway, catwalk, Floater, Crusher, and Boss vertical clearances', () => {
    const doorHeightM = (DOOR_Y_MAX - DOOR_Y_MIN + 1) * VOXEL_SIZE_M;
    assert.ok(Math.abs(doorHeightM - 2.8) < 1e-6);
    assert.ok(doorHeightM - PLAYER_AABB_H >= 1.2 - 1e-6);

    const cargoDeckM = CARGO_DECK_TOP_Y * VOXEL_SIZE_M;
    const cargoCatUnderM = CARGO_CATWALK_Y_MIN * VOXEL_SIZE_M;
    const cargoCatTopM = (CARGO_CATWALK_Y_MAX + 1) * VOXEL_SIZE_M;
    const ceilingM = TALL_CEILING_UNDERSIDE_Y * VOXEL_SIZE_M;

    const belowCargoCat = cargoCatUnderM - cargoDeckM;
    const aboveCargoCat = ceilingM - cargoCatTopM;
    assert.ok(Math.abs(belowCargoCat - 2.4) < 1e-6);
    assert.ok(Math.abs(aboveCargoCat - 2.4) < 1e-6);
    assert.ok(belowCargoCat > BOSS_HEIGHT_M);
    assert.ok(belowCargoCat > CRUSHER_HEIGHT_M);
    assert.ok(aboveCargoCat > PLAYER_AABB_H);

    // Floater hover clamp under Cargo catwalk (3.6 m) and above Boss grates (4.2 m under 6.2 m)
    const floaterMaxUnderCargo = Math.min(cargoDeckM + 0.9, cargoCatUnderM - 1.55);
    assert.ok(floaterMaxUnderCargo + FLOATER_HEIGHT_M < cargoCatUnderM);

    const bossGrateUnderM = BOSS_GRATE_Y_MIN * VOXEL_SIZE_M;
    const bossGrateTopM = (BOSS_GRATE_Y_MAX + 1) * VOXEL_SIZE_M;
    assert.ok(Math.abs(bossGrateUnderM - cargoDeckM - 2.8) < 1e-6);
    assert.ok(Math.abs(ceilingM - bossGrateTopM - 2.0) < 1e-6);
    assert.ok(bossGrateUnderM - cargoDeckM > BOSS_HEIGHT_M);
    const floaterMaxAboveBossGrate = Math.min(bossGrateTopM + 0.9, ceilingM - 1.55);
    assert.ok(floaterMaxAboveBossGrate >= bossGrateTopM + 0.4);
    assert.ok(floaterMaxAboveBossGrate + FLOATER_HEIGHT_M < ceilingM);
  });

  it('enforces GRAV_CD_MIN === 2.5 > 0 and deck room bounds (10..14)', () => {
    assert.equal(GRAV_CD_MIN, 2.5);
    assert.ok(GRAV_CD_MIN > 0);
    assert.equal(gravCooldownS(0), 4.0);
    assert.equal(gravCooldownS(1), 3.5);
    assert.equal(gravCooldownS(2), 3.0);
    assert.equal(gravCooldownS(3), 2.5);
    assert.equal(DECK_ROOMS_MIN, 10);
    assert.equal(DECK_ROOMS_MAX, 14);
    assert.equal(DECK_MAX_DEGREE, 4);
  });

  it('round-trips 32-bit voxel bit-packing and deterministic hash32 cleanly', () => {
    assert.equal(MATERIAL_SPEC.length, 13);
    assert.equal(MATERIAL_SPEC[MAT.BOUNDARY_HULL].structHp, Infinity);

    const packed = packVoxel(MAT.STEEL_GRATE, 125, 60, 1, 7, 3, 14);
    assert.equal(getMat(packed), MAT.STEEL_GRATE);
    assert.equal(getTempByte(packed), 125);
    assert.equal(getTimerOrCharge(packed), 60);
    assert.equal(getStepped(packed), 1);
    assert.equal(getShimmer(packed), 7);
    assert.equal(getSlideDir(packed), 3);
    assert.equal(getDamage(packed), 14);

    assert.equal(hash32(42, 10, 999), hash32(42, 10, 999));
    assert.notEqual(hash32(42, 10, 999), hash32(42, 10, 1000));
  });
});
