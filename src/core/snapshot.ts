import {
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  GRAVITY_MODE,
  MAT,
  MAX_DEFERRED_FLUID,
  SLICE_STRIDE,
  TOTAL_CHUNKS,
  gravCooldownS,
  type GravityMode,
  type MaterialId,
} from './balance.ts';
import {
  getArrivalInitialSpawn,
  getDoorSpawnPoint,
  getRoomDimsForNode,
  type DeckGraph,
} from './deckGen.ts';
import {
  drainOrSerializeBallistics,
  enqueueDeferredFluid,
  reseedActiveLists,
  spawnBallistic,
} from './fluids.ts';
import { hash32 } from './hash.ts';
import { generateRoomFromNode, populateRoomEntities } from './roomGen.ts';
import {
  PERSIST_MASK,
  getDamage,
  getMat,
  isSolidMat,
  recomputeRoomLedgers,
  recountChunkFluids,
  resetRoomRuntimeTransient,
  type DoorFace,
  type HazardEmitter,
  type RoomState,
  type RoomWorkbenchState,
  type SerializedBallisticRecord,
  type VatRecord,
} from './types.ts';
import type { Entity, WorldState } from './world.ts';

export const MAX_SNAPSHOT_CHUNKS_PER_FRAME = 64;
export const AIRLOCK_MIN_CYCLE_FRAMES = 21; // 0.35 s @ 60 Hz (§4.4)

// Module-level zero-GC scratch buffer for chunk RLE encode (4096 cells * 2 uint32 = 32 KB)
const rleScratch = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE * 2);

export interface SerializedDeferredRecord {
  mat: MaterialId;
  tempByte: number;
  chargeUnits: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export type { RoomWorkbenchState };

export interface RoomSnapshot {
  roomId: number;
  roomSeed: number;
  gravityMode: GravityMode;
  cleared: boolean;
  doorLocks: boolean[];
  chunks: Map<number, Uint32Array>;
  entities: Entity[];
  deferredFluid: SerializedDeferredRecord[];
  fallbackBallistics: SerializedBallisticRecord[];
  emitters: HazardEmitter[];
  vats: VatRecord[];
  oilCombusted: number;
  cryoBoiledOff: number;
  acidConsumed: number;
  podsTotal: number;
  podsRemaining: number;
  workbench: RoomWorkbenchState;
}

export interface SnapshotStore {
  byRoomId: Map<number, RoomSnapshot>;
}

export function createSnapshotStore(): SnapshotStore {
  return { byRoomId: new Map<number, RoomSnapshot>() };
}

export function getSnapshotStoreBytes(store: SnapshotStore): number {
  let bytes = 0;
  for (const snap of store.byRoomId.values()) {
    for (const chunk of snap.chunks.values()) {
      bytes += chunk.byteLength;
    }
    bytes += snap.entities.length * 160;
    bytes += snap.deferredFluid.length * 12;
    bytes += snap.fallbackBallistics.length * 40;
  }
  return bytes;
}

function cloneEntity(e: Entity): Entity {
  return {
    ...e,
    glands: e.glands.map((g) => ({ ...g })),
  };
}

function serializeDeferredQueue(room: RoomState): SerializedDeferredRecord[] {
  const dq = room.deferredFluid;
  const out: SerializedDeferredRecord[] = [];
  for (let n = 0; n < dq.count; n++) {
    const slot = (dq.head + n) % MAX_DEFERRED_FLUID;
    out.push({
      mat: dq.mat[slot] as MaterialId,
      tempByte: dq.tempByte[slot],
      chargeUnits: dq.chargeUnits[slot],
      targetX: dq.targetX[slot],
      targetY: dq.targetY[slot],
      targetZ: dq.targetZ[slot],
    });
  }
  return out;
}

/**
 * RLE-encodes a single 16^3 chunk masking out transient bits 22..25 (PERSIST_MASK = 0xFC3FFFFF).
 * Persists MaterialID, tempByte, timerOrCharge, slideDir (bits 26..27), and damage (bits 28..31).
 */
export function encodeChunkRLE(room: RoomState, cIdx: number): Uint32Array {
  const plane = CHUNKS_X * CHUNKS_Z;
  const cy = Math.floor(cIdx / plane);
  const rem = cIdx - cy * plane;
  const cz = Math.floor(rem / CHUNKS_X);
  const cx = rem - cz * CHUNKS_X;

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const g = room.grid;

  let outLen = 0;
  let hasRun = false;
  let runVal = 0;
  let runCount = 0;

  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    const yOff = y * SLICE_STRIDE;
    for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
      const row = yOff + z * ARENA_W;
      for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
        const masked = (g[row + x] & PERSIST_MASK) >>> 0;
        if (!hasRun) {
          runVal = masked;
          runCount = 1;
          hasRun = true;
        } else if (masked === runVal) {
          runCount++;
        } else {
          rleScratch[outLen++] = runCount;
          rleScratch[outLen++] = runVal;
          runVal = masked;
          runCount = 1;
        }
      }
    }
  }
  if (hasRun) {
    rleScratch[outLen++] = runCount;
    rleScratch[outLen++] = runVal;
  }

  return rleScratch.slice(0, outLen);
}

