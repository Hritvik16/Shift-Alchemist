import {
  ARENA_W,
  BFS_MANHATTAN_RADIUS,
  MAT,
  MAX_BFS_EMITTER,
  MAX_BFS_GLOBAL,
  SLICE_STRIDE,
} from './balance.ts';
import {
  cellIndex,
  getMat,
  getTimerOrCharge,
  inRoomBounds,
  isSolidMat,
  pushCombatEvent,
  writeCell,
  type ElectricPulseFrontier,
  type HazardEmitter,
  type RoomState,
} from './types.ts';
import type { WorldState } from './world.ts';

const FRONTIER_CAP = 16_384;
const MAX_ACTIVE_FRONTIERS = 12;
const CONDUIT_PULSE_INTERVAL_TICKS = 14; // 0.23 s @ 60 Hz (refreshes full puddle ahead of -3/tick decay)
const CONDUIT_PULSE_CHARGE = 62; // +124 V
const CHARGE_DECAY_PER_TICK = 3; // ~0.35 s crisp discharge decay (<= 25 ticks)

// 6 orthogonal faces + 4 horizontal XZ diagonals (so thin 1-voxel water lobes never break conductivity)
const NB_DX = [1, -1, 0, 0, 0, 0, 1, 1, -1, -1] as const;
const NB_DY = [0, 0, 1, -1, 0, 0, 0, 0, 0, 0] as const;
const NB_DZ = [0, 0, 0, 0, 1, -1, 1, -1, 1, -1] as const;

export function isElectricConductorMat(mat: number): boolean {
  return (
    mat === MAT.WATER ||
    mat === MAT.HULL_STEEL ||
    mat === MAT.STEEL_GRATE ||
    mat === MAT.ACID
  );
}

function isExposedSteelConductor(room: RoomState, x: number, y: number, z: number): boolean {
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  if (x > 0 && !isSolidMat(getMat(g[idx - 1]))) return true;
  if (x + 1 < room.roomW && !isSolidMat(getMat(g[idx + 1]))) return true;
  if (z > 0 && !isSolidMat(getMat(g[idx - ARENA_W]))) return true;
  if (z + 1 < room.roomD && !isSolidMat(getMat(g[idx + ARENA_W]))) return true;
  if (y > 0 && !isSolidMat(getMat(g[idx - SLICE_STRIDE]))) return true;
  if (y + 1 < room.roomH && !isSolidMat(getMat(g[idx + SLICE_STRIDE]))) return true;
  return false;
}

function canConductAt(room: RoomState, x: number, y: number, z: number): boolean {
  if (!inRoomBounds(room, x, y, z)) return false;
  const mat = getMat(room.grid[cellIndex(x, y, z)]);
  if (mat === MAT.WATER || mat === MAT.ACID || mat === MAT.STEEL_GRATE) return true;
  if (mat === MAT.HULL_STEEL) {
    return isExposedSteelConductor(room, x, y, z);
  }
  return false;
}

function writeCellChargeUnits(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  newCharge: number,
  simTick: number,
): void {
  const idx = cellIndex(x, y, z);
  const val = room.grid[idx];
  const clamped = newCharge < 0 ? 0 : newCharge > 63 ? 63 : newCharge | 0;
  if (getTimerOrCharge(val) === clamped) return;
  const updated = ((val & ~(0x3f << 16)) | (clamped << 16)) >>> 0;
  writeCell(room, x, y, z, updated, simTick);
}

function enqueueFrontierNode(
  f: ElectricPulseFrontier,
  idx: number,
  scaledCharge: number,
): void {
  if (f.count >= FRONTIER_CAP) return;
  f.queueIdx[f.tail] = idx;
  f.queueScaled[f.tail] = scaledCharge;
  f.tail = (f.tail + 1) & (FRONTIER_CAP - 1);
  f.count++;
}

