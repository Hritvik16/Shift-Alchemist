import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAVITY_MODE,
  PLAYER_MAX_HP,
  TEMP_BYTE,
  gravCooldownS,
} from './balance.ts';
import { generateCargoHold } from './roomGen.ts';
import { computePlumbLine, computeWallSplatDamage, stepWorldTick } from './physics.ts';
import {
  createEmptyInput,
  createWorldState,
  getFeetY,
  type WorldState,
} from './world.ts';

function makeCargoWorld(seed = 1337): WorldState {
  const world = createWorldState(seed);
  generateCargoHold(world.room, seed);
  return world;
}

describe('Milestone 1.2 — Fixed 60 Hz Controller, Gravity Pulses, Stairs & Wall-Splat', () => {
  it('climbs the 5 vestibule steps, 5 pit exit steps, and 13 catwalk stairs cleanly in 1G', () => {
    const world = makeCargoWorld();
    // 1. Spawn in North vestibule at (12.0, 0.2, 1.0) and walk South (+Z) up 5 steps to deck (1.2 m)
    for (let i = 0; i < 60; i++) {
      const inp = createEmptyInput();
      inp.moveZ = 1;
      stepWorldTick(world, inp);
    }
    assert.ok(Math.abs(world.player.y - 1.2) < 0.02, `vestibule climb y=${world.player.y}`);
    assert.equal(world.player.grounded, true);

    // 2. Place in sunken pit center (11.0, 0.2, 12.0) and walk West (-X) up 5 exit steps to deck (1.2 m)
    world.player.x = 11.0;
    world.player.y = 0.2;
    world.player.z = 12.0;
    world.player.vx = 0;
    world.player.vy = 0;
    world.player.vz = 0;
    world.player.grounded = true;
    for (let i = 0; i < 70; i++) {
      const inp = createEmptyInput();
      inp.moveX = -1;
      stepWorldTick(world, inp);
    }
    assert.ok(world.player.x < 7.8, `pit exit x=${world.player.x}`);
    assert.ok(Math.abs(world.player.y - 1.2) < 0.02, `pit exit y=${world.player.y}`);

    // 3. Walk up the 13-step catwalk stairs (x=5.8, z=9.8 -> z=15.0) from 1.2 m to 3.8 m catwalk
    world.player.x = 5.8;
    world.player.y = 1.2;
    world.player.z = 9.8;
    world.player.vx = 0;
    world.player.vy = 0;
    world.player.vz = 0;
    world.player.grounded = true;
    for (let i = 0; i < 60; i++) {
      const inp = createEmptyInput();
      inp.moveZ = 1;
      stepWorldTick(world, inp);
    }
    assert.ok(world.player.z > 14.4, `catwalk z=${world.player.z}`);
    assert.ok(Math.abs(world.player.y - 3.8) < 0.02, `catwalk top y=${world.player.y}`);
    assert.equal(world.player.grounded, true);
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'normal stair movement never deals Wall-Splat');
  });

  it('supports baseline C (2G) and V (-1G) pulses, early Q cancel, post-end GRAV_CD, and upSign/feetY flip', () => {
    const world = makeCargoWorld();
    world.player.x = 5.0;
    world.player.y = 1.2;
    world.player.z = 7.0;
    world.player.grounded = true;

    // Trigger baseline V (-1G, 3.5 s = 210 ticks) with no attachments
    const pressV = createEmptyInput();
    pressV.pressV = true;
    stepWorldTick(world, pressV);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.GN1);
    assert.equal(world.player.upSign, -1);
    assert.equal(getFeetY(world.player), world.player.y + world.player.height);
    assert.equal(world.gravityPulse.cooldownTicks, 0, 'GRAV_CD does not start until V ends/cancels');

    // C is mutually blocked while V is active
    const pressC = createEmptyInput();
    pressC.pressC = true;
    stepWorldTick(world, pressC);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.GN1);

    // Let player fly up to the ceiling (6.2 m underside -> pos.y = 4.6 m, feetY = 6.2 m)
    for (let i = 0; i < 90; i++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(Math.abs(world.player.y - 4.6) < 0.02, `ceiling y=${world.player.y}`);
    assert.ok(Math.abs(getFeetY(world.player) - 6.2) < 0.02);
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'own -1G pulse flip is exempt from self Wall-Splat');

    // Early Q cancel returns to 1G, starts GRAV_CD now, does NOT toggle 0G
    const pressQ = createEmptyInput();
    pressQ.pressQ = true;
    stepWorldTick(world, pressQ);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G1);
    assert.equal(world.player.upSign, 1);
    assert.equal(world.gravityPulse.cooldownTicks, Math.round(gravCooldownS(0) * 60));

    // Wait out return fall and cooldown, then verify baseline C (2G) auto-ends after 3.0 s
    for (let i = 0; i < 250; i++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(world.gravityPulse.cooldownTicks, 0);
    assert.equal(world.player.hp, PLAYER_MAX_HP, 'return drop from own V pulse is also exempt');

    const startC = createEmptyInput();
    startC.pressC = true;
    stepWorldTick(world, startC);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G2);
    for (let i = 0; i < 180; i++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G1);
    assert.ok(world.gravityPulse.cooldownTicks > 200, 'GRAV_CD starts when C auto-ends');
  });

  it('bounds 0G flight cleanly and detects deck-relative plumb-line hits above pit/deck/catwalk', () => {
    const world = makeCargoWorld();
    world.player.x = 12.0;
    world.player.y = 0.2;
    world.player.z = 12.0; // Pit floor (0.2 m)

    const toggleQ = createEmptyInput();
    toggleQ.pressQ = true;
    stepWorldTick(world, toggleQ);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G0);

    // Ascend for 1.5 s into mid-air over pit
    for (let i = 0; i < 90; i++) {
      const up = createEmptyInput();
      up.ascend = true;
      stepWorldTick(world, up);
    }
    assert.ok(world.player.y > 2.0 && world.player.y + world.player.height <= 6.2 + 1e-4);

    const plumb = computePlumbLine(world.room, world.player);
    assert.equal(plumb.visible, true);
    assert.equal(plumb.plumbDir, -1);
    assert.ok(Math.abs(plumb.hitY - 0.2) < 0.01, `plumb over pit hitY=${plumb.hitY}`);
    assert.ok(plumb.distanceM > 1.5);
  });

  it('applies capped 1G drop Wall-Splat damage with i-frames when walking off the 3.8 m catwalk into the 0.2 m pit', () => {
    const world = makeCargoWorld();
    // Place on the catwalk spur directly over the 0.2 m pit and walk West off the ledge
    world.player.x = 14.8;
    world.player.y = 3.8;
    world.player.z = 11.0;
    world.player.grounded = true;

    for (let i = 0; i < 80; i++) {
      const inp = createEmptyInput();
      if (world.player.y > 3.5) inp.moveX = -1;
      stepWorldTick(world, inp);
    }

    assert.ok(Math.abs(world.player.y - 0.2) < 0.02, `pit landing y=${world.player.y}`);
    assert.ok(world.impactTelemetry.lastImpactSpeed > 9.5, `v=${world.impactTelemetry.lastImpactSpeed}`);
    assert.ok(world.impactTelemetry.lastWallSplatDmg > 10, `dmg=${world.impactTelemetry.lastWallSplatDmg}`);
    assert.ok(world.player.hp < PLAYER_MAX_HP);

    // Direct formula check: embrittled 3x cap
    assert.equal(computeWallSplatDamage(90, 20.0, TEMP_BYTE.AMBIENT), 120);
    assert.equal(computeWallSplatDamage(90, 20.0, TEMP_BYTE.EMBRITTLED), 360);
  });
});
