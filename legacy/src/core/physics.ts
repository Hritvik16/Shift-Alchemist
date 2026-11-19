// Pure TypeScript 3D Physics:
// - 60 FPS Sub-Voxel Fluid Stepping (every frame instead of 20 Hz grid hopping!)
// - Direct 3D Air-Nozzle Spray Impulse on Sub-Voxel Liquid Quanta
// - 14m Range & Voxel Line-of-Sight (LOS) enforcement

import {
  VOXEL_SIZE,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
  isSolidVoxel,
} from './types';
import type {
  RoomGrid,
  PlayerInputState,
  PlayerRigState,
  DynamicEntity,
  LockOnTarget,
} from './types';
import { recountActiveCells } from './roomGen';
import {
  applyZeroGLiftImpulseToGrid,
  step3DFluidStencil,
  shatterCylindricalVat,
  isFluidMaterial,
  syncQuantaToVoxelGrid,
} from './fluids';

const GRAVITY_ACCEL = 22.0;
const STEP_UP_HEIGHT = 0.52;
const SLAM_SPEED_THRESHOLD = 5.2;
export const NOZZLE_MAX_RANGE = 14.0;

export function createPlayerRig(): PlayerRigState {
  return {
    x: 6.5,
    y: 1.5,
    z: 16.5,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    radius: 0.3,
    height: 1.35,
    mass: 80,
    grounded: true,
    floorY: 1.5,
    walkPhase: 0,
    walkBlend: 0,
    dashTimer: 0,
    dashCooldown: 0,
    nozzleCooldown: 0,
    jetpackActive: false,
    inOilTar: false,
    lastSlamDamage: 0,
    slamFlashTimer: 0,
  };
}

export function collidesWithWorld(
  room: RoomGrid,
  wx: number,
  wy: number,
  wz: number,
  radius: number,
  height: number,
  ignoreVoxelIdx = -1
): boolean {
  const minX = Math.floor((wx - radius) / VOXEL_SIZE);
  const maxX = Math.floor((wx + radius) / VOXEL_SIZE);
  const minY = Math.floor((wy + 0.06) / VOXEL_SIZE);
  const maxY = Math.floor((wy + height - 0.04) / VOXEL_SIZE);
  const minZ = Math.floor((wz - radius) / VOXEL_SIZE);
  const maxZ = Math.floor((wz + radius) / VOXEL_SIZE);

  for (let vy = minY; vy <= maxY; vy++) {
    for (let vz = minZ; vz <= maxZ; vz++) {
      for (let vx = minX; vx <= maxX; vx++) {
        if (!inRoomBounds(room, vx, vy, vz)) return true;
        const idx = getVoxelIndex(room, vx, vy, vz);
        if (idx === ignoreVoxelIdx) continue;
        if (isSolidVoxel(room, vx, vy, vz)) return true;
      }
    }
  }
  return false;
}

export function computeFloorAltitudeBelow(
  room: RoomGrid,
  wx: number,
  wy: number,
  wz: number,
  radius = 0.3,
  ignoreVoxelIdx = -1
): number {
  const r = radius * 0.78;
  const samplePoints: [number, number][] = [
    [wx, wz],
    [wx - r, wz - r],
    [wx + r, wz - r],
    [wx - r, wz + r],
    [wx + r, wz + r],
  ];

  const startVy = Math.min(
    room.height - 2,
    Math.floor((wy + 0.08) / VOXEL_SIZE)
  );
  let highestFloorY = 0.5;

  for (const [sx, sz] of samplePoints) {
    const vx = Math.floor(sx / VOXEL_SIZE);
    const vz = Math.floor(sz / VOXEL_SIZE);
    if (vx < 0 || vx >= room.width || vz < 0 || vz >= room.depth) continue;

    for (let vy = startVy; vy >= 0; vy--) {
      const idx = getVoxelIndex(room, vx, vy, vz);
      if (idx === ignoreVoxelIdx) continue;

      if (isSolidVoxel(room, vx, vy, vz)) {
        const aboveIdx = getVoxelIndex(room, vx, vy + 1, vz);
        const aboveIsSolid =
          aboveIdx !== ignoreVoxelIdx && isSolidVoxel(room, vx, vy + 1, vz);
        if (!aboveIsSolid) {
          const surfaceY = (vy + 1) * VOXEL_SIZE;
          if (surfaceY <= wy + 0.12 && surfaceY > highestFloorY) {
            highestFloorY = surfaceY;
          }
          break;
        }
      }
    }
  }

  return highestFloorY;
}

