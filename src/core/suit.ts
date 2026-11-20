import {
  ARENA_W,
  DASH_CD_TICKS,
  DASH_DURATION_TICKS,
  DASH_EXHAUST_SPEED_M_S,
  DASH_SPEED_M_S,
  GRAVITY_MODE,
  MAT,
  MAX_ACTIVE_BALLISTIC,
  NOZZLE_CLUSTER_RADIUS_M,
  NOZZLE_HOLD_RECOIL_0G,
  NOZZLE_HOLD_SPEED_M_S,
  NOZZLE_TAP_BURST_L,
  NOZZLE_TAP_CD_TICKS,
  NOZZLE_TAP_RECOIL_0G,
  NOZZLE_TAP_SHOT_L,
  NOZZLE_TAP_SHOTS,
  NOZZLE_TAP_SPACING_TICKS,
  NOZZLE_TAP_SPEED_M_S,
  NOZZLE_TAP_WAIT_TICKS,
  PLAYER_TORSO_OFFSET_M,
  SIPHON_CONE_COS_SQ,
  SIPHON_RANGE_M,
  SLICE_STRIDE,
  TEMP_BYTE,
  VOXEL_SIZE_M,
  nozzlePressureMult,
  siphonRateLPerTick,
  type MaterialId,
} from './balance.ts';
import { spawnBallistic } from './fluids.ts';
import { hash32 } from './hash.ts';
import {
  BALLISTIC_FLAG,
  cellIndex,
  chunkIndex,
  getMat,
  getTempByte,
  getTimerOrCharge,
  inRoomBounds,
  isSolidMat,
  packVoxel,
  writeCell,
  type RoomState,
} from './types.ts';
import {
  getActiveChamber,
  getFeetY,
  type InputFrame,
  type TankChamberState,
  type WorldState,
} from './world.ts';

const SIPHON_RANGE_V = Math.ceil(SIPHON_RANGE_M / VOXEL_SIZE_M); // 60
const SIPHON_RANGE_SQ_V = SIPHON_RANGE_V * SIPHON_RANGE_V; // 3,600
const NUM_DIST_BUCKETS = SIPHON_RANGE_V + 2; // 62
const MAX_SIPHON_CANDIDATES = 32_768;

// Pre-allocated zero-GC siphon candidate bucket buffers
const bucketHeads = new Int32Array(NUM_DIST_BUCKETS);
const candCellIdx = new Int32Array(MAX_SIPHON_CANDIDATES);
const candDistSq = new Float32Array(MAX_SIPHON_CANDIDATES);
const candNext = new Int32Array(MAX_SIPHON_CANDIDATES);
const sortBucketBuf: number[] = [];

function isSiphonableGridMat(mat: number): boolean {
  return mat === MAT.WATER || mat === MAT.OIL || mat === MAT.CRYO;
}

function isSiphonLosBlocker(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.BOUNDARY_HULL ||
    mat === MAT.WOOD_BARRIER ||
    mat === MAT.GLASS_VAT ||
    mat === MAT.ICE
  );
}

/**
 * 3D Amanatides-Woo DDA LOS check for Atomic Siphon (§6.2):
 * Passes AIR, fluids, and STEEL_GRATE; blocked by HULL_STEEL, BOUNDARY_HULL,
 * WOOD_BARRIER, GLASS_VAT, and ICE.
 */