/**
 * Decodes a single 16^3 RLE chunk directly into room.grid, deterministically regenerating
 * shimmer via hash32(roomSeed, 0, idx) & 7 strictly for mat !== AIR (§4.4).
 */
export function decodeChunkRLE(room: RoomState, cIdx: number, data: Uint32Array): boolean {
  const plane = CHUNKS_X * CHUNKS_Z;
  const cy = Math.floor(cIdx / plane);
  const rem = cIdx - cy * plane;
  const cz = Math.floor(rem / CHUNKS_X);
  const cx = rem - cz * CHUNKS_X;

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const g = room.grid;
  const seed = room.roomSeed;

  let pairPos = 0;
  let runRemaining = 0;
  let runVal = 0;
  let hasDamagedSolid = false;

  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    const yOff = y * SLICE_STRIDE;
    for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
      const row = yOff + z * ARENA_W;
      for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
        if (runRemaining === 0) {
          runRemaining = data[pairPos++];
          runVal = data[pairPos++];
        }
        const idx = row + x;
        const mat = getMat(runVal);
        let finalVal = runVal;
        if (mat !== MAT.AIR) {
          const shimmer = hash32(seed, 0, idx) & 7;
          finalVal = (runVal | (shimmer << 23)) >>> 0;
          if (isSolidMat(mat) && getDamage(finalVal) > 0) {
            hasDamagedSolid = true;
          }
        }
        g[idx] = finalVal;
        runRemaining--;
      }
    }
  }

  return hasDamagedSolid;
}

export interface AirlockTransitionJob {
  phase: 'encode' | 'decode' | 'mesh' | 'done';
  targetRoomId: number;
  enterFace: DoorFace | null;
  framesElapsed: number;
  outgoingSnap: RoomSnapshot;
  dirtyEncodeList: number[];
  encodeCursor: number;
  incomingSnap: RoomSnapshot | null;
  decodeEntries: Array<[number, Uint32Array]>;
  decodeCursor: number;
  visualResetPending: boolean;
}

/**
 * Captures outgoing room metadata, normalizes any active timed gravity pulse (§4.2 M28),
 * drains or serializes ballistics, and queues dirtySnapshot chunks for bounded encoding.
 */