export function hasVoxelLineOfSight(
  room: RoomGrid,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  maxRange = NOZZLE_MAX_RANGE,
  ignoreIndices?: Set<number>
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > maxRange) return false;
  if (dist < 0.15) return true;

  const stepSize = 0.12;
  const steps = Math.floor((dist - 0.15) / stepSize);
  const invDist = 1.0 / dist;
  const ux = dx * invDist;
  const uy = dy * invDist;
  const uz = dz * invDist;

  for (let i = 1; i <= steps; i++) {
    const d = i * stepSize;
    const vx = Math.floor((x0 + ux * d) / VOXEL_SIZE);
    const vy = Math.floor((y0 + uy * d) / VOXEL_SIZE);
    const vz = Math.floor((z0 + uz * d) / VOXEL_SIZE);
    if (!inRoomBounds(room, vx, vy, vz)) return false;
    const idx = getVoxelIndex(room, vx, vy, vz);
    if (ignoreIndices && ignoreIndices.has(idx)) continue;
    const mat = room.matGrid[idx] as MaterialID;
    if (
      mat === MaterialID.HULL_STEEL ||
      mat === MaterialID.GLASS_VAT ||
      mat === MaterialID.WOOD_CRATE ||
      mat === MaterialID.ICE
    ) {
      return false;
    }
  }
  return true;
}

export function toggleRoomGravity(room: RoomGrid, player: PlayerRigState): void {
  if (room.gravityG > 0) {
    room.gravityG = 0.0;
    player.grounded = false;
    if (player.vy <= 0) player.vy = 1.5;

    for (const ent of room.entities) {
      ent.grounded = false;
      ent.vy = 1.2 + (ent.id % 3) * 0.35;
    }

    applyZeroGLiftImpulseToGrid(room);
    room.lastCombatLog =
      '0G Activated — Sub-voxel liquid droplets coalescing into floating 3D orbs!';
  } else {
    room.gravityG = 1.0;
    if (player.y - player.floorY > 0.35) {
      player.vy = Math.min(player.vy, -4.5);
    }
    for (const ent of room.entities) {
      if (ent.y - ent.floorY > 0.25) {
        ent.vy = Math.min(ent.vy, -5.5);
      }
    }
    for (const q of room.fluidQuanta) {
      q.vy = Math.min(q.vy, -4.5);
    }
    room.dirtyFluidRender = true;
    room.lastCombatLog =
      '1G Restored — Airborne Aliens, Crates & Liquid Orbs slamming down!';
  }
}

export function triggerPlayerDash(
  room: RoomGrid,
  player: PlayerRigState,
  input: PlayerInputState,
  lockTarget: LockOnTarget | null
): void {
  if (player.dashCooldown > 0) return;

  let dx = input.moveX;
  let dz = input.moveZ;
  const mag = Math.hypot(dx, dz);
  if (mag > 0.05) {
    dx /= mag;
    dz /= mag;
  } else {
    dx = Math.sin(player.yaw);
    dz = Math.cos(player.yaw);
  }

  const dashSpeed = 14.5;
  player.vx = dx * dashSpeed;
  player.vz = dz * dashSpeed;

  if (room.gravityG === 0) {
    if (Math.abs(input.moveY) > 0.05) {
      player.vy = input.moveY * 9.0;
    } else if (lockTarget) {
      const toTx = lockTarget.x - player.x;
      const toTz = lockTarget.z - player.z;
      const horizDist = Math.hypot(toTx, toTz);
      if (horizDist > 0.5) {
        const dot = (toTx / horizDist) * dx + (toTz / horizDist) * dz;
        if (dot > 0.45) {
          const dy = lockTarget.y - (player.y + player.height * 0.5);
          player.vy = Math.max(-10, Math.min(10, (dy / horizDist) * dashSpeed));
        }
      }
    }
  }

  player.dashTimer = 0.22;
  player.dashCooldown = 0.65;
  player.jetpackActive = true;
}