function acquireFrontier(
  room: RoomState,
  emitterId: number,
  originX: number,
  originY: number,
  originZ: number,
  resetIfActive = true,
): ElectricPulseFrontier | null {
  if (emitterId >= 0) {
    for (let i = 0; i < room.electricFrontiers.length; i++) {
      const f = room.electricFrontiers[i];
      if (f.emitterId === emitterId) {
        if (resetIfActive || f.count === 0) {
          f.waveId = ++room.bfsWaveCounter;
          f.originX = originX;
          f.originY = originY;
          f.originZ = originZ;
          f.head = 0;
          f.tail = 0;
          f.count = 0;
        }
        return f;
      }
    }
  }

  for (let i = 0; i < room.electricFrontiers.length; i++) {
    const f = room.electricFrontiers[i];
    if (f.count === 0) {
      f.emitterId = emitterId;
      f.waveId = ++room.bfsWaveCounter;
      f.originX = originX;
      f.originY = originY;
      f.originZ = originZ;
      f.head = 0;
      f.tail = 0;
      return f;
    }
  }

  if (room.electricFrontiers.length >= MAX_ACTIVE_FRONTIERS) return null;

  const created: ElectricPulseFrontier = {
    emitterId,
    waveId: ++room.bfsWaveCounter,
    originX,
    originY,
    originZ,
    queueIdx: new Int32Array(FRONTIER_CAP),
    queueScaled: new Uint16Array(FRONTIER_CAP),
    head: 0,
    tail: 0,
    count: 0,
  };
  room.electricFrontiers.push(created);
  return created;
}

export function triggerElectricalPulseAt(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  chargeUnits = CONDUIT_PULSE_CHARGE,
  simTick = 1,
  emitterId = -1,
  resetIfActive = true,
): boolean {
  if (!canConductAt(room, x, y, z)) return false;
  const f = acquireFrontier(room, emitterId, x, y, z, resetIfActive);
  if (!f) return false;
  const idx = cellIndex(x, y, z);
  const curCharge = getTimerOrCharge(room.grid[idx]);
  if (chargeUnits > curCharge) {
    writeCellChargeUnits(room, x, y, z, chargeUnits, simTick);
  }
  room.bfsVisitedStamp[idx] = f.waveId;
  enqueueFrontierNode(f, idx, chargeUnits * 8 + 7);
  return true;
}

function seedConduitPulse(
  room: RoomState,
  em: HazardEmitter,
  emitterId: number,
  simTick: number,
): boolean {
  const seeds: number[] = [];
  const g = room.grid;
  // Seed any live WATER, ACID, or STEEL_GRATE directly touching the Tesla Node's 3x3x3 housing (never dry floor HULL_STEEL)
  for (let dy = -2; dy <= 2; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        const az = Math.abs(dz);
        if (Math.max(ax, ay, az) !== 2) continue;
        // Skip far corners outside a 1-voxel skirt around the 3x3x3 pylon
        if ((ax === 2 ? 1 : 0) + (ay === 2 ? 1 : 0) + (az === 2 ? 1 : 0) > 2) continue;

        const wx = em.x + dx;
        const wy = em.y + dy;
        const wz = em.z + dz;
        if (!inRoomBounds(room, wx, wy, wz)) continue;
        const m = getMat(g[cellIndex(wx, wy, wz)]);
        if (m !== MAT.WATER && m !== MAT.ACID && m !== MAT.STEEL_GRATE) continue;
        seeds.push(cellIndex(wx, wy, wz));
      }
    }
  }

  if (seeds.length === 0) return false;

  const f = acquireFrontier(room, emitterId, em.x, em.y, em.z, true);
  if (!f) return false;

  const startScaled = CONDUIT_PULSE_CHARGE * 8 + 7;
  for (let i = 0; i < seeds.length; i++) {
    const idx = seeds[i];
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    if (CONDUIT_PULSE_CHARGE > getTimerOrCharge(g[idx])) {
      writeCellChargeUnits(room, x, y, z, CONDUIT_PULSE_CHARGE, simTick);
    }
    room.bfsVisitedStamp[idx] = f.waveId;
    enqueueFrontierNode(f, idx, startScaled);
  }
  return true;
}

