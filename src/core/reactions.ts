import { isElectricConductorMat } from './electricity.ts';
import {
  AMBIENT_RELAX_DIV,
  ARENA_W,
  CELLULAR_CLOCK_DIV,
  EXPLOSION_DMG_NOM,
  EXPLOSION_IMPULSE_NOM,
  EXPLOSION_MAX_PROMOS,
  EXPLOSION_RADIUS_M,
  FIXED_DT,
  GRAVITY_MODE,
  MAT,
  MATERIAL_SPEC,
  MAX_ACTIVE_BALLISTIC,
  MAX_ACTIVE_GRID_FLUID,
  MAX_ACTIVE_THERMAL_SOLIDS,
  MAX_EXPLOSIONS_PER_TICK,
  SLICE_STRIDE,
  TEMP_BYTE,
  VOXEL_SIZE_M,
} from './balance.ts';
import { applyEntityStun } from './ai.ts';
import { hasAirBurstLOS } from './combat.ts';
import { detonatePrimedInRadius, placeOrDeferFluid, spawnBallistic, voxelOverlapsEntity } from './fluids.ts';
import { hash32 } from './hash.ts';
import {
  applyStructuralDamage,
  cellIndex,
  getMat,
  getStepped,
  getTempByte,
  getTimerOrCharge,
  inRoomBounds,
  isFluidOrGasMat,
  isLiquidMat,
  isSolidMat,
  isThermalSolidActiveEligible,
  packVoxel,
  pushCombatEvent,
  queuePhaseExplosion,
  transitionCell,
  wake26Neighbors,
  wakeCell,
  writeCell,
  type RoomState,
} from './types.ts';
import { getEffectiveMassKg, getFeetY, type Entity, type WorldState } from './world.ts';

const FACE_DX = [1, -1, 0, 0, 0, 0] as const;
const FACE_DY = [0, 0, 1, -1, 0, 0] as const;
const FACE_DZ = [0, 0, 0, 0, 1, -1] as const;

// 26 deterministic unit rays: 6 face + 12 edge + 8 corner (§6.1 Stage 6)
const EXPLOSION_DIRS: readonly [number, number, number][] = (() => {
  const dirs: [number, number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dirs.push([dx * inv, dy * inv, dz * inv]);
      }
    }
  }
  return dirs;
})();

// Pre-allocated zero-GC scratch buffers for Stage 5 & Stage 6
const stage5FluidBuf = new Int32Array(MAX_ACTIVE_GRID_FLUID * 2);
const stage5ThermalBuf = new Int32Array(MAX_ACTIVE_THERMAL_SOLIDS * 2);
const explosionHitIndices = new Int32Array(26);

const WOOD_IGNITE_TEMP_BYTE = 85; // +140 C (above steam/boil, catches from fire/oil/vent)
const GLASS_THERMAL_SHOCK_DELTA_BYTES = 35; // 140 C in 4 C steps (§6.1 Stage 5d, §7)

function isThermalShockSourceMat(mat: number): boolean {
  return (
    mat === MAT.WATER ||
    mat === MAT.OIL ||
    mat === MAT.CRYO ||
    mat === MAT.STEAM ||
    mat === MAT.FIRE ||
    mat === MAT.ACID
  );
}

function checkGlassThermalShockNeighbors(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  sourceTempByte: number,
  simTick: number,
): void {
  const g = room.grid;
  for (let f = 0; f < 6; f++) {
    const nx = x + FACE_DX[f];
    const ny = y + FACE_DY[f];
    const nz = z + FACE_DZ[f];
    if (!inRoomBounds(room, nx, ny, nz)) continue;
    const nVal = g[cellIndex(nx, ny, nz)];
    if (getMat(nVal) !== MAT.GLASS_VAT) continue;
    if (Math.abs(sourceTempByte - getTempByte(nVal)) >= GLASS_THERMAL_SHOCK_DELTA_BYTES) {
      applyStructuralDamage(room, nx, ny, nz, 4, false, simTick);
    }
  }
}

function isConductiveMat(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.STEEL_GRATE ||
    mat === MAT.WATER ||
    mat === MAT.OIL ||
    mat === MAT.ICE
  );
}

function isCryoSolidWarmer(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.STEEL_GRATE ||
    mat === MAT.ICE ||
    mat === MAT.WOOD_BARRIER
  );
}

function hasAdjacentAir(room: RoomState, x: number, y: number, z: number): boolean {
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  if (x > 0 && getMat(g[idx - 1]) === MAT.AIR) return true;
  if (x + 1 < room.roomW && getMat(g[idx + 1]) === MAT.AIR) return true;
  if (z > 0 && getMat(g[idx - ARENA_W]) === MAT.AIR) return true;
  if (z + 1 < room.roomD && getMat(g[idx + ARENA_W]) === MAT.AIR) return true;
  if (y > 0 && getMat(g[idx - SLICE_STRIDE]) === MAT.AIR) return true;
  if (y + 1 < room.roomH && getMat(g[idx + SLICE_STRIDE]) === MAT.AIR) return true;
  return false;
}

