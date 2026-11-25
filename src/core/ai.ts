import {
  GRAVITY_ACCEL_BY_MODE,
  GRAVITY_MODE,
  MAX_ACTIVE_BALLISTIC,
  PLAYER_TORSO_OFFSET_M,
  STUN_DURATION_TICKS,
  STUN_IMMUNITY_TICKS,
  TEMP_BYTE,
  VOXEL_SIZE_M,
} from './balance.ts';
import { computeBallisticAimDir, hasAirBurstLOS } from './combat.ts';
import { placeOrDeferFluid, spawnBallistic } from './fluids.ts';
import { hash32 } from './hash.ts';
import {
  cellIndex,
  getMat,
  inRoomBounds,
  isSolidMat,
  packVoxel,
  pushCombatEvent,
  type RoomState,
} from './types.ts';
import type { Entity, WorldState } from './world.ts';

const SKITTERER_SPEED_1G = 4.6;
const SKITTERER_LUNGE_SPEED = 11.4;
const SKITTERER_LUNGE_RANGE_M = 3.6;
const SKITTERER_SPIT_RANGE_M = 6.5;

const BRUISER_SPEED_1G = 2.75;
const BRUISER_CHARGE_SPEED = 10.6;
const BRUISER_CHARGE_RANGE_M = 5.4;

const SPITTER_RANGE_M = 13.0;
const FLOATER_SPEED_1G = 3.2;
const FLOATER_SPIT_RANGE_M = 11.5;
const POD_SPIT_RANGE_M = 10.0;

/**
 * Applies Stun Contract (§8.2): 0.75 s stun gated by 2.0 s stunImmunityTicks.
 * Armored Carapace Bruisers resist light staggers unless stunned by an alchemical counter
 * (bypassArmor = true from Electricity, Phase Explosions, or Embrittled Cryo Shatter).
 */
export function applyEntityStun(
  room: RoomState,
  entity: Entity,
  ticks = STUN_DURATION_TICKS,
  wasInterrupt = false,
  bypassArmor = false,
): boolean {
  if (entity.hp <= 0 || entity.deathHusk) return false;
  if (
    entity.carapace === 'armored' &&
    !bypassArmor &&
    entity.tempByte > TEMP_BYTE.EMBRITTLED
  ) {
    return false;
  }
  if (entity.stunImmunityTicks > 0) return false;

  const alreadyStunned = entity.stunTicks > 0;
  entity.stunTicks = Math.max(entity.stunTicks, ticks);
  entity.aiState = 'recover';
  entity.aiTimer = 24;
  entity.aiAttackKind = 'none';
  entity.meleeHitDone = false;

  if (!alreadyStunned || wasInterrupt) {
    pushCombatEvent(room, {
      kind: wasInterrupt ? 'interrupt' : 'stun',
      entityId: entity.id,
      x: entity.x,
      y: entity.y + entity.height + 0.15,
      z: entity.z,
      value: 0,
      colorHex: wasInterrupt ? 0xffe066 : 0x7ef9ff,
      label: wasInterrupt ? 'INTERRUPT!' : 'STUNNED!',
    });
  }
  return true;
}

function isStepBlockedAhead(
  room: RoomState,
  e: Entity,
  dirX: number,
  dirZ: number,
): boolean {
  const probeDist = e.halfW + 0.35;
  const px = e.x + dirX * probeDist;
  const pz = e.z + dirZ * probeDist;
  const vx = Math.floor(px / VOXEL_SIZE_M);
  const vz = Math.floor(pz / VOXEL_SIZE_M);
  const vy = Math.floor((e.y + 0.35) / VOXEL_SIZE_M);
  if (!inRoomBounds(room, vx, vy, vz)) return true;
  return isSolidMat(getMat(room.grid[cellIndex(vx, vy, vz)]));
}

