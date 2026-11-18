// Strictly Mass-Conserving 3D Voxel Fluid & Ice Stencil (0.0 - 1.0L Contract)
// - 0G Mid-Air Suspension Band (y = 4..7) + Whole-Cell Transport + 5x5x5 Cohesive Merging
// - Strict MIN_FLUID_VOL (0.05L) on both source & target cells (zero orphan slivers or thin films)
// - 1G Gravity for unsupported ICE blocks
// - 6-neighbor Cryo + Water -> Ice phase transition

import {
  MAX_CELL_VOLUME,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
} from './types';
import type { RoomGrid, GlassVatTank } from './types';
import { setVoxel, recountActiveCells } from './roomGen';

export const MIN_FLUID_VOL = 0.05;

const STENCIL_6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

const HORIZ_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function isFluidMaterial(mat: MaterialID): boolean {
  return (
    mat === MaterialID.WATER ||
    mat === MaterialID.OIL ||
    mat === MaterialID.CRYO
  );
}

/**
 * Shatters a Cylindrical Glass Vat, releasing its exact 12.0L into its 12 voxels (1.0L each)
 */
export function shatterCylindricalVat(room: RoomGrid, vat: GlassVatTank): void {
  const count = vat.voxelIndices.length;
  const volPerVoxel = count > 0 ? vat.fluidVolume / count : MAX_CELL_VOLUME;

  for (const idx of vat.voxelIndices) {
    const x = idx % room.width;
    const z = Math.floor(idx / room.width) % room.depth;
    const y = Math.floor(idx / (room.width * room.depth));

    const dx = x + 0.5 - vat.x * 2;
    const dz = z + 0.5 - vat.z * 2;
    setVoxel(
      room,
      x,
      y,
      z,
      vat.fluidMat,
      volPerVoxel,
      dx * 2.8,
      room.gravityG === 0 ? 0.4 : 0.5,
      dz * 2.8 + (y >= 7 ? 2.8 : 0)
    );
  }

  const vIdx = room.vats.indexOf(vat);
  if (vIdx >= 0) room.vats.splice(vIdx, 1);

  room.dirtyStaticRender = true;
  room.dirtyFluidRender = true;
  recountActiveCells(room);
}

/**
 * Gives floor puddles a controlled lift impulse toward the mid-air suspension band (y = 4..7)
 */
export function applyZeroGLiftImpulseToGrid(room: RoomGrid): void {
  const { width, height, depth, matGrid, vyGrid } = room;
  for (let y = 1; y < height - 1; y++) {
    for (let z = 1; z < depth - 1; z++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = getVoxelIndex(room, x, y, z);
        const mat = matGrid[idx] as MaterialID;
        if (!isFluidMaterial(mat)) continue;
        // Lift low puddles upward toward y = 5..6, and gently pull high ceiling cells downward
        if (y <= 3) {
          vyGrid[idx] = 1.6 + ((x + z) % 3) * 0.25;
        } else if (y >= 8) {
          vyGrid[idx] = -1.2;
        } else {
          vyGrid[idx] = 0.3;
        }
      }
    }
  }
  room.dirtyFluidRender = true;
}

/**
 * Non-destructive Cryo + Water -> Ice Phase Transition
 */
function tryFreezeCryoWaterContact(
  room: RoomGrid,
  idxA: number,
  idxB: number
): boolean {
  const matA = room.matGrid[idxA] as MaterialID;
  const matB = room.matGrid[idxB] as MaterialID;

  let waterIdx = -1;
  let cryoIdx = -1;
  if (matA === MaterialID.WATER && matB === MaterialID.CRYO) {
    waterIdx = idxA;
    cryoIdx = idxB;
  } else if (matA === MaterialID.CRYO && matB === MaterialID.WATER) {
    waterIdx = idxB;
    cryoIdx = idxA;
  } else {
    return false;
  }

  if (
    room.volGrid[waterIdx] < MIN_FLUID_VOL ||
    room.volGrid[cryoIdx] < MIN_FLUID_VOL
  ) {
    return false;
  }

  room.matGrid[waterIdx] = MaterialID.ICE;
  room.tempGrid[waterIdx] = -10;
  room.vxGrid[waterIdx] = 0;
  room.vyGrid[waterIdx] = 0;
  room.vzGrid[waterIdx] = 0;

  room.dirtyStaticRender = true;
  room.dirtyFluidRender = true;
  room.lastCombatLog = 'Cryo-Coolant flash-froze adjacent Water into solid Ice!';
  return true;
}

