import {
  AIR_BURST_CD_TICKS,
  AIR_BURST_CONE_COS_SQ,
  AIR_BURST_DELTAV_MAX,
  AIR_BURST_DELTAV_MIN,
  AIR_BURST_DMG,
  AIR_BURST_IMPULSE_NOM,
  AIR_BURST_RANGE_M,
  AIR_BURST_RECOIL_0G,
  AIR_BURST_TIER1_DMG,
  AIR_BURST_TIER2_DMG,
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  ENTITY_RESTITUTION,
  FIXED_DT,
  GRAVITY_ACCEL_BY_MODE,
  GRAVITY_MODE,
  IMPACT_IFRAMES_TICKS,
  LOCKON_CURSOR_SNAP_M,
  LOCKON_RANGE_M,
  NOZZLE_HOLD_SPEED_M_S,
  NOZZLE_TAP_SPEED_M_S,
  MAT,
  MATERIAL_SPEC,
  PLAYER_TORSO_OFFSET_M,
  SCRAP_DROPS,
  SLICE_STRIDE,
  TEMP_BYTE,
  TOTAL_CHUNKS,
  VOXEL_SIZE_M,
  WALL_SPLAT_BASE_CAP,
  WALL_SPLAT_COEFF,
  WALL_SPLAT_EMBRITTLED_CAP,
  WALL_SPLAT_V_MIN,
  nozzlePressureMult,
} from './balance.ts';
import { hash32 } from './hash.ts';
import {
  applyStructuralDamage,
  cellIndex,
  getMat,
  getTempByte,
  inRoomBounds,
  isFluidOrGasMat,
  type RoomState,
  type VatRecord,
} from './types.ts';
import {
  getActiveChamber,
  getEffectiveMassKg,
  type Entity,
  type InputFrame,
  type LockOnTarget,
  type WorldState,
} from './world.ts';

const IMPULSE_TIMER_TICKS = 36; // 0.6 s (§8.2)
const AIR_BURST_TAN_25 = 0.4663076581549986; // tan(25 deg), deterministic constant
const AIR_BURST_RAY_STEP = AIR_BURST_TAN_25 * 0.7071067811865475 * 0.5;
const airBurstHitIndices = new Int32Array(25);

/**
 * Computes a deterministic normalized aim direction from (ox,oy,oz) to (tx,ty,tz).
 * When speed > 0 and gravity is non-zero, solves the low-angle ballistic pitch so fluid
 * lands directly on the targeted voxel (clamping to a clean max-range lob if out of reach).
 */
export function computeBallisticAimDir(
  ox: number,
  oy: number,
  oz: number,
  tx: number,
  ty: number,
  tz: number,
  speed: number,
  gravityAccel: number,
): [number, number, number] {
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const horiz = Math.hypot(dx, dz);
  const dist = Math.hypot(horiz, dy);
  if (dist < 1e-4) return [0, 0, 1];

  if (speed <= 0 || Math.abs(gravityAccel) < 1e-4 || horiz < 0.08) {
    return [dx / dist, dy / dist, dz / dist];
  }

  const gSign = gravityAccel < 0 ? 1 : -1;
  const g = Math.abs(gravityAccel);
  const dyEff = dy * gSign;
  const v2 = speed * speed;
  const v4 = v2 * v2;
  const disc = v4 - g * (g * horiz * horiz + 2 * dyEff * v2);
  let tanTheta = disc >= 0 ? (v2 - Math.sqrt(disc)) / (g * horiz) : 0.36;
  if (tanTheta < -1.4) tanTheta = -1.4;
  else if (tanTheta > 0.72) tanTheta = 0.72;

  const ux = dx / horiz;
  const uz = dz / horiz;
  const uy = tanTheta * gSign;
  const invLen = 1 / Math.sqrt(1 + uy * uy);
  return [ux * invLen, uy * invLen, uz * invLen];
}