export function beginAirlockTransition(
  world: WorldState,
  store: SnapshotStore,
  targetRoomId: number,
  enterFace: DoorFace | null,
): AirlockTransitionJob {
  const room = world.room;

  // Normalize active C/V pulse on exit: cut pulse ends now and starts GRAV_CD; 0G persists (§4.2)
  let persistedGravity: GravityMode = room.gravityMode;
  if (world.gravityPulse.activePulse !== 'none') {
    world.gravityPulse.activePulse = 'none';
    world.gravityPulse.pulseTicksLeft = 0;
    world.gravityPulse.cooldownTicks = Math.round(gravCooldownS(world.gravCdRank) * 60);
    world.gravityPulse.ownPulseExempt = false;
    world.gravityPulse.ownPulseGraceTicks = 0;
    persistedGravity = GRAVITY_MODE.G1;
    room.gravityMode = GRAVITY_MODE.G1;
    world.player.upSign = 1;
  } else if (persistedGravity !== GRAVITY_MODE.G0) {
    persistedGravity = GRAVITY_MODE.G1;
  }

  // Drain all active ballistics into grid/deferred, or serialize overflow records
  const fallbackBallistics = drainOrSerializeBallistics(world);

  const existing = store.byRoomId.get(room.roomId);
  const chunks = existing ? existing.chunks : new Map<number, Uint32Array>();
  const workbench: RoomWorkbenchState = {
    patchBought: room.workbenchState.patchBought,
    nonPatchCount: room.workbenchState.nonPatchCount,
    terminalPurchases: [...room.workbenchState.terminalPurchases] as [
      number,
      number,
      number,
      number,
    ],
  };

  const outgoingSnap: RoomSnapshot = {
    roomId: room.roomId,
    roomSeed: room.roomSeed,
    gravityMode: persistedGravity,
    cleared: room.cleared,
    doorLocks: room.doors.map((d) => d.locked),
    chunks,
    entities: world.entities.map(cloneEntity),
    deferredFluid: serializeDeferredQueue(room),
    fallbackBallistics,
    emitters: room.emitters.map((em) => ({ ...em })),
    vats: room.vats.map((v) => ({ ...v })),
    oilCombusted: room.ledgers.oilCombusted,
    cryoBoiledOff: room.ledgers.cryoBoiledOff,
    acidConsumed: room.ledgers.acidConsumed,
    podsTotal: world.podsTotal,
    podsRemaining: world.podsRemaining,
    workbench,
  };
  store.byRoomId.set(room.roomId, outgoingSnap);

  const dirtyEncodeList: number[] = [];
  for (let c = 0; c < TOTAL_CHUNKS; c++) {
    if (room.dirtySnapshot[c] && !room.outOfBounds[c]) {
      dirtyEncodeList.push(c);
    }
  }

  return {
    phase: 'encode',
    targetRoomId,
    enterFace,
    framesElapsed: 0,
    outgoingSnap,
    dirtyEncodeList,
    encodeCursor: 0,
    incomingSnap: store.byRoomId.get(targetRoomId) ?? null,
    decodeEntries: [],
    decodeCursor: 0,
    visualResetPending: false,
  };
}

function finalizeRoomLoadPostDecode(
  world: WorldState,
  deck: DeckGraph,
  targetRoomId: number,
  enterFace: DoorFace | null,
  snap: RoomSnapshot | null,
): void {
  const node = deck.nodes[targetRoomId];
  const room = world.room;

  if (snap !== null) {
    resetRoomRuntimeTransient(room);
    room.gravityMode = snap.gravityMode;
    room.cleared = snap.cleared;
    room.workbenchState = {
      patchBought: snap.workbench.patchBought,
      nonPatchCount: snap.workbench.nonPatchCount,
      terminalPurchases: [...snap.workbench.terminalPurchases] as [number, number, number, number],
    };
    for (let i = 0; i < room.doors.length && i < snap.doorLocks.length; i++) {
      room.doors[i].locked = snap.doorLocks[i];
    }
    room.emitters = snap.emitters.map((em) => ({ ...em }));
    room.vats = snap.vats.map((v) => ({ ...v }));
    room.ledgers.oilCombusted = snap.oilCombusted;
    room.ledgers.cryoBoiledOff = snap.cryoBoiledOff;
    room.ledgers.acidConsumed = snap.acidConsumed;

    world.entities = snap.entities.map(cloneEntity);
    room.entitiesRef = world.entities;
    world.podsTotal = snap.podsTotal;
    world.podsRemaining = snap.podsRemaining;

    for (let i = 0; i < snap.deferredFluid.length; i++) {
      const df = snap.deferredFluid[i];
      enqueueDeferredFluid(room, df.mat, df.tempByte, df.chargeUnits, df.targetX, df.targetY, df.targetZ);
    }
    for (let i = 0; i < snap.fallbackBallistics.length; i++) {
      const fb = snap.fallbackBallistics[i];
      const slot = spawnBallistic(
        room,
        fb.x,
        fb.y,
        fb.z,
        fb.vx,
        fb.vy,
        fb.vz,
        fb.packedVoxel,
        fb.flags,
        fb.fuseTicks,
      );
      if (slot !== -1) room.ballistic.flightTicks[slot] = fb.flightTicks;
    }

    reseedActiveLists(room, world.simTick > 0 ? world.simTick : 1);
    room.dirtySnapshot.fill(0);
    room.fluidOverflowFlag.fill(0);
    room.thermalOverflowFlag.fill(0);
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (!room.outOfBounds[c]) {
        room.dirtySolidMesh[c] = 1;
        room.dirtyFluidRender[c] = 1;
      }
    }
    recountChunkFluids(room);
  } else {
    room.entitiesRef = world.entities;
    populateRoomEntities(world, node);
  }

  world.currentRoomId = targetRoomId;
  world.pendingAirlock = null;
  world.nearbyDoor = null;
  world.nearbyTerminalIndex = null;
  world.lockOn = null;
  world.zeroGLoftTicksLeft = 0;
  world.gravityChangedThisTick = false;

  const dims = getRoomDimsForNode(node);
  const spawn =
    enterFace !== null ? getDoorSpawnPoint(dims, enterFace) : getArrivalInitialSpawn();
  world.player.x = spawn.x;
  world.player.y = spawn.y;
  world.player.z = spawn.z;
  world.player.vx = 0;
  world.player.vy = 0;
  world.player.vz = 0;
  world.player.upSign = room.gravityMode === GRAVITY_MODE.GN1 ? -1 : 1;
  world.player.grounded = room.gravityMode !== GRAVITY_MODE.G0;
  world.player.dashTimer = 0;
  world.player.dashGraceTimer = 0;
  world.player.impulseTimer = 0;

  recomputeRoomLedgers(room, world.playerTank);
  world.entryLedgers = { ...room.ledgers };
}

