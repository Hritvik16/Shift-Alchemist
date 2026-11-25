import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_BURST_CD_TICKS,
  AIR_BURST_DMG,
  AIR_BURST_RECOIL_0G,
  CARGO_DECK_TOP_Y,
  CARGO_POD_COUNT,
  GRAVITY_MODE,
  MAT,
  SCRAP_DROPS,
  TEMP_BYTE,
} from '../src/core/balance.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import { generateCargoHold, populateCargoHoldEntities } from '../src/core/roomGen.ts';
import {
  cellIndex,
  getDamage,
  getMat,
  packVoxel,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import {
  createBroodPodEntity,
  createCrateEntity,
  createEmptyInput,
  createWorldState,
  type LockOnTarget,
  type WorldState,
} from '../src/core/world.ts';

function makePopulatedWorld(seed = 1301): WorldState {
  const world = createWorldState(seed);
  generateCargoHold(world.room, seed);
  populateCargoHoldEntities(world);
  recomputeRoomLedgers(world.room, world.playerTank);
  world.entryLedgers = { ...world.room.ledgers };
  return world;
}

describe('Milestone 1.3-lite — Air Burst, 12 m LOS Lock-On, Crates, Brood Pods & Clear Loop', () => {
  it('deterministically populates 6 Brood Pods and 6 movable crates (1 Bio-Cache) per seed', () => {
    const a = makePopulatedWorld(777);
    const b = makePopulatedWorld(777);

    assert.equal(a.podsTotal, CARGO_POD_COUNT);
    assert.equal(a.podsRemaining, CARGO_POD_COUNT);
    assert.equal(a.entities.length, 12);

    const pods = a.entities.filter((e) => e.kind === 'alien');
    const crates = a.entities.filter((e) => e.kind === 'crate');
    assert.equal(pods.length, 6);
    assert.equal(crates.length, 6);
    assert.equal(crates.filter((c) => c.bioCache).length, 1);

    for (let i = 0; i < a.entities.length; i++) {
      assert.equal(a.entities[i].x, b.entities[i].x);
      assert.equal(a.entities[i].y, b.entities[i].y);
      assert.equal(a.entities[i].z, b.entities[i].z);
      assert.equal(a.entities[i].kind, b.entities[i].kind);
    }
  });

  it('locks onto pods/crates through GLASS_VAT and blocks lock-on through HULL_STEEL, plus detects 0G >= 20 L clusters', () => {
    const world = createWorldState(42);
    generateCargoHold(world.room, 42);
    const room = world.room;

    world.player.x = 6.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    world.player.grounded = true;

    const pod = createBroodPodEntity(1, 10.0, 1.2, 5.0);
    world.entities.push(pod);

    // Put a 1-voxel GLASS_VAT pane between player (x=60) and pod (x=100) at x=80 -> lock passes glass
    for (let y = 12; y <= 30; y++) {
      for (let z = 45; z <= 55; z++) {
        writeCell(room, 80, y, z, packVoxel(MAT.GLASS_VAT, TEMP_BYTE.AMBIENT));
      }
    }

    const inp = createEmptyInput();
    inp.hasAimPoint = true;
    inp.aimPointX = 10.0;
    inp.aimPointY = 2.0;
    inp.aimPointZ = 5.0;
    stepWorldTick(world, inp);
    assert.ok(world.lockOn !== null && world.lockOn.kind === 'alien' && world.lockOn.id === 1);

    // Replace pane with HULL_STEEL -> lock-on must be blocked
    for (let y = 12; y <= 30; y++) {
      for (let z = 45; z <= 55; z++) {
        writeCell(room, 80, y, z, packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT));
      }
    }
    stepWorldTick(world, inp);
    assert.equal(world.lockOn, null, 'HULL_STEEL must block magnetic lock-on');

    // Clear entities & steel, enter 0G, place a 25 L WATER cluster within 12 m -> locks onto fluid0g
    world.entities.length = 0;
    for (let y = 12; y <= 30; y++) {
      for (let z = 45; z <= 55; z++) {
        writeCell(room, 80, y, z, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT));
      }
    }
    for (let dx = 0; dx < 5; dx++) {
      for (let dz = 0; dz < 5; dz++) {
        writeCell(room, 85 + dx, CARGO_DECK_TOP_Y + 8, 48 + dz, packVoxel(MAT.WATER, TEMP_BYTE.AMBIENT));
      }
    }
    room.gravityMode = GRAVITY_MODE.G0;
    inp.aimPointX = 8.7;
    inp.aimPointY = 2.0;
    inp.aimPointZ = 5.0;
    stepWorldTick(world, inp);
    const fluidLock = world.lockOn as LockOnTarget | null;
    assert.ok(fluidLock !== null && fluidLock.kind === 'fluid0g', 'locks onto >= 20 L 0G fluid cluster');
  });

  it('fires empty-tank Compressed Air Burst: shatters GLASS_VAT & ICE (0 drift), deduplicates WOOD damage, hits multiple targets & recoils in 0G', () => {
    const world = createWorldState(88);
    generateCargoHold(world.room, 88);
    const room = world.room;

    // 1. Shatter WATER vat 0 directly with an empty-tank Air Burst (no debug carve keys)
    const vat = room.vats[0]; // x=24..39, y=12..26, z=44..59
    world.player.x = 5.5;
    world.player.y = 1.2;
    world.player.z = 5.1;
    world.player.grounded = true;
    recomputeRoomLedgers(room, world.playerTank);
    const startWater = room.ledgers.water;

    const burstVat = createEmptyInput();
    burstVat.aimX = -1;
    burstVat.aimY = 0;
    burstVat.aimZ = 0;
    burstVat.primaryHeld = true;
    stepWorldTick(world, burstVat);

    assert.equal(world.suit.airBurstCdTicks, AIR_BURST_CD_TICKS);
    let brokenGlass = 0;
    for (let y = vat.minY + 1; y < vat.maxY; y++) {
      for (let z = vat.minZ + 1; z < vat.maxZ; z++) {
        if (getMat(room.grid[cellIndex(vat.maxX, y, z)]) === MAT.AIR) brokenGlass++;
      }
    }
    assert.ok(brokenGlass >= 1, 'Air Burst shatters Tier-1 GLASS_VAT in 1 hit');
    assert.ok(room.ballistic.count > 0 || room.activeFluidNextCount > 0, 'exposed vat fluid starts pouring');

    // 2. Deduplicated ray check on WOOD_BARRIER (HP 12) + ICE shatter 1:1 with 0 water drift
    world.suit.airBurstCdTicks = 0;
    world.player.x = 10.0;
    world.player.y = 1.2;
    world.player.z = 5.0;
    writeCell(room, 120, 20, 50, packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT));
    writeCell(room, 120, 20, 53, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE));
    recomputeRoomLedgers(room, world.playerTank);
    const waterWithIce = room.ledgers.water;

    const burstStruct = createEmptyInput();
    burstStruct.aimX = 1;
    burstStruct.aimY = 0;
    burstStruct.aimZ = 0;
    burstStruct.primaryHeld = true;
    stepWorldTick(world, burstStruct);

    assert.equal(getDamage(room.grid[cellIndex(120, 20, 50)]), 2);
    assert.equal(getMat(room.grid[cellIndex(120, 20, 53)]), MAT.AIR);
    let foundIceShard = false;
    for (let bi = 0; bi < room.ballistic.active.length; bi++) {
      if (room.ballistic.active[bi] && getMat(room.ballistic.packedVoxel[bi]) === MAT.ICE) {
        assert.ok(room.ballistic.vx[bi] > 2.0 && room.ballistic.vy[bi] > 1.5, `ICE shard must launch outward & up, v=(${room.ballistic.vx[bi]},${room.ballistic.vy[bi]})`);
        foundIceShard = true;
      }
    }
    assert.ok(foundIceShard, 'shattered ICE spawns launched Ballistic(ICE) shrapnel');
    recomputeRoomLedgers(room, world.playerTank);
    assert.equal(room.ledgers.water, waterWithIce, 'ICE shatter via Air Burst conserves water ledger');

    // 3. Multi-target Air Burst impulse + 0G recoil in clear space
    writeCell(room, 120, 20, 50, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT));
    world.suit.airBurstCdTicks = 0;
    const crate = createCrateEntity(10, 11.4, 1.2, 4.7);
    const pod = createBroodPodEntity(11, 13.0, 1.2, 5.2);
    world.entities.push(crate, pod);
    room.gravityMode = GRAVITY_MODE.G0;
    world.player.vx = 0;
    world.player.vy = 0;
    world.player.vz = 0;

    const burstTest = createEmptyInput();
    burstTest.aimX = 1;
    burstTest.aimY = 0;
    burstTest.aimZ = 0;
    burstTest.primaryHeld = true;
    stepWorldTick(world, burstTest);

    assert.equal(crate.hp, 60 - AIR_BURST_DMG);
    assert.equal(pod.hp, 100 - AIR_BURST_DMG);
    assert.ok(crate.vx > 10.0, `crate impulse vx=${crate.vx}`);
    assert.ok(pod.vx > 10.0, `pod impulse vx=${pod.vx}`);
    assert.ok(world.player.vx <= -AIR_BURST_RECOIL_0G + 0.4, `0G recoil vx=${world.player.vx}`);
    assert.ok(startWater > 0);
  });

  it('deals 100% target / 50% striker entity-entity Wall-Splat when punting a crate into a Brood Pod and buoys crates in WATER', () => {
    const world = createWorldState(99);
    generateCargoHold(world.room, 99);
    const room = world.room;

    const crate = createCrateEntity(1, 10.0, 1.2, 5.0);
    const pod = createBroodPodEntity(2, 11.6, 1.2, 5.0);
    world.entities.push(crate, pod);

    // Launch crate at 14 m/s into stationary pod with impulseTimer active
    crate.vx = 14.0;
    crate.impulseTimer = 36;
    for (let t = 0; t < 15; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    assert.ok(pod.hp < pod.maxHp, `pod took Wall-Splat damage: hp=${pod.hp}`);
    assert.ok(crate.hp < crate.maxHp, `crate took 50% striker recoil: hp=${crate.hp}`);
    assert.ok(pod.maxHp - pod.hp > crate.maxHp - crate.hp, 'target takes ~2x striker recoil');

    // Buoyancy check: submerge a crate in a contained 1.0 m WATER basin in the pit
    world.entities.length = 0;
    for (let y = 2; y <= 11; y++) {
      for (let z = 112; z <= 128; z++) {
        for (let x = 112; x <= 128; x++) {
          const isWall = x === 112 || x === 128 || z === 112 || z === 128;
          writeCell(room, x, y, z, packVoxel(isWall ? MAT.HULL_STEEL : MAT.WATER, TEMP_BYTE.AMBIENT));
        }
      }
    }
    const floatCrate = createCrateEntity(3, 12.0, 0.2, 12.0);
    world.entities.push(floatCrate);
    for (let t = 0; t < 30; t++) {
      stepWorldTick(world, createEmptyInput());
    }
    assert.ok(floatCrate.y > 0.45, `crate must float upward in WATER, y=${floatCrate.y}`);
  });

  it('credits Scrap on pod/Bio-Cache kills and triggers runCleared when all 6 Brood Pods are destroyed', () => {
    const world = makePopulatedWorld(555);
    assert.equal(world.runCleared, false);
    assert.equal(world.scrap, 0);

    // Destroy the Bio-Cache crate + all 6 Brood Pods
    for (const e of world.entities) {
      if (e.kind === 'alien' || e.bioCache) {
        e.hp = 0;
      }
    }
    stepWorldTick(world, createEmptyInput());

    assert.equal(world.podsRemaining, 0);
    assert.equal(world.kills, 6);
    assert.equal(world.runCleared, true);
    assert.ok(world.clearTimeS > 0);
    assert.equal(
      world.scrap,
      6 * SCRAP_DROPS.skitterer + SCRAP_DROPS.bioCache + SCRAP_DROPS.roomClear,
    );
  });
});