export function hasSiphonLOS(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  targetVX: number,
  targetVY: number,
  targetVZ: number,
): boolean {
  const ox = oxM / VOXEL_SIZE_M;
  const oy = oyM / VOXEL_SIZE_M;
  const oz = ozM / VOXEL_SIZE_M;

  const tx = targetVX + 0.5;
  const ty = targetVY + 0.5;
  const tz = targetVZ + 0.5;

  const vx = tx - ox;
  const vy = ty - oy;
  const vz = tz - oz;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (dist < 1e-4) return true;

  const dx = vx / dist;
  const dy = vy / dist;
  const dz = vz / dist;

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
  for (let steps = 0; steps < 200 && t <= dist; steps++) {
    if (gx === targetVX && gy === targetVY && gz === targetVZ) return true;
    if (!inRoomBounds(room, gx, gy, gz)) return false;
    const mat = getMat(room.grid[cellIndex(gx, gy, gz)]);
    if (isSiphonLosBlocker(mat)) return false;

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
  return false;
}

function resolveSafeSpawnPoint(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  txM: number,
  tyM: number,
  tzM: number,
): [number, number, number] {
  // Step in 0.05 m increments from torso to target to prevent wall-bypassing
  const dx = txM - oxM;
  const dy = tyM - oyM;
  const dz = tzM - ozM;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return [oxM, oyM, ozM];
  const steps = Math.max(1, Math.ceil(len / 0.05));
  let safeX = oxM;
  let safeY = oyM;
  let safeZ = ozM;
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    const px = oxM + dx * f;
    const py = oyM + dy * f;
    const pz = ozM + dz * f;
    const vx = Math.floor(px / VOXEL_SIZE_M);
    const vy = Math.floor(py / VOXEL_SIZE_M);
    const vz = Math.floor(pz / VOXEL_SIZE_M);
    if (!inRoomBounds(room, vx, vy, vz)) break;
    if (isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]))) break;
    safeX = px;
    safeY = py;
    safeZ = pz;
  }
  return [safeX, safeY, safeZ];
}

function clampToRoomInterior(room: RoomState, x: number, y: number, z: number): [number, number, number] {
  const cx = Math.max(VOXEL_SIZE_M * 1.1, Math.min((room.roomW - 1.1) * VOXEL_SIZE_M, x));
  const cy = Math.max(VOXEL_SIZE_M * 1.1, Math.min((room.roomH - 1.1) * VOXEL_SIZE_M, y));
  const cz = Math.max(VOXEL_SIZE_M * 1.1, Math.min((room.roomD - 1.1) * VOXEL_SIZE_M, z));
  return [cx, cy, cz];
}

function emptyChamberIfZero(chamber: TankChamberState): void {
  if (chamber.liters <= 0) {
    chamber.liters = 0;
    chamber.mat = MAT.AIR;
    chamber.tempByte = TEMP_BYTE.AMBIENT;
    chamber.chargeUnits = 0;
    chamber.lockedSpill = false;
  }
}

/**
 * Step 1a: Atomic Vacuum Siphon (6.0 m, 35 deg LOS cone, 2 + siphonRank L/tick).
 * Nearest-first by (distSq, idx), single material per tick, cap & source guarded (§3.2, §6.2).
 */