export function fireCompressedAirNozzle(
  room: RoomGrid,
  player: PlayerRigState,
  input: PlayerInputState,
  lockTarget: LockOnTarget | null
): void {
  if (player.nozzleCooldown > 0) return;
  player.nozzleCooldown = 0.22;

  const muzzleX = player.x + Math.sin(player.yaw) * 0.45;
  const muzzleY = player.y + 0.78;
  const muzzleZ = player.z + Math.cos(player.yaw) * 0.45;

  const targetX = lockTarget ? lockTarget.x : input.aimWorldX;
  const targetY = lockTarget ? lockTarget.y : input.aimWorldY;
  const targetZ = lockTarget ? lockTarget.z : input.aimWorldZ;

  let dirX = targetX - muzzleX;
  let dirY = targetY - muzzleY;
  let dirZ = targetZ - muzzleZ;
  const rawDist = Math.hypot(dirX, dirY, dirZ) || 1;
  dirX /= rawDist;
  dirY /= rawDist;
  dirZ /= rawDist;

  const desiredDist = Math.min(rawDist, NOZZLE_MAX_RANGE);
  let actualDist = desiredDist;
  let struckGlassVoxelIdx = -1;

  const stepSize = 0.12;
  const maxSteps = Math.floor(desiredDist / stepSize);
  for (let i = 1; i <= maxSteps; i++) {
    const d = i * stepSize;
    const vx = Math.floor((muzzleX + dirX * d) / VOXEL_SIZE);
    const vy = Math.floor((muzzleY + dirY * d) / VOXEL_SIZE);
    const vz = Math.floor((muzzleZ + dirZ * d) / VOXEL_SIZE);
    if (!inRoomBounds(room, vx, vy, vz)) {
      actualDist = d;
      break;
    }
    const idx = getVoxelIndex(room, vx, vy, vz);
    const mat = room.matGrid[idx] as MaterialID;
    if (mat === MaterialID.GLASS_VAT) {
      actualDist = d;
      struckGlassVoxelIdx = idx;
      break;
    }
    if (mat === MaterialID.HULL_STEEL || mat === MaterialID.ICE) {
      actualDist = d;
      break;
    }
  }

  const endX = muzzleX + dirX * actualDist;
  const endY = muzzleY + dirY * actualDist;
  const endZ = muzzleZ + dirZ * actualDist;

  room.airBursts.push({
    startX: muzzleX,
    startY: muzzleY,
    startZ: muzzleZ,
    endX,
    endY,
    endZ,
    timer: 0.18,
    maxTimer: 0.18,
  });

  if (room.gravityG === 0) {
    player.vx -= dirX * 2.4;
    player.vy -= dirY * 1.8;
    player.vz -= dirZ * 2.4;
  }

  // 1. Check Cylindrical Glass Vat Shatter
  for (let i = room.vats.length - 1; i >= 0; i--) {
    const vat = room.vats[i];
    const vatCenterY = vat.y + vat.height * 0.5;
    const distFromMuzzle = Math.hypot(
      vat.x - muzzleX,
      vatCenterY - muzzleY,
      vat.z - muzzleZ
    );
    if (distFromMuzzle > NOZZLE_MAX_RANGE) continue;

    const hitVatVoxel =
      struckGlassVoxelIdx >= 0 && vat.voxelIndices.includes(struckGlassVoxelIdx);
    const endDistToVat = Math.hypot(
      vat.x - endX,
      vatCenterY - endY,
      vat.z - endZ
    );

    if (hitVatVoxel || endDistToVat < vat.radius + 0.75) {
      const ignoreSet = new Set(vat.voxelIndices);
      if (
        hasVoxelLineOfSight(
          room,
          muzzleX,
          muzzleY,
          muzzleZ,
          vat.x,
          vatCenterY,
          vat.z,
          NOZZLE_MAX_RANGE,
          ignoreSet
        )
      ) {
        const matName = MATERIAL_TABLE[vat.fluidMat].name;
        shatterCylindricalVat(room, vat);
        room.lastCombatLog = `Shattered ${matName} Vat — 240 ballistic micro-droplets unleashed!`;
        return;
      }
    }
  }

  // 2. Blast Sub-Voxel Liquid Quanta into a 60 FPS Noita Spray Arc!
  let blastedQuanta = 0;
  for (let i = 0; i < room.fluidQuanta.length; i++) {
    const q = room.fluidQuanta[i];
    const dImpact = Math.hypot(q.x - endX, q.y - endY, q.z - endZ);
    if (dImpact <= 1.35) {
      if (
        hasVoxelLineOfSight(
          room,
          muzzleX,
          muzzleY,
          muzzleZ,
          q.x,
          q.y,
          q.z,
          NOZZLE_MAX_RANGE
        )
      ) {
        blastedQuanta++;
        const falloff = 1.0 - dImpact / 1.45;
        const speed = (6.5 + q.shimmer * 3.5) * falloff;
        q.vx += dirX * speed + (q.shimmer - 0.5) * 2.2;
        q.vz += dirZ * speed + (((i * 7) % 10) / 10 - 0.5) * 2.2;
        q.vy +=
          room.gravityG === 0
            ? dirY * speed
            : Math.max(2.4, dirY * speed + 3.2 * falloff);
        q.grounded = false;
      }
    }
  }

  // 3. Punt Dynamic Entities (Crates & Aliens)
  let hitEntities = 0;
  for (const ent of room.entities) {
    const entCenterY = ent.y + ent.height * 0.5;
    const toEntX = ent.x - muzzleX;
    const toEntY = entCenterY - muzzleY;
    const toEntZ = ent.z - muzzleZ;
    const entDist = Math.hypot(toEntX, toEntY, toEntZ);
    if (entDist > NOZZLE_MAX_RANGE) continue;

    const proj = toEntX * dirX + toEntY * dirY + toEntZ * dirZ;
    if (proj < 0 || proj > actualDist + ent.radius) continue;

    const perpDist = Math.hypot(
      ent.x - (muzzleX + dirX * proj),
      entCenterY - (muzzleY + dirY * proj),
      ent.z - (muzzleZ + dirZ * proj)
    );

    if (perpDist <= ent.radius + 0.85) {
      const ignoreSet =
        ent.proxyVoxelIdx >= 0 ? new Set([ent.proxyVoxelIdx]) : undefined;
      if (
        hasVoxelLineOfSight(
          room,
          muzzleX,
          muzzleY,
          muzzleZ,
          ent.x,
          entCenterY,
          ent.z,
          NOZZLE_MAX_RANGE,
          ignoreSet
        )
      ) {
        hitEntities++;
        const impulse = ent.kind === 'crate' ? 11.5 : 10.5;
        ent.vx += dirX * impulse;
        ent.vz += dirZ * impulse;
        ent.vy +=
          room.gravityG > 0
            ? Math.max(2.8, dirY * impulse + 2.5)
            : dirY * impulse + 1.2;
        ent.grounded = false;
        ent.hitStunTimer = 0.55;
      }
    }
  }

  if (blastedQuanta > 0) {
    room.dirtyFluidRender = true;
    room.lastCombatLog = `Air Burst sprayed ${blastedQuanta} sub-voxel liquid droplets across the arena!`;
  } else if (hitEntities > 0) {
    room.lastCombatLog = `Air Burst punted ${hitEntities} target(s) — watch for Wall-Splat!`;
  }
}