function decayTrackedChargedCells(room: RoomState, simTick: number): void {
  const g = room.grid;
  let write = 0;
  for (let i = 0; i < room.chargedCellsCount; i++) {
    const idx = room.chargedCells[i];
    const val = g[idx];
    const mat = getMat(val);
    const ch = getTimerOrCharge(val);
    if (!isElectricConductorMat(mat) || ch <= 0) {
      room.chargedBitset[idx >>> 5] &= ~(1 << (idx & 31));
      continue;
    }
    const nextCh = ch > CHARGE_DECAY_PER_TICK ? ch - CHARGE_DECAY_PER_TICK : 0;
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    writeCellChargeUnits(room, x, y, z, nextCh, simTick);
    if (nextCh > 0) {
      room.chargedCells[write++] = idx;
    } else {
      room.chargedBitset[idx >>> 5] &= ~(1 << (idx & 31));
    }
  }
  room.chargedCellsCount = write;
}

export function stepElectricityStage7(world: WorldState): void {
  const room = world.room;
  const simTick = world.simTick;

  decayTrackedChargedCells(room, simTick);

  for (let i = 0; i < room.emitters.length; i++) {
    const em = room.emitters[i];
    if (em.kind !== 'conduit') continue;
    if (em.timer > 0) {
      em.timer--;
    }
    if (em.timer <= 0) {
      if (seedConduitPulse(room, em, i, simTick)) {
        em.timer = CONDUIT_PULSE_INTERVAL_TICKS;
      }
    }
  }

  const activeIndices: number[] = [];
  for (let i = 0; i < room.electricFrontiers.length; i++) {
    if (room.electricFrontiers[i].count > 0) activeIndices.push(i);
  }
  const nActive = activeIndices.length;
  if (nActive === 0) return;

  const startOffset = room.bfsRoundRobinCursor % nActive;
  room.bfsRoundRobinCursor = (room.bfsRoundRobinCursor + 1) >>> 0;

  const g = room.grid;
  let globalUsed = 0;

  for (let k = 0; k < nActive && globalUsed < MAX_BFS_GLOBAL; k++) {
    const f = room.electricFrontiers[activeIndices[(startOffset + k) % nActive]];
    const remainingFrontiers = nActive - k;
    const perEmitterBudget = Math.max(
      1,
      Math.min(
        nActive === 1
          ? MAX_BFS_GLOBAL
          : Math.max(MAX_BFS_EMITTER, Math.floor((MAX_BFS_GLOBAL - globalUsed) / remainingFrontiers)),
        MAX_BFS_GLOBAL - globalUsed,
      ),
    );
    let localUsed = 0;

    while (f.count > 0 && localUsed < perEmitterBudget && globalUsed < MAX_BFS_GLOBAL) {
      const idx = f.queueIdx[f.head];
      const scaled = f.queueScaled[f.head];
      f.head = (f.head + 1) & (FRONTIER_CAP - 1);
      f.count--;
      localUsed++;
      globalUsed++;

      const y = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - y * SLICE_STRIDE;
      const z = Math.floor(rem / ARENA_W);
      const x = rem - z * ARENA_W;
      const maxNb = 10;

      for (let nb = 0; nb < maxNb; nb++) {
        const nx = x + NB_DX[nb];
        const ny = y + NB_DY[nb];
        const nz = z + NB_DZ[nb];
        if (!inRoomBounds(room, nx, ny, nz)) continue;

        const manhattan =
          Math.abs(nx - f.originX) + Math.abs(ny - f.originY) + Math.abs(nz - f.originZ);
        if (manhattan > BFS_MANHATTAN_RADIUS) continue;

        const nIdx = cellIndex(nx, ny, nz);
        if (room.bfsVisitedStamp[nIdx] === f.waveId) continue;
        const nVal = g[nIdx];
        const nMat = getMat(nVal);

        let stepCost = 0;
        if (nMat === MAT.WATER || nMat === MAT.ACID) {
          stepCost = nb >= 6 ? 2 : 1; // Ultra-low loss so even huge 3,000 L puddles stay uniformly energized
        } else if (nMat === MAT.STEEL_GRATE && nb < 6) {
          stepCost = 1; // Bare conductive catwalk/pit grate
        } else {
          // Never waste BFS budget flooding insulated floor HULL_STEEL slabs beneath puddles
          continue;
        }

        const nextScaled = scaled - stepCost;
        if (nextScaled < 8) continue;
        const nextCharge = nextScaled >> 3;

        room.bfsVisitedStamp[nIdx] = f.waveId;
        if (nextCharge > getTimerOrCharge(nVal)) {
          writeCellChargeUnits(room, nx, ny, nz, nextCharge, simTick);
        }
        enqueueFrontierNode(f, nIdx, nextScaled);
      }
    }
  }
}

