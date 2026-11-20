import {
  DASH_GRACE_TICKS,
  FIXED_DT,
  GRAVITY_ACCEL_BY_MODE,
  GRAVITY_MODE,
  IMPACT_IFRAMES_TICKS,
  MAT,
  PLAYER_SPEED_0G_HORIZ,
  PLAYER_SPEED_0G_VERT,
  PLAYER_SPEED_1G,
  PLAYER_SPEED_2G,
  PLAYER_SPEED_3G,
  PLAYER_SPEED_N1G,
  TEMP_BYTE,
  VOXEL_SIZE_M,
  WALL_SPLAT_BASE_CAP,
  WALL_SPLAT_COEFF,
  WALL_SPLAT_EMBRITTLED_CAP,
  WALL_SPLAT_V_MIN,
  type GravityMode,
} from './balance.ts';
import {
  applyStructuralDamage,
  cellIndex,
  getMat,
  getTempByte,
  inRoomBounds,
  isSolidMat,
  type RoomState,
} from './types.ts';
import {
  processPendingVatShatters,
  reseedActiveLists,
  stepBallisticsStage3,
  stepFluidMovementStage4,
  stepFluidStage8,
  stepMinimalCryoWarming,
} from './fluids.ts';
import { applyDashVelocityIfActive, stepSuitActionsStage1 } from './suit.ts';
import {
  getEffectiveMassKg,
  getFeetY,
  getPlumbDir,
  stepSuitGravityState,
  type Entity,
  type InputFrame,
  type WorldState,
} from './world.ts';

const EPS = 1e-4;
const IMPULSE_TIMER_TICKS = 36; // 0.6 s (§8.2)
const STEP_HEIGHTS_M = [0.1, 0.2] as const;

export interface PlumbLineResult {
  visible: boolean;
  originX: number;
  originY: number;
  originZ: number;
  hitY: number;
  distanceM: number;
  plumbDir: -1 | 1;
}

function getPlayerMoveSpeed(mode: GravityMode): number {
  switch (mode) {
    case GRAVITY_MODE.G1:
      return PLAYER_SPEED_1G;
    case GRAVITY_MODE.G2:
      return PLAYER_SPEED_2G;
    case GRAVITY_MODE.G3:
      return PLAYER_SPEED_3G;
    case GRAVITY_MODE.GN1:
      return PLAYER_SPEED_N1G;
    case GRAVITY_MODE.G0:
      return PLAYER_SPEED_0G_HORIZ;
  }
}

interface OverlapBounds {
  hit: boolean;
  minVX: number;
  maxVX: number;
  minVY: number;
  maxVY: number;
  minVZ: number;
  maxVZ: number;
}

function querySolidOverlap(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  halfW: number,
  height: number,
  halfD: number,
): OverlapBounds {
  const vx0 = Math.floor((x - halfW + EPS) / VOXEL_SIZE_M);
  const vx1 = Math.floor((x + halfW - EPS) / VOXEL_SIZE_M);
  const vy0 = Math.floor((y + EPS) / VOXEL_SIZE_M);
  const vy1 = Math.floor((y + height - EPS) / VOXEL_SIZE_M);
  const vz0 = Math.floor((z - halfD + EPS) / VOXEL_SIZE_M);
  const vz1 = Math.floor((z + halfD - EPS) / VOXEL_SIZE_M);

  let hit = false;
  let minVX = 1e9;
  let maxVX = -1e9;
  let minVY = 1e9;
  let maxVY = -1e9;
  let minVZ = 1e9;
  let maxVZ = -1e9;

  for (let vy = vy0; vy <= vy1; vy++) {
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        const solid =
          !inRoomBounds(room, vx, vy, vz) || isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]));
        if (solid) {
          hit = true;
          if (vx < minVX) minVX = vx;
          if (vx > maxVX) maxVX = vx;
          if (vy < minVY) minVY = vy;
          if (vy > maxVY) maxVY = vy;
          if (vz < minVZ) minVZ = vz;
          if (vz > maxVZ) maxVZ = vz;
        }
      }
    }
  }

  return { hit, minVX, maxVX, minVY, maxVY, minVZ, maxVZ };
}