export function findMagneticLockOnTarget(
  room: RoomGrid,
  player: PlayerRigState,
  rayOriginX: number,
  rayOriginY: number,
  rayOriginZ: number,
  rayDirX: number,
  rayDirY: number,
  rayDirZ: number,
  cursorWorldX: number,
  cursorWorldY: number,
  cursorWorldZ: number,
  cursorHitGeometry = true
): LockOnTarget | null {
  const muzzleX = player.x + Math.sin(player.yaw) * 0.35;
  const muzzleY = player.y + 0.78;
  const muzzleZ = player.z + Math.cos(player.yaw) * 0.35;

  let bestTarget: LockOnTarget | null = null;
  let bestScore = 2.1;

  for (const ent of room.entities) {
    const cy = ent.y + ent.height * 0.5;
    const toX = ent.x - rayOriginX;
    const toY = cy - rayOriginY;
    const toZ = ent.z - rayOriginZ;
    const t = toX * rayDirX + toY * rayDirY + toZ * rayDirZ;
    if (t <= 0) continue;

    const rayDist = Math.hypot(
      ent.x - (rayOriginX + rayDirX * t),
      cy - (rayOriginY + rayDirY * t),
      ent.z - (rayOriginZ + rayDirZ * t)
    );
    const score = ent.kind === 'alien' ? rayDist * 0.85 : rayDist;
    if (score < bestScore) {
      const ignoreSet =
        ent.proxyVoxelIdx >= 0 ? new Set([ent.proxyVoxelIdx]) : undefined;
      if (
        hasVoxelLineOfSight(
          room,
          muzzleX,
          muzzleY,
          muzzleZ,
          ent.x,
          cy,
          ent.z,
          NOZZLE_MAX_RANGE,
          ignoreSet
        )
      ) {
        bestScore = score;
        bestTarget = {
          kind: 'entity',
          entityId: ent.id,
          x: ent.x,
          y: cy,
          z: ent.z,
          label:
            ent.kind === 'alien'
              ? `Xenomorph Dummy (${ent.hp}/${ent.maxHp} HP)`
              : `Wood Crate (${ent.hp}/${ent.maxHp} HP)`,
        };
      }
    }
  }

  for (const vat of room.vats) {
    const cy = vat.y + vat.height * 0.5;
    const toX = vat.x - rayOriginX;
    const toY = cy - rayOriginY;
    const toZ = vat.z - rayOriginZ;
    const t = toX * rayDirX + toY * rayDirY + toZ * rayDirZ;
    if (t <= 0) continue;

    const rayDist = Math.hypot(
      vat.x - (rayOriginX + rayDirX * t),
      cy - (rayOriginY + rayDirY * t),
      vat.z - (rayOriginZ + rayDirZ * t)
    );
    if (rayDist < bestScore) {
      const ignoreSet = new Set(vat.voxelIndices);
      if (
        hasVoxelLineOfSight(
          room,
          muzzleX,
          muzzleY,
          muzzleZ,
          vat.x,
          cy,
          vat.z,
          NOZZLE_MAX_RANGE,
          ignoreSet
        )
      ) {
        bestScore = rayDist;
        const matName = MATERIAL_TABLE[vat.fluidMat].name;
        bestTarget = {
          kind: 'vat',
          vatId: vat.id,
          x: vat.x,
          y: cy,
          z: vat.z,
          label: `Pressurized ${matName} Tank (L-Click to Shatter)`,
        };
      }
    }
  }

  if (bestTarget) return bestTarget;
  if (!cursorHitGeometry) return null;

  const cvx = Math.floor(cursorWorldX / VOXEL_SIZE);
  const cvy = Math.floor(cursorWorldY / VOXEL_SIZE);
  const cvz = Math.floor(cursorWorldZ / VOXEL_SIZE);

  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const vx = cvx + dx;
        const vy = cvy + dy;
        const vz = cvz + dz;
        if (!inRoomBounds(room, vx, vy, vz)) continue;
        const idx = getVoxelIndex(room, vx, vy, vz);
        const mat = room.matGrid[idx] as MaterialID;
        if (isFluidMaterial(mat)) {
          const wx = (vx + 0.5) * VOXEL_SIZE;
          const wy = (vy + 0.5) * VOXEL_SIZE;
          const wz = (vz + 0.5) * VOXEL_SIZE;
          if (
            hasVoxelLineOfSight(
              room,
              muzzleX,
              muzzleY,
              muzzleZ,
              wx,
              wy,
              wz,
              NOZZLE_MAX_RANGE
            )
          ) {
            return {
              kind: 'fluidCluster',
              voxelCoords: { x: vx, y: vy, z: vz },
              x: wx,
              y: wy,
              z: wz,
              label: `${MATERIAL_TABLE[mat].name} Pool/Cluster (${room.volGrid[idx].toFixed(2)}L)`,
            };
          }
        }
      }
    }
  }

  return null;
}