function stepAtomicSiphon(world: WorldState, input: InputFrame): void {
  const suit = world.suit;
  suit.siphonActive = false;
  suit.siphonLitersThisTick = 0;

  if (!input.siphonHeld) return;

  const chamber = getActiveChamber(world.playerTank);
  if (chamber.lockedSpill) return;
  const headroom = chamber.capL - chamber.liters;
  if (headroom <= 0) return;

  const maxTake = Math.min(siphonRateLPerTick(world.siphonRank), headroom);
  const room = world.room;
  const p = world.player;
  const oxM = p.x;
  const oyM = p.y + PLAYER_TORSO_OFFSET_M;
  const ozM = p.z;
  const oxV = oxM / VOXEL_SIZE_M;
  const oyV = oyM / VOXEL_SIZE_M;
  const ozV = ozM / VOXEL_SIZE_M;

  const ax = suit.aimDirX;
  const ay = suit.aimDirY;
  const az = suit.aimDirZ;

  // Tight voxel AABB bounded by the 6.0 m sphere around torso
  const minVX = Math.max(1, Math.floor(oxV - SIPHON_RANGE_V));
  const maxVX = Math.min(room.roomW - 2, Math.ceil(oxV + SIPHON_RANGE_V));
  const minVY = Math.max(1, Math.floor(oyV - SIPHON_RANGE_V));
  const maxVY = Math.min(room.roomH - 2, Math.ceil(oyV + SIPHON_RANGE_V));
  const minVZ = Math.max(1, Math.floor(ozV - SIPHON_RANGE_V));
  const maxVZ = Math.min(room.roomD - 2, Math.ceil(ozV + SIPHON_RANGE_V));

  const minCX = minVX >> 4;
  const maxCX = maxVX >> 4;
  const minCY = minVY >> 4;
  const maxCY = maxVY >> 4;
  const minCZ = minVZ >> 4;
  const maxCZ = maxVZ >> 4;

  bucketHeads.fill(-1);
  let candCount = 0;
  const g = room.grid;

  for (let cy = minCY; cy <= maxCY; cy++) {
    const y0 = Math.max(minVY, cy << 4);
    const y1 = Math.min(maxVY, (cy << 4) + 15);
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      const z0 = Math.max(minVZ, cz << 4);
      const z1 = Math.min(maxVZ, (cz << 4) + 15);
      for (let cx = minCX; cx <= maxCX; cx++) {
        const cIdx = chunkIndex(cx, cy, cz);
        if (room.chunkFluidVoxelCount[cIdx] === 0) continue;

        const x0 = Math.max(minVX, cx << 4);
        const x1 = Math.min(maxVX, (cx << 4) + 15);

        for (let y = y0; y <= y1; y++) {
          const dy = y + 0.5 - oyV;
          const dySq = dy * dy;
          if (dySq > SIPHON_RANGE_SQ_V) continue;
          const yOff = y * SLICE_STRIDE;

          for (let z = z0; z <= z1; z++) {
            const dz = z + 0.5 - ozV;
            const dyzSq = dySq + dz * dz;
            if (dyzSq > SIPHON_RANGE_SQ_V) continue;
            const row = yOff + z * ARENA_W;

            for (let x = x0; x <= x1; x++) {
              const dx = x + 0.5 - oxV;
              const dSq = dyzSq + dx * dx;
              if (dSq > SIPHON_RANGE_SQ_V) continue;

              const idx = row + x;
              const mat = getMat(g[idx]);
              if (!isSiphonableGridMat(mat)) continue;

              // Cone check: dot > 0 and dot^2 >= dSq * cos^2(35 deg)
              if (dSq > 1e-4) {
                const dot = dx * ax + dy * ay + dz * az;
                if (dot <= 0) continue;
                if (dot * dot < dSq * SIPHON_CONE_COS_SQ) continue;
              }

              if (candCount >= MAX_SIPHON_CANDIDATES) continue;
              const b = Math.min(NUM_DIST_BUCKETS - 1, Math.floor(Math.sqrt(dSq)));
              candCellIdx[candCount] = idx;
              candDistSq[candCount] = dSq;
              candNext[candCount] = bucketHeads[b];
              bucketHeads[b] = candCount;
              candCount++;
            }
          }
        }
      }
    }
  }

  if (candCount === 0) return;

  // Walk distance buckets nearest-first; sort within each bucket by (distSq, idx)
  let chosenMat: MaterialId = MAT.AIR;
  let extracted = 0;
  let totalTemp = chamber.liters * chamber.tempByte;
  let maxCharge = chamber.liters > 0 ? chamber.chargeUnits : 0;

  for (let b = 0; b < NUM_DIST_BUCKETS && extracted < maxTake; b++) {
    let head = bucketHeads[b];
    if (head === -1) continue;

    sortBucketBuf.length = 0;
    while (head !== -1) {
      sortBucketBuf.push(head);
      head = candNext[head];
    }

    if (sortBucketBuf.length > 1) {
      sortBucketBuf.sort((a, bIdx) => {
        const diff = candDistSq[a] - candDistSq[bIdx];
        if (diff !== 0) return diff;
        return candCellIdx[a] - candCellIdx[bIdx];
      });
    }

    for (let i = 0; i < sortBucketBuf.length && extracted < maxTake; i++) {
      const slot = sortBucketBuf[i];
      const idx = candCellIdx[slot];
      const val = g[idx];
      const mat = getMat(val);
      if (!isSiphonableGridMat(mat)) continue;

      // Once nearest LOS-clear source locks chosenMat, skip other materials this tick (§3.2)
      if (chosenMat !== MAT.AIR && mat !== chosenMat) continue;

      const vy = Math.floor(idx / SLICE_STRIDE);
      const rem = idx - vy * SLICE_STRIDE;
      const vz = Math.floor(rem / ARENA_W);
      const vx = rem - vz * ARENA_W;

      if (!hasSiphonLOS(room, oxM, oyM, ozM, vx, vy, vz)) continue;

      if (chosenMat === MAT.AIR) {
        chosenMat = mat;
        // M3.1 single-material guard (M3.2 adds expanding-BFS displacement & backfire here)
        if (chamber.liters > 0 && chamber.mat !== chosenMat) {
          return;
        }
        suit.siphonTargetX = (vx + 0.5) * VOXEL_SIZE_M;
        suit.siphonTargetY = (vy + 0.5) * VOXEL_SIZE_M;
        suit.siphonTargetZ = (vz + 0.5) * VOXEL_SIZE_M;
      }

      totalTemp += getTempByte(val);
      const c = getTimerOrCharge(val);
      if (c > maxCharge) maxCharge = c;

      // Atomic extraction: clears grid cell, marks dirtySnapshot/dirtyFluidRender + wakes 6 neighbors
      writeCell(room, vx, vy, vz, packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT), world.simTick);
      extracted++;
    }
  }

  if (extracted > 0) {
    const newLiters = chamber.liters + extracted;
    chamber.mat = chosenMat;
    chamber.liters = newLiters;
    chamber.tempByte = Math.round(totalTemp / newLiters);
    chamber.chargeUnits = maxCharge;
    suit.siphonActive = true;
    suit.siphonMat = chosenMat;
    suit.siphonLitersThisTick = extracted;
  }
}

