// Strictly Mass-Conserving 3D Voxel Fluid Stencil (0.0 - 1.0L Volume Contract)
// - Non-destructive 6-neighbor Cryo + Water -> Ice phase transition (top-down, bottom-up & side-by-side)
// - 1G Ledge Suction Gradient for catwalk waterfalls
// - 0G Surface-Tension Cohesion

import {
  MAX_CELL_VOLUME,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
} from './types';
import type { RoomGrid, GlassVatTank } from './types';
import { setVoxel, recountActiveCells } from './roomGen';

const MIN_FLUID_VOL = 0.02;

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
      dx * 3.2,
      room.gravityG === 0 ? 1.6 : 0.5,
      dz * 3.2 + (y >= 7 ? 2.8 : 0)
    );
  }

  const vIdx = room.vats.indexOf(vat);
  if (vIdx >= 0) room.vats.splice(vIdx, 1);

  room.dirtyStaticRender = true;
  room.dirtyFluidRender = true;
  recountActiveCells(room);
}

export function applyZeroGLiftImpulseToGrid(room: RoomGrid): void {
  const { width, height, depth, matGrid, vyGrid } = room;
  for (let y = 1; y < height - 1; y++) {
    for (let z = 1; z < depth - 1; z++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = getVoxelIndex(room, x, y, z);
        const mat = matGrid[idx] as MaterialID;
        if (!isFluidMaterial(mat)) continue;
        vyGrid[idx] = 2.8 + ((x * 7 + z * 13) % 5) * 0.35;
      }
    }
  }
  room.dirtyFluidRender = true;
}

/**
 * Non-destructive Cryo + Water -> Ice Phase Transition:
 * Freezes the Water cell in-place into MaterialID.ICE while preserving its exact volGrid[waterIdx]
 * and keeping Cryo's volume 100% intact (zero mass created or destroyed!).
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

  if (room.volGrid[waterIdx] < MIN_FLUID_VOL || room.volGrid[cryoIdx] < MIN_FLUID_VOL) {
    return false;
  }

  // Convert the Water cell in-place to solid Ice, keeping its exact volume in volGrid!
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
 * 100% Mass-Conserving Fluid Transfer (strictly respects MAX_CELL_VOLUME = 1.0)
 */