/**
 * 100% Mass-Conserving Fluid Transfer:
 * Enforces MIN_FLUID_VOL on BOTH the source remainder AND any newly created target cell!
 */
function transferFluidVolume(
  room: RoomGrid,
  fromIdx: number,
  toIdx: number,
  requestedAmount: number,
  minNewTargetVol = MIN_FLUID_VOL
): boolean {
  if (fromIdx === toIdx) return false;
  const mat = room.matGrid[fromIdx] as MaterialID;
  if (!isFluidMaterial(mat)) return false;

  const fromVol = room.volGrid[fromIdx];
  if (fromVol <= 0) return false;

  const toMat = room.matGrid[toIdx] as MaterialID;

  if (tryFreezeCryoWaterContact(room, fromIdx, toIdx)) {
    return true;
  }

  if (toMat !== MaterialID.AIR && toMat !== mat) return false;

  const existingToVol = toMat === MaterialID.AIR ? 0.0 : room.volGrid[toIdx];
  const availSpace = Math.max(0, MAX_CELL_VOLUME - existingToVol);
  if (availSpace <= 1e-5) return false;

  let actual = Math.min(fromVol, requestedAmount, availSpace);

  // 1. Prevent leaving a sub-minimum sliver in the source cell
  if (fromVol - actual < MIN_FLUID_VOL) {
    if (availSpace >= fromVol) {
      actual = fromVol;
    } else {
      // Cannot move whole cell and cannot leave a sliver < MIN_FLUID_VOL
      const maxAllowed = fromVol - MIN_FLUID_VOL;
      if (maxAllowed >= MIN_FLUID_VOL) {
        actual = Math.min(actual, maxAllowed);
      } else {
        return false;
      }
    }
  }

  // 2. Prevent creating a new target cell in AIR with volume below minNewTargetVol
  if (toMat === MaterialID.AIR && actual < minNewTargetVol) {
    if (fromVol >= minNewTargetVol && availSpace >= fromVol) {
      actual = fromVol; // Move whole droplet intact instead of creating a tiny fragment
    } else {
      return false;
    }
  }

  if (actual <= 1e-5) return false;

  const newToVol = existingToVol + actual;

  room.matGrid[toIdx] = mat;
  room.volGrid[toIdx] = newToVol;
  room.vxGrid[toIdx] =
    (room.vxGrid[toIdx] * existingToVol + room.vxGrid[fromIdx] * actual) / newToVol;
  room.vyGrid[toIdx] =
    (room.vyGrid[toIdx] * existingToVol + room.vyGrid[fromIdx] * actual) / newToVol;
  room.vzGrid[toIdx] =
    (room.vzGrid[toIdx] * existingToVol + room.vzGrid[fromIdx] * actual) / newToVol;
  room.tempGrid[toIdx] =
    (room.tempGrid[toIdx] * existingToVol + room.tempGrid[fromIdx] * actual) / newToVol;
  room.voltGrid[toIdx] = Math.max(room.voltGrid[toIdx], room.voltGrid[fromIdx]);

  const remaining = fromVol - actual;
  if (remaining <= 1e-5) {
    room.matGrid[fromIdx] = MaterialID.AIR;
    room.volGrid[fromIdx] = 0.0;
    room.vxGrid[fromIdx] = 0.0;
    room.vyGrid[fromIdx] = 0.0;
    room.vzGrid[fromIdx] = 0.0;
  } else {
    room.volGrid[fromIdx] = remaining;
  }

  return true;
}

function isOpenLedgeDropOff(
  room: RoomGrid,
  nx: number,
  y: number,
  nz: number
): boolean {
  if (y <= 1) return false;
  if (!inRoomBounds(room, nx, y, nz)) return false;
  const sideMat = room.matGrid[getVoxelIndex(room, nx, y, nz)] as MaterialID;
  if (sideMat !== MaterialID.AIR && !isFluidMaterial(sideMat)) return false;
  const belowSideMat = room.matGrid[getVoxelIndex(room, nx, y - 1, nz)] as MaterialID;
  return !MATERIAL_TABLE[belowSideMat].isSolid;
}