export function computeWallSplatDamage(
  effectiveMassKg: number,
  normalImpactSpeed: number,
  targetTempByte: number,
): number {
  if (normalImpactSpeed <= WALL_SPLAT_V_MIN) return 0;
  const excess = normalImpactSpeed - WALL_SPLAT_V_MIN;
  const base = Math.min(WALL_SPLAT_BASE_CAP, WALL_SPLAT_COEFF * effectiveMassKg * excess * excess);
  const embrittled = targetTempByte <= TEMP_BYTE.EMBRITTLED;
  const dmg = embrittled ? Math.min(WALL_SPLAT_EMBRITTLED_CAP, base * 3.0) : base;
  return Math.round(dmg);
}

function isLockOnLosBlocker(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.BOUNDARY_HULL ||
    mat === MAT.WOOD_BARRIER ||
    mat === MAT.ICE
  );
}

function isAirBurstLosBlocker(mat: number): boolean {
  return (
    mat === MAT.HULL_STEEL ||
    mat === MAT.BOUNDARY_HULL ||
    mat === MAT.WOOD_BARRIER ||
    mat === MAT.GLASS_VAT ||
    mat === MAT.ICE
  );
}

function checkDdaLos(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  txM: number,
  tyM: number,
  tzM: number,
  blockGlass: boolean,
): boolean {
  const ox = oxM / VOXEL_SIZE_M;
  const oy = oyM / VOXEL_SIZE_M;
  const oz = ozM / VOXEL_SIZE_M;
  const tx = txM / VOXEL_SIZE_M;
  const ty = tyM / VOXEL_SIZE_M;
  const tz = tzM / VOXEL_SIZE_M;

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
  const targetGX = Math.floor(tx);
  const targetGY = Math.floor(ty);
  const targetGZ = Math.floor(tz);

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
  for (let steps = 0; steps < 320 && t < dist - 0.1; steps++) {
    if (gx === targetGX && gy === targetGY && gz === targetGZ) return true;
    if (!inRoomBounds(room, gx, gy, gz)) return false;
    const mat = getMat(room.grid[cellIndex(gx, gy, gz)]);
    if (blockGlass ? isAirBurstLosBlocker(mat) : isLockOnLosBlocker(mat)) return false;

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
  return true;
}

export function hasLockOnLOS(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  txM: number,
  tyM: number,
  tzM: number,
): boolean {
  return checkDdaLos(room, oxM, oyM, ozM, txM, tyM, tzM, false);
}

export function hasAirBurstLOS(
  room: RoomState,
  oxM: number,
  oyM: number,
  ozM: number,
  txM: number,
  tyM: number,
  tzM: number,
): boolean {
  return checkDdaLos(room, oxM, oyM, ozM, txM, tyM, tzM, true);
}

function vatHasGlassRemaining(room: RoomState, vat: VatRecord): boolean {
  const g = room.grid;
  // Check shell faces only (fast O(surface) early-exit on first GLASS_VAT voxel)
  for (let y = vat.minY; y <= vat.maxY; y++) {
    const yOff = y * SLICE_STRIDE;
    const isYFace = y === vat.minY || y === vat.maxY;
    for (let z = vat.minZ; z <= vat.maxZ; z++) {
      const row = yOff + z * ARENA_W;
      const isZFace = z === vat.minZ || z === vat.maxZ;
      if (isYFace || isZFace) {
        for (let x = vat.minX; x <= vat.maxX; x++) {
          if (getMat(g[row + x]) === MAT.GLASS_VAT) return true;
        }
      } else {
        if (getMat(g[row + vat.minX]) === MAT.GLASS_VAT) return true;
        if (getMat(g[row + vat.maxX]) === MAT.GLASS_VAT) return true;
      }
    }
  }
  return false;
}

/**
 * 12.0 m 3D DDA Magnetic Lock-On (§5):
 * Picks target nearest to cursor aim point (ties: nearest to player) among
 * Enemies (Brood Pods), WOOD_CRATEs, intact GLASS_VATs, and 0G >= 20 L fluid clusters.
 */
export function updateMagneticLockOn(world: WorldState, input: InputFrame): void {
  const room = world.room;
  const p = world.player;
  const suit = world.suit;

  const ox = p.x;
  const oy = p.y + PLAYER_TORSO_OFFSET_M;
  const oz = p.z;

  const refX = input.hasAimPoint ? input.aimPointX : ox + suit.aimDirX * 4.0;
  const refY = input.hasAimPoint ? input.aimPointY : oy + suit.aimDirY * 4.0;
  const refZ = input.hasAimPoint ? input.aimPointZ : oz + suit.aimDirZ * 4.0;

  const maxRangeSq = LOCKON_RANGE_M * LOCKON_RANGE_M;
  const maxSnapCursorSq = LOCKON_CURSOR_SNAP_M * LOCKON_CURSOR_SNAP_M;

  let best: LockOnTarget | null = null;
  let bestCursorDistSq = maxSnapCursorSq;
  let bestPlayerDistSq = Infinity;

  const consider = (
    kind: LockOnTarget['kind'],
    id: number,
    tx: number,
    ty: number,
    tz: number,
    radiusM: number,
  ): void => {
    const pdx = tx - ox;
    const pdy = ty - oy;
    const pdz = tz - oz;
    const pDistSq = pdx * pdx + pdy * pdy + pdz * pdz;
    if (pDistSq > maxRangeSq) return;

    // Cursor distance measured primarily on horizontal torso plane + gentle vertical weighting
    const cdx = tx - refX;
    const cdy = (ty - refY) * 0.35;
    const cdz = tz - refZ;
    const cDistSq = cdx * cdx + cdy * cdy + cdz * cdz;
    if (cDistSq > bestCursorDistSq + 1e-4) return;
    if (Math.abs(cDistSq - bestCursorDistSq) <= 1e-4 && pDistSq >= bestPlayerDistSq) return;

    if (!hasLockOnLOS(room, ox, oy, oz, tx, ty, tz)) return;

    bestCursorDistSq = cDistSq;
    bestPlayerDistSq = pDistSq;
    best = { kind, id, x: tx, y: ty, z: tz, radiusM };
  };

  // 1. Living non-husk Aliens (Brood Pods) and Crates
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp <= 0 || e.deathHusk) continue;
    if (e.kind !== 'alien' && e.kind !== 'crate') continue;
    consider(
      e.kind,
      e.id,
      e.x,
      e.y + e.height * 0.5,
      e.z,
      Math.max(e.halfW, e.height * 0.5) + 0.15,
    );
  }

  // 2. Intact GLASS_VATs
  for (let v = 0; v < room.vats.length; v++) {
    const vat = room.vats[v];
    if (!vatHasGlassRemaining(room, vat)) continue;
    consider('vat', vat.id, vat.centerX, vat.centerY, vat.centerZ, 0.95);
  }

  // 3. 0G fluid clusters (>= 20 L in chunk)
  if (room.gravityMode === GRAVITY_MODE.G0) {
    const plane = CHUNKS_X * CHUNKS_Z;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (room.outOfBounds[c] || room.chunkFluidVoxelCount[c] < 20) continue;
      const cy = Math.floor(c / plane);
      const rem = c - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;

      const approxX = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const approxY = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const approxZ = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
      const adx = approxX - ox;
      const ady = approxY - oy;
      const adz = approxZ - oz;
      if (adx * adx + ady * ady + adz * adz > (LOCKON_RANGE_M + 1.6) * (LOCKON_RANGE_M + 1.6)) {
        continue;
      }

      // Compute exact fluid centroid inside chunk
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let cnt = 0;
      const x0 = cx * CHUNK_SIZE;
      const y0 = cy * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      const x1 = Math.min(room.roomW, x0 + CHUNK_SIZE);
      const y1 = Math.min(room.roomH, y0 + CHUNK_SIZE);
      const z1 = Math.min(room.roomD, z0 + CHUNK_SIZE);
      for (let y = y0; y < y1; y++) {
        const yOff = y * SLICE_STRIDE;
        for (let z = z0; z < z1; z++) {
          const row = yOff + z * ARENA_W;
          for (let x = x0; x < x1; x++) {
            if (isFluidOrGasMat(getMat(room.grid[row + x]))) {
              sx += x + 0.5;
              sy += y + 0.5;
              sz += z + 0.5;
              cnt++;
            }
          }
        }
      }
      if (cnt >= 20) {
        consider(
          'fluid0g',
          c,
          (sx / cnt) * VOXEL_SIZE_M,
          (sy / cnt) * VOXEL_SIZE_M,
          (sz / cnt) * VOXEL_SIZE_M,
          0.65,
        );
      }
    }
  }

  world.lockOn = best;

  // Aim Model (§5): when locked, snap aim to target (gravity-compensated when nozzle is loaded)
  if (best !== null) {
    const target: LockOnTarget = best;
    const chamber = getActiveChamber(world.playerTank);
    const loaded = chamber.liters > 0 && chamber.mat !== MAT.AIR;
    const speed = loaded
      ? (suit.nozzleHoseActive ? NOZZLE_HOLD_SPEED_M_S : NOZZLE_TAP_SPEED_M_S) *
        nozzlePressureMult(world.nozzlePressureRank)
      : 0;
    const [ax, ay, az] = computeBallisticAimDir(
      ox,
      oy,
      oz,
      target.x,
      target.y,
      target.z,
      speed,
      GRAVITY_ACCEL_BY_MODE[room.gravityMode],
    );
    suit.aimDirX = ax;
    suit.aimDirY = ay;
    suit.aimDirZ = az;
  }
}