function transferFluidVolume(
  room: RoomGrid,
  fromIdx: number,
  toIdx: number,
  requestedAmount: number
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

  // Never leave a sub-threshold sliver behind: either move 100% of fromVol or hold intact
  if (fromVol - actual < MIN_FLUID_VOL) {
    if (availSpace >= fromVol) {
      actual = fromVol;
    } else if (actual < MIN_FLUID_VOL) {
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
 * Pure 3D Cellular Stencil Step (20 Hz):
 * - 100% Mass-Conserving within [0.0, 1.0] per cell
 * - 6-neighbor Cryo + Water freezing (vertical & horizontal)
 * - 1G Ledge Suction Waterfalls & Archimedes Density Stratification
 * - 0G Surface-Tension Cohesive Clustering
 */
export function step3DFluidStencil(room: RoomGrid, dt: number): void {
  const { width, height, depth, matGrid, volGrid, vxGrid, vyGrid, vzGrid } = room;
  let changed = false;

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

  if (activeIndices.length === 0) return;

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

    // 0. Check 6-Neighbor Cryo + Water Contact FIRST (handles top-down, bottom-up, and side-by-side!)
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

    // 1. 1G Vertical Free-Fall & Archimedes Density Stratification
    if (room.gravityG > 0 && y > 1) {
      const belowIdx = getVoxelIndex(room, x, y - 1, z);
      const belowMat = matGrid[belowIdx] as MaterialID;

      if (belowMat === MaterialID.AIR || belowMat === mat) {
        vyGrid[idx] = Math.min(-3.5, vyGrid[idx] - 18.0 * dt);
        const dropFraction = vol > 0.45 ? 0.8 : 1.0;
        if (transferFluidVolume(room, idx, belowIdx, vol * dropFraction)) {
          changed = true;
          if (matGrid[idx] === MaterialID.AIR) continue;
          vol = volGrid[idx];
        }
      } else if (isFluidMaterial(belowMat)) {
        const belowProps = MATERIAL_TABLE[belowMat];
        // Archimedes Buoyancy: Denser Water (1.0) sinks underneath lighter Oil (0.82)
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
        const splashSpeed = Math.min(4.5, Math.abs(vyGrid[idx]) * 0.45);
        const angle = ((x * 17 + z * 31) % 8) * (Math.PI / 4);
        vxGrid[idx] += Math.cos(angle) * splashSpeed;
        vzGrid[idx] += Math.sin(angle) * splashSpeed;
        vyGrid[idx] = 0;
      }
    }

    // 2. Compute 3D Surface Tension / Cohesion Gradient & 1G Ledge Suction Gradient
    let cohX = 0;
    let cohY = 0;
    let cohZ = 0;
    let sameNeighborCount = 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!inRoomBounds(room, nx, ny, nz)) continue;
          const nIdx = getVoxelIndex(room, nx, ny, nz);
          if (matGrid[nIdx] === mat) {
            const nVol = volGrid[nIdx];
            cohX += dx * nVol;
            cohY += dy * nVol;
            cohZ += dz * nVol;
            sameNeighborCount++;
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
            const weight = 3.2 / dist;
            ledgePullX += dx * weight;
            ledgePullZ += dz * weight;
            break;
          }
        }
      }

      vxGrid[idx] += ledgePullX * dt * 8.0;
      vzGrid[idx] += ledgePullZ * dt * 8.0;

      const damp = Math.max(0.25, 1.0 - (1.4 + props.viscosity * 3.5) * dt);
      vxGrid[idx] *= damp;
      vzGrid[idx] *= damp;
    } else {
      const pullStrength = props.surfaceTension * 4.2;
      vxGrid[idx] += cohX * pullStrength * dt;
      vyGrid[idx] += cohY * pullStrength * dt;
      vzGrid[idx] += cohZ * pullStrength * dt;

      if (y <= 2 && vyGrid[idx] < 0) vyGrid[idx] = -vyGrid[idx] * 0.6 + 0.8;
      if (y >= height - 2 && vyGrid[idx] > 0) vyGrid[idx] = -vyGrid[idx] * 0.6;

      const damp0G = Math.max(0.4, 1.0 - 1.5 * dt);
      vxGrid[idx] *= damp0G;
      vyGrid[idx] *= damp0G;
      vzGrid[idx] *= damp0G;
    }

    // 3. 1G Hydrostatic Spreading & Ledge Waterfall Spillover
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
          if (transferFluidVolume(room, idx, nIdx, vol * 0.85)) {
            changed = true;
            spilledOverLedge = true;
            break;
          }
        }
      }
      if (spilledOverLedge && matGrid[idx] === MaterialID.AIR) continue;
      vol = volGrid[idx];

      const minPuddleHeight = 0.08 + props.viscosity * 0.32;
      const horizSpeed = Math.hypot(vxGrid[idx], vzGrid[idx]);

      if (vol > minPuddleHeight || horizSpeed > 0.6) {
        const flowRate = Math.min(
          0.75,
          (1.0 - props.viscosity * 1.3) * 0.38 + horizSpeed * 0.12
        );
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
          const isCryoWaterPair =
            (mat === MaterialID.CRYO && nMat === MaterialID.WATER) ||
            (mat === MaterialID.WATER && nMat === MaterialID.CRYO);

          if (
            nMat === MaterialID.AIR ||
            (nMat === mat && vol > volGrid[nIdx] + 0.03 && volGrid[nIdx] < MAX_CELL_VOLUME) ||
            isCryoWaterPair
          ) {
            const dot =
              dx * vxGrid[idx] +
              dz * vzGrid[idx] +
              (nMat === MaterialID.AIR || isCryoWaterPair ? 0.5 : 0);
            if (dot > bestDot) {
              bestDot = dot;
              bestDir = (startD + d) & 3;
            }
          }
        }

        if (bestDir >= 0) {
          const [dx, dz] = HORIZ_4[bestDir];
          const nIdx = getVoxelIndex(room, x + dx, y, z + dz);
          if (transferFluidVolume(room, idx, nIdx, vol * flowRate)) {
            changed = true;
            if (matGrid[idx] === MaterialID.AIR) continue;
            vol = volGrid[idx];
          }
        }
      }
    } else {
      // 4. 0G Advection & Surface-Tension Compaction
      const vx = vxGrid[idx];
      const vy = vyGrid[idx];
      const vz = vzGrid[idx];
      const speed = Math.hypot(vx, vy, vz);

      if (speed > 0.4) {
        const stepX =
          Math.abs(vx) >= Math.abs(vy) && Math.abs(vx) >= Math.abs(vz) ? Math.sign(vx) : 0;
        const stepY =
          Math.abs(vy) > Math.abs(vx) && Math.abs(vy) >= Math.abs(vz) ? Math.sign(vy) : 0;
        const stepZ = stepX === 0 && stepY === 0 ? Math.sign(vz) : 0;

        const nx = x + stepX;
        const ny = Math.max(2, Math.min(height - 2, y + stepY));
        const nz = z + stepZ;

        if (nx > 0 && nx < width - 1 && nz > 0 && nz < depth - 1) {
          const targetIdx = getVoxelIndex(room, nx, ny, nz);
          const targetMat = matGrid[targetIdx] as MaterialID;

          if (MATERIAL_TABLE[targetMat].isSolid) {
            if (stepX !== 0) vxGrid[idx] = -vx * 0.45;
            if (stepY !== 0) vyGrid[idx] = -vy * 0.45;
            if (stepZ !== 0) vzGrid[idx] = -vz * 0.45;
          } else if (targetMat === mat || speed > 1.6 || sameNeighborCount <= 2) {
            const frac = Math.min(0.85, speed * 0.25);
            if (transferFluidVolume(room, idx, targetIdx, vol * frac)) {
              changed = true;
              if (matGrid[idx] === MaterialID.AIR) continue;
              vol = volGrid[idx];
            }
          }
        }
      }

      // 0G Cohesive Compaction within MAX_CELL_VOLUME = 1.0
      let bestNeighborIdx = -1;
      let bestNeighborVol = vol;
      for (const [dx, dy, dz] of STENCIL_6) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx <= 0 || nx >= width - 1 || ny <= 1 || ny >= height - 1 || nz <= 0 || nz >= depth - 1)
          continue;
        const nIdx = getVoxelIndex(room, nx, ny, nz);
        if (
          matGrid[nIdx] === mat &&
          volGrid[nIdx] >= bestNeighborVol &&
          volGrid[nIdx] < MAX_CELL_VOLUME
        ) {
          bestNeighborVol = volGrid[nIdx];
          bestNeighborIdx = nIdx;
        }
      }
      if (bestNeighborIdx >= 0 && vol < MAX_CELL_VOLUME) {
        if (transferFluidVolume(room, idx, bestNeighborIdx, vol * 0.65)) {
          changed = true;
        }
      }
    }
  }

  if (changed) {
    room.dirtyFluidRender = true;
    recountActiveCells(room);
  }
}