/**
 * Step 1b: Tank chamber electrical charge decay (-2 units/tick, §3.1).
 */
function stepTankChargeDecay(world: WorldState): void {
  const count = world.playerTank.baffled ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const c = world.playerTank.chambers[i];
    if (c.chargeUnits > 0) {
      c.chargeUnits = Math.max(0, c.chargeUnits - 2);
    }
  }
}

function buildPerpBasis(ax: number, ay: number, az: number): [number, number, number, number, number, number] {
  // Deterministic orthonormal basis (right, up) perpendicular to aimDir (no sin/cos)
  let rx = -az;
  let ry = 0;
  let rz = ax;
  let rLen = Math.sqrt(rx * rx + rz * rz);
  if (rLen < 1e-4) {
    rx = 1;
    ry = 0;
    rz = 0;
    rLen = 1;
  } else {
    rx /= rLen;
    rz /= rLen;
  }
  // up = aim x right
  const ux = ay * rz - az * ry;
  const uy = az * rx - ax * rz;
  const uz = ax * ry - ay * rx;
  return [rx, ry, rz, ux, uy, uz];
}

const CLUSTER_OFFSETS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Step 1c: Loaded Nozzle tap (15 L 5+5+5 @ ticks 0/4/8, 18 m/s) & hold (60 L/s @ 15 m/s) (§8.1).
 */