function castAirBurstRayFirstSolid(
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
  for (let steps = 0; steps < 220 && t <= maxDistV; steps++) {
    if (!inRoomBounds(room, gx, gy, gz)) return -1;
    const idx = cellIndex(gx, gy, gz);
    const mat = getMat(room.grid[idx]);
    if (isAirBurstLosBlocker(mat)) return idx;

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
 * Empty-tank Compressed Air Burst (§8.1):
 * 8.0 m, 25 deg cone hitting all LOS-clear entities + 25 deduped structural rays + 0G recoil.
 */
export function fireCompressedAirBurst(world: WorldState): void {
  const room = world.room;
  const p = world.player;
  const suit = world.suit;

  suit.airBurstCdTicks = AIR_BURST_CD_TICKS;
  suit.airBurstFlashTicks = 6;

  const ox = p.x;
  const oy = p.y + PLAYER_TORSO_OFFSET_M;
  const oz = p.z;
  const ax = suit.aimDirX;
  const ay = suit.aimDirY;
  const az = suit.aimDirZ;

  const rangeSq = AIR_BURST_RANGE_M * AIR_BURST_RANGE_M;
  const nomImpulse = AIR_BURST_IMPULSE_NOM * nozzlePressureMult(world.nozzlePressureRank);

  // 1. Hit all valid entities in the 8.0 m, 25 deg cone with unobstructed LOS
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp <= 0 || e.deathHusk) continue;
    const tx = e.x;
    const ty = e.y + e.height * 0.5;
    const tz = e.z;
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > rangeSq) continue;

    if (dSq > 1e-4) {
      const dot = dx * ax + dy * ay + dz * az;
      if (dot <= 0) continue;
      if (dot * dot < dSq * AIR_BURST_CONE_COS_SQ) continue;
    }

    if (!hasAirBurstLOS(room, ox, oy, oz, tx, ty, tz)) continue;

    e.hp = Math.max(0, e.hp - AIR_BURST_DMG);
    const massKg = getEffectiveMassKg(e);
    const dv = Math.max(
      AIR_BURST_DELTAV_MIN,
      Math.min(AIR_BURST_DELTAV_MAX, nomImpulse / Math.max(1, massKg)),
    );

    let dirX = ax;
    let dirY = ay;
    let dirZ = az;
    if (dSq > 1e-4) {
      const invD = 1 / Math.sqrt(dSq);
      dirX = dx * invD;
      dirY = dy * invD;
      dirZ = dz * invD;
    }
    e.vx += dirX * dv;
    e.vy += dirY * dv;
    e.vz += dirZ * dv;
    e.grounded = false;
    e.impulseTimer = IMPULSE_TIMER_TICKS;
  }

  // 2. Deterministic 5x5 (25-ray) cone deduplicated by hit voxel idx
  let rx = -az;
  let ry = 0;
  let rz = ax;
  let rLen = Math.sqrt(rx * rx + rz * rz);
  if (rLen < 1e-4) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rLen;
    rz /= rLen;
  }
  const ux = ay * rz - az * ry;
  const uy = az * rx - ax * rz;
  const uz = ax * ry - ay * rx;

  let hitCount = 0;
  for (let iu = -2; iu <= 2; iu++) {
    const su = iu * AIR_BURST_RAY_STEP;
    for (let iv = -2; iv <= 2; iv++) {
      const sv = iv * AIR_BURST_RAY_STEP;
      const rdx = ax + rx * su + ux * sv;
      const rdy = ay + ry * su + uy * sv;
      const rdz = az + rz * su + uz * sv;
      const invL = 1 / Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      const hitIdx = castAirBurstRayFirstSolid(
        room,
        ox,
        oy,
        oz,
        rdx * invL,
        rdy * invL,
        rdz * invL,
        AIR_BURST_RANGE_M,
      );
      if (hitIdx < 0) continue;

      let dup = false;
      for (let k = 0; k < hitCount; k++) {
        if (airBurstHitIndices[k] === hitIdx) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        airBurstHitIndices[hitCount++] = hitIdx;
      }
    }
  }

  for (let k = 0; k < hitCount; k++) {
    const idx = airBurstHitIndices[k];
    const val = room.grid[idx];
    const mat = getMat(val);
    const tier = MATERIAL_SPEC[mat]?.structTier ?? 0;
    let baseDmg = 0;
    if (tier === 1) baseDmg = AIR_BURST_TIER1_DMG;
    else if (tier === 2) baseDmg = AIR_BURST_TIER2_DMG;
    if (baseDmg === 0) continue;

    const mult = getTempByte(val) <= TEMP_BYTE.EMBRITTLED ? 3 : 1;
    const vy = Math.floor(idx / SLICE_STRIDE);
    const rem = idx - vy * SLICE_STRIDE;
    const vz = Math.floor(rem / ARENA_W);
    const vx = rem - vz * ARENA_W;
    if (mat === MAT.ICE) {
      const h = hash32(room.roomSeed, world.simTick, idx);
      const spd = 7.5 + 3.5 * ((h & 255) / 255);
      const sx = (((h >>> 8) & 255) / 127.5 - 1) * 2.2;
      const sz = (((h >>> 16) & 255) / 127.5 - 1) * 2.2;
      const sy = 2.8 + 2.4 * (((h >>> 24) & 255) / 255);
      const hLen = Math.hypot(ax, az);
      const fx = hLen > 1e-3 ? ax / hLen : 0;
      const fz = hLen > 1e-3 ? az / hLen : 1;
      applyStructuralDamage(
        room,
        vx,
        vy,
        vz,
        baseDmg * mult,
        true,
        world.simTick,
        fx * spd + sx,
        Math.max(sy, ay * spd + 2.4),
        fz * spd + sz,
      );
    } else {
      applyStructuralDamage(room, vx, vy, vz, baseDmg * mult, true, world.simTick);
    }
  }

  // 3. 0G recoil (-2.5 m/s)
  if (room.gravityMode === GRAVITY_MODE.G0) {
    p.vx -= ax * AIR_BURST_RECOIL_0G;
    p.vy -= ay * AIR_BURST_RECOIL_0G;
    p.vz -= az * AIR_BURST_RECOIL_0G;
  }
}