export function aabbOverlapsSolid(
  room: RoomState,
  x: number,
  y: number,
  z: number,
  halfW: number,
  height: number,
  halfD: number,
): boolean {
  const vx0 = Math.floor((x - halfW + EPS) / VOXEL_SIZE_M);
  const vx1 = Math.floor((x + halfW - EPS) / VOXEL_SIZE_M);
  const vy0 = Math.floor((y + EPS) / VOXEL_SIZE_M);
  const vy1 = Math.floor((y + height - EPS) / VOXEL_SIZE_M);
  const vz0 = Math.floor((z - halfD + EPS) / VOXEL_SIZE_M);
  const vz1 = Math.floor((z + halfD - EPS) / VOXEL_SIZE_M);

  for (let vy = vy0; vy <= vy1; vy++) {
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        if (
          !inRoomBounds(room, vx, vy, vz) ||
          isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function applyWallImpactToSolidFace(
  room: RoomState,
  minVX: number,
  maxVX: number,
  minVY: number,
  maxVY: number,
  minVZ: number,
  maxVZ: number,
): void {
  for (let vy = minVY; vy <= maxVY; vy++) {
    for (let vz = minVZ; vz <= maxVZ; vz++) {
      for (let vx = minVX; vx <= maxVX; vx++) {
        if (!inRoomBounds(room, vx, vy, vz)) continue;
        const val = room.grid[cellIndex(vx, vy, vz)];
        const mat = getMat(val);
        let baseDmg = 0;
        if (mat === MAT.WOOD_BARRIER) baseDmg = 6;
        else if (mat === MAT.GLASS_VAT || mat === MAT.ICE) baseDmg = 4;
        if (baseDmg === 0) continue;
        const mult = getTempByte(val) <= TEMP_BYTE.EMBRITTLED ? 3 : 1;
        applyStructuralDamage(room, vx, vy, vz, baseDmg * mult, true);
      }
    }
  }
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

function resolveSolidImpact(
  world: WorldState,
  entity: Entity,
  impactSpeed: number,
  bounds: OverlapBounds,
): void {
  if (impactSpeed <= WALL_SPLAT_V_MIN) return;

  const isPlayer = entity.kind === 'player';
  const dashImmune = isPlayer && (entity.dashTimer > 0 || entity.dashGraceTimer > 0);
  const pulseExempt = isPlayer && world.gravityPulse.ownPulseExempt;

  if (isPlayer) {
    world.impactTelemetry.lastImpactSpeed = impactSpeed;
    world.impactTelemetry.lastImpactTick = world.simTick;
    world.impactTelemetry.lastImpactExempt = pulseExempt || dashImmune || entity.impulseTimer <= 0;
    world.impactTelemetry.lastWallSplatDmg = 0;
  }

  if (entity.impulseTimer <= 0) return;

  applyWallImpactToSolidFace(
    world.room,
    bounds.minVX,
    bounds.maxVX,
    bounds.minVY,
    bounds.maxVY,
    bounds.minVZ,
    bounds.maxVZ,
  );

  if (dashImmune || entity.impactIFrames > 0) return;

  const massKg = getEffectiveMassKg(entity, world.playerTank);
  const dmg = computeWallSplatDamage(massKg, impactSpeed, entity.tempByte);
  if (dmg > 0) {
    entity.hp = Math.max(0, entity.hp - dmg);
    entity.impactIFrames = IMPACT_IFRAMES_TICKS;
    if (isPlayer) {
      world.impactTelemetry.lastWallSplatDmg = dmg;
    }
  }
}

export function integrateEntityVoxelPhysics(
  world: WorldState,
  entity: Entity,
): void {
  const room = world.room;
  const mode = room.gravityMode;
  const gAccel = GRAVITY_ACCEL_BY_MODE[mode];
  const wasDashing = entity.dashTimer > 0;

  if (entity.impactIFrames > 0) entity.impactIFrames--;
  if (entity.impulseTimer > 0) entity.impulseTimer--;

  // Apply gravity acceleration (suspended during active Jetpack Dash so horizontal dashes cross gaps cleanly)
  if (mode !== GRAVITY_MODE.G0 && !wasDashing) {
    entity.vy += gAccel * FIXED_DT;
  }

  const isPlayerExempt = entity.kind === 'player' && world.gravityPulse.ownPulseExempt;
  if (Math.abs(entity.vy) > WALL_SPLAT_V_MIN && !isPlayerExempt) {
    entity.impulseTimer = IMPULSE_TIMER_TICKS;
  }

  // 1. Horizontal X with stair step-up
  const dx = entity.vx * FIXED_DT;
  if (dx !== 0) {
    const nextX = entity.x + dx;
    const ov = querySolidOverlap(
      room,
      nextX,
      entity.y,
      entity.z,
      entity.halfW,
      entity.height,
      entity.halfD,
    );
    if (!ov.hit) {
      entity.x = nextX;
    } else {
      let stepped = false;
      if (entity.grounded && mode !== GRAVITY_MODE.G0) {
        for (let s = 0; s < STEP_HEIGHTS_M.length; s++) {
          const stepY = entity.y + STEP_HEIGHTS_M[s] * entity.upSign;
          if (
            !aabbOverlapsSolid(room, entity.x, stepY, entity.z, entity.halfW, entity.height, entity.halfD) &&
            !aabbOverlapsSolid(room, nextX, stepY, entity.z, entity.halfW, entity.height, entity.halfD)
          ) {
            entity.x = nextX;
            entity.y = stepY;
            stepped = true;
            break;
          }
        }
      }
      if (!stepped) {
        const impactSpeed = Math.abs(entity.vx);
        if (dx > 0) {
          entity.x = ov.minVX * VOXEL_SIZE_M - entity.halfW;
        } else {
          entity.x = (ov.maxVX + 1) * VOXEL_SIZE_M + entity.halfW;
        }
        resolveSolidImpact(world, entity, impactSpeed, ov);
        entity.vx = 0;
      }
    }
  }

  // 2. Horizontal Z with stair step-up
  const dz = entity.vz * FIXED_DT;
  if (dz !== 0) {
    const nextZ = entity.z + dz;
    const ov = querySolidOverlap(
      room,
      entity.x,
      entity.y,
      nextZ,
      entity.halfW,
      entity.height,
      entity.halfD,
    );
    if (!ov.hit) {
      entity.z = nextZ;
    } else {
      let stepped = false;
      if (entity.grounded && mode !== GRAVITY_MODE.G0) {
        for (let s = 0; s < STEP_HEIGHTS_M.length; s++) {
          const stepY = entity.y + STEP_HEIGHTS_M[s] * entity.upSign;
          if (
            !aabbOverlapsSolid(room, entity.x, stepY, entity.z, entity.halfW, entity.height, entity.halfD) &&
            !aabbOverlapsSolid(room, entity.x, stepY, nextZ, entity.halfW, entity.height, entity.halfD)
          ) {
            entity.z = nextZ;
            entity.y = stepY;
            stepped = true;
            break;
          }
        }
      }
      if (!stepped) {
        const impactSpeed = Math.abs(entity.vz);
        if (dz > 0) {
          entity.z = ov.minVZ * VOXEL_SIZE_M - entity.halfD;
        } else {
          entity.z = (ov.maxVZ + 1) * VOXEL_SIZE_M + entity.halfD;
        }
        resolveSolidImpact(world, entity, impactSpeed, ov);
        entity.vz = 0;
      }
    }
  }

  // 3. Vertical Y sweep & ground detection
  const dy = entity.vy * FIXED_DT;
  let landedOnSupport = false;
  if (dy !== 0) {
    const nextY = entity.y + dy;
    const ov = querySolidOverlap(
      room,
      entity.x,
      nextY,
      entity.z,
      entity.halfW,
      entity.height,
      entity.halfD,
    );
    if (!ov.hit) {
      entity.y = nextY;
    } else {
      const impactSpeed = Math.abs(entity.vy);
      if (dy < 0) {
        entity.y = (ov.maxVY + 1) * VOXEL_SIZE_M;
        if (entity.upSign === 1) landedOnSupport = true;
      } else {
        entity.y = ov.minVY * VOXEL_SIZE_M - entity.height;
        if (entity.upSign === -1) landedOnSupport = true;
      }
      resolveSolidImpact(world, entity, impactSpeed, ov);
      entity.vy = 0;
    }
  }

  // Tick dash duration -> start 0.15 s post-dash wall-splat grace when dash ends (§8.1)
  if (wasDashing) {
    entity.dashTimer--;
    if (entity.dashTimer === 0) {
      entity.dashGraceTimer = DASH_GRACE_TICKS;
    }
  } else if (entity.dashGraceTimer > 0) {
    entity.dashGraceTimer--;
  }

  // Ground probe in supporting direction (-upSign) when not in 0G
  if (mode === GRAVITY_MODE.G0) {
    entity.grounded = false;
  } else if (landedOnSupport) {
    entity.grounded = true;
  } else {
    const movingAway = entity.vy * entity.upSign > 0.01;
    if (movingAway) {
      entity.grounded = false;
    } else {
      const probeY = entity.y - 0.02 * entity.upSign;
      entity.grounded = aabbOverlapsSolid(
        room,
        entity.x,
        probeY,
        entity.z,
        entity.halfW,
        entity.height,
        entity.halfD,
      );
    }
  }

  if (
    entity.kind === 'player' &&
    entity.grounded &&
    world.gravityPulse.ownPulseExempt &&
    world.gravityPulse.activePulse === 'none'
  ) {
    world.gravityPulse.ownPulseExempt = false;
    world.gravityPulse.ownPulseGraceTicks = 0;
  }
}

export function stepWorldTick(world: WorldState, input: InputFrame): void {
  world.simTick++;

  // Stage 1: Gravity pulse state machine + atomic Siphon, charge decay, Nozzle, Jetpack Dash
  stepSuitGravityState(world, input);
  stepSuitActionsStage1(world, input);

  const player = world.player;
  const mode = world.room.gravityMode;

  if (!applyDashVelocityIfActive(world)) {
    const speed = getPlayerMoveSpeed(mode);
    let ix = input.moveX;
    let iz = input.moveZ;
    const ilen = Math.sqrt(ix * ix + iz * iz);
    if (ilen > 1e-6) {
      ix /= ilen;
      iz /= ilen;
    } else {
      ix = 0;
      iz = 0;
    }

    if (mode === GRAVITY_MODE.G0) {
      const accel = 18.0 * FIXED_DT;
      const targetVx = ix * speed;
      const targetVz = iz * speed;
      player.vx += Math.max(-accel, Math.min(accel, targetVx - player.vx));
      player.vz += Math.max(-accel, Math.min(accel, targetVz - player.vz));

      let vertDir = 0;
      if (input.ascend) vertDir += 1;
      if (input.descend) vertDir -= 1;
      let targetVy = vertDir * PLAYER_SPEED_0G_VERT;

      if (targetVy !== 0) {
        const probeDist = 0.12;
        const probeY = targetVy > 0 ? player.y + probeDist : player.y - probeDist;
        if (
          aabbOverlapsSolid(
            world.room,
            player.x,
            probeY,
            player.z,
            player.halfW,
            player.height,
            player.halfD,
          )
        ) {
          targetVy *= 0.25;
        }
      }
      const vAccel = 16.0 * FIXED_DT;
      player.vy += Math.max(-vAccel, Math.min(vAccel, targetVy - player.vy));
    } else {
      const blend = player.grounded ? 0.45 : 0.18;
      player.vx += (ix * speed - player.vx) * blend;
      player.vz += (iz * speed - player.vz) * blend;
    }
  }

  // Stage 2: Entity Kinematics & Swept AABB Voxel Collisions
  integrateEntityVoxelPhysics(world, player);

  // Process vat shatters & gravity-shift reseed
  processPendingVatShatters(world);
  if (world.gravityChangedThisTick) {
    reseedActiveLists(world.room, world.simTick);
    world.gravityChangedThisTick = false;
  }

  // Stage 3: Ballistic Quanta Integration & Swept 3D DDA
  stepBallisticsStage3(world);

  // Stage 4: 60 Hz Fluid & Gas Movement CA
  stepFluidMovementStage4(world);

  // M2.1 minimal CRYO finite floor/0G warming
  stepMinimalCryoWarming(world);

  // Stage 8: Deferred retries, overflow scanners & bit-22 cleanup
  stepFluidStage8(world);
}

export function computePlumbLine(room: RoomState, entity: Entity): PlumbLineResult {
  const plumbDir = getPlumbDir(room.gravityMode);
  const feetY = getFeetY(entity);
  const vx = Math.floor(entity.x / VOXEL_SIZE_M);
  const vz = Math.floor(entity.z / VOXEL_SIZE_M);

  if (vx < 0 || vx >= room.roomW || vz < 0 || vz >= room.roomD) {
    return {
      visible: false,
      originX: entity.x,
      originY: feetY,
      originZ: entity.z,
      hitY: feetY,
      distanceM: 0,
      plumbDir,
    };
  }

  if (plumbDir === -1) {
    const startVY = Math.min(room.roomH - 1, Math.floor((feetY - EPS) / VOXEL_SIZE_M));
    for (let vy = startVY; vy >= 0; vy--) {
      if (isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]))) {
        const hitY = (vy + 1) * VOXEL_SIZE_M;
        const dist = Math.max(0, feetY - hitY);
        return {
          visible: dist > 0.2,
          originX: entity.x,
          originY: feetY,
          originZ: entity.z,
          hitY,
          distanceM: dist,
          plumbDir,
        };
      }
    }
  } else {
    const startVY = Math.max(0, Math.floor((feetY + EPS) / VOXEL_SIZE_M));
    for (let vy = startVY; vy < room.roomH; vy++) {
      if (isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]))) {
        const hitY = vy * VOXEL_SIZE_M;
        const dist = Math.max(0, hitY - feetY);
        return {
          visible: dist > 0.2,
          originX: entity.x,
          originY: feetY,
          originZ: entity.z,
          hitY,
          distanceM: dist,
          plumbDir,
        };
      }
    }
  }

  return {
    visible: false,
    originX: entity.x,
    originY: feetY,
    originZ: entity.z,
    hitY: feetY,
    distanceM: 0,
    plumbDir,
  };
}