/**
 * Looks a few cells along a horizontal direction for an open ledge.
 * This lets shallow puddle cells on a catwalk/shelf drain toward the edge instead of
 * being permanently stranded by the minimum-puddle-thickness rule.
 */
function hasOpenDropOffAhead(
  room: RoomGrid,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  maxDist = 4
): boolean {
  if (y <= 1) return false;
  for (let dist = 1; dist <= maxDist; dist++) {
    const nx = x + dx * dist;
    const nz = z + dz * dist;
    if (!inRoomBounds(room, nx, y, nz)) return false;
    const idx = getVoxelIndex(room, nx, y, nz);
    const mat = room.matGrid[idx] as MaterialID;
    if (MATERIAL_TABLE[mat].isSolid) return false;

    const belowMat = room.matGrid[
      getVoxelIndex(room, nx, y - 1, nz)
    ] as MaterialID;
    if (!MATERIAL_TABLE[belowMat].isSolid) return true;
  }
  return false;
}

/**
 * Rejects diagonal 0G merges whose axis-aligned bounding box crosses solid matter.
 * A 3x3x3 merge must never teleport a droplet through a wall/catwalk corner.
 */
function hasClearMergePath(
  room: RoomGrid,
  fromIdx: number,
  toIdx: number
): boolean {
  const { width, depth } = room;
  const fromX = fromIdx % width;
  const fromZ = Math.floor(fromIdx / width) % depth;
  const fromY = Math.floor(fromIdx / (width * depth));
  const toX = toIdx % width;
  const toZ = Math.floor(toIdx / width) % depth;
  const toY = Math.floor(toIdx / (width * depth));

  for (let y = Math.min(fromY, toY); y <= Math.max(fromY, toY); y++) {
    for (let z = Math.min(fromZ, toZ); z <= Math.max(fromZ, toZ); z++) {
      for (let x = Math.min(fromX, toX); x <= Math.max(fromX, toX); x++) {
        if (
          (x === fromX && y === fromY && z === fromZ) ||
          (x === toX && y === toY && z === toZ)
        ) {
          continue;
        }
        const idx = getVoxelIndex(room, x, y, z);
        if (MATERIAL_TABLE[room.matGrid[idx] as MaterialID].isSolid) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Pure 3D Cellular Stencil Step (20 Hz):
 * - 1G Gravity for unsupported ICE blocks (no floating ice platforms in 1G)
 * - 0G Mid-Air Suspension Band (y = 4..7) + Whole-Cell Transport + 5x5x5 Cohesive Merging
 * - 1G Puddle Thickness Enforcement (prevents thin-film over-spreading)
 */
export function step3DFluidStencil(room: RoomGrid, dt: number): void {
  const { width, height, depth, matGrid, volGrid, vxGrid, vyGrid, vzGrid } = room;
  let changed = false;

  // 0. Step 1G Gravity for unsupported ICE blocks first (bottom-up so falling columns drop cleanly)
  if (room.gravityG > 0) {
    for (let y = 2; y < height - 1; y++) {
      for (let z = 1; z < depth - 1; z++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = getVoxelIndex(room, x, y, z);
          if ((matGrid[idx] as MaterialID) !== MaterialID.ICE) continue;

          const belowIdx = getVoxelIndex(room, x, y - 1, z);
          const belowMat = matGrid[belowIdx] as MaterialID;

          if (belowMat === MaterialID.AIR) {
            // Move unsupported ICE block straight down into AIR
            matGrid[belowIdx] = MaterialID.ICE;
            volGrid[belowIdx] = volGrid[idx];
            room.tempGrid[belowIdx] = room.tempGrid[idx];
            room.voltGrid[belowIdx] = room.voltGrid[idx];

            matGrid[idx] = MaterialID.AIR;
            volGrid[idx] = 0.0;
            room.dirtyStaticRender = true;
            changed = true;
          } else if (isFluidMaterial(belowMat)) {
            // Ice sinks into underlying liquid pool (swap ICE with fluid below)
            const fMat = matGrid[belowIdx];
            const fVol = volGrid[belowIdx];
            const fTemp = room.tempGrid[belowIdx];
            const fVolt = room.voltGrid[belowIdx];

            matGrid[belowIdx] = MaterialID.ICE;
            volGrid[belowIdx] = volGrid[idx];
            room.tempGrid[belowIdx] = room.tempGrid[idx];
            room.voltGrid[belowIdx] = room.voltGrid[idx];

            matGrid[idx] = fMat;
            volGrid[idx] = fVol;
            room.tempGrid[idx] = fTemp;
            room.voltGrid[idx] = fVolt;
            room.dirtyStaticRender = true;
            room.dirtyFluidRender = true;
            changed = true;
          }
        }
      }
    }
  }

  // Collect active fluid cells
  const activeIndices: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let z = 1; z < depth - 1; z++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = getVoxelIndex(room, x, y, z);
        if (isFluidMaterial(matGrid[idx] as MaterialID)) {
          activeIndices.push(idx);
        }
      }
    }
  }

  if (activeIndices.length === 0) {
    if (changed) recountActiveCells(room);
    return;
  }

  for (let i = 0; i < activeIndices.length; i++) {
    const idx = activeIndices[i];
    const mat = matGrid[idx] as MaterialID;
    if (!isFluidMaterial(mat)) continue;

    let vol = volGrid[idx];
    if (vol <= 0) continue;

    const x = idx % width;
    const z = Math.floor(idx / width) % depth;
    const y = Math.floor(idx / (width * depth));
    const props = MATERIAL_TABLE[mat];

    // 1. Check 6-Neighbor Cryo + Water Contact (top-down, bottom-up, and side-by-side)
    if (mat === MaterialID.CRYO || mat === MaterialID.WATER) {
      let froze = false;
      for (const [dx, dy, dz] of STENCIL_6) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!inRoomBounds(room, nx, ny, nz)) continue;
        const nIdx = getVoxelIndex(room, nx, ny, nz);
        if (tryFreezeCryoWaterContact(room, idx, nIdx)) {
          changed = true;
          froze = true;
          if ((matGrid[idx] as MaterialID) === MaterialID.ICE) break;
        }
      }
      if (froze && (matGrid[idx] as MaterialID) === MaterialID.ICE) continue;
    }

    // 2. 1G Vertical Free-Fall & Archimedes Density Stratification
    if (room.gravityG > 0 && y > 1) {
      const belowIdx = getVoxelIndex(room, x, y - 1, z);
      const belowMat = matGrid[belowIdx] as MaterialID;

      if (belowMat === MaterialID.AIR || belowMat === mat) {
        vyGrid[idx] = Math.min(-3.5, vyGrid[idx] - 18.0 * dt);
        // Move 100% of falling cell volume when possible so no mid-air orphan slivers remain
        if (transferFluidVolume(room, idx, belowIdx, vol, MIN_FLUID_VOL)) {
          changed = true;
          if (matGrid[idx] === MaterialID.AIR) continue;
          vol = volGrid[idx];
        }
      } else if (isFluidMaterial(belowMat)) {
        const belowProps = MATERIAL_TABLE[belowMat];
        if (props.density > belowProps.density + 0.05) {
          const tempMat = matGrid[belowIdx];
          const tempVol = volGrid[belowIdx];
          const tempTemp = room.tempGrid[belowIdx];
          const tempVolt = room.voltGrid[belowIdx];

          matGrid[belowIdx] = mat;
          volGrid[belowIdx] = vol;
          room.tempGrid[belowIdx] = room.tempGrid[idx];
          room.voltGrid[belowIdx] = room.voltGrid[idx];

          matGrid[idx] = tempMat;
          volGrid[idx] = tempVol;
          room.tempGrid[idx] = tempTemp;
          room.voltGrid[idx] = tempVolt;
          changed = true;
          continue;
        }
      } else if (MATERIAL_TABLE[belowMat].isSolid && vyGrid[idx] < -1.5) {
        const splashSpeed = Math.min(4.0, Math.abs(vyGrid[idx]) * 0.4);
        const angle = ((x * 17 + z * 31) % 8) * (Math.PI / 4);
        vxGrid[idx] += Math.cos(angle) * splashSpeed;
        vzGrid[idx] += Math.sin(angle) * splashSpeed;
        vyGrid[idx] = 0;
      }
    }

    // 3. Compute 5x5x5 Cohesive Attraction Gradient (wider range re-merges separated 0G droplets!)
    let cohX = 0;
    let cohY = 0;
    let cohZ = 0;
    let sameNeighborCount = 0;
    const radiusScan = room.gravityG === 0 ? 2 : 1;

    for (let dy = -radiusScan; dy <= radiusScan; dy++) {
      for (let dz = -radiusScan; dz <= radiusScan; dz++) {
        for (let dx = -radiusScan; dx <= radiusScan; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!inRoomBounds(room, nx, ny, nz)) continue;
          const nIdx = getVoxelIndex(room, nx, ny, nz);
          if (matGrid[nIdx] === mat) {
            const nVol = volGrid[nIdx];
            const dist = Math.hypot(dx, dy, dz);
            const weight = nVol / dist;
            cohX += (dx / dist) * weight;
            cohY += (dy / dist) * weight;
            cohZ += (dz / dist) * weight;
            if (dist <= 1.8) sameNeighborCount++;
          }
        }
      }
    }

    if (room.gravityG > 0) {
      let ledgePullX = 0;
      let ledgePullZ = 0;
      for (const [dx, dz] of HORIZ_4) {
        for (let dist = 1; dist <= 3; dist++) {
          const lx = x + dx * dist;
          const lz = z + dz * dist;
          if (lx <= 0 || lx >= width - 1 || lz <= 0 || lz >= depth - 1) break;
          if (isOpenLedgeDropOff(room, lx, y, lz)) {
            const weight = 3.5 / dist;
            ledgePullX += dx * weight;
            ledgePullZ += dz * weight;
            break;
          }
        }
      }

      vxGrid[idx] += ledgePullX * dt * 8.0;
      vzGrid[idx] += ledgePullZ * dt * 8.0;

      const damp = Math.max(0.25, 1.0 - (1.6 + props.viscosity * 3.5) * dt);
      vxGrid[idx] *= damp;
      vzGrid[idx] *= damp;
    } else {
      // 0G Mid-Air Suspension Band (y = 4..7 -> 2.0m..3.5m altitude):
      // Gentle restoring force keeps floating clusters suspended in mid-air instead of hitting y=9..10 ceiling!
      const pullStrength = props.surfaceTension * 5.0;
      vxGrid[idx] += cohX * pullStrength * dt;
      vyGrid[idx] += cohY * pullStrength * dt;
      vzGrid[idx] += cohZ * pullStrength * dt;

      const targetMidAirY = 5.5;
      const altError = targetMidAirY - y;
      vyGrid[idx] += altError * 1.8 * dt;

      // Strong ceiling/floor repulsion outside y in [3..7]
      if (y <= 3 && vyGrid[idx] < 0) vyGrid[idx] = Math.max(0.6, -vyGrid[idx] * 0.5);
      if (y >= 8 && vyGrid[idx] > 0) vyGrid[idx] = Math.min(-0.8, -vyGrid[idx] * 0.5);

      const damp0G = Math.max(0.3, 1.0 - 3.2 * dt);
      vxGrid[idx] *= damp0G;
      vyGrid[idx] *= damp0G;
      vzGrid[idx] *= damp0G;
    }

    // 4. 1G Hydrostatic Spreading (with strict minPuddleHeight so puddles don't over-spread into thin films!)
    if (room.gravityG > 0) {
      let spilledOverLedge = false;
      for (const [dx, dz] of HORIZ_4) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx <= 0 || nx >= width - 1 || nz <= 0 || nz >= depth - 1) continue;
        if (isOpenLedgeDropOff(room, nx, y, nz)) {
          const nIdx = getVoxelIndex(room, nx, y, nz);
          vxGrid[idx] = dx * 2.2;
          vzGrid[idx] = dz * 2.2;
          vyGrid[idx] = -3.0;
          // Move 100% of edge cell over the waterfall lip
          if (transferFluidVolume(room, idx, nIdx, vol, MIN_FLUID_VOL)) {
            changed = true;
            spilledOverLedge = true;
            break;
          }
        }
      }
      if (spilledOverLedge && matGrid[idx] === MaterialID.AIR) continue;
      vol = volGrid[idx];

      // Natural puddle thickness threshold (Water ~0.16L, Oil ~0.28L, Cryo ~0.13L)
      const minPuddleHeight = 0.12 + props.viscosity * 0.38;
      const horizSpeed = Math.hypot(vxGrid[idx], vzGrid[idx]);
      const nearDropOff = HORIZ_4.some(([dx, dz]) =>
        hasOpenDropOffAhead(room, x, y, z, dx, dz)
      );

      if (vol > minPuddleHeight * 1.35 || horizSpeed > 1.2 || nearDropOff) {
        const excess = Math.max(0, vol - minPuddleHeight);
        const desiredTransfer = Math.max(excess * 0.55, vol * 0.35);
        const startD = (x + z + y) & 3;

        let bestDir = -1;
        let bestDot = -999;
        for (let d = 0; d < 4; d++) {
          const [dx, dz] = HORIZ_4[(startD + d) & 3];
          const nx = x + dx;
          const nz = z + dz;
          if (nx <= 0 || nx >= width - 1 || nz <= 0 || nz >= depth - 1) continue;
          const nIdx = getVoxelIndex(room, nx, y, nz);
          const nMat = matGrid[nIdx] as MaterialID;
          const dropAhead =
            nMat === MaterialID.AIR &&
            hasOpenDropOffAhead(room, x, y, z, dx, dz);
          const isCryoWaterPair =
            (mat === MaterialID.CRYO && nMat === MaterialID.WATER) ||
            (mat === MaterialID.WATER && nMat === MaterialID.CRYO);

          // Normal AIR spreading requires a proper puddle cell; near an open ledge,
          // allow shallow cells to move so catwalk waterfalls do not strand.
          const canSpreadToAir =
            nMat === MaterialID.AIR &&
            (dropAhead ||
              (desiredTransfer >= minPuddleHeight &&
                vol - desiredTransfer >= minPuddleHeight));
          const canLevelSameFluid =
            nMat === mat &&
            vol > volGrid[nIdx] + 0.04 &&
            volGrid[nIdx] < MAX_CELL_VOLUME;

          if (canSpreadToAir || canLevelSameFluid || isCryoWaterPair) {
            const dot =
              dx * vxGrid[idx] +
              dz * vzGrid[idx] +
              (canSpreadToAir || isCryoWaterPair ? 0.4 : 0);
            if (dot > bestDot) {
              bestDot = dot;
              bestDir = (startD + d) & 3;
            }
          }
        }

        if (bestDir >= 0) {
          const [dx, dz] = HORIZ_4[bestDir];
          const nIdx = getVoxelIndex(room, x + dx, y, z + dz);
          const nMat = matGrid[nIdx] as MaterialID;
          const dropAhead =
            nMat === MaterialID.AIR &&
            hasOpenDropOffAhead(room, x, y, z, dx, dz);
          const minTarget = nMat === MaterialID.AIR
            ? dropAhead
              ? MIN_FLUID_VOL
              : minPuddleHeight
            : MIN_FLUID_VOL;
          const transferAmount = dropAhead ? vol : desiredTransfer;
          if (
            transferFluidVolume(room, idx, nIdx, transferAmount, minTarget)
          ) {
            changed = true;
            if (matGrid[idx] === MaterialID.AIR) continue;
            vol = volGrid[idx];
          }
        }
      } else if (vol < minPuddleHeight && sameNeighborCount > 0 && !nearDropOff) {
        // Surface tension retracts thin puddle fringes (< minPuddleHeight) back into adjacent pool cells!
        for (const [dx, dz] of HORIZ_4) {
          const nx = x + dx;
          const nz = z + dz;
          if (!inRoomBounds(room, nx, y, nz)) continue;
          const nIdx = getVoxelIndex(room, nx, y, nz);
          if (
            matGrid[nIdx] === mat &&
            volGrid[nIdx] >= vol &&
            volGrid[nIdx] + vol <= MAX_CELL_VOLUME
          ) {
            if (transferFluidVolume(room, idx, nIdx, vol, MIN_FLUID_VOL)) {
              changed = true;
              break;
            }
          }
        }
      }
    } else {
      // 5. 0G Whole-Cell Advection & 26-Neighbor Cohesive Compaction (Zero Orphan Splits!)
      const vx = vxGrid[idx];
      const vy = vyGrid[idx];
      const vz = vzGrid[idx];
      const speed = Math.hypot(vx, vy, vz);
      // Keep 0G vertical movement inside the advertised mid-air suspension zone
      // (y = 3..7 for the default 12-voxel-tall room), but only one cell per tick.
      const maxSuspensionY = Math.max(3, Math.min(height - 4, 7));

      // If a cell escaped above the band (e.g. a shattered high vat), walk it down one
      // cell per tick. This is deliberately checked before horizontal cohesion so it
      // cannot stay parked at y=8..10 just because a horizontal velocity is larger.
      if (y > maxSuspensionY) {
        const downIdx = getVoxelIndex(room, x, y - 1, z);
        const downMat = matGrid[downIdx] as MaterialID;
        if (
          !MATERIAL_TABLE[downMat].isSolid &&
          (downMat === mat || downMat === MaterialID.AIR) &&
          transferFluidVolume(room, idx, downIdx, vol, MIN_FLUID_VOL)
        ) {
          changed = true;
          if (matGrid[idx] === MaterialID.AIR) continue;
          vol = volGrid[idx];
        }
      }

      // First try 26-neighbor (3x3x3) cohesive merging into the fullest nearby same-fluid cell
      let bestMergeIdx = -1;
      let bestMergeVol = vol;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (
              nx <= 0 ||
              nx >= width - 1 ||
              ny <= 2 ||
              ny >= height - 2 ||
              nz <= 0 ||
              nz >= depth - 1
            ) {
              continue;
            }
            const nIdx = getVoxelIndex(room, nx, ny, nz);
            if (
              matGrid[nIdx] === mat &&
              volGrid[nIdx] >= bestMergeVol &&
              volGrid[nIdx] < MAX_CELL_VOLUME &&
              hasClearMergePath(room, idx, nIdx)
            ) {
              bestMergeVol = volGrid[nIdx];
              bestMergeIdx = nIdx;
            }
          }
        }
      }

      if (bestMergeIdx >= 0 && vol < MAX_CELL_VOLUME) {
        // Transfer up to 100% of vol into the fuller neighbor so droplets coalesce cleanly!
        if (transferFluidVolume(room, idx, bestMergeIdx, vol, MIN_FLUID_VOL)) {
          changed = true;
          if (matGrid[idx] === MaterialID.AIR) continue;
          vol = volGrid[idx];
        }
      }

      // Second: Whole-Cell 0G Advection along velocity/cohesion vector (moves 100% of cell, never 85%!)
      // The 5x5x5 cohesion field settles around ~0.4–0.5 speed for separated droplets;
      // a lower threshold lets them actually approach and merge instead of hovering forever.
      if (speed > 0.3) {
        const stepX =
          Math.abs(vx) >= Math.abs(vy) && Math.abs(vx) >= Math.abs(vz) ? Math.sign(vx) : 0;
        const stepY =
          Math.abs(vy) > Math.abs(vx) && Math.abs(vy) >= Math.abs(vz) ? Math.sign(vy) : 0;
        const stepZ = stepX === 0 && stepY === 0 ? Math.sign(vz) : 0;

        // Clamp vertical movement to one cell inside the suspension band; clamping
        // directly to the band would teleport high-up fluid through solid layers.
        const nx = x + stepX;
        let ny = y;
        if (stepX === 0 && stepZ === 0) {
          if (stepY < 0 && y > 3) ny = y - 1;
          else if (stepY > 0 && y < maxSuspensionY) ny = y + 1;
        }
        const nz = z + stepZ;

        if (
          (nx !== x || ny !== y || nz !== z) &&
          nx > 0 &&
          nx < width - 1 &&
          nz > 0 &&
          nz < depth - 1
        ) {
          const targetIdx = getVoxelIndex(room, nx, ny, nz);
          const targetMat = matGrid[targetIdx] as MaterialID;

          if (MATERIAL_TABLE[targetMat].isSolid) {
            if (stepX !== 0) vxGrid[idx] = -vx * 0.45;
            if (stepY !== 0) vyGrid[idx] = -vy * 0.45;
            if (stepZ !== 0) vzGrid[idx] = -vz * 0.45;
          } else if (
            targetMat === mat ||
            (targetMat === MaterialID.AIR && (speed > 1.2 || sameNeighborCount === 0))
          ) {
            // Move 100% of `vol` so moving into AIR never leaves a 15% orphan fragment behind!
            if (transferFluidVolume(room, idx, targetIdx, vol, vol)) {
              changed = true;
            }
          }
        }
      }
    }
  }

  if (changed) {
    room.dirtyFluidRender = true;
    recountActiveCells(room);
  }
}
