import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GRAVITY_MODE, MAT, SCRAP_DROPS, TEMP_BYTE, gravCooldownS } from '../src/core/balance.ts';
import { generateDeckGraph, getDoorSpawnPoint, getRoomDimsForNode } from '../src/core/deckGen.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import {
  createSnapshotStore,
  getSnapshotStoreBytes,
  loadInitialDeckRoom,
  transitionRoomSync,
} from '../src/core/snapshot.ts';
import {
  PERSIST_MASK,
  applyStructuralDamage,
  carveSphereDebug,
  cellIndex,
  getDamage,
  getMat,
  getShimmer,
  packVoxel,
  recomputeRoomLedgers,
  writeCell,
} from '../src/core/types.ts';
import { createEmptyInput, createWorldState, getActiveChamber } from '../src/core/world.ts';

describe('Slice B2 — In-RAM RLE Snapshots & Airlock Room Transitions (M4.2-lite)', () => {
  it('passes dirtySnapshot completeness audit: bit-exact persisted grid + damage + slideDir across backtracking', () => {
    const seed = 42001;
    const deck = generateDeckGraph(seed, false);
    const store = createSnapshotStore();
    const world = createWorldState(seed);

    loadInitialDeckRoom(world, deck, deck.arrivalRoomId, null);

    // Mutate Arrival: shatter the WATER vat, partially damage a floor steel cell, place OIL + ICE, run sim
    const vat = world.room.vats[0];
    carveSphereDebug(world.room, vat.maxX, vat.minY + 2, vat.minZ + 7, 3, world.simTick);
    applyStructuralDamage(world.room, 40, 1, 40, 5, false, world.simTick);
    writeCell(world.room, 42, 2, 42, packVoxel(MAT.OIL, TEMP_BYTE.AMBIENT, 0, 0, 0, 2, 0), world.simTick);
    writeCell(world.room, 45, 2, 45, packVoxel(MAT.ICE, TEMP_BYTE.FREEZE), world.simTick);

    for (let t = 0; t < 40; t++) {
      stepWorldTick(world, createEmptyInput());
    }

    // Transition to Combat Room 1 (this drains ballistics into Arrival and encodes all dirtySnapshot chunks)
    const exitDoor = world.room.doors[0];
    assert.ok(exitDoor.targetRoomId !== null);
    const arrivalW = world.room.roomW;
    const arrivalH = world.room.roomH;
    const arrivalD = world.room.roomD;

    transitionRoomSync(world, deck, store, exitDoor.targetRoomId!, exitDoor.targetFace);
    assert.equal(world.currentRoomId, exitDoor.targetRoomId);
    assert.ok(getSnapshotStoreBytes(store) > 0);

    // Capture Arrival's exact persisted state by transitioning back, then comparing against a second round-trip
    const returnDoor = world.room.doors.find((d) => d.targetRoomId === 0)!;
    assert.ok(returnDoor !== undefined);

    transitionRoomSync(world, deck, store, 0, returnDoor.targetFace);
    assert.equal(world.currentRoomId, 0);
    assert.equal(getDamage(world.room.grid[cellIndex(40, 1, 40)]), 5, 'partial solid damage persisted');
    assert.equal(getMat(world.room.grid[cellIndex(45, 2, 45)]), MAT.ICE, 'ICE voxel persisted');
    assert.equal(getMat(world.room.grid[cellIndex(42, 2, 42)]) !== MAT.AIR || world.room.ledgers.oil >= 1, true);

    // Snapshot every persisted cell bit in Arrival
    const beforeBits = new Uint32Array(arrivalW * arrivalH * arrivalD);
    let bi = 0;
    for (let y = 0; y < arrivalH; y++) {
      for (let z = 0; z < arrivalD; z++) {
        for (let x = 0; x < arrivalW; x++) {
          const v = world.room.grid[cellIndex(x, y, z)];
          beforeBits[bi++] = (v & PERSIST_MASK) >>> 0;
          if (getMat(v) === MAT.AIR) {
            assert.equal(getShimmer(v), 0, 'AIR shimmer must stay 0 after decode');
          }
        }
      }
    }

    // Round-trip out to Combat Room 1 and back to Arrival without ticking -> persisted grid must be bit-identical
    transitionRoomSync(world, deck, store, exitDoor.targetRoomId!, exitDoor.targetFace);
    transitionRoomSync(world, deck, store, 0, returnDoor.targetFace);

    bi = 0;
    for (let y = 0; y < arrivalH; y++) {
      for (let z = 0; z < arrivalD; z++) {
        for (let x = 0; x < arrivalW; x++) {
          const v = world.room.grid[cellIndex(x, y, z)];
          assert.equal((v & PERSIST_MASK) >>> 0, beforeBits[bi++], `mismatch at (${x},${y},${z})`);
        }
      }
    }
  });

  it('conserves exact room-plus-tank ledgers across multi-room backtracking and fluid transport (Drift = 0)', () => {
    const seed = 42009;
    const deck = generateDeckGraph(seed, false);
    const store = createSnapshotStore();
    const world = createWorldState(seed);

    loadInitialDeckRoom(world, deck, 0, null);
    const arrivalWaterInitial = world.room.ledgers.water;

    // Siphon 20 L from Arrival's starter WATER puddle (x=2.3..2.9) from open East side
    world.player.x = 3.8;
    world.player.y = 0.2;
    world.player.z = 1.25;
    world.player.grounded = true;
    const siphon = createEmptyInput();
    siphon.aimX = -1;
    siphon.aimY = -0.35;
    siphon.aimZ = 0;
    siphon.siphonHeld = true;
        // Position player right beside the Arrival starter puddle (22..27, 2, 22..27), clear of all Shift Gates
    world.player.x = 3.2;
    world.player.y = 0.2;
    world.player.z = 3.2;
    world.player.grounded = true;
    siphon.aimX = -0.68;
    siphon.aimY = -0.30;
    siphon.aimZ = -0.68;
    siphon.hasAimPoint = false;
for (let t = 0; t < 15; t++) {
      stepWorldTick(world, siphon);
      if (getActiveChamber(world.playerTank).liters >= 20) break;
    }
    const carried = getActiveChamber(world.playerTank).liters;
    assert.ok(carried >= 10, `expected siphoned water, got ${carried}`);

    recomputeRoomLedgers(world.room, world.playerTank);
    const arrivalRoomWaterAtExit = world.room.ledgers.water - carried;
    assert.equal(arrivalRoomWaterAtExit + carried, arrivalWaterInitial);

    // Carry that water into Combat Room 1 and shoot a 5 L tap shot there
    const doorTo1 = world.room.doors[0];
    transitionRoomSync(world, deck, store, doorTo1.targetRoomId!, doorTo1.targetFace);
    const room1EntryWater = world.entryLedgers.water;

    const shoot = createEmptyInput();
    shoot.aimX = 0;
    shoot.aimZ = 1;
    shoot.primaryHeld = true;
    stepWorldTick(world, shoot);
    for (let t = 0; t < 15; t++) stepWorldTick(world, createEmptyInput());

    recomputeRoomLedgers(world.room, world.playerTank);
    assert.equal(world.room.ledgers.water, room1EntryWater, '0 drift in Combat Room 1');
    const carriedBack = getActiveChamber(world.playerTank).liters;
    assert.ok(carriedBack < carried, 'spent water in Combat Room 1');

    // Return to Arrival -> Arrival's room-only water terms must equal exit terms identically
    const doorTo0 = world.room.doors.find((d) => d.targetRoomId === 0)!;
    transitionRoomSync(world, deck, store, 0, doorTo0.targetFace);
    recomputeRoomLedgers(world.room, world.playerTank);
    const arrivalRoomWaterOnReturn = world.room.ledgers.water - carriedBack;
    assert.equal(arrivalRoomWaterOnReturn, arrivalRoomWaterAtExit, 'Arrival room-term water invariant');
  });

  it('persists 0G toggle across visits while normalizing active C/V pulse to 1G and starting GRAV_CD', () => {
    const seed = 42017;
    const deck = generateDeckGraph(seed, false);
    const store = createSnapshotStore();
    const world = createWorldState(seed);

    loadInitialDeckRoom(world, deck, 0, null);
    const doorTo1 = world.room.doors[0];

    // Toggle 0G in Arrival, exit to Room 1, return to Arrival -> Arrival stays 0G
    const q = createEmptyInput();
    q.pressQ = true;
    stepWorldTick(world, q);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G0);

    transitionRoomSync(world, deck, store, doorTo1.targetRoomId!, doorTo1.targetFace);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G1, 'fresh Room 1 starts in 1G');

    // Start V (-1G) pulse in Room 1, then immediately exit mid-pulse
    world.gravityPulse.cooldownTicks = 0;
    const v = createEmptyInput();
    v.pressV = true;
    stepWorldTick(world, v);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.GN1);
    assert.equal(world.gravityPulse.activePulse, 'invert');
    assert.equal(world.gravityPulse.cooldownTicks, 0);

    const doorTo0 = world.room.doors.find((d) => d.targetRoomId === 0)!;
    transitionRoomSync(world, deck, store, 0, doorTo0.targetFace);

    assert.equal(world.gravityPulse.activePulse, 'none');
    assert.equal(world.gravityPulse.cooldownTicks, Math.round(gravCooldownS(0) * 60), 'cut pulse starts GRAV_CD');
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G0, 'Arrival 0G persisted');

    // Re-enter Room 1 -> normalized to 1G
    transitionRoomSync(world, deck, store, doorTo1.targetRoomId!, doorTo1.targetFace);
    assert.equal(world.room.gravityMode, GRAVITY_MODE.G1, 'cut V pulse normalized to 1G on return');
  });

  it('unlocks combat room doors on pod clear and completes the run via the final room Extraction airlock', () => {
    const seed = 42029;
    const deck = generateDeckGraph(seed, false);
    const world = createWorldState(seed);

    // Load the final combat room directly
    loadInitialDeckRoom(world, deck, deck.finalRoomId, null);
    const extDoor = world.room.doors.find((d) => d.isExtraction)!;
    assert.ok(extDoor !== undefined);
    assert.equal(extDoor.locked, true);
    assert.equal(world.room.cleared, false);
    assert.equal(world.runCleared, false);

    // Stand 1.0 m inside the Extraction door on the y=0.2 m floor and press F while locked -> blocked
    const extSpawn = getDoorSpawnPoint(
      getRoomDimsForNode(deck.nodes[deck.finalRoomId]),
      extDoor.face,
    );
    world.player.x = extSpawn.x;
    world.player.y = extSpawn.y;
    world.player.z = extSpawn.z;
    const pressF = createEmptyInput();
    pressF.pressInteract = true;
    stepWorldTick(world, pressF);
    assert.equal(world.runCleared, false, 'locked extraction door cannot trigger clear');

    // Destroy all Brood Pods -> unlocks doors + credits roomClear Scrap once
    const pods = world.entities.filter((e) => e.kind === 'alien');
    assert.ok(pods.length >= 2);
    const extraBruiserScrap = world.entities.filter((ent) => ent.kind === 'alien' && ent.locomotion === 'crusher' && ent.hp > 0 && !ent.deathHusk).length * (SCRAP_DROPS.crusher - SCRAP_DROPS.skitterer);
    for (const p of pods) p.hp = 0;
    stepWorldTick(world, createEmptyInput());

    assert.equal(world.room.cleared, true);
    assert.equal(extDoor.locked, false);
    assert.equal(world.runCleared, false, 'clearing final room unlocks extraction; player must press F');
    assert.equal(world.scrap, (pods.length * SCRAP_DROPS.skitterer + SCRAP_DROPS.roomClear) + extraBruiserScrap);

    // Press F at unlocked Extraction airlock -> runCleared = true
    stepWorldTick(world, pressF);
    assert.equal(world.runCleared, true);
    assert.ok(world.clearTimeS > 0);
  });
});