function stepLoadedNozzle(world: WorldState, input: InputFrame): void {
  const suit = world.suit;
  const room = world.room;
  const p = world.player;
  const chamber = getActiveChamber(world.playerTank);

  if (suit.nozzleTapCdTicks > 0) suit.nozzleTapCdTicks--;
  if (!input.primaryHeld) suit.nozzleHoseActive = false;

  const risingEdge = input.primaryHeld && !suit.prevPrimaryHeld;

  if (
    risingEdge &&
    suit.nozzleTapCdTicks === 0 &&
    suit.nozzleTapBurstShotsLeft === 0 &&
    chamber.liters > 0 &&
    !chamber.lockedSpill
  ) {
    suit.nozzleTapBurstShotsLeft = NOZZLE_TAP_SHOTS;
    suit.nozzleTapSpacingTicks = 0;
    suit.nozzleTapWaitTicks = 0;
    suit.nozzleTapCdTicks = NOZZLE_TAP_CD_TICKS;
    suit.nozzleHoseActive = false;
  } else if (
    input.primaryHeld &&
    suit.prevPrimaryHeld &&
    suit.nozzleTapCdTicks === 0 &&
    suit.nozzleTapBurstShotsLeft === 0
  ) {
    suit.nozzleHoseActive = true;
  }

  const oxM = p.x;
  const oyM = p.y + PLAYER_TORSO_OFFSET_M;
  const ozM = p.z;
  const ax = suit.aimDirX;
  const ay = suit.aimDirY;
  const az = suit.aimDirZ;
  const speedMult = nozzlePressureMult(world.nozzlePressureRank);

  // Active tap burst (ticks 0, 4, 8)
  if (suit.nozzleTapBurstShotsLeft > 0) {
    if (suit.nozzleTapSpacingTicks > 0) {
      suit.nozzleTapSpacingTicks--;
    }

    if (suit.nozzleTapSpacingTicks === 0) {
      if (chamber.liters <= 0 || chamber.lockedSpill) {
        suit.nozzleTapBurstShotsLeft = 0;
        suit.nozzleTapWaitTicks = 0;
      } else {
        const wanted = Math.min(NOZZLE_TAP_SHOT_L, chamber.liters);
        const freeSlots = MAX_ACTIVE_BALLISTIC - room.ballistic.count;
        if (freeSlots < wanted) {
          // Pool-full guarantee: wait up to 0.25 s without decrementing tank
          suit.nozzleTapWaitTicks++;
          if (suit.nozzleTapWaitTicks >= NOZZLE_TAP_WAIT_TICKS) {
            suit.nozzleTapBurstShotsLeft = 0;
            suit.nozzleTapWaitTicks = 0;
          }
        } else {
          const [mx, my, mz] = resolveSafeSpawnPoint(
            room,
            oxM,
            oyM,
            ozM,
            oxM + ax * 0.45,
            oyM + ay * 0.45,
            ozM + az * 0.45,
          );
          const [rx, ry, rz, ux, uy, uz] = buildPerpBasis(ax, ay, az);
          const speed = NOZZLE_TAP_SPEED_M_S * speedMult;
          const rOff = NOZZLE_CLUSTER_RADIUS_M * 0.7;

          let spawned = 0;
          for (let k = 0; k < wanted; k++) {
            const [ou, ov] = CLUSTER_OFFSETS[k];
            const candX = mx + (rx * ou + ux * ov) * rOff;
            const candY = my + (ry * ou + uy * ov) * rOff;
            const candZ = mz + (rz * ou + uz * ov) * rOff;
            const cvx = Math.floor(candX / VOXEL_SIZE_M);
            const cvy = Math.floor(candY / VOXEL_SIZE_M);
            const cvz = Math.floor(candZ / VOXEL_SIZE_M);
            const blocked =
              !inRoomBounds(room, cvx, cvy, cvz) ||
              isSolidMat(getMat(room.grid[cellIndex(cvx, cvy, cvz)]));
            const [sx, sy, sz] = clampToRoomInterior(
              room,
              blocked ? mx : candX,
              blocked ? my : candY,
              blocked ? mz : candZ,
            );
            const shimmer = hash32(room.roomSeed, world.simTick, k * 31 + 7) & 7;
            const packed = packVoxel(chamber.mat, chamber.tempByte, chamber.chargeUnits, 0, shimmer, 0, 0);
            const slot = spawnBallistic(
              room,
              sx,
              sy,
              sz,
              ax * speed,
              ay * speed,
              az * speed,
              packed,
              BALLISTIC_FLAG.FIRED_BY_PLAYER,
            );
            if (slot !== -1) spawned++;
          }

          if (spawned > 0) {
            chamber.liters -= spawned;
            emptyChamberIfZero(chamber);
            if (room.gravityMode === GRAVITY_MODE.G0) {
              const recoil = NOZZLE_TAP_RECOIL_0G * (spawned / NOZZLE_TAP_BURST_L);
              p.vx -= ax * recoil;
              p.vy -= ay * recoil;
              p.vz -= az * recoil;
            }
          }

          suit.nozzleTapBurstShotsLeft--;
          suit.nozzleTapWaitTicks = 0;
          if (suit.nozzleTapBurstShotsLeft > 0) {
            suit.nozzleTapSpacingTicks = NOZZLE_TAP_SPACING_TICKS;
          }
        }
      }
    }
  } else if (suit.nozzleHoseActive && chamber.liters > 0 && !chamber.lockedSpill) {
    // Loaded hold hose: 60 L/s (1 L/tick) @ 15 m/s; pauses cleanly if ballistic pool is full
    if (room.ballistic.count < MAX_ACTIVE_BALLISTIC) {
      const [mx, my, mz] = resolveSafeSpawnPoint(
        room,
        oxM,
        oyM,
        ozM,
        oxM + ax * 0.45,
        oyM + ay * 0.45,
        ozM + az * 0.45,
      );
      const [sx, sy, sz] = clampToRoomInterior(room, mx, my, mz);
      const speed = NOZZLE_HOLD_SPEED_M_S * speedMult;
      const shimmer = hash32(room.roomSeed, world.simTick, 911) & 7;
      const packed = packVoxel(chamber.mat, chamber.tempByte, chamber.chargeUnits, 0, shimmer, 0, 0);
      const slot = spawnBallistic(
        room,
        sx,
        sy,
        sz,
        ax * speed,
        ay * speed,
        az * speed,
        packed,
        BALLISTIC_FLAG.FIRED_BY_PLAYER,
      );
      if (slot !== -1) {
        chamber.liters -= 1;
        emptyChamberIfZero(chamber);
        if (room.gravityMode === GRAVITY_MODE.G0) {
          p.vx -= ax * NOZZLE_HOLD_RECOIL_0G;
          p.vy -= ay * NOZZLE_HOLD_RECOIL_0G;
          p.vz -= az * NOZZLE_HOLD_RECOIL_0G;
        }
      }
    }
  }

  suit.prevPrimaryHeld = input.primaryHeld;
}