function isInsideVentPlume(room: RoomState, x: number, y: number, z: number): boolean {
  for (let i = 0; i < room.emitters.length; i++) {
    const em = room.emitters[i];
    if (em.kind !== 'vent') continue;
    if (
      x >= em.x - 1 &&
      x <= em.x + 1 &&
      z >= em.z - 1 &&
      z <= em.z + 1 &&
      y >= em.y &&
      y <= em.y + 12
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveThermalSourceNeighbor(room: RoomState, x: number, y: number, z: number): boolean {
  if (isInsideVentPlume(room, x, y, z)) return true;
  const g = room.grid;
  const idx = cellIndex(x, y, z);
  const isSrc = (m: number): boolean => m === MAT.FIRE || m === MAT.CRYO;
  if (x > 0 && isSrc(getMat(g[idx - 1]))) return true;
  if (x + 1 < room.roomW && isSrc(getMat(g[idx + 1]))) return true;
  if (z > 0 && isSrc(getMat(g[idx - ARENA_W]))) return true;
  if (z + 1 < room.roomD && isSrc(getMat(g[idx + ARENA_W]))) return true;
  if (y > 0 && isSrc(getMat(g[idx - SLICE_STRIDE]))) return true;
  if (y + 1 < room.roomH && isSrc(getMat(g[idx + SLICE_STRIDE]))) return true;
  return false;
}

function cellOverlapsAnyLivingEntity(world: WorldState, vx: number, vy: number, vz: number): boolean {
  if (voxelOverlapsEntity(world.player, vx, vy, vz)) return true;
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp <= 0 || e.deathHusk) continue;
    if (voxelOverlapsEntity(e, vx, vy, vz)) return true;
  }
  return false;
}

function writeCellTempByte(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  val: number,
  newTempByte: number,
  simTick: number,
): void {
  const clamped = newTempByte < 0 ? 0 : newTempByte > 255 ? 255 : newTempByte | 0;
  if (clamped === getTempByte(val)) return;
  const updated = ((val & ~(0xff << 8)) | (clamped << 8)) >>> 0;
  writeCell(room, x, y, z, updated, simTick);
}

function recordCryoSublimationVisual(room: RoomState, x: number, y: number, z: number): void {
  if (room.sublimationEventCount < 128) {
    const b = room.sublimationEventCount * 3;
    room.sublimationEvents[b] = (x + 0.5) * VOXEL_SIZE_M;
    room.sublimationEvents[b + 1] = (y + 0.5) * VOXEL_SIZE_M;
    room.sublimationEvents[b + 2] = (z + 0.5) * VOXEL_SIZE_M;
    room.sublimationEventCount++;
  }
}

function isStage5Active(room: RoomState, idx: number): boolean {
  const w = idx >>> 5;
  const bit = 1 << (idx & 31);
  return (
    ((room.activeFluidBitsetCur[w] |
      room.activeFluidBitsetNext[w] |
      room.activeThermalBitsetCur[w] |
      room.activeThermalBitsetNext[w]) &
      bit) !==
    0
  );
}

function keepThermalSolidsAlive(room: RoomState, simTick: number): void {
  const g = room.grid;
  for (let i = 0; i < room.activeThermalCurCount; i++) {
    const idx = room.activeThermalCur[i];
    const val = g[idx];
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    if (isThermalSolidActiveEligible(room, x, y, z, val)) {
      wakeCell(room, x, y, z, simTick);
    }
  }
}

function collectStage5Lists(room: RoomState): { fluidCount: number; thermalCount: number } {
  const g = room.grid;

  let fCount = 0;
  for (let i = 0; i < room.activeFluidCurCount; i++) {
    const idx = room.activeFluidCur[i];
    if (isFluidOrGasMat(getMat(g[idx]))) {
      stage5FluidBuf[fCount++] = idx;
    }
  }
  for (let i = 0; i < room.activeFluidNextCount; i++) {
    const idx = room.activeFluidNext[i];
    const w = idx >>> 5;
    const bit = 1 << (idx & 31);
    if ((room.activeFluidBitsetCur[w] & bit) === 0 && isFluidOrGasMat(getMat(g[idx]))) {
      stage5FluidBuf[fCount++] = idx;
    }
  }
  if (fCount > 1) stage5FluidBuf.subarray(0, fCount).sort();

  let tCount = 0;
  for (let i = 0; i < room.activeThermalCurCount; i++) {
    const idx = room.activeThermalCur[i];
    const mat = getMat(g[idx]);
    if (isSolidMat(mat)) stage5ThermalBuf[tCount++] = idx;
  }
  for (let i = 0; i < room.activeThermalNextCount; i++) {
    const idx = room.activeThermalNext[i];
    const w = idx >>> 5;
    const bit = 1 << (idx & 31);
    if ((room.activeThermalBitsetCur[w] & bit) === 0 && isSolidMat(getMat(g[idx]))) {
      stage5ThermalBuf[tCount++] = idx;
    }
  }
  if (tCount > 1) stage5ThermalBuf.subarray(0, tCount).sort();

  return { fluidCount: fCount, thermalCount: tCount };
}

/**
 * Stage 5: 15 Hz Cellular Reactions & 1 Hz Ambient Relaxation (§6.1).
 */
function findVentAt(room: RoomState, x: number, y: number, z: number): { vent: RoomState['emitters'][number]; outerFloorCollar: boolean } | null {
  for (let i = 0; i < room.emitters.length; i++) {
    const em = room.emitters[i];
    if (em.kind !== 'vent') continue;
    const dx = Math.abs(x - em.x);
    const dz = Math.abs(z - em.z);
    if (dx <= 2 && dz <= 2 && y >= em.y && y <= em.y + 12) {
      const outerFloorCollar = y <= em.y + 1 && (dx === 2 || dz === 2);
      return { vent: em, outerFloorCollar };
    }
  }
  return null;
}

export function stepReactionsStage5(world: WorldState): void {
  const room = world.room;
  const simTick = world.simTick;

  for (let i = 0; i < room.emitters.length; i++) {
    if (room.emitters[i].timer > 0) room.emitters[i].timer--;
  }

  if ((simTick & (CELLULAR_CLOCK_DIV - 1)) !== 0) {
    // Preserve active thermal solids across the 3 non-15 Hz ticks between Stage 4 list swaps
    keepThermalSolidsAlive(room, simTick);
    return;
  }

  const g = room.grid;
  const doRelax1Hz = simTick % AMBIENT_RELAX_DIV === 0;
  const doZeroGCryoWarm = room.gravityMode === GRAVITY_MODE.G0 && simTick % 300 === 0;

  // (a1) Hazard Emitter heat injection (Thermal Steam Vent +300C housing collar + vertical plume)
  for (let i = 0; i < room.emitters.length; i++) {
    const em = room.emitters[i];
    if (em.kind !== 'vent') continue;
    const heatBox = (bx0: number, bx1: number, by0: number, by1: number, bz0: number, bz1: number): void => {
      const x0 = Math.max(1, bx0);
      const x1 = Math.min(room.roomW - 2, bx1);
      const y0 = Math.max(1, by0);
      const y1 = Math.min(room.roomH - 2, by1);
      const z0 = Math.max(1, bz0);
      const z1 = Math.min(room.roomD - 2, bz1);
      for (let y = y0; y <= y1; y++) {
        const yOff = y * SLICE_STRIDE;
        for (let z = z0; z <= z1; z++) {
          const row = yOff + z * ARENA_W;
          for (let x = x0; x <= x1; x++) {
            const val = g[row + x];
            const mat = getMat(val);
            if (mat === MAT.AIR || mat === MAT.BOUNDARY_HULL || mat === MAT.GLASS_VAT) continue;
            if (getTempByte(val) < TEMP_BYTE.THERMAL_VENT) {
              writeCellTempByte(room, x, y, z, val, TEMP_BYTE.THERMAL_VENT, simTick);
            }
          }
        }
      }
    };
    // 7x3x7 furnace grate base collar heats deck puddles & enemies cleanly; 3x10x3 vertical plume above
    heatBox(em.x - 3, em.x + 3, em.y, em.y + 2, em.z - 3, em.z + 3);
    heatBox(em.x - 1, em.x + 1, em.y + 3, em.y + 12, em.z - 1, em.z + 1);
    checkGlassThermalShockNeighbors(room, em.x, em.y + 3, em.z, TEMP_BYTE.THERMAL_VENT, simTick);
  }

  // (a1b) Leaking Cryo Pipe: 1 L per 15 Hz tick (15 L/s) from finite 500 L Emitter(CRYO) reserve (§3.2, §9)
  for (let i = 0; i < room.emitters.length; i++) {
    const em = room.emitters[i];
    if (em.kind !== 'cryo_pipe' || em.reserveL <= 0) continue;
    const ox = em.x + (em.faceDir === '+X' ? 2 : em.faceDir === '-X' ? -2 : 0);
    const oy = em.y + (em.faceDir === '+Y' ? 2 : 0);
    const oz = em.z + (em.faceDir === '+Z' ? 2 : em.faceDir === '-Z' ? -2 : 0);
    if (!inRoomBounds(room, ox, oy, oz)) continue;
    checkGlassThermalShockNeighbors(room, ox, oy, oz, TEMP_BYTE.CRYO, simTick);
    const placed = placeOrDeferFluid(
      room,
      MAT.CRYO,
      TEMP_BYTE.CRYO,
      0,
      ox,
      oy,
      oz,
      true,
      world.player,
      simTick,
    );
    if (placed) {
      em.reserveL--;
    }
  }

  const { fluidCount, thermalCount } = collectStage5Lists(room);

  // (a2) FIRE neighbor heating (+8 bytes / +32C to non-FIRE 6-neighbors excl. AIR/GLASS_VAT/BOUNDARY_HULL)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    if (getMat(g[idx]) !== MAT.FIRE) continue;
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    for (let f = 0; f < 6; f++) {
      const nx = x + FACE_DX[f];
      const ny = y + FACE_DY[f];
      const nz = z + FACE_DZ[f];
      if (!inRoomBounds(room, nx, ny, nz)) continue;
      const nVal = g[cellIndex(nx, ny, nz)];
      const nMat = getMat(nVal);
      if (
        nMat === MAT.AIR ||
        nMat === MAT.FIRE ||
        nMat === MAT.GLASS_VAT ||
        nMat === MAT.BOUNDARY_HULL
      ) {
        continue;
      }
      const nextT = Math.min(TEMP_BYTE.FIRE, getTempByte(nVal) + 8);
      writeCellTempByte(room, nx, ny, nz, nVal, nextT, simTick);
    }
  }

  // (b) Symmetric 6-Neighbor Conductive-Pair Conduction (DeltaT / 8, {HULL_STEEL, STEEL_GRATE, WATER, OIL, ICE})
  const runConduction = (buf: Int32Array, count: number): void => {
    for (let i = 0; i < count; i++) {
      const idxA = buf[i];
      const valA = g[idxA];
      const matA = getMat(valA);
      if (!isConductiveMat(matA)) continue;

      const y = Math.floor(idxA / SLICE_STRIDE);
      const rem = idxA - y * SLICE_STRIDE;
      const z = Math.floor(rem / ARENA_W);
      const x = rem - z * ARENA_W;
      let tempA = getTempByte(valA);

      for (let f = 0; f < 6; f++) {
        const nx = x + FACE_DX[f];
        const ny = y + FACE_DY[f];
        const nz = z + FACE_DZ[f];
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const idxB = cellIndex(nx, ny, nz);
        const valB = g[idxB];
        const matB = getMat(valB);
        if (!isConductiveMat(matB)) continue;
        if (isStage5Active(room, idxB) && idxA >= idxB) continue;

        const tempB = getTempByte(valB);
        const delta = Math.trunc((tempA - tempB) / 8);
        if (delta === 0) continue;

        tempA -= delta;
        writeCellTempByte(room, x, y, z, g[idxA], tempA, simTick);
        writeCellTempByte(room, nx, ny, nz, valB, tempB + delta, simTick);
      }
    }
  };
  runConduction(stage5FluidBuf, fluidCount);
  runConduction(stage5ThermalBuf, thermalCount);

  // (c) Pairwise WATER + FIRE Dousing (steppedThisPass === 0 on both, no Phase Explosion)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    const mat = getMat(val);
    if (getStepped(val) !== 0) continue;
    if (mat !== MAT.WATER && mat !== MAT.FIRE) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    for (let f = 0; f < 6; f++) {
      const nx = x + FACE_DX[f];
      const ny = y + FACE_DY[f];
      const nz = z + FACE_DZ[f];
      if (!inRoomBounds(room, nx, ny, nz)) continue;
      const nVal = g[cellIndex(nx, ny, nz)];
      if (getStepped(nVal) !== 0) continue;
      const nMat = getMat(nVal);
      if (mat === MAT.WATER && nMat === MAT.FIRE) {
        transitionCell(room, x, y, z, MAT.STEAM, TEMP_BYTE.BOIL, simTick);
        transitionCell(room, nx, ny, nz, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
        break;
      }
      if (mat === MAT.FIRE && nMat === MAT.WATER) {
        transitionCell(room, nx, ny, nz, MAT.STEAM, TEMP_BYTE.BOIL, simTick);
        transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
        break;
      }
    }
  }

  // (c.4) Oil Flashover & Flammable WOOD Combustion (0.3 m radiant box, dy -2..1 downward radiation, 0 fluid drift)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    const mat = getMat(val);
    if (mat !== MAT.FIRE) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    for (let dy = -2; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 1 || ny >= room.roomH - 1) continue;
      for (let dz = -3; dz <= 3; dz++) {
        const nz = z + dz;
        if (nz < 1 || nz >= room.roomD - 1) continue;
        for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          if (nx < 1 || nx >= room.roomW - 1) continue;
          const nIdx = cellIndex(nx, ny, nz);
          const nVal = g[nIdx];
          const nMat = getMat(nVal);
          if (nMat === MAT.OIL && getTempByte(nVal) < 111 && hasAdjacentAir(room, nx, ny, nz)) {
            writeCellTempByte(room, nx, ny, nz, nVal, 111, simTick);
          } else if (nMat === MAT.WOOD_BARRIER && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) {
            const curT = getTempByte(nVal);
            if (curT < TEMP_BYTE.FIRE) {
              writeCellTempByte(room, nx, ny, nz, nVal, Math.min(TEMP_BYTE.FIRE, curT + 18), simTick);
            }
          }
        }
      }
    }
  }

  // Burning WOOD spreads fire to neighboring WOOD, spawns rising FIRE flames, quenches on WATER, and burns away to AIR
  const reactionTick = simTick >>> 2;
  for (let i = 0; i < thermalCount; i++) {
    const idx = stage5ThermalBuf[i];
    const val = g[idx];
    if (getMat(val) !== MAT.WOOD_BARRIER) continue;
    const tByte = getTempByte(val);
    if (tByte < WOOD_IGNITE_TEMP_BYTE) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    // Quench immediately if touching WATER or CRYO
    let quenched = false;
    for (let f = 0; f < 6; f++) {
      const nx = x + FACE_DX[f];
      const ny = y + FACE_DY[f];
      const nz = z + FACE_DZ[f];
      if (!inRoomBounds(room, nx, ny, nz)) continue;
      const nm = getMat(g[cellIndex(nx, ny, nz)]);
      if (nm === MAT.WATER || nm === MAT.CRYO) {
        writeCellTempByte(room, x, y, z, val, TEMP_BYTE.AMBIENT, simTick);
        quenched = true;
        break;
      }
    }
    if (quenched) continue;

    // Spread heat to adjacent WOOD with upward chimney bias (dy -1..2) so fire climbs scaffold legs into loft decks
    for (let dy = -1; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny < 1 || ny >= room.roomH - 1) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = z + dz;
        if (nz < 1 || nz >= room.roomD - 1) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          if (nx < 1 || nx >= room.roomW - 1) continue;
          const nVal = g[cellIndex(nx, ny, nz)];
          if (getMat(nVal) === MAT.WOOD_BARRIER && getTempByte(nVal) < WOOD_IGNITE_TEMP_BYTE + 20) {
            writeCellTempByte(room, nx, ny, nz, nVal, Math.min(TEMP_BYTE.FIRE, getTempByte(nVal) + 14), simTick);
          }
        }
      }
    }

    // Emit sustained roaring FIRE flames onto exposed AIR faces above & beside burning wood (0 fluid drift)
    if (((reactionTick + x + z) % 2) === 0) {
      const aboveY = y + 1;
      if (inRoomBounds(room, x, aboveY, z) && getMat(g[cellIndex(x, aboveY, z)]) === MAT.AIR) {
        writeCell(room, x, aboveY, z, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 38, 0, (reactionTick + x) & 7), simTick);
      } else {
        const fDir = (reactionTick + x + y + z) & 3;
        const fx = x + FACE_DX[fDir];
        const fz = z + FACE_DZ[fDir];
        if (inRoomBounds(room, fx, y, fz) && getMat(g[cellIndex(fx, y, fz)]) === MAT.AIR) {
          writeCell(room, fx, y, fz, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 34, 0, (reactionTick + z) & 7), simTick);
        }
      }
    }

    // Burn steadily across all 12 struct HP (~2.8 s per voxel, ~4-5 s for full scaffold collapse)
    if (((reactionTick + x * 7 + y * 13 + z * 19) % 3) === 0) {
      applyStructuralDamage(room, x, y, z, 1, false, simTick);
    }
  }

  // (c.5) Electrical Spark Ignition: conductor >= +40V (20 units) arcs into adjacent OIL + AIR (§6.1)
  const runSparkIgnition = (buf: Int32Array, count: number): void => {
    for (let i = 0; i < count; i++) {
      const idx = buf[i];
      const val = g[idx];
      const mat = getMat(val);
      if (!isElectricConductorMat(mat)) continue;
      let charge = getTimerOrCharge(val);
      if (charge < 20) continue;

      const y = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - y * SLICE_STRIDE;
      const z = Math.floor(rem / ARENA_W);
      const x = rem - z * ARENA_W;

      for (let f = 0; f < 6 && charge >= 20; f++) {
        const nx = x + FACE_DX[f];
        const ny = y + FACE_DY[f];
        const nz = z + FACE_DZ[f];
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const nVal = g[cellIndex(nx, ny, nz)];
        if (getMat(nVal) !== MAT.OIL) continue;
        if (!hasAdjacentAir(room, nx, ny, nz)) continue;

        charge -= 10;
        const updatedCond = ((g[idx] & ~(0x3f << 16)) | ((charge & 0x3f) << 16)) >>> 0;
        writeCell(room, x, y, z, updatedCond, simTick);
        if (getTempByte(nVal) < TEMP_BYTE.OIL_IGNITE) {
          writeCellTempByte(room, nx, ny, nz, nVal, TEMP_BYTE.OIL_IGNITE, simTick);
        }
      }
    }
  };
  runSparkIgnition(stage5FluidBuf, fluidCount);
  runSparkIgnition(stage5ThermalBuf, thermalCount);

  // (d0) GLASS_VAT Thermal Shock (|T_source - T_glass| >= 140C strictly against fluid/gas sources, §6.1, §7)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    const mat = getMat(val);
    if (!isThermalShockSourceMat(mat)) continue;
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    checkGlassThermalShockNeighbors(room, x, y, z, getTempByte(val), simTick);
  }

  // (d) Instant CRYO Boil-Off Phase Explosion (>= +100C contact or plume)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    if (getMat(val) !== MAT.CRYO) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    let hotContact = getTempByte(val) >= TEMP_BYTE.BOIL || isInsideVentPlume(room, x, y, z);
    if (!hotContact) {
      for (let f = 0; f < 6; f++) {
        const nx = x + FACE_DX[f];
        const ny = y + FACE_DY[f];
        const nz = z + FACE_DZ[f];
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const nVal = g[cellIndex(nx, ny, nz)];
        const nMat = getMat(nVal);
        if (nMat === MAT.AIR || nMat === MAT.GLASS_VAT || nMat === MAT.BOUNDARY_HULL) continue;
        if (getTempByte(nVal) >= TEMP_BYTE.BOIL) {
          hotContact = true;
          break;
        }
      }
    }
    if (hotContact) {
      transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
      room.ledgers.cryoBoiledOff++;
      const ventInfo = findVentAt(room, x, y, z);
      if (!ventInfo || (!ventInfo.outerFloorCollar && ventInfo.vent.timer === 0)) {
        if (ventInfo) ventInfo.vent.timer = 15;
        queuePhaseExplosion(
          room,
          (x + 0.5) * VOXEL_SIZE_M,
          (y + 0.5) * VOXEL_SIZE_M,
          (z + 0.5) * VOXEL_SIZE_M,
          false,
          'cryo',
        );
      }
    }
  }

  // (e) OIL & WOOD_BARRIER Ignition (strictly requiring adjacent AIR)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    if (getMat(val) !== MAT.OIL || getTempByte(val) < TEMP_BYTE.OIL_IGNITE) continue;
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    if (hasAdjacentAir(room, x, y, z)) {
      transitionCell(room, x, y, z, MAT.FIRE, TEMP_BYTE.FIRE, simTick);
      room.ledgers.oilCombusted++;
    }
  }

  // Heated WOOD_BARRIER burns progressively via step (c.4) above instead of vaporizing on tick 1

  // (f) WATER <-> ICE / STEAM phase changes & CRYO finite freezing/chilling/sublimation
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    const mat = getMat(val);
    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;

    if (mat === MAT.WATER) {
      const temp = getTempByte(val);
      if (temp >= TEMP_BYTE.BOIL) {
        transitionCell(room, x, y, z, MAT.STEAM, TEMP_BYTE.BOIL, simTick);
        const ventInfo = findVentAt(room, x, y, z);
        if (!ventInfo || (!ventInfo.outerFloorCollar && ventInfo.vent.timer === 0)) {
          if (ventInfo) ventInfo.vent.timer = 15;
          queuePhaseExplosion(
            room,
            (x + 0.5) * VOXEL_SIZE_M,
            (y + 0.5) * VOXEL_SIZE_M,
            (z + 0.5) * VOXEL_SIZE_M,
            false,
            'steam',
          );
        }
      } else if (temp <= TEMP_BYTE.FREEZE) {
        if (!cellOverlapsAnyLivingEntity(world, x, y, z)) {
          transitionCell(room, x, y, z, MAT.ICE, temp, simTick);
        } else {
          wakeCell(room, x, y, z, simTick);
        }
      }
    } else if (mat === MAT.STEAM) {
      if (getStepped(val) === 0) {
        let coldSolid = false;
        for (let f = 0; f < 6; f++) {
          const nx = x + FACE_DX[f];
          const ny = y + FACE_DY[f];
          const nz = z + FACE_DZ[f];
          if (!inRoomBounds(room, nx, ny, nz)) continue;
          const nVal = g[cellIndex(nx, ny, nz)];
          if (isSolidMat(getMat(nVal)) && getTempByte(nVal) <= TEMP_BYTE.STEAM_CONDENSE) {
            coldSolid = true;
            break;
          }
        }
        if (coldSolid) {
          transitionCell(
            room,
            x,
            y,
            z,
            MAT.WATER,
            Math.min(getTempByte(val), TEMP_BYTE.STEAM_CONDENSE),
            simTick,
          );
        }
      }
    } else if (mat === MAT.CRYO) {
      let cryoTemp = getTempByte(val);
      let solidContact = false;
      let anySolidNeighbor = false;
      let frozeWater = false;
      let chilledWood = false;

      for (let f = 0; f < 6; f++) {
        const nx = x + FACE_DX[f];
        const ny = y + FACE_DY[f];
        const nz = z + FACE_DZ[f];
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const nIdx = cellIndex(nx, ny, nz);
        const nVal = g[nIdx];
        const nMat = getMat(nVal);

        if (isSolidMat(nMat)) {
          anySolidNeighbor = true;
          if (isCryoSolidWarmer(nMat)) solidContact = true;
        }

        if (!frozeWater && nMat === MAT.WATER && !cellOverlapsAnyLivingEntity(world, nx, ny, nz)) {
          transitionCell(room, nx, ny, nz, MAT.ICE, TEMP_BYTE.FREEZE, simTick);
          cryoTemp += 8; // +32C per frozen water cell (§3.2)
          frozeWater = true;
        } else if (!chilledWood && nMat === MAT.WOOD_BARRIER) {
          const nextWoodT = Math.max(TEMP_BYTE.CRYO, getTempByte(nVal) - 3);
          writeCellTempByte(room, nx, ny, nz, nVal, nextWoodT, simTick);
          cryoTemp += 1; // +4C per wood chill tick (§3.2)
          chilledWood = true;
        }
      }

      if (doRelax1Hz && solidContact) cryoTemp += 1;
      if (doZeroGCryoWarm && !anySolidNeighbor) cryoTemp += 1;

      if (cryoTemp >= TEMP_BYTE.FREEZE) {
        transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
        room.ledgers.cryoBoiledOff++;
        recordCryoSublimationVisual(room, x, y, z);
      } else if (cryoTemp !== getTempByte(val)) {
        writeCellTempByte(room, x, y, z, g[idx], cryoTemp, simTick);
      }
    }
  }

  for (let i = 0; i < thermalCount; i++) {
    const idx = stage5ThermalBuf[i];
    const val = g[idx];
    if (getMat(val) !== MAT.ICE) continue;
    const temp = getTempByte(val);
    if (temp >= TEMP_BYTE.MELT) {
      const y = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - y * SLICE_STRIDE;
      const z = Math.floor(rem / ARENA_W);
      const x = rem - z * ARENA_W;
      transitionCell(room, x, y, z, MAT.WATER, temp, simTick);
    }
  }

  // (g) 1 Hz Ambient Relaxation (step 1 byte toward 55; ICE only upward toward 50)
  if (doRelax1Hz) {
    const relaxList = (buf: Int32Array, count: number): void => {
      for (let i = 0; i < count; i++) {
        const idx = buf[i];
        const val = g[idx];
        const mat = getMat(val);
        if (
          mat === MAT.AIR ||
          mat === MAT.FIRE ||
          mat === MAT.CRYO ||
          mat === MAT.GLASS_VAT ||
          mat === MAT.BOUNDARY_HULL
        ) {
          continue;
        }
        const y = Math.floor(idx / SLICE_STRIDE);
        const rem = idx - y * SLICE_STRIDE;
        const z = Math.floor(rem / ARENA_W);
        const x = rem - z * ARENA_W;
        if (hasActiveThermalSourceNeighbor(room, x, y, z)) continue;

        const temp = getTempByte(val);
        if (mat === MAT.ICE) {
          if (temp < TEMP_BYTE.FREEZE) {
            writeCellTempByte(room, x, y, z, val, temp + 1, simTick);
          }
        } else if (temp < TEMP_BYTE.AMBIENT) {
          writeCellTempByte(room, x, y, z, val, temp + 1, simTick);
        } else if (temp > TEMP_BYTE.AMBIENT) {
          writeCellTempByte(room, x, y, z, val, temp - 1, simTick);
        }
      }
    };
    relaxList(stage5FluidBuf, fluidCount);
    relaxList(stage5ThermalBuf, thermalCount);
  }

  // (h) FIRE / STEAM 15 Hz timer decay (skip steppedThisPass === 1 birth tick)
  for (let i = 0; i < fluidCount; i++) {
    const idx = stage5FluidBuf[i];
    const val = g[idx];
    const mat = getMat(val);
    if (mat !== MAT.FIRE && mat !== MAT.STEAM) continue;
    if (getStepped(val) !== 0) continue;

    const y = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - y * SLICE_STRIDE;
    const z = Math.floor(rem / ARENA_W);
    const x = rem - z * ARENA_W;
    const timer = getTimerOrCharge(val);

    if (timer <= 1) {
      if (mat === MAT.FIRE) {
        transitionCell(room, x, y, z, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
      } else {
        transitionCell(
          room,
          x,
          y,
          z,
          MAT.WATER,
          Math.min(getTempByte(val), TEMP_BYTE.STEAM_CONDENSE),
          simTick,
        );
      }
    } else {
      const updated = ((val & ~(0x3f << 16)) | ((timer - 1) << 16)) >>> 0;
      writeCell(room, x, y, z, updated, simTick);
    }
  }

  // Keep eligible thermal solids awake if still off relaxation target
  keepThermalSolidsAlive(room, simTick);
}