export function stepWorldPhysics(
  room: RoomGrid,
  player: PlayerRigState,
  input: PlayerInputState,
  dt: number
): void {
  const clampedDt = Math.min(dt, 0.04);

  if (player.slamFlashTimer > 0) {
    player.slamFlashTimer = Math.max(0, player.slamFlashTimer - clampedDt);
  }
  if (player.dashTimer > 0) {
    player.dashTimer = Math.max(0, player.dashTimer - clampedDt);
  }
  if (player.dashCooldown > 0) {
    player.dashCooldown = Math.max(0, player.dashCooldown - clampedDt);
  }
  if (player.nozzleCooldown > 0) {
    player.nozzleCooldown = Math.max(0, player.nozzleCooldown - clampedDt);
  }

  for (let i = room.airBursts.length - 1; i >= 0; i--) {
    room.airBursts[i].timer -= clampedDt;
    if (room.airBursts[i].timer <= 0) {
      room.airBursts.splice(i, 1);
    }
  }

  for (const ent of room.entities) {
    if (ent.proxyVoxelIdx >= 0) {
      if (room.matGrid[ent.proxyVoxelIdx] === MaterialID.WOOD_CRATE) {
        room.matGrid[ent.proxyVoxelIdx] = MaterialID.AIR;
        room.volGrid[ent.proxyVoxelIdx] = 0;
      }
      ent.proxyVoxelIdx = -1;
    }
  }

  // Step the Sub-Voxel Noita Fluid Engine EVERY FRAME at 60 FPS!
  step3DFluidStencil(room, clampedDt);

  const pvx = Math.floor(player.x / VOXEL_SIZE);
  const pvy = Math.floor((player.y + 0.1) / VOXEL_SIZE);
  const pvz = Math.floor(player.z / VOXEL_SIZE);
  player.inOilTar =
    player.grounded &&
    inRoomBounds(room, pvx, pvy, pvz) &&
    room.matGrid[getVoxelIndex(room, pvx, pvy, pvz)] === MaterialID.OIL;

  // Player feet physically splash through liquid quanta when running or landing!
  const pSpeed = Math.hypot(player.vx, player.vy, player.vz);
  if (pSpeed > 1.5) {
    for (let i = 0; i < room.fluidQuanta.length; i++) {
      const q = room.fluidQuanta[i];
      if (q.mat === MaterialID.ICE) continue;
      const dx = q.x - player.x;
      const dy = q.y - (player.y + 0.25);
      const dz = q.z - player.z;
      if (Math.abs(dy) < 0.35 && dx * dx + dz * dz < 0.42 * 0.42) {
        q.vx += player.vx * 0.35 + dx * 2.5;
        q.vz += player.vz * 0.35 + dz * 2.5;
        q.vy += Math.min(2.2, pSpeed * 0.25);
        q.grounded = false;
      }
    }
  }

  const dxAim = input.aimWorldX - player.x;
  const dzAim = input.aimWorldZ - player.z;
  if (dxAim * dxAim + dzAim * dzAim > 0.01) {
    const targetYaw = Math.atan2(dxAim, dzAim);
    let diff = targetYaw - player.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    player.yaw += diff * Math.min(1, clampedDt * 18);
  }

  let moveX = input.moveX;
  let moveZ = input.moveZ;
  const mag = Math.hypot(moveX, moveZ);
  if (mag > 1) {
    moveX /= mag;
    moveZ /= mag;
  }

  if (player.dashTimer > 0) {
    player.jetpackActive = true;
  } else if (room.gravityG > 0) {
    const runSpeed = player.inOilTar ? 3.6 : 6.6;
    const accel = player.grounded ? 26.0 : 12.0;
    player.vx += (moveX * runSpeed - player.vx) * Math.min(1, accel * clampedDt);
    player.vz += (moveZ * runSpeed - player.vz) * Math.min(1, accel * clampedDt);
    player.vy -= GRAVITY_ACCEL * room.gravityG * clampedDt;
    player.jetpackActive = false;
  } else {
    const skateSpeed = 6.2;
    const verticalSpeed = 4.4;
    const thrusterAccel = 5.0;

    if (mag > 0.01) {
      player.vx += (moveX * skateSpeed - player.vx) * Math.min(1, thrusterAccel * clampedDt);
      player.vz += (moveZ * skateSpeed - player.vz) * Math.min(1, thrusterAccel * clampedDt);
    } else {
      player.vx *= Math.max(0, 1 - 1.4 * clampedDt);
      player.vz *= Math.max(0, 1 - 1.4 * clampedDt);
    }

    if (Math.abs(input.moveY) > 0.01) {
      player.vy += (input.moveY * verticalSpeed - player.vy) * Math.min(1, 7.5 * clampedDt);
    } else {
      player.vy *= Math.max(0, 1 - 3.5 * clampedDt);
    }

    player.jetpackActive = mag > 0.01 || Math.abs(input.moveY) > 0.01;
  }

  const nextX = player.x + player.vx * clampedDt;
  if (!collidesWithWorld(room, nextX, player.y, player.z, player.radius, player.height)) {
    player.x = nextX;
  } else if (
    room.gravityG > 0 &&
    player.grounded &&
    !collidesWithWorld(
      room,
      nextX,
      player.y + STEP_UP_HEIGHT,
      player.z,
      player.radius,
      player.height
    )
  ) {
    player.x = nextX;
    player.y += VOXEL_SIZE;
  } else {
    player.vx = 0;
  }

  const nextZ = player.z + player.vz * clampedDt;
  if (!collidesWithWorld(room, player.x, player.y, nextZ, player.radius, player.height)) {
    player.z = nextZ;
  } else if (
    room.gravityG > 0 &&
    player.grounded &&
    !collidesWithWorld(
      room,
      player.x,
      player.y + STEP_UP_HEIGHT,
      nextZ,
      player.radius,
      player.height
    )
  ) {
    player.z = nextZ;
    player.y += VOXEL_SIZE;
  } else {
    player.vz = 0;
  }

  player.floorY = computeFloorAltitudeBelow(
    room,
    player.x,
    player.y,
    player.z,
    player.radius
  );

  let nextY = player.y + player.vy * clampedDt;
  if (room.gravityG === 0) {
    nextY = Math.max(player.floorY, Math.min(5.85 - player.height, nextY));
  }

  if (room.gravityG > 0 && player.vy <= 0 && nextY <= player.floorY + 0.04) {
    const impactSpeed = Math.abs(player.vy);
    if (!player.grounded && impactSpeed >= SLAM_SPEED_THRESHOLD) {
      player.lastSlamDamage = Math.round(0.015 * player.mass * impactSpeed * impactSpeed);
      player.slamFlashTimer = 1.2;
    }
    player.y = player.floorY;
    player.vy = 0;
    player.grounded = true;
  } else if (!collidesWithWorld(room, player.x, nextY, player.z, player.radius, player.height)) {
    player.y = nextY;
    player.grounded = false;
  } else {
    player.vy = 0;
  }

  player.floorY = computeFloorAltitudeBelow(
    room,
    player.x,
    player.y,
    player.z,
    player.radius
  );

  const horizSpeed = Math.hypot(player.vx, player.vz);
  const isWalking = player.grounded && room.gravityG > 0 && horizSpeed > 0.35;
  const targetBlend = isWalking ? Math.min(1.0, horizSpeed / 5.5) : 0.0;
  player.walkBlend += (targetBlend - player.walkBlend) * Math.min(1, clampedDt * 14);
  if (player.walkBlend > 0.01) {
    player.walkPhase = (player.walkPhase + horizSpeed * clampedDt * 2.8) % (Math.PI * 2);
  }

  stepDynamicEntities(room, player, clampedDt);
  syncQuantaToVoxelGrid(room);
}