/**
 * Step 1d: Plumbed Jetpack Dash (14 m/s, 24 ticks / 0.4 s, 1 L/tick boot exhaust, 1.2 s CD) (§8.1).
 */
function stepJetpackDash(world: WorldState, input: InputFrame): void {
  const suit = world.suit;
  const room = world.room;
  const p = world.player;
  const mode = room.gravityMode;

  if (suit.dashCdTicks > 0) suit.dashCdTicks--;

  if (input.pressDash && p.dashTimer === 0 && suit.dashCdTicks === 0) {
    let dx = 0;
    let dy = 0;
    let dz = 0;

    if (mode === GRAVITY_MODE.G0) {
      dx = suit.aimDirX;
      dy = suit.aimDirY;
      dz = suit.aimDirZ;
    } else {
      const mLen = Math.sqrt(input.moveX * input.moveX + input.moveZ * input.moveZ);
      if (mLen > 1e-4) {
        dx = input.moveX / mLen;
        dz = input.moveZ / mLen;
      } else {
        // Horizontal aim fallback when no WASD key is held (§8.1)
        const hLen = Math.sqrt(suit.aimDirX * suit.aimDirX + suit.aimDirZ * suit.aimDirZ);
        if (hLen > 1e-4) {
          dx = suit.aimDirX / hLen;
          dz = suit.aimDirZ / hLen;
        } else {
          dx = 0;
          dz = 1;
        }
      }
    }

    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dLen > 1e-4) {
      suit.dashDirX = dx / dLen;
      suit.dashDirY = dy / dLen;
      suit.dashDirZ = dz / dLen;
    } else {
      suit.dashDirX = 0;
      suit.dashDirY = 0;
      suit.dashDirZ = 1;
    }

    p.dashTimer = DASH_DURATION_TICKS;
    p.dashGraceTimer = 0;
    suit.dashCdTicks = DASH_CD_TICKS;
  }

  if (p.dashTimer > 0) {
    // Plumbed exhaust: 1 L/tick from active chamber behind boots (pool-full safe)
    const chamber = getActiveChamber(world.playerTank);
    if (chamber.liters > 0 && !chamber.lockedSpill && room.ballistic.count < MAX_ACTIVE_BALLISTIC) {
      const feetY = getFeetY(p);
      const originY = feetY + 0.15 * p.upSign;
      const [ex, ey, ez] = resolveSafeSpawnPoint(
        room,
        p.x,
        originY,
        p.z,
        p.x - suit.dashDirX * 0.38,
        originY - suit.dashDirY * 0.38,
        p.z - suit.dashDirZ * 0.38,
      );
      const [sx, sy, sz] = clampToRoomInterior(room, ex, ey, ez);
      const shimmer = hash32(room.roomSeed, world.simTick, 4099) & 7;
      const packed = packVoxel(chamber.mat, chamber.tempByte, chamber.chargeUnits, 0, shimmer, 0, 0);
      const slot = spawnBallistic(
        room,
        sx,
        sy,
        sz,
        -suit.dashDirX * DASH_EXHAUST_SPEED_M_S,
        -suit.dashDirY * DASH_EXHAUST_SPEED_M_S,
        -suit.dashDirZ * DASH_EXHAUST_SPEED_M_S,
        packed,
        BALLISTIC_FLAG.FIRED_BY_PLAYER,
      );
      if (slot !== -1) {
        chamber.liters -= 1;
        emptyChamberIfZero(chamber);
      }
    }
  }
}