function castExplosionRayFirstSolid(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistM: number,
): number {
  const ox = oxM / VOXEL_SIZE_M;
  const oy = oyM / VOXEL_SIZE_M;
  const oz = ozM / VOXEL_SIZE_M;
  const maxDistV = maxDistM / VOXEL_SIZE_M;

  let gx = Math.floor(ox);
  let gy = Math.floor(oy);
  let gz = Math.floor(oz);

  const stepX = dx >= 0 ? 1 : -1;
  const stepY = dy >= 0 ? 1 : -1;
  const stepZ = dz >= 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx !== 0 ? ((stepX > 0 ? gx + 1 : gx) - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((stepY > 0 ? gy + 1 : gy) - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? ((stepZ > 0 ? gz + 1 : gz) - oz) / dz : Infinity;

  let t = 0;
  for (let steps = 0; steps < 80 && t <= maxDistV; steps++) {
    if (!inRoomBounds(room, gx, gy, gz)) return -1;
    const idx = cellIndex(gx, gy, gz);
    if (isSolidMat(getMat(room.grid[idx]))) return idx;

    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        gx += stepX;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        gz += stepZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        gy += stepY;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        gz += stepZ;
      }
    }
  }
  return -1;
}

/**
 * Stage 6: Coalesced Phase Explosions (max 4/tick, 1.8 m radius, 26 deduped rays, 64 promos) (§6.1).
 */