function applyWallSplatDamage(
  room: RoomGrid,
  ent: DynamicEntity,
  impactSpeed: number,
  reason: string
): void {
  if (impactSpeed < SLAM_SPEED_THRESHOLD) return;
  const dmg = Math.max(5, Math.round(0.016 * ent.mass * impactSpeed * impactSpeed));
  ent.hp = Math.max(0, ent.hp - dmg);
  ent.lastImpactDamage = dmg;
  ent.slamFlashTimer = 1.0;

  const name = ent.kind === 'alien' ? 'Xenomorph' : 'Wood Crate';
  if (ent.hp <= 0) {
    room.lastCombatLog = `${name} destroyed by ${reason} (${dmg} Mass*V² dmg)!`;
  } else {
    room.lastCombatLog = `${name} took ${dmg} ${reason} dmg (${ent.hp}/${ent.maxHp} HP)!`;
  }
}

function stepDynamicEntities(
  room: RoomGrid,
  player: PlayerRigState,
  dt: number
): void {
  for (let i = room.entities.length - 1; i >= 0; i--) {
    const ent = room.entities[i];

    if (ent.hitStunTimer > 0) ent.hitStunTimer = Math.max(0, ent.hitStunTimer - dt);
    if (ent.slamFlashTimer > 0) ent.slamFlashTimer = Math.max(0, ent.slamFlashTimer - dt);

    if (room.gravityG > 0) {
      ent.vy -= GRAVITY_ACCEL * room.gravityG * dt;
      const evx = Math.floor(ent.x / VOXEL_SIZE);
      const evy = Math.floor((ent.y + 0.1) / VOXEL_SIZE);
      const evz = Math.floor(ent.z / VOXEL_SIZE);
      const inOil =
        ent.grounded &&
        inRoomBounds(room, evx, evy, evz) &&
        room.matGrid[getVoxelIndex(room, evx, evy, evz)] === MaterialID.OIL;

      const friction = ent.grounded ? (inOil ? 16.0 : 8.5) : 1.5;
      ent.vx *= Math.max(0, 1 - friction * dt);
      ent.vz *= Math.max(0, 1 - friction * dt);
    } else {
      ent.vx *= Math.max(0, 1 - 0.9 * dt);
      ent.vy *= Math.max(0, 1 - 1.2 * dt);
      ent.vz *= Math.max(0, 1 - 0.9 * dt);
    }

    const nextX = ent.x + ent.vx * dt;
    if (!collidesWithWorld(room, nextX, ent.y, ent.z, ent.radius, ent.height)) {
      ent.x = nextX;
    } else {
      applyWallSplatDamage(room, ent, Math.abs(ent.vx), 'Wall-Splat');
      ent.vx = -ent.vx * 0.25;
    }

    const nextZ = ent.z + ent.vz * dt;
    if (!collidesWithWorld(room, ent.x, ent.y, nextZ, ent.radius, ent.height)) {
      ent.z = nextZ;
    } else {
      applyWallSplatDamage(room, ent, Math.abs(ent.vz), 'Wall-Splat');
      ent.vz = -ent.vz * 0.25;
    }

    ent.floorY = computeFloorAltitudeBelow(
      room,
      ent.x,
      ent.y,
      ent.z,
      ent.radius
    );

    let nextY = ent.y + ent.vy * dt;
    if (room.gravityG === 0) {
      nextY = Math.max(ent.floorY, Math.min(5.8 - ent.height, nextY));
    }

    if (room.gravityG > 0 && ent.vy <= 0 && nextY <= ent.floorY + 0.04) {
      if (!ent.grounded) {
        applyWallSplatDamage(room, ent, Math.abs(ent.vy), 'Gravity-Slam');
      }
      ent.y = ent.floorY;
      ent.vy = 0;
      ent.grounded = true;
    } else if (!collidesWithWorld(room, ent.x, nextY, ent.z, ent.radius, ent.height)) {
      ent.y = nextY;
      ent.grounded = false;
    } else {
      applyWallSplatDamage(room, ent, Math.abs(ent.vy), 'Ceiling-Splat');
      ent.vy = 0;
    }

    ent.floorY = computeFloorAltitudeBelow(
      room,
      ent.x,
      ent.y,
      ent.z,
      ent.radius
    );

    const dyPlayer = Math.abs(
      ent.y + ent.height * 0.5 - (player.y + player.height * 0.5)
    );
    if (dyPlayer < (ent.height + player.height) * 0.5) {
      const dxP = ent.x - player.x;
      const dzP = ent.z - player.z;
      const distP = Math.hypot(dxP, dzP);
      const minDistP = ent.radius + player.radius;
      if (distP < minDistP) {
        const nx = distP > 1e-4 ? dxP / distP : Math.sin(player.yaw);
        const nz = distP > 1e-4 ? dzP / distP : Math.cos(player.yaw);
        const overlap = minDistP - distP;

        const pNextX = player.x - nx * overlap * 0.6;
        const pNextZ = player.z - nz * overlap * 0.6;
        if (
          !collidesWithWorld(
            room,
            pNextX,
            player.y,
            pNextZ,
            player.radius,
            player.height
          )
        ) {
          player.x = pNextX;
          player.z = pNextZ;
        }

        const eNextX = ent.x + nx * overlap * 0.4;
        const eNextZ = ent.z + nz * overlap * 0.4;
        if (
          !collidesWithWorld(room, eNextX, ent.y, eNextZ, ent.radius, ent.height)
        ) {
          ent.x = eNextX;
          ent.z = eNextZ;
        }

        const relSpeed = Math.hypot(player.vx - ent.vx, player.vz - ent.vz);
        if (player.dashTimer > 0 || relSpeed > 4.5) {
          ent.vx += nx * 5.5;
          ent.vz += nz * 5.5;
        }
      }
    }

    for (let j = i - 1; j >= 0; j--) {
      const other = room.entities[j];
      const dy = Math.abs(ent.y + ent.height * 0.5 - (other.y + other.height * 0.5));
      if (dy < (ent.height + other.height) * 0.55) {
        const dx = ent.x - other.x;
        const dz = ent.z - other.z;
        const dist = Math.hypot(dx, dz);
        const minDist = ent.radius + other.radius;
        if (dist > 0.001 && dist < minDist) {
          const relSpeed = Math.hypot(
            ent.vx - other.vx,
            ent.vy - other.vy,
            ent.vz - other.vz
          );
          if (relSpeed >= SLAM_SPEED_THRESHOLD) {
            applyWallSplatDamage(room, ent, relSpeed, 'Crate-Impact');
            applyWallSplatDamage(room, other, relSpeed, 'Crate-Impact');
          }
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minDist - dist) * 0.5;
          if (
            !collidesWithWorld(
              room,
              ent.x + nx * overlap,
              ent.y,
              ent.z + nz * overlap,
              ent.radius,
              ent.height
            )
          ) {
            ent.x += nx * overlap;
            ent.z += nz * overlap;
          }
          if (
            !collidesWithWorld(
              room,
              other.x - nx * overlap,
              other.y,
              other.z - nz * overlap,
              other.radius,
              other.height
            )
          ) {
            other.x -= nx * overlap;
            other.z -= nz * overlap;
          }
        }
      }
    }

    if (ent.hp <= 0) {
      room.entities.splice(i, 1);
      recountActiveCells(room);
      continue;
    }

    if (ent.kind === 'crate') {
      const vx = Math.floor(ent.x / VOXEL_SIZE);
      const vy = Math.floor((ent.y + 0.25) / VOXEL_SIZE);
      const vz = Math.floor(ent.z / VOXEL_SIZE);
      if (inRoomBounds(room, vx, vy, vz)) {
        const idx = getVoxelIndex(room, vx, vy, vz);
        if (room.matGrid[idx] === MaterialID.AIR) {
          room.matGrid[idx] = MaterialID.WOOD_CRATE;
          room.volGrid[idx] = 1.0;
          ent.proxyVoxelIdx = idx;
        }
      }
    }
  }
}