/**
 * Discharges a live Tesla Power Node when ballistic WATER/ACID hits its housing:
 * - Energizes both the splash voxel and any floor puddle beneath/around the node,
 * - Backfeeds up a continuous water hose to shock the player.
 */
export function triggerConduitWaterImpact(
  world: WorldState,
  emitterIdx: number,
  hitX: number,
  hitY: number,
  hitZ: number,
  firedByPlayer: boolean,
): void {
  const room = world.room;
  const simTick = world.simTick;
  const g = room.grid;

  const hitCharge = getTimerOrCharge(g[cellIndex(hitX, hitY, hitZ)]);
  if (hitCharge < 52) {
    triggerElectricalPulseAt(room, hitX, hitY, hitZ, CONDUIT_PULSE_CHARGE, simTick, emitterIdx, false);
  }

  // Arc straight down/around to grounded WATER/ACID puddle touching the Tesla Node
  const puddleFrontierId = 1000 + emitterIdx;
  let seeded = false;
  for (let y = 1; y <= hitY && !seeded; y++) {
    for (let dz = -4; dz <= 4 && !seeded; dz++) {
      for (let dx = -4; dx <= 4 && !seeded; dx++) {
        const wx = hitX + dx;
        const wz = hitZ + dz;
        if (!inRoomBounds(room, wx, y, wz)) continue;
        const val = g[cellIndex(wx, y, wz)];
        const m = getMat(val);
        if (m === MAT.WATER || m === MAT.ACID) {
          if (getTimerOrCharge(val) < 52) {
            triggerElectricalPulseAt(
              room,
              wx,
              y,
              wz,
              CONDUIT_PULSE_CHARGE,
              simTick,
              puddleFrontierId,
              false,
            );
          }
          seeded = true;
        }
      }
    }
  }

  if (
    firedByPlayer &&
    world.suit.nozzleHoseActive &&
    world.suit.streamShockCdTicks === 0
  ) {
    const p = world.player;
    const dmg = world.liningRank >= 3 ? 5 : 10;
    p.hp = Math.max(0, p.hp - dmg);
    p.shockTicks = 24;
    world.suit.streamShockCdTicks = 30;
    pushCombatEvent(room, {
      kind: 'damage',
      entityId: p.id,
      x: p.x,
      y: p.y + p.height + 0.15,
      z: p.z,
      value: dmg,
      colorHex: 0x7ef9ff,
      label: `STREAM ARC! -${dmg}`,
    });

    const px = Math.floor(p.x / 0.1);
    const py = Math.max(1, Math.floor(p.y / 0.1));
    const pz = Math.floor(p.z / 0.1);
    if (inRoomBounds(room, px, py, pz)) {
      const fVal = g[cellIndex(px, py, pz)];
      const footMat = getMat(fVal);
      if ((footMat === MAT.WATER || footMat === MAT.ACID) && getTimerOrCharge(fVal) < 52) {
        triggerElectricalPulseAt(
          room,
          px,
          py,
          pz,
          CONDUIT_PULSE_CHARGE,
          simTick,
          2000 + emitterIdx,
          false,
        );
      }
    }
  }
}