export function stepPhaseExplosionsStage6(world: WorldState): void {
  const room = world.room;
  const q = room.explosionQueue;
  if (q.length === 0) return;

  const toRun = Math.min(MAX_EXPLOSIONS_PER_TICK, q.length);
  const simTick = world.simTick;

  for (let wIdx = 0; wIdx < toRun; wIdx++) {
    const wave = q.shift()!;
    const cx = wave.x;
    const cy = wave.y;
    const cz = wave.z;

    if (room.recentExplosions.length < 16) {
      room.recentExplosions.push({
        x: cx,
        y: cy,
        z: cz,
        radiusM: EXPLOSION_RADIUS_M,
        intensity: wave.intensity,
        tick: simTick,
        kind: wave.kind,
      });
    }

    // 0. Chain-detonate any Phase-Lock Fuse primed quanta inside the 1.8 m blast radius (§9)
    detonatePrimedInRadius(world, cx, cy, cz, EXPLOSION_RADIUS_M);

    // 1. Entity damage + clamped radial impulse (unobstructed 3D DDA LOS)
    const entities: Entity[] = [world.player];
    for (let i = 0; i < world.entities.length; i++) {
      const e = world.entities[i];
      if (e.hp > 0 && !e.deathHusk) entities.push(e);
    }

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const tx = e.x;
      const ty = e.y + e.height * 0.5;
      const tz = e.z;
      const dx = tx - cx;
      const dy = ty - cy;
      const dz = tz - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= EXPLOSION_RADIUS_M) continue;
      if (!hasAirBurstLOS(room, cx, cy, cz, tx, ty, tz)) continue;

      const f = 1 - d / EXPLOSION_RADIUS_M;
      const blastDamped = e.kind === 'player' && wave.playerOnly && world.liningRank >= 1;
      const dmg = blastDamped ? 0 : Math.round(EXPLOSION_DMG_NOM * f);
      if (dmg > 0) {
        e.hp = Math.max(0, e.hp - dmg);
        pushCombatEvent(room, {
          kind: 'damage',
          entityId: e.id,
          x: e.x,
          y: e.y + e.height,
          z: e.z,
          value: dmg,
          colorHex: wave.kind === 'cryo' ? 0x7ef9ff : 0xffffff,
          label: wave.kind === 'cryo' ? `CRYO BLAST -${dmg}` : `STEAM BLAST -${dmg}`,
        });
      }

      const massKg = getEffectiveMassKg(e, world.playerTank);
      const rawDv = Math.max(1.5 * f, Math.min(12.0 * f, (EXPLOSION_IMPULSE_NOM * f) / Math.max(1, massKg)));
      const dv = blastDamped ? rawDv * 0.5 : rawDv;

      let dirX: number;
      let dirY: number;
      let dirZ: number;
      if (d >= 1e-4) {
        dirX = dx / d;
        dirY = dy / d;
        dirZ = dz / d;
      } else {
        const h = hash32(room.roomSeed, simTick, e.id + 17);
        const rx = ((h & 255) / 127.5) - 1;
        const ry = (((h >>> 8) & 255) / 127.5) - 1;
        const rz = (((h >>> 16) & 255) / 127.5) - 1;
        const inv = 1 / Math.max(1e-4, Math.sqrt(rx * rx + ry * ry + rz * rz));
        dirX = rx * inv;
        dirY = ry * inv;
        dirZ = rz * inv;
      }
      e.vx += dirX * dv;
      e.vy += dirY * dv;
      e.vz += dirZ * dv;
      e.grounded = false;
      e.impulseTimer = 36;
      if (e.kind === 'alien') applyEntityStun(room, e, 45, false, true);
    }

    // 2. 26 deterministic rays deduplicated by solid idx (8 T1 / 6 T2 / 0 T3, 3x if embrittled)
    let hitCount = 0;
    for (let r = 0; r < EXPLOSION_DIRS.length; r++) {
      const [rdx, rdy, rdz] = EXPLOSION_DIRS[r];
      const hitIdx = castExplosionRayFirstSolid(room, cx, cy, cz, rdx, rdy, rdz, EXPLOSION_RADIUS_M);
      if (hitIdx < 0) continue;
      let dup = false;
      for (let k = 0; k < hitCount; k++) {
        if (explosionHitIndices[k] === hitIdx) {
          dup = true;
          break;
        }
      }
      if (!dup) explosionHitIndices[hitCount++] = hitIdx;
    }

    for (let k = 0; k < hitCount; k++) {
      const idx = explosionHitIndices[k];
      const val = room.grid[idx];
      const mat = getMat(val);
      const tier = MATERIAL_SPEC[mat]?.structTier ?? 0;
      const baseDmg = tier === 1 ? 8 : tier === 2 ? 6 : 0;
      if (baseDmg === 0) continue;
      const mult = getTempByte(val) <= TEMP_BYTE.EMBRITTLED ? 3 : 1;
      const vy = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - vy * SLICE_STRIDE;
      const vz = Math.floor(rem / ARENA_W);
      const vx = rem - vz * ARENA_W;
      if (mat === MAT.ICE) {
        const dx = (vx + 0.5) * VOXEL_SIZE_M - cx;
        const dy = (vy + 0.5) * VOXEL_SIZE_M - cy;
        const dz = (vz + 0.5) * VOXEL_SIZE_M - cz;
        const inv = 1 / Math.max(0.05, Math.hypot(dx, dy, dz));
        applyStructuralDamage(
          room,
          vx,
          vy,
          vz,
          baseDmg * mult,
          true,
          simTick,
          dx * inv * 8.5,
          Math.max(2.6, dy * inv * 8.5 + 2.2),
          dz * inv * 8.5,
        );
      } else {
        applyStructuralDamage(room, vx, vy, vz, baseDmg * mult, true, simTick);
      }
    }

    // 3. Promote up to 20 nearby surface fluid cells outward (avoiding upward popcorn loops)
    const g = room.grid;
    const centerVX = Math.floor(cx / VOXEL_SIZE_M);
    const centerVY = Math.floor(cy / VOXEL_SIZE_M);
    const centerVZ = Math.floor(cz / VOXEL_SIZE_M);
    const radV = 11; // 1.1 m splash scatter
    const radSqV = radV * radV;
    const promoCap = Math.min(20, EXPLOSION_MAX_PROMOS);
    let promos = 0;

    for (let dy = -radV; dy <= radV && promos < promoCap; dy++) {
      const vy = centerVY + dy;
      if (vy < 1 || vy >= room.roomH - 1) continue;
      for (let dz = -radV; dz <= radV && promos < promoCap; dz++) {
        const vz = centerVZ + dz;
        if (vz < 1 || vz >= room.roomD - 1) continue;
        for (let dx = -radV; dx <= radV && promos < promoCap; dx++) {
          if (dx * dx + dy * dy + dz * dz > radSqV) continue;
          if (room.ballistic.count >= MAX_ACTIVE_BALLISTIC) {
            promos = EXPLOSION_MAX_PROMOS;
            break;
          }
          const vx = centerVX + dx;
          if (vx < 1 || vx >= room.roomW - 1) continue;
          const idx = cellIndex(vx, vy, vz);
          const val = g[idx];
          const mat = getMat(val);
          if (!isLiquidMat(mat)) continue;
          if (!hasAdjacentAir(room, vx, vy, vz)) continue;

          const px = (vx + 0.5) * VOXEL_SIZE_M;
          const py = (vy + 0.5) * VOXEL_SIZE_M;
          const pz = (vz + 0.5) * VOXEL_SIZE_M;
          let dirX = px - cx;
          let dirY = py - cy;
          let dirZ = pz - cz;
          const dist = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
          const h = hash32(room.roomSeed, simTick, idx);
          if (dist >= 1e-4) {
            dirX /= dist;
            dirY /= dist;
            dirZ /= dist;
          } else {
            const rx = ((h & 255) / 127.5) - 1;
            const ry = (((h >>> 8) & 255) / 127.5) - 1;
            const rz = (((h >>> 16) & 255) / 127.5) - 1;
            const inv = 1 / Math.max(1e-4, Math.sqrt(rx * rx + ry * ry + rz * rz));
            dirX = rx * inv;
            dirY = ry * inv;
            dirZ = rz * inv;
          }
          const speed = 4.8 + 3.0 * ((h & 1023) / 1023);
          const hLen = Math.hypot(dirX, dirZ);
          const outX = hLen > 1e-3 ? dirX / hLen : dirX;
          const outZ = hLen > 1e-3 ? dirZ / hLen : dirZ;
          const outY = Math.max(1.6, Math.min(3.4, dirY * speed + 1.8));
          const slot = spawnBallistic(room, px, py, pz, outX * speed, outY, outZ * speed, val);
          if (slot !== -1) {
            writeCell(room, vx, vy, vz, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), simTick);
            wake26Neighbors(room, vx, vy, vz, simTick);
            promos++;
          }
        }
      }
    }
  }
}