/**
 * Full-AABB water-voxel overlap buoyancy for hollow 60 kg WOOD_CRATEs (§3.1, §8.2).
 */
export function applyCrateBuoyancy(world: WorldState, crate: Entity): void {
  const room = world.room;
  const mode = room.gravityMode;
  if (mode === GRAVITY_MODE.G0) return;

  const vx0 = Math.max(0, Math.floor((crate.x - crate.halfW) / VOXEL_SIZE_M));
  const vx1 = Math.min(room.roomW - 1, Math.floor((crate.x + crate.halfW) / VOXEL_SIZE_M));
  const vy0 = Math.max(0, Math.floor(crate.y / VOXEL_SIZE_M));
  const vy1 = Math.min(room.roomH - 1, Math.floor((crate.y + crate.height) / VOXEL_SIZE_M));
  const vz0 = Math.max(0, Math.floor((crate.z - crate.halfD) / VOXEL_SIZE_M));
  const vz1 = Math.min(room.roomD - 1, Math.floor((crate.z + crate.halfD) / VOXEL_SIZE_M));

  let waterVoxels = 0;
  const g = room.grid;
  for (let vy = vy0; vy <= vy1; vy++) {
    const yOff = vy * SLICE_STRIDE;
    for (let vz = vz0; vz <= vz1; vz++) {
      const row = yOff + vz * ARENA_W;
      for (let vx = vx0; vx <= vx1; vx++) {
        if (getMat(g[row + vx]) === MAT.WATER) waterVoxels++;
      }
    }
  }
  if (waterVoxels === 0) return;

  const gMag = Math.abs(GRAVITY_ACCEL_BY_MODE[mode]);
  const aBuoy = Math.min(2.2 * gMag, (waterVoxels / 1000) * 2.5 * gMag);
  crate.vy += crate.upSign * aBuoy * FIXED_DT;
  crate.vy *= 0.85;
  if (crate.vy > 3.5) crate.vy = 3.5;
  else if (crate.vy < -3.5) crate.vy = -3.5;
}

