import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_MAX_DEGREE,
  DECK_ROOMS_MAX,
  DECK_ROOMS_MIN,
  MAT,
  PLAYER_AABB_D,
  PLAYER_AABB_H,
  PLAYER_AABB_W,
  VAT_VOLUME_MAX_L,
  VAT_VOLUME_MIN_L,
} from '../src/core/balance.ts';
import {
  generateDeckGraph,
  getArrivalInitialSpawn,
  getDoorSpawnPoint,
  getOppositeFace,
  getRoomDimsForNode,
} from '../src/core/deckGen.ts';
import { aabbOverlapsSolid } from '../src/core/physics.ts';
import { generateRoomFromNode, populateRoomEntities } from '../src/core/roomGen.ts';
import { cellIndex, getMat, recomputeRoomLedgers } from '../src/core/types.ts';
import { createWorldState } from '../src/core/world.ts';

describe('Slice B1 — Graph-Grammar Deck Generator & Multi-Template RoomGen (M4.2-lite)', () => {
  it('generates connected, deterministic 10-14 room decks with degree <= 4, symmetric faces, and no consecutive combat repeats', () => {
    for (let s = 1; s <= 50; s++) {
      const seed = s * 9973 + 17;
      for (const includeBoss of [false, true]) {
        const deck = generateDeckGraph(seed, includeBoss);
        const deckAgain = generateDeckGraph(seed, includeBoss);
        assert.deepEqual(deck, deckAgain, `deck must be deterministic for seed=${seed}`);

        assert.ok(
          deck.nodes.length >= DECK_ROOMS_MIN && deck.nodes.length <= DECK_ROOMS_MAX,
          `room count ${deck.nodes.length} out of [10, 14] (includeBoss=${includeBoss})`,
        );

        assert.equal(deck.nodes[0].template, 'arrival');
        assert.equal(deck.nodes[3].alcoveIndex, 1, 'Combat Room 3 holds Workbench Alcove 1');
        assert.equal(deck.nodes[6].alcoveIndex, 2, 'Combat Room 6 holds Workbench Alcove 2');

        // Check no consecutive combat template repeats
        for (let c = 2; c <= deck.combatCount; c++) {
          assert.notEqual(
            deck.nodes[c].template,
            deck.nodes[c - 1].template,
            `consecutive combat repeat at room ${c}`,
          );
        }

        // Check face uniqueness, degree <= 4, and bidirectional opposite-face symmetry
        let extractionCount = 0;
        for (const node of deck.nodes) {
          assert.ok(node.doors.length >= 1 && node.doors.length <= DECK_MAX_DEGREE);
          const seenFaces = new Set<string>();
          for (const d of node.doors) {
            assert.equal(seenFaces.has(d.face), false, `duplicate face ${d.face} on room ${node.id}`);
            seenFaces.add(d.face);

            if (d.isExtraction) {
              extractionCount++;
              assert.equal(d.targetRoomId, null);
              assert.equal(node.id, deck.combatCount);
            } else {
              assert.notEqual(d.targetRoomId, null);
              const neighbor = deck.nodes[d.targetRoomId!];
              assert.ok(neighbor !== undefined);
              const expectedBack = getOppositeFace(d.face);
              assert.equal(d.targetFace, expectedBack);
              const rev = neighbor.doors.find(
                (nd) => nd.targetRoomId === node.id && nd.face === expectedBack,
              );
              assert.ok(rev !== undefined, `missing reverse edge ${neighbor.id} -> ${node.id}`);
            }
          }
        }
        assert.equal(extractionCount, includeBoss ? 0 : 1);

        // Side rooms avoid Combat 3 & 6
        for (const node of deck.nodes) {
          if (node.template === 'side') {
            const hostId = node.doors[0].targetRoomId!;
            assert.equal(deck.nodes[hostId].alcoveIndex, 0, 'side room should avoid alcove hosts');
          }
        }

        // Full connectivity via BFS from Arrival
        const visited = new Set<number>([0]);
        const queue = [0];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const d of deck.nodes[cur].doors) {
            if (d.targetRoomId !== null && !visited.has(d.targetRoomId)) {
              visited.add(d.targetRoomId);
              queue.push(d.targetRoomId);
            }
          }
        }
        assert.equal(visited.size, deck.nodes.length, 'all rooms must be reachable from Arrival');
      }
    }
  });

  it('generates every room in a deck with sealed BOUNDARY_HULL, clear door spawns, valid vats, alcoves, and non-overlapping entities', () => {
    const deck = generateDeckGraph(20261123, false);
    const world = createWorldState(deck.runSeed);
    const seenTemplates = new Set<string>();

    for (const node of deck.nodes) {
      seenTemplates.add(node.template);
      generateRoomFromNode(world.room, node);
      populateRoomEntities(world, node);

      const room = world.room;
      const dims = getRoomDimsForNode(node);
      assert.equal(dims.w % 16, 0);
      assert.equal(dims.h % 16, 0);
      assert.equal(dims.d % 16, 0);
      assert.equal(room.roomW, dims.w);
      assert.equal(room.roomH, dims.h);
      assert.equal(room.roomD, dims.d);
      assert.equal(room.doors.length, node.doors.length);

      // Verify all 6 outer faces sealed with BOUNDARY_HULL
      for (let x = 0; x < dims.w; x += 13) {
        assert.equal(getMat(room.grid[cellIndex(x, 0, dims.d >> 1)]), MAT.BOUNDARY_HULL);
        assert.equal(getMat(room.grid[cellIndex(x, dims.h - 1, dims.d >> 1)]), MAT.BOUNDARY_HULL);
        assert.equal(getMat(room.grid[cellIndex(x, 10, 0)]), MAT.BOUNDARY_HULL);
        assert.equal(getMat(room.grid[cellIndex(x, 10, dims.d - 1)]), MAT.BOUNDARY_HULL);
      }
      for (let z = 0; z < dims.d; z += 13) {
        assert.equal(getMat(room.grid[cellIndex(0, 10, z)]), MAT.BOUNDARY_HULL);
        assert.equal(getMat(room.grid[cellIndex(dims.w - 1, 10, z)]), MAT.BOUNDARY_HULL);
      }

      // Verify Arrival initial spawn and every doorway spawn point is collision-free
      if (node.template === 'arrival') {
        const sp = getArrivalInitialSpawn();
        assert.equal(
          aabbOverlapsSolid(room, sp.x, sp.y, sp.z, PLAYER_AABB_W * 0.5, PLAYER_AABB_H, PLAYER_AABB_D * 0.5),
          false,
          'Arrival initial spawn must be collision-free',
        );
        assert.equal(room.cleared, true);
        assert.equal(room.emitters.some((e) => e.kind === 'conduit'), true);
      }

      for (const d of node.doors) {
        const sp = getDoorSpawnPoint(dims, d.face);
        assert.equal(
          aabbOverlapsSolid(room, sp.x, sp.y, sp.z, PLAYER_AABB_W * 0.5, PLAYER_AABB_H, PLAYER_AABB_D * 0.5),
          false,
          `Door spawn (${node.template} face=${d.face}) overlaps solid`,
        );
      }

      // Verify vats meet volume invariants
      assert.ok(room.vats.length >= 1, `${node.template} must have >= 1 vat`);
      for (const v of room.vats) {
        assert.ok(
          v.interiorLiters >= VAT_VOLUME_MIN_L && v.interiorLiters <= VAT_VOLUME_MAX_L,
          `vat liters ${v.interiorLiters} out of [2000, 3000] in ${node.template}`,
        );
      }

      // Verify Workbench alcove placement in Combat Rooms 3 and 6
      if (node.alcoveIndex > 0) {
        assert.equal(room.workbenchTerminals.length, 4);
      } else {
        assert.equal(room.workbenchTerminals.length, 0);
      }

      // Verify lock/clear rules and Bio-Cache counts
      if (node.template === 'side') {
        assert.equal(room.cleared, true);
        assert.equal(world.podsTotal, 0);
        assert.equal(world.entities.filter((e) => e.bioCache).length, 2);
      } else if (node.combatIndex > 0) {
        assert.equal(room.cleared, false);
        assert.equal(room.setpieces.length, 2, "combat arena stitches 2 setpieces");
        assert.notEqual(room.setpieces[0], room.setpieces[1], "2 setpieces must be distinct");
        assert.ok(dims.w >= 112 && dims.w <= 208 && dims.d >= 112 && dims.d <= 176);
        assert.ok(world.podsTotal >= 3 && world.podsTotal <= 8, `expected 3..8 hostiles, got ${world.podsTotal}`);
        assert.equal(world.entities.filter((e) => e.bioCache).length, 1);
      }

      // Verify every spawned entity AABB is collision-free against solid terrain
      for (const e of world.entities) {
        assert.equal(
          aabbOverlapsSolid(room, e.x, e.y, e.z, e.halfW, e.height, e.halfD),
          false,
          `Entity ${e.kind} at (${e.x},${e.y},${e.z}) in ${node.template} overlaps solid`,
        );
      }

      // Verify ledger parity on fresh generation
      const before = { ...room.ledgers };
      recomputeRoomLedgers(room, world.playerTank);
      assert.deepEqual(room.ledgers, before);
    }

    assert.ok(seenTemplates.has('arrival'));
    assert.ok(seenTemplates.has('side'));
    assert.ok(seenTemplates.has('corridor'));
    assert.ok(seenTemplates.has('reactor'));
    assert.ok(seenTemplates.has('cargo'));
  });
});