/**
 * Stage 8: Non-displacing Entity-Fluid Sampling, DOTs & 1 Hz Thermal Relaxation (§3.1, §8.2).
 */
export function stepEntityFluidSamplingStage8(world: WorldState): void {
  const room = world.room;
  const g = room.grid;
  const simTick = world.simTick;
  const is15Hz = (simTick & (CELLULAR_CLOCK_DIV - 1)) === 0;
  const is1Hz = simTick % AMBIENT_RELAX_DIV === 0;

  const entities: Entity[] = [world.player];
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp > 0 && !e.deathHusk) entities.push(e);
  }

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const feetY = getFeetY(e) + 0.05 * e.upSign;
    const torsoY = e.y + e.height * 0.5;
    const vx = Math.floor(e.x / VOXEL_SIZE_M);
    const vz = Math.floor(e.z / VOXEL_SIZE_M);
    const vyFeet = Math.floor(feetY / VOXEL_SIZE_M);
    const vyTorso = Math.floor(torsoY / VOXEL_SIZE_M);

    let touchWater = false;
    let touchFire = false;
    let touchCryo = false;
    let touchOil = false;
    let touchAcid = false;
    let touchElectrified = false;
    let waterTemp: number = TEMP_BYTE.AMBIENT;
    let cryoX = -1;
    let cryoY = -1;
    let cryoZ = -1;

    const sampleCell = (sx: number, sy: number, sz: number): void => {
      if (!inRoomBounds(room, sx, sy, sz)) return;
      const val = g[cellIndex(sx, sy, sz)];
      const mat = getMat(val);
      if (mat === MAT.WATER) {
        touchWater = true;
        waterTemp = getTempByte(val);
        if (getTimerOrCharge(val) > 0) touchElectrified = true;
      } else if (mat === MAT.FIRE) {
        touchFire = true;
      } else if (mat === MAT.CRYO) {
        touchCryo = true;
        cryoX = sx;
        cryoY = sy;
        cryoZ = sz;
      } else if (mat === MAT.OIL) {
        touchOil = true;
      } else if (mat === MAT.ACID) {
        touchAcid = true;
        if (getTimerOrCharge(val) > 0) touchElectrified = true;
      } else if (e.kind === 'crate' && getTempByte(val) >= TEMP_BYTE.WOOD_IGNITE) {
        touchFire = true;
      }
      if (isInsideVentPlume(room, sx, sy, sz)) {
        touchFire = true;
      }
    };

    sampleCell(vx, vyFeet, vz);
    sampleCell(vx, vyTorso, vz);
    const offX = Math.max(1, Math.floor((e.halfW * 0.72) / VOXEL_SIZE_M));
    const offZ = Math.max(1, Math.floor((e.halfD * 0.72) / VOXEL_SIZE_M));
    sampleCell(vx + offX, vyFeet, vz);
    sampleCell(vx - offX, vyFeet, vz);
    sampleCell(vx, vyFeet, vz + offZ);
    sampleCell(vx, vyFeet, vz - offZ);

    if (touchWater) {
      e.wetTicks = 120;
      e.burnTicks = 0;
      if (is15Hz) {
        const diff = waterTemp - e.tempByte;
        const step = diff > 3 ? 3 : diff < -3 ? -3 : diff;
        e.tempByte += step;
      }
    } else if (e.wetTicks > 0) {
      e.wetTicks--;
    }

    const flameWeave = e.kind === 'player' && world.liningRank >= 2;
    if (touchFire && e.wetTicks === 0 && e.carapace !== 'thermal' && !flameWeave) {
      e.burnTicks = 180;
    } else if (e.burnTicks > 0) {
      e.burnTicks--;
    }

    if (touchCryo) {
      const frostInsul = e.kind === 'player' && world.liningRank >= 3;
      e.hp = Math.max(0, e.hp - (frostInsul ? 4 : 8) * FIXED_DT);
      if (is15Hz) {
        const minTemp = frostInsul ? TEMP_BYTE.EMBRITTLED + 1 : TEMP_BYTE.CRYO;
        const wasFrozen = e.tempByte <= TEMP_BYTE.EMBRITTLED;
        e.tempByte = Math.max(minTemp, e.tempByte - 5);
        if (!wasFrozen && e.tempByte <= TEMP_BYTE.EMBRITTLED && e.kind === 'alien') {
          pushCombatEvent(room, {
            kind: 'shatter',
            entityId: e.id,
            x: e.x,
            y: e.y + e.height + 0.15,
            z: e.z,
            value: 0,
            colorHex: 0x7ef9ff,
            label: 'FROZEN! (3x SHATTER)',
          });
        }
        if (cryoX >= 0) {
          const cIdx = cellIndex(cryoX, cryoY, cryoZ);
          const cVal = g[cIdx];
          if (getMat(cVal) === MAT.CRYO) {
            const nextCT = getTempByte(cVal) + 1;
            if (nextCT >= TEMP_BYTE.FREEZE) {
              transitionCell(room, cryoX, cryoY, cryoZ, MAT.AIR, TEMP_BYTE.AMBIENT, simTick);
              room.ledgers.cryoBoiledOff++;
              recordCryoSublimationVisual(room, cryoX, cryoY, cryoZ);
            } else {
              writeCellTempByte(room, cryoX, cryoY, cryoZ, cVal, nextCT, simTick);
            }
          }
        }
      }
    }

    if (touchAcid) {
      e.hp = Math.max(0, e.hp - 20 * FIXED_DT);
    }

    if (touchElectrified && e.carapace !== 'insulated') {
      const lining3 = e.kind === 'player' && world.liningRank >= 3;
      const armorConductMult = e.carapace === 'armored' ? 1.5 : 1.0;
      const baseDps = (e.wetTicks > 0 ? 22.5 : 18.0) * armorConductMult;
      const dps = lining3 ? baseDps * 0.5 : baseDps;
      e.hp = Math.max(0, e.hp - dps * FIXED_DT);
      e.shockTicks = 18;
      if (world.simTick % 20 === 0) {
        pushCombatEvent(room, {
          kind: 'damage',
          entityId: e.id,
          x: e.x,
          y: e.y + e.height,
          z: e.z,
          value: Math.round(dps * 0.33),
          colorHex: 0x7ef9ff,
          label: e.carapace === 'armored' ? `CONDUCT FRY! -${Math.round(dps * 0.33)}` : `SHOCK! -${Math.round(dps * 0.33)}`,
        });
      }
      if (!lining3 && e.kind === 'alien') {
        applyEntityStun(room, e, 45, false, true);
      }
    }

    // Burning crates emit flames into adjacent air to ignite nearby oil & wood
    if (e.kind === 'crate' && e.burnTicks > 0 && (world.simTick & 7) === 0) {
      const fx = Math.floor(e.x / VOXEL_SIZE_M);
      const fy = Math.floor((e.y + e.height + 0.05) / VOXEL_SIZE_M);
      const fz = Math.floor(e.z / VOXEL_SIZE_M);
      if (inRoomBounds(room, fx, fy, fz) && getMat(room.grid[cellIndex(fx, fy, fz)]) === MAT.AIR) {
        writeCell(room, fx, fy, fz, packVoxel(MAT.FIRE, TEMP_BYTE.FIRE, 26, 0, world.simTick & 7), world.simTick);
      }
    }
    if (e.burnTicks > 0) {
      const burnDps = touchFire ? 20 : 12;
      e.hp = Math.max(0, e.hp - burnDps * FIXED_DT);
      // Burning crates ignite 1 adjacent OIL or WOOD_BARRIER cell per 15 Hz tick (§8.2)
      if (e.kind === 'crate' && is15Hz) {
        let ignited = false;
        for (let dy = -1; dy <= 1 && !ignited; dy++) {
          for (let dz = -1; dz <= 1 && !ignited; dz++) {
            for (let dx = -1; dx <= 1 && !ignited; dx++) {
              const nx = vx + dx;
              const ny = vyFeet + dy;
              const nz = vz + dz;
              if (!inRoomBounds(room, nx, ny, nz)) continue;
              const nVal = g[cellIndex(nx, ny, nz)];
              const nMat = getMat(nVal);
              if (nMat === MAT.OIL || nMat === MAT.WOOD_BARRIER) {
                writeCellTempByte(room, nx, ny, nz, nVal, TEMP_BYTE.FIRE, simTick);
                ignited = true;
              }
            }
          }
        }
      }
    }

    if (touchOil && e.grounded && e.dashTimer === 0) {
      e.vx *= 0.86;
      e.vz *= 0.86;
    }

    // 1 Hz entity thermal relaxation toward ambient (+20C / byte 55)
    if (is1Hz && !touchCryo && !touchFire) {
      if (e.tempByte < TEMP_BYTE.AMBIENT) e.tempByte++;
      else if (e.tempByte > TEMP_BYTE.AMBIENT) e.tempByte--;
    }
  }
}
