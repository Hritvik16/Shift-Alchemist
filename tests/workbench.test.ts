import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAT,
  PLAYER_MAX_HP,
  PLAYER_PATCH_HEAL,
  TEMP_BYTE,
  WORKBENCH_COSTS,
  tankBaffledChamberCapL,
  tankStarterCapL,
} from '../src/core/balance.ts';
import { generateDeckGraph } from '../src/core/deckGen.ts';
import { stepWorldTick } from '../src/core/physics.ts';
import {
  createSnapshotStore,
  loadInitialDeckRoom,
  transitionRoomSync,
} from '../src/core/snapshot.ts';
import { recomputeRoomLedgers } from '../src/core/types.ts';
import {
  ALCOVE_1_NON_PATCH_CAP,
  getWorkbenchOffer,
  purchaseWorkbenchTerminal,
  upgradeToBaffledTank,
} from '../src/core/workbench.ts';
import {
  createEmptyInput,
  createWorldState,
  getActiveChamber,
  setTankCapRank,
} from '../src/core/world.ts';

describe('Slice B3 — In-World Workbench Upgrade Terminals, Baffled Auto-Split & R Valve (M4.2-lite)', () => {
  it('enforces offline lock until room clear, Patch 1/alcove + FULL HP guard, Alcove 1 cap (4) vs Alcove 2 unlimited', () => {
    const seed = 55001;
    const deck = generateDeckGraph(seed, false);
    const world = createWorldState(seed);

    // Load Combat Room 3 (Alcove 1)
    loadInitialDeckRoom(world, deck, 3, null);
    assert.equal(world.room.workbenchAlcoveIndex, 1);
    assert.equal(world.room.workbenchTerminals.length, 4);
    assert.equal(world.room.cleared, false);
    assert.equal(getWorkbenchOffer(world, 0).status, 'offline');
    assert.equal(purchaseWorkbenchTerminal(world, 0), false);

    // Clear all pods -> terminals power on
    for (const e of world.entities) {
      if (e.kind === 'alien') e.hp = 0;
    }
    stepWorldTick(world, createEmptyInput());
    assert.equal(world.room.cleared, true);

    // Patch at full HP -> FULL HP, cannot buy
    world.scrap = 1000;
    assert.equal(getWorkbenchOffer(world, 0).status, 'full_hp');
    assert.equal(purchaseWorkbenchTerminal(world, 0), false);

    // Damage player -> Patch heals +25 HP once, then SOLD OUT (does not consume non-patch cap)
    world.player.hp = 60;
    assert.equal(getWorkbenchOffer(world, 0).status, 'available');
    assert.equal(purchaseWorkbenchTerminal(world, 0), true);
    assert.equal(world.player.hp, 60 + PLAYER_PATCH_HEAL);
    assert.equal(world.scrap, 1000 - WORKBENCH_COSTS.patch);
    assert.equal(getWorkbenchOffer(world, 0).status, 'sold_out');
    assert.equal(world.room.workbenchState.nonPatchCount, 0);

    // Buy 4 non-patch upgrades at Alcove 1 -> 5th non-patch purchase must be SOLD OUT
    assert.equal(purchaseWorkbenchTerminal(world, 1), true); // Baffled Tank (80)
    assert.equal(world.playerTank.baffled, true);
    // Once Baffled is owned, Terminal 1 offers Tank Cap Rk 1 and Terminal 2 excludes tankCap
    assert.equal(getWorkbenchOffer(world, 1).offerId, 'tankCap');

    assert.equal(purchaseWorkbenchTerminal(world, 2), true);
    assert.equal(purchaseWorkbenchTerminal(world, 3), true);
    assert.equal(purchaseWorkbenchTerminal(world, 1), true);
    assert.equal(world.room.workbenchState.nonPatchCount, ALCOVE_1_NON_PATCH_CAP);
    assert.equal(getWorkbenchOffer(world, 1).status, 'sold_out');
    assert.equal(getWorkbenchOffer(world, 2).status, 'sold_out');
    assert.equal(getWorkbenchOffer(world, 3).status, 'sold_out');
    assert.equal(purchaseWorkbenchTerminal(world, 2), false);

    // Load Combat Room 6 (Alcove 2): unlimited non-patch purchases
    loadInitialDeckRoom(world, deck, 6, null);
    assert.equal(world.room.workbenchAlcoveIndex, 2);
    for (const e of world.entities) {
      if (e.kind === 'alien') e.hp = 0;
    }
    stepWorldTick(world, createEmptyInput());
    world.scrap = 2000;
    let buys = 0;
    for (let k = 0; k < 6; k++) {
      const idx = (k % 2 === 0 ? 2 : 3) as 2 | 3;
      if (purchaseWorkbenchTerminal(world, idx)) buys++;
    }
    assert.equal(buys, 6, 'Alcove 2 allows > 4 non-patch purchases');
  });

  it('auto-splits full Starter Tank into Baffled Dual-Chamber with 0 overflow & 0 ledger drift across ranks 0..3, and swaps via R', () => {
    for (let rank = 0; rank <= 3; rank++) {
      const world = createWorldState(6000 + rank);
      const deck = generateDeckGraph(6000 + rank, false);
      loadInitialDeckRoom(world, deck, 0, null);
      setTankCapRank(world, rank);

      const cap = tankStarterCapL(rank);
      world.playerTank.chambers[0].mat = MAT.OIL;
      world.playerTank.chambers[0].liters = cap;
      world.playerTank.chambers[0].tempByte = TEMP_BYTE.AMBIENT;
      recomputeRoomLedgers(world.room, world.playerTank);
      const startOil = world.room.ledgers.oil;

      upgradeToBaffledTank(world);
      const bCap = tankBaffledChamberCapL(rank);
      assert.equal(world.playerTank.baffled, true);
      assert.equal(world.playerTank.chambers[0].capL, bCap);
      assert.equal(world.playerTank.chambers[1].capL, bCap);
      assert.equal(world.playerTank.chambers[0].liters, bCap);
      assert.equal(world.playerTank.chambers[1].liters, cap - bCap);
      assert.ok(bCap - world.playerTank.chambers[1].liters >= 60);

      recomputeRoomLedgers(world.room, world.playerTank);
      assert.equal(world.room.ledgers.oil, startOil, `0 oil drift on rank ${rank} Baffled auto-split`);

      // Press R -> swaps activeChamber 0 -> 1 -> 0 without moving liters
      const swap = createEmptyInput();
      swap.pressSwapChamber = true;
      stepWorldTick(world, swap);
      assert.equal(world.playerTank.activeChamber, 1);
      assert.equal(getActiveChamber(world.playerTank).liters, cap - bCap);

      stepWorldTick(world, swap);
      assert.equal(world.playerTank.activeChamber, 0);
      assert.equal(getActiveChamber(world.playerTank).liters, bCap);
    }
  });

  it('disambiguates F interaction by proximity (nearest of terminal <= 1.5 m vs airlock <= 2.0 m) and persists workbench state via RLE', () => {
    const seed = 55099;
    const deck = generateDeckGraph(seed, false);
    const store = createSnapshotStore();
    const world = createWorldState(seed);

    loadInitialDeckRoom(world, deck, 3, null);
    for (const e of world.entities) {
      if (e.kind === 'alien') e.hp = 0;
    }
    stepWorldTick(world, createEmptyInput());

    // Place player directly beside Terminal 1 (Baffled Tank) and press F -> buys immediately
    const term0 = world.room.workbenchTerminals[0];
    const term1 = world.room.workbenchTerminals[1];
    const rowAlongZ = Math.abs(term1.z - term0.z) > Math.abs(term1.x - term0.x);
    world.scrap = 100;
    world.player.x = term1.x + (rowAlongZ ? 0.6 : 0);
    world.player.y = term1.y;
    world.player.z = term1.z + (rowAlongZ ? 0 : 0.6);
    world.player.grounded = true;

    const pressF = createEmptyInput();
    pressF.pressInteract = true;
    stepWorldTick(world, pressF);
    assert.equal(world.nearbyTerminalIndex, 1);
    assert.equal(world.nearbyDoor, null);
    assert.equal(world.playerTank.baffled, true);
    assert.equal(world.scrap, 100 - WORKBENCH_COSTS.baffled);
    assert.equal(world.pendingAirlock, null);

    // Move right beside an unlocked airlock (away from terminals) -> nearbyDoor wins
    const door = world.room.doors[0];
    world.player.x = (door.minX + door.maxX + 1) * 0.05;
    world.player.y = 0.2;
    world.player.z =
      door.face === 'N'
        ? 1.0
        : door.face === 'S'
          ? world.room.roomD * 0.1 - 1.0
          : (door.minZ + door.maxZ + 1) * 0.05;
    if (door.face === 'W') world.player.x = 1.0;
    if (door.face === 'E') world.player.x = world.room.roomW * 0.1 - 1.0;
    stepWorldTick(world, createEmptyInput());
    assert.equal(world.nearbyTerminalIndex, null);
    assert.ok(world.nearbyDoor !== null);

    // Leave Room 3 and return -> Alcove 1 nonPatchCount (1) and terminalPurchases[1] (1) persisted
    transitionRoomSync(world, deck, store, door.targetRoomId!, door.targetFace);
    const backDoor = world.room.doors.find((d) => d.targetRoomId === 3)!;
    transitionRoomSync(world, deck, store, 3, backDoor.targetFace);

    assert.equal(world.room.cleared, true);
    assert.equal(world.room.workbenchState.nonPatchCount, 1);
    assert.equal(world.room.workbenchState.terminalPurchases[1], 1);
    assert.equal(getWorkbenchOffer(world, 1).offerId, 'tankCap');
    assert.equal(PLAYER_MAX_HP, 100);
  });
});