/**
 * Normalizes quantized aim direction and runs Stage 1 suit actions in canonical order (§6.1):
 * (1) Siphon -> (2) Chamber charge decay -> (3) Nozzle tap/hold -> (4) Jetpack Dash & exhaust.
 */
export function stepSuitActionsStage1(world: WorldState, input: InputFrame): void {
  const suit = world.suit;
  const len = Math.sqrt(
    input.aimX * input.aimX + input.aimY * input.aimY + input.aimZ * input.aimZ,
  );
  if (len > 1e-4) {
    suit.aimDirX = input.aimX / len;
    suit.aimDirY = input.aimY / len;
    suit.aimDirZ = input.aimZ / len;
  }

  stepAtomicSiphon(world, input);
  stepTankChargeDecay(world);
  stepLoadedNozzle(world, input);
  stepJetpackDash(world, input);
}

export function applyDashVelocityIfActive(world: WorldState): boolean {
  const p = world.player;
  if (p.dashTimer <= 0) return false;
  const suit = world.suit;
  p.vx = suit.dashDirX * DASH_SPEED_M_S;
  p.vz = suit.dashDirZ * DASH_SPEED_M_S;
  if (world.room.gravityMode === GRAVITY_MODE.G0) {
    p.vy = suit.dashDirY * DASH_SPEED_M_S;
  } else {
    p.vy = 0;
  }
  return true;
}