/**
 * Deterministic entity-entity swept/overlap collision by entity id order (§6.1 Stage 2, §8.2):
 * Positional separation + 1D elastic momentum exchange (e = 0.4) + 100% target / 50% striker Wall-Splat.
 */
export function resolveEntityEntityCollisions(world: WorldState): void {
  const all: Entity[] = [world.player];
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp > 0 && !e.deathHusk) all.push(e);
  }
  all.sort((a, b) => a.id - b.id);

  const n = all.length;
  for (let i = 0; i < n; i++) {
    const a = all[i];
    for (let j = i + 1; j < n; j++) {
      const b = all[j];

      const overlapX = a.halfW + b.halfW - Math.abs(b.x - a.x);
      if (overlapX <= 0) continue;
      const overlapZ = a.halfD + b.halfD - Math.abs(b.z - a.z);
      if (overlapZ <= 0) continue;

      const aCenterY = a.y + a.height * 0.5;
      const bCenterY = b.y + b.height * 0.5;
      const overlapY = (a.height + b.height) * 0.5 - Math.abs(bCenterY - aCenterY);
      if (overlapY <= 0) continue;

      // Minimum-penetration axis normal pointing from A to B
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let pen = overlapX;
      if (overlapX <= overlapY && overlapX <= overlapZ) {
        nx = b.x >= a.x ? 1 : -1;
        pen = overlapX;
      } else if (overlapZ <= overlapY) {
        nz = b.z >= a.z ? 1 : -1;
        pen = overlapZ;
      } else {
        ny = bCenterY >= aCenterY ? 1 : -1;
        pen = overlapY;
      }

      const massA = getEffectiveMassKg(a, world.playerTank);
      const massB = getEffectiveMassKg(b, world.playerTank);
      const invA = 1 / Math.max(1, massA);
      const invB = 1 / Math.max(1, massB);
      const invSum = invA + invB;

      // Positional separation
      const sepA = pen * (invA / invSum);
      const sepB = pen * (invB / invSum);
      a.x -= nx * sepA;
      a.y -= ny * sepA;
      a.z -= nz * sepA;
      b.x += nx * sepB;
      b.y += ny * sepB;
      b.z += nz * sepB;

      // Relative velocity along normal
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const rvz = b.vz - a.vz;
      const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;
      if (velAlongNormal >= 0) continue;

      const closingSpeed = -velAlongNormal;

      // Entity-Entity Wall-Splat (§8.2): striker = higher speed, 100% target / 50% striker recoil
      if (closingSpeed > WALL_SPLAT_V_MIN && (a.impulseTimer > 0 || b.impulseTimer > 0)) {
        const speedASq = a.vx * a.vx + a.vy * a.vy + a.vz * a.vz;
        const speedBSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
        const striker = speedASq >= speedBSq ? a : b;
        const target = striker === a ? b : a;
        const strikerMass = striker === a ? massA : massB;

        const targetDashImmune =
          target.kind === 'player' && (target.dashTimer > 0 || target.dashGraceTimer > 0);
        if (!targetDashImmune && target.impactIFrames === 0) {
          const dmg = computeWallSplatDamage(strikerMass, closingSpeed, target.tempByte);
          if (dmg > 0) {
            target.hp = Math.max(0, target.hp - dmg);
            target.impactIFrames = IMPACT_IFRAMES_TICKS;
          }
        }

        const strikerDashImmune =
          striker.kind === 'player' && (striker.dashTimer > 0 || striker.dashGraceTimer > 0);
        if (!strikerDashImmune && striker.impactIFrames === 0) {
          const recoil = Math.round(
            computeWallSplatDamage(strikerMass, closingSpeed, striker.tempByte) * 0.5,
          );
          if (recoil > 0) {
            striker.hp = Math.max(0, striker.hp - recoil);
            striker.impactIFrames = IMPACT_IFRAMES_TICKS;
          }
        }

        target.impulseTimer = IMPULSE_TIMER_TICKS;
      }

      // 1D elastic momentum exchange (e = 0.4)
      const jImp = (-(1 + ENTITY_RESTITUTION) * velAlongNormal) / invSum;
      a.vx -= jImp * invA * nx;
      a.vy -= jImp * invA * ny;
      a.vz -= jImp * invA * nz;
      b.vx += jImp * invB * nx;
      b.vy += jImp * invB * ny;
      b.vz += jImp * invB * nz;
    }
  }
}

/**
 * End-of-Stage-8 ordered death resolution, Scrap credit & Brood Pod clear check (§6.1, §10.0).
 */
export function resolveStage8DeathsAndClear(world: WorldState): void {
  let write = 0;
  let remainingPods = 0;

  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (e.hp <= 0) {
      if (e.kind === 'alien') {
        world.kills++;
        world.scrap += SCRAP_DROPS.skitterer;
      } else if (e.kind === 'crate' && e.bioCache) {
        world.scrap += SCRAP_DROPS.bioCache;
      }
      if (world.lockOn && (world.lockOn.kind === 'alien' || world.lockOn.kind === 'crate') && world.lockOn.id === e.id) {
        world.lockOn = null;
      }
      continue;
    }
    if (e.kind === 'alien' && !e.deathHusk) {
      remainingPods++;
    }
    world.entities[write++] = e;
  }
  world.entities.length = write;
  world.podsRemaining = remainingPods;

  if (!world.runCleared && world.podsTotal > 0 && remainingPods === 0) {
    world.runCleared = true;
    world.clearTimeS = world.simTick * FIXED_DT;
    world.scrap += SCRAP_DROPS.roomClear;
  }
}