function fireAlienGlandVolley(
  world: WorldState,
  alien: Entity,
  volleyL: number,
  speedM: number,
  highArcBoost = 0,
): void {
  const room = world.room;
  if (alien.glands.length === 0) return;
  const gland = alien.glands[0];
  if (gland.liters <= 0) return;

  const toFire = Math.min(volleyL, gland.liters);
  const p = world.player;
  const ox = alien.x;
  const oy = alien.y + alien.height * 0.72;
  const oz = alien.z;
  const tx = p.x;
  const ty = p.y + PLAYER_TORSO_OFFSET_M * 0.85;
  const tz = p.z;

  let [ax, ay, az] = computeBallisticAimDir(
    ox,
    oy,
    oz,
    tx,
    ty,
    tz,
    speedM,
    GRAVITY_ACCEL_BY_MODE[room.gravityMode],
  );
  if (highArcBoost > 0 && room.gravityMode !== GRAVITY_MODE.G0) {
    ay = Math.min(0.72, ay + highArcBoost);
    const inv = 1 / Math.max(1e-4, Math.hypot(ax, ay, az));
    ax *= inv;
    ay *= inv;
    az *= inv;
  }

  let rx = -az;
  let rz = ax;
  const rLen = Math.hypot(rx, rz);
  if (rLen > 1e-4) {
    rx /= rLen;
    rz /= rLen;
  } else {
    rx = 1;
    rz = 0;
  }

  let fired = 0;
  for (let k = 0; k < toFire; k++) {
    if (room.ballistic.count >= MAX_ACTIVE_BALLISTIC) break;
    const h = hash32(room.roomSeed, world.simTick, alien.id * 97 + k);
    const spread = ((k / Math.max(1, toFire - 1)) - 0.5) * 0.2;
    const jY = (((h & 255) / 255) - 0.5) * 0.08;
    let dx = ax + rx * spread;
    let dy = ay + jY;
    let dz = az + rz * spread;
    const inv = 1 / Math.max(1e-4, Math.hypot(dx, dy, dz));
    dx *= inv;
    dy *= inv;
    dz *= inv;

    const shimmer = (h >>> 8) & 7;
    const packed = packVoxel(gland.mat, gland.tempByte, gland.chargeUnits, 0, shimmer, 0, 0);
    const sx = Math.max(0.15, Math.min(room.roomW * VOXEL_SIZE_M - 0.15, ox + dx * (alien.halfW + 0.18)));
    const sy = Math.max(0.15, Math.min(room.roomH * VOXEL_SIZE_M - 0.15, oy + dy * 0.2));
    const sz = Math.max(0.15, Math.min(room.roomD * VOXEL_SIZE_M - 0.15, oz + dz * (alien.halfD + 0.18)));
    const slot = spawnBallistic(room, sx, sy, sz, dx * speedM, dy * speedM, dz * speedM, packed, 0);
    if (slot !== -1) {
      gland.liters--;
      fired++;
    }
  }
  if (fired > 0) {
    alien.telegraphDirX = ax;
    alien.telegraphDirY = ay;
    alien.telegraphDirZ = az;
  }
}

/**
 * Releases all remaining gland liters on alien death via ballistic burst / placeOrDeferFluid.
 * Returns true if fully drained, false if entity must persist as non-colliding deathHusk (§3.2).
 */
export function burstAlienGlandsOnDeath(world: WorldState, alien: Entity, maxLiters = 999): boolean {
  const room = world.room;
  const cx = alien.x;
  const cy = alien.y + alien.height * 0.5;
  const cz = alien.z;
  const vx = Math.floor(cx / VOXEL_SIZE_M);
  const vy = Math.floor(cy / VOXEL_SIZE_M);
  const vz = Math.floor(cz / VOXEL_SIZE_M);

  let remainingBudget = maxLiters;
  let allEmpty = true;

  for (let gIdx = 0; gIdx < alien.glands.length; gIdx++) {
    const g = alien.glands[gIdx];
    while (g.liters > 0 && remainingBudget > 0) {
      const h = hash32(room.roomSeed, world.simTick, alien.id * 131 + g.liters);
      const rx = ((h & 255) / 127.5) - 1;
      const ry = 0.25 + (((h >>> 8) & 255) / 255) * 0.75;
      const rz = (((h >>> 16) & 255) / 127.5) - 1;
      const inv = 1 / Math.max(1e-4, Math.hypot(rx, ry, rz));
      const spd = 2.8 + (((h >>> 24) & 255) / 255) * 2.4;
      const packed = packVoxel(g.mat, g.tempByte, g.chargeUnits, 0, h & 7, 0, 0);

      let placed = false;
      if (room.ballistic.count < MAX_ACTIVE_BALLISTIC) {
        const slot = spawnBallistic(
          room,
          cx,
          cy,
          cz,
          rx * inv * spd,
          ry * inv * spd,
          rz * inv * spd,
          packed,
          0,
        );
        placed = slot !== -1;
      }
      if (!placed) {
        placed = placeOrDeferFluid(
          room,
          g.mat,
          g.tempByte,
          g.chargeUnits,
          vx,
          vy,
          vz,
          false,
          world.player,
          world.simTick,
        );
      }
      if (!placed) {
        allEmpty = false;
        break;
      }
      g.liters--;
      remainingBudget--;
    }
    if (g.liters > 0) allEmpty = false;
  }

  return allEmpty;
}