/**
 * Advances the paused airlock transition by at most MAX_SNAPSHOT_CHUNKS_PER_FRAME (64)
 * chunks of RLE encode or decode. Returns true once core room load is ready for meshing.
 */
export function stepAirlockTransitionCore(
  job: AirlockTransitionJob,
  world: WorldState,
  deck: DeckGraph,
  maxChunks = MAX_SNAPSHOT_CHUNKS_PER_FRAME,
): boolean {
  job.framesElapsed++;

  if (job.phase === 'encode') {
    const end = Math.min(job.dirtyEncodeList.length, job.encodeCursor + maxChunks);
    for (let i = job.encodeCursor; i < end; i++) {
      const cIdx = job.dirtyEncodeList[i];
      job.outgoingSnap.chunks.set(cIdx, encodeChunkRLE(world.room, cIdx));
      world.room.dirtySnapshot[cIdx] = 0;
    }
    job.encodeCursor = end;

    if (job.encodeCursor >= job.dirtyEncodeList.length) {
      const targetNode = deck.nodes[job.targetRoomId];
      generateRoomFromNode(world.room, targetNode);

      if (job.incomingSnap !== null && job.incomingSnap.chunks.size > 0) {
        job.decodeEntries = Array.from(job.incomingSnap.chunks.entries());
        job.decodeCursor = 0;
        job.phase = 'decode';
      } else {
        finalizeRoomLoadPostDecode(world, deck, job.targetRoomId, job.enterFace, job.incomingSnap);
        job.visualResetPending = true;
        job.phase = 'mesh';
        return true;
      }
    }
    return false;
  }

  if (job.phase === 'decode') {
    const end = Math.min(job.decodeEntries.length, job.decodeCursor + maxChunks);
    for (let i = job.decodeCursor; i < end; i++) {
      const [cIdx, rle] = job.decodeEntries[i];
      const hasDamagedSolid = decodeChunkRLE(world.room, cIdx, rle);
      if (hasDamagedSolid) {
        world.room.dirtyDecals[cIdx] = 1;
      }
    }
    job.decodeCursor = end;

    if (job.decodeCursor >= job.decodeEntries.length) {
      finalizeRoomLoadPostDecode(world, deck, job.targetRoomId, job.enterFace, job.incomingSnap);
      job.visualResetPending = true;
      job.phase = 'mesh';
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Synchronous helper (runs the exact same chunked state machine) for initial run load and tests.
 */
export function loadInitialDeckRoom(
  world: WorldState,
  deck: DeckGraph,
  roomId = deck.arrivalRoomId,
  enterFace: DoorFace | null = null,
): void {
  world.deck = deck;
  const node = deck.nodes[roomId];
  generateRoomFromNode(world.room, node);
  finalizeRoomLoadPostDecode(world, deck, roomId, enterFace, null);
}

export function transitionRoomSync(
  world: WorldState,
  deck: DeckGraph,
  store: SnapshotStore,
  targetRoomId: number,
  enterFace: DoorFace | null,
): AirlockTransitionJob {
  const job = beginAirlockTransition(world, store, targetRoomId, enterFace);
  while (job.phase === 'encode' || job.phase === 'decode') {
    stepAirlockTransitionCore(job, world, deck, MAX_SNAPSHOT_CHUNKS_PER_FRAME);
  }
  job.phase = 'done';
  return job;
}