export interface VoxelRayHit {
  hitVoxel: { x: number; y: number; z: number };
  adjacentVoxel: { x: number; y: number; z: number };
  worldPoint: { x: number; y: number; z: number };
}

export function raycastVoxelGrid(
  room: RoomGrid,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDist = 65.0
): VoxelRayHit | null {
  const stepSize = 0.12;
  const maxSteps = Math.floor(maxDist / stepSize);
  let prevVx = -1;
  let prevVy = -1;
  let prevVz = -1;

  for (let i = 0; i < maxSteps; i++) {
    const dist = i * stepSize;
    const wx = originX + dirX * dist;
    const wy = originY + dirY * dist;
    const wz = originZ + dirZ * dist;

    const vx = Math.floor(wx / VOXEL_SIZE);
    const vy = Math.floor(wy / VOXEL_SIZE);
    const vz = Math.floor(wz / VOXEL_SIZE);

    if (inRoomBounds(room, vx, vy, vz)) {
      if ((vz === room.depth - 1 || vx === room.width - 1) && vy > 3) {
        continue;
      }

      const idx = getVoxelIndex(room, vx, vy, vz);
      const mat = room.matGrid[idx] as MaterialID;
      if (mat !== MaterialID.AIR) {
        const adj = inRoomBounds(room, prevVx, prevVy, prevVz)
          ? { x: prevVx, y: prevVy, z: prevVz }
          : { x: vx, y: vy, z: vz };
        return {
          hitVoxel: { x: vx, y: vy, z: vz },
          adjacentVoxel: adj,
          worldPoint: { x: wx, y: wy, z: wz },
        };
      }
      prevVx = vx;
      prevVy = vy;
      prevVz = vz;
    }
  }
  return null;
}