/**
 * Stage 8 Enemy AI & Stun Contract (§8.2, §8.3, Patch B):
 * - Armored Carapace Bruiser (locomotion: 'crusher'): heavy bull-charge & close slam, resists light stagger, vulnerable to 4 alchemical counters.
 * - High-Ground Scaffold Spitter (locomotion: 'spitter'): holds perched wood scaffolding firing ranged 6 L fluid volleys; drops when scaffold burns out.
 * - Pack Skitterers (locomotion: 'skitterer'): flanking pack pursuit to punish single-target kiting.
 * - Brood Spitter Pod: stationary fluid volley shooter in deck mode.
 */
export function stepEnemyAIStage8(world: WorldState): void {
  const room = world.room;
  const p = world.player;
  const mode = room.gravityMode;
  const isZeroG = mode === GRAVITY_MODE.G0;
  const isInverted = mode === GRAVITY_MODE.GN1;
  const gravSpeedScale =
    mode === GRAVITY_MODE.G3 ? 0.45 : mode === GRAVITY_MODE.G2 ? 0.68 : 1.0;

  const pTorsoX = p.x;
  const pTorsoY = p.y + PLAYER_TORSO_OFFSET_M;
  const pTorsoZ = p.z;

  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];

    if (e.deathHusk) {
      burstAlienGlandsOnDeath(world, e, 16);
      continue;
    }

    if (e.hp <= 0) continue;

    if (e.stunTicks > 0) {
      e.stunTicks--;
      if (e.stunTicks === 0) {
        e.stunImmunityTicks = STUN_IMMUNITY_TICKS;
      }
    } else if (e.stunImmunityTicks > 0) {
      e.stunImmunityTicks--;
    }

    if (e.kind !== 'alien') continue;
    if (e.attackCdTicks > 0) e.attackCdTicks--;
    if (e.stunTicks > 0) continue;

    const dx = pTorsoX - e.x;
    const dy = pTorsoY - (e.y + e.height * 0.5);
    const dz = pTorsoZ - e.z;
    const horizDist = Math.hypot(dx, dz);
    const dist3D = Math.hypot(horizDist, dy);

    // 1. Armored Carapace Bruiser (locomotion: 'crusher')
    if (e.locomotion === 'crusher') {
      if (isZeroG || isInverted || !e.grounded) {
        if (e.aiState !== 'lunge') {
          e.aiState = 'idle';
          e.aiTimer = 0;
          e.aiAttackKind = 'none';
        }
        continue;
      }

      if (e.aiState === 'telegraph') {
        e.aiTimer--;
        e.vx *= 0.6;
        e.vz *= 0.6;
        if (horizDist > 1e-4 && e.aiTimer > 10) {
          e.telegraphDirX = dx / horizDist;
          e.telegraphDirY = 0;
          e.telegraphDirZ = dz / horizDist;
        }
        if (e.aiTimer <= 0) {
          e.aiState = 'lunge';
          e.aiTimer = 20;
          e.meleeHitDone = false;
          e.vx = e.telegraphDirX * BRUISER_CHARGE_SPEED * gravSpeedScale;
          e.vz = e.telegraphDirZ * BRUISER_CHARGE_SPEED * gravSpeedScale;
          e.attackCdTicks = 125;
        }
        continue;
      }

      if (e.aiState === 'lunge') {
        e.aiTimer--;
        e.vx = e.telegraphDirX * BRUISER_CHARGE_SPEED * gravSpeedScale;
        e.vz = e.telegraphDirZ * BRUISER_CHARGE_SPEED * gravSpeedScale;

        if (!e.meleeHitDone && p.dashTimer === 0) {
          const hitX = Math.abs(p.x - e.x) < p.halfW + e.halfW + 0.25;
          const hitZ = Math.abs(p.z - e.z) < p.halfD + e.halfD + 0.25;
          const hitY = Math.abs(p.y - e.y) < 1.3;
          if (hitX && hitZ && hitY) {
            e.meleeHitDone = true;
            p.hp = Math.max(0, p.hp - 25);
            p.vx += e.telegraphDirX * 9.5;
            p.vz += e.telegraphDirZ * 9.5;
            p.impulseTimer = 36;
            pushCombatEvent(room, {
              kind: 'damage',
              entityId: p.id,
              x: p.x,
              y: p.y + p.height,
              z: p.z,
              value: 25,
              colorHex: 0xff595e,
              label: 'BRUISER SLAM! -25',
            });
          }
        }

        if (e.aiTimer <= 0) {
          e.aiState = 'recover';
          e.aiTimer = 48;
          e.aiAttackKind = 'none';
          e.vx *= 0.25;
          e.vz *= 0.25;
        }
        continue;
      }

      if (e.aiState === 'recover') {
        e.aiTimer--;
        e.vx *= 0.75;
        e.vz *= 0.75;
        if (e.aiTimer <= 0) e.aiState = 'chase';
        continue;
      }

      const hasLos =
        dist3D < 16.0 &&
        hasAirBurstLOS(room, e.x, e.y + 0.8, e.z, pTorsoX, pTorsoY, pTorsoZ);
      if (e.attackCdTicks === 0 && hasLos && Math.abs(p.y - e.y) < 1.6 && horizDist <= BRUISER_CHARGE_RANGE_M) {
        e.aiState = 'telegraph';
        e.aiAttackKind = 'melee';
        e.aiTimer = 42; // 0.7 s heavy telegraph
        e.telegraphDirX = horizDist > 1e-4 ? dx / horizDist : 1;
        e.telegraphDirY = 0;
        e.telegraphDirZ = horizDist > 1e-4 ? dz / horizDist : 0;
        continue;
      }

      if (horizDist > 1.7 && horizDist < 20.0) {
        e.aiState = 'chase';
        let dirX = dx / horizDist;
        let dirZ = dz / horizDist;
        if (isStepBlockedAhead(room, e, dirX, dirZ)) {
          const sign = e.id & 1 ? 1 : -1;
          const c = 0.6428;
          const sn = 0.766 * sign;
          const alt1X = dirX * c - dirZ * sn;
          const alt1Z = dirX * sn + dirZ * c;
          if (!isStepBlockedAhead(room, e, alt1X, alt1Z)) {
            dirX = alt1X;
            dirZ = alt1Z;
          } else {
            dirX = dirX * c + dirZ * sn;
            dirZ = -dirX * sn + dirZ * c;
          }
        }
        const chillMult = e.tempByte <= TEMP_BYTE.EMBRITTLED ? 0.45 : 1.0;
        const spd = BRUISER_SPEED_1G * gravSpeedScale * chillMult;
        e.vx += (dirX * spd - e.vx) * 0.2;
        e.vz += (dirZ * spd - e.vz) * 0.2;
      } else {
        e.aiState = 'idle';
      }
      continue;
    }

    // 1.5. Hovering Gas-Bladder Floater (locomotion: 'floater')
    if (e.locomotion === 'floater') {
      if (isZeroG || isInverted || mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3) {
        e.aiState = 'idle';
        e.aiTimer = 0;
        e.aiAttackKind = 'none';
        continue;
      }

      if (e.aiState === 'telegraph') {
        e.aiTimer--;
        e.vx *= 0.72;
        e.vz *= 0.72;
        if (dist3D > 1e-4) {
          e.telegraphDirX = dx / dist3D;
          e.telegraphDirY = dy / dist3D;
          e.telegraphDirZ = dz / dist3D;
        }
        if (e.aiTimer <= 0) {
          if (e.aiAttackKind === 'spit') {
            fireAlienGlandVolley(world, e, 8, 11.5, 0.04);
            e.aiState = 'recover';
            e.aiTimer = 30;
            e.aiAttackKind = 'none';
            e.attackCdTicks = 150;
          } else {
            // Depleted-gland diving ram
            e.aiState = 'lunge';
            e.aiTimer = 18;
            e.meleeHitDone = false;
            e.vx = e.telegraphDirX * 10.5;
            e.vy = e.telegraphDirY * 9.0;
            e.vz = e.telegraphDirZ * 10.5;
            e.attackCdTicks = 120;
          }
        }
        continue;
      }

      if (e.aiState === 'lunge') {
        e.aiTimer--;
        if (!e.meleeHitDone && p.dashTimer === 0) {
          const hitX = Math.abs(p.x - e.x) < p.halfW + e.halfW + 0.2;
          const hitZ = Math.abs(p.z - e.z) < p.halfD + e.halfD + 0.2;
          const hitY = Math.abs(p.y - e.y) < 1.3;
          if (hitX && hitZ && hitY) {
            e.meleeHitDone = true;
            p.hp = Math.max(0, p.hp - 12);
            p.vx += e.telegraphDirX * 6.0;
            p.vz += e.telegraphDirZ * 6.0;
            p.impulseTimer = 24;
            pushCombatEvent(room, {
              kind: 'damage',
              entityId: p.id,
              x: p.x,
              y: p.y + p.height,
              z: p.z,
              value: 12,
              colorHex: 0xff595e,
              label: '-12',
            });
          }
        }
        if (e.aiTimer <= 0) {
          e.aiState = 'recover';
          e.aiTimer = 36;
          e.aiAttackKind = 'none';
        }
        continue;
      }

      if (e.aiState === 'recover') {
        e.aiTimer--;
        e.vx *= 0.84;
        e.vz *= 0.84;
        if (e.aiTimer <= 0) e.aiState = 'chase';
        continue;
      }

      const hasGland = e.glands.length > 0 && e.glands[0].liters > 0;
      const hasLos =
        dist3D < 15.0 &&
        hasAirBurstLOS(room, e.x, e.y + 0.7, e.z, pTorsoX, pTorsoY, pTorsoZ);
      if (e.attackCdTicks === 0 && hasLos && dist3D <= FLOATER_SPIT_RANGE_M) {
        e.aiState = 'telegraph';
        e.aiAttackKind = hasGland ? 'spit' : 'melee';
        e.aiTimer = 32;
        e.telegraphDirX = dist3D > 1e-4 ? dx / dist3D : 1;
        e.telegraphDirY = dist3D > 1e-4 ? dy / dist3D : 0;
        e.telegraphDirZ = dist3D > 1e-4 ? dz / dist3D : 0;
        continue;
      }

      // Strafe & maintain preferred elevated bombing range (4.5..7.5 m)
      if (horizDist > 0.2 && horizDist < 19.0) {
        e.aiState = 'chase';
        const nx = dx / horizDist;
        const nz = dz / horizDist;
        const strafeSign = e.id & 1 ? 1 : -1;
        const radPull = horizDist > 7.2 ? 0.8 : horizDist < 3.8 ? -0.75 : 0.0;
        const dirX = nx * radPull - nz * 0.65 * strafeSign;
        const dirZ = nz * radPull + nx * 0.65 * strafeSign;
        const chillMult = e.tempByte <= TEMP_BYTE.EMBRITTLED ? 0.45 : 1.0;
        const spd = FLOATER_SPEED_1G * chillMult;
        e.vx += (dirX * spd - e.vx) * 0.14;
        e.vz += (dirZ * spd - e.vz) * 0.14;
      }
      continue;
    }

    // 2. High-Ground Scaffold Spitter (locomotion: 'spitter')
    if (e.locomotion === 'spitter') {
      if (isZeroG || isInverted || !e.grounded) {
        e.aiState = 'idle';
        e.aiTimer = 0;
        e.aiAttackKind = 'none';
        continue;
      }

      if (e.aiState === 'telegraph') {
        e.aiTimer--;
        e.vx *= 0.6;
        e.vz *= 0.6;
        if (dist3D > 1e-4) {
          e.telegraphDirX = dx / dist3D;
          e.telegraphDirY = dy / dist3D;
          e.telegraphDirZ = dz / dist3D;
        }
        if (e.aiTimer <= 0) {
          fireAlienGlandVolley(world, e, 6, 11.5, 0.14);
          e.aiState = 'recover';
          e.aiTimer = 32;
          e.aiAttackKind = 'none';
          e.attackCdTicks = 156; // 2.6 s volley cadence
        }
        continue;
      }

      if (e.aiState === 'recover') {
        e.aiTimer--;
        if (e.aiTimer <= 0) e.aiState = 'idle';
        continue;
      }

      // Holds elevated scaffold perch rather than walking off; lobs fluid volleys downrange
      const hasGland = e.glands.length > 0 && e.glands[0].liters > 0;
      if (
        hasGland &&
        e.attackCdTicks === 0 &&
        dist3D <= SPITTER_RANGE_M &&
        dist3D > 1.2 &&
        hasAirBurstLOS(room, e.x, e.y + 0.85, e.z, pTorsoX, pTorsoY, pTorsoZ)
      ) {
        e.aiState = 'telegraph';
        e.aiAttackKind = 'spit';
        e.aiTimer = 36; // 0.6 s volley windup
        e.telegraphDirX = dx / dist3D;
        e.telegraphDirY = dy / dist3D;
        e.telegraphDirZ = dz / dist3D;
      }
      continue;
    }

    // 3. Coordinated Pack Skitterer AI
    if (e.locomotion === 'skitterer') {
      if (isZeroG || isInverted || !e.grounded) {
        if (e.aiState !== 'lunge') {
          e.aiState = 'idle';
          e.aiTimer = 0;
          e.aiAttackKind = 'none';
        }
        continue;
      }

      if (e.aiState === 'telegraph') {
        e.aiTimer--;
        e.vx *= 0.65;
        e.vz *= 0.65;
        if (horizDist > 1e-4 && e.aiTimer > 8) {
          e.telegraphDirX = dx / horizDist;
          e.telegraphDirY = 0;
          e.telegraphDirZ = dz / horizDist;
        }
        if (e.aiTimer <= 0) {
          if (e.aiAttackKind === 'melee') {
            e.aiState = 'lunge';
            e.aiTimer = 14;
            e.meleeHitDone = false;
            e.vx = e.telegraphDirX * SKITTERER_LUNGE_SPEED * gravSpeedScale;
            e.vz = e.telegraphDirZ * SKITTERER_LUNGE_SPEED * gravSpeedScale;
            e.attackCdTicks = 90;
          } else {
            fireAlienGlandVolley(world, e, 6, 10.5);
            e.aiState = 'recover';
            e.aiTimer = 36;
            e.aiAttackKind = 'none';
            e.attackCdTicks = 170;
          }
        }
        continue;
      }

      if (e.aiState === 'lunge') {
        e.aiTimer--;
        e.vx = e.telegraphDirX * SKITTERER_LUNGE_SPEED * gravSpeedScale;
        e.vz = e.telegraphDirZ * SKITTERER_LUNGE_SPEED * gravSpeedScale;

        if (!e.meleeHitDone && p.dashTimer === 0) {
          const hitX = Math.abs(p.x - e.x) < p.halfW + e.halfW + 0.18;
          const hitZ = Math.abs(p.z - e.z) < p.halfD + e.halfD + 0.18;
          const hitY = Math.abs(p.y - e.y) < 1.1;
          if (hitX && hitZ && hitY) {
            e.meleeHitDone = true;
            p.hp = Math.max(0, p.hp - 15);
            p.vx += e.telegraphDirX * 6.5;
            p.vz += e.telegraphDirZ * 6.5;
            p.impulseTimer = 24;
            pushCombatEvent(room, {
              kind: 'damage',
              entityId: p.id,
              x: p.x,
              y: p.y + p.height,
              z: p.z,
              value: 15,
              colorHex: 0xff595e,
              label: '-15',
            });
          }
        }

        if (e.aiTimer <= 0) {
          e.aiState = 'recover';
          e.aiTimer = 38;
          e.aiAttackKind = 'none';
          e.vx *= 0.3;
          e.vz *= 0.3;
        }
        continue;
      }

      if (e.aiState === 'recover') {
        e.aiTimer--;
        e.vx *= 0.8;
        e.vz *= 0.8;
        if (e.aiTimer <= 0) e.aiState = 'chase';
        continue;
      }

      const hasLos =
        dist3D < 14.0 &&
        hasAirBurstLOS(room, e.x, e.y + 0.5, e.z, pTorsoX, pTorsoY, pTorsoZ);

      if (e.attackCdTicks === 0 && hasLos && Math.abs(p.y - e.y) < 1.3) {
        if (horizDist <= SKITTERER_LUNGE_RANGE_M) {
          e.aiState = 'telegraph';
          e.aiAttackKind = 'melee';
          e.aiTimer = 30;
          e.telegraphDirX = horizDist > 1e-4 ? dx / horizDist : 1;
          e.telegraphDirY = 0;
          e.telegraphDirZ = horizDist > 1e-4 ? dz / horizDist : 0;
          continue;
        }
        if (
          horizDist <= SKITTERER_SPIT_RANGE_M &&
          e.glands.length > 0 &&
          e.glands[0].liters > 0
        ) {
          e.aiState = 'telegraph';
          e.aiAttackKind = 'spit';
          e.aiTimer = 30;
          e.telegraphDirX = horizDist > 1e-4 ? dx / horizDist : 1;
          e.telegraphDirY = 0;
          e.telegraphDirZ = horizDist > 1e-4 ? dz / horizDist : 0;
          continue;
        }
      }

      // Coordinated pack flanking: when > 3.5 m out, pack members fan +/- 26 deg so they encircle instead of conga-lining
      if (horizDist > 1.35 && horizDist < 19.0) {
        e.aiState = 'chase';
        let dirX = dx / horizDist;
        let dirZ = dz / horizDist;
        const flankSlot = e.id % 3;
        if (horizDist > 3.5 && flankSlot !== 0) {
          const flSign = flankSlot === 1 ? 1 : -1;
          const fc = 0.8988; // cos(26 deg)
          const fs = 0.4384 * flSign; // sin(26 deg)
          const fx = dirX * fc - dirZ * fs;
          const fz = dirX * fs + dirZ * fc;
          dirX = fx;
          dirZ = fz;
        }
        if (isStepBlockedAhead(room, e, dirX, dirZ)) {
          const sign = e.id & 1 ? 1 : -1;
          const c = 0.6428;
          const sn = 0.766 * sign;
          const alt1X = dirX * c - dirZ * sn;
          const alt1Z = dirX * sn + dirZ * c;
          if (!isStepBlockedAhead(room, e, alt1X, alt1Z)) {
            dirX = alt1X;
            dirZ = alt1Z;
          } else {
            dirX = dirX * c + dirZ * sn;
            dirZ = -dirX * sn + dirZ * c;
          }
        }
        const chillMult = e.tempByte <= TEMP_BYTE.EMBRITTLED ? 0.45 : 1.0;
        const spd = SKITTERER_SPEED_1G * gravSpeedScale * chillMult;
        e.vx += (dirX * spd - e.vx) * 0.25;
        e.vz += (dirZ * spd - e.vz) * 0.25;
      } else {
        e.aiState = 'idle';
      }
      continue;
    }

    // 4. Active Brood Spitter Pod (only in deck combat rooms; passive in Tier A standalone mode)
    if (e.locomotion === 'pod' && world.deck !== null && e.glands.length > 0 && e.glands[0].liters > 0) {
      if (e.aiState === 'telegraph') {
        e.aiTimer--;
        if (horizDist > 1e-4) {
          e.telegraphDirX = dx / dist3D;
          e.telegraphDirY = dy / dist3D;
          e.telegraphDirZ = dz / dist3D;
        }
        if (e.aiTimer <= 0) {
          fireAlienGlandVolley(world, e, 4, 10.0);
          e.aiState = 'recover';
          e.aiTimer = 30;
          e.aiAttackKind = 'none';
          e.attackCdTicks = 210;
        }
        continue;
      }
      if (e.aiState === 'recover') {
        e.aiTimer--;
        if (e.aiTimer <= 0) e.aiState = 'idle';
        continue;
      }
      if (
        e.attackCdTicks === 0 &&
        dist3D <= POD_SPIT_RANGE_M &&
        dist3D > 1.4 &&
        hasAirBurstLOS(room, e.x, e.y + 0.7, e.z, pTorsoX, pTorsoY, pTorsoZ)
      ) {
        e.aiState = 'telegraph';
        e.aiAttackKind = 'spit';
        e.aiTimer = 36;
        e.telegraphDirX = dx / dist3D;
        e.telegraphDirY = dy / dist3D;
        e.telegraphDirZ = dz / dist3D;
      }
    }
  }
}
