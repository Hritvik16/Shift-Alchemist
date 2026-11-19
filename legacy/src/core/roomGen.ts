// Parameterized 3D Voxel Room Generator + Sub-Voxel Quanta Spawner

import {
  VOXEL_SIZE,
  MAX_CELL_VOLUME,
  QUANTUM_VOLUME,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
} from './types';
import type { RoomGrid, DynamicEntity, GlassVatTank, FluidQuantum } from './types';

let nextQuantumId = 1;

export function createRoomGrid(width = 48, height = 12, depth = 48): RoomGrid {
  const total = width * height * depth;
  const tempGrid = new Float32Array(total);
  tempGrid.fill(20.0);

  return {
    width,
    height,
    depth,
    matGrid: new Uint8Array(total),
    volGrid: new Float32Array(total),
    tempGrid,
    voltGrid: new Float32Array(total),
    vxGrid: new Float32Array(total),
    vyGrid: new Float32Array(total),
    vzGrid: new Float32Array(total),
    gravityG: 1.0,
    dirtyStaticRender: true,
    dirtyFluidRender: true,
    activeStencilCount: 0,
    gridFluidVolume: 0,
    iceVolume: 0,
    vatFluidVolume: 0,
    totalFluidVolume: 0,
    fluidQuanta: [],
    entities: [],
    vats: [],
    airBursts: [],
    lastCombatLog:
      '60 FPS Sub-Voxel Noita Fluids Active — Shatter a tank or blast pools with L-Click Air!',
  };
}

export function spawnFluidQuantaInBox(
  room: RoomGrid,
  mat: MaterialID,
  totalVolume: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  vx = 0,
  vy = 0,
  vz = 0
): void {
  if (totalVolume <= 1e-6) return;
  const count = Math.max(1, Math.round(totalVolume / QUANTUM_VOLUME));
  const exactVolPerQuantum = totalVolume / count;
  const defaultTemp = MATERIAL_TABLE[mat].defaultTemp;

  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const phi1 = (i * 0.61803398875) % 1;
    const phi2 = (i * 0.38196601125) % 1;

    const qx = minX + (maxX - minX) * phi1;
    const qy = minY + (maxY - minY) * t;
    const qz = minZ + (maxZ - minZ) * phi2;

    const q: FluidQuantum = {
      id: nextQuantumId++,
      mat,
      vol: exactVolPerQuantum,
      x: qx,
      y: qy,
      z: qz,
      vx: vx + (phi1 - 0.5) * 0.25,
      vy: vy,
      vz: vz + (phi2 - 0.5) * 0.25,
      temp: defaultTemp,
      volt: 0,
      shimmer: (i * 0.7548776662) % 1,
      neighborCount: 2,
      grounded: room.gravityG > 0 && qy - minY < 0.12,
    };
    room.fluidQuanta.push(q);
  }
}

/**
 * Sets a macro voxel cell:
 * - Preserves existing liquid quanta when adding fluid or carving solid blocks (AIR)
 * - Removes ICE quanta only when carving an ICE voxel to AIR
 */
export function setVoxel(
  room: RoomGrid,
  x: number,
  y: number,
  z: number,
  mat: MaterialID,
  vol = 1.0,
  vx = 0,
  vy = 0,
  vz = 0
): void {
  if (!inRoomBounds(room, x, y, z)) return;
  const idx = getVoxelIndex(room, x, y, z);
  const prevMat = room.matGrid[idx] as MaterialID;
  const clampedVol =
    mat === MaterialID.AIR ? 0.0 : Math.max(0.0, Math.min(MAX_CELL_VOLUME, vol));

  // If carving an ICE voxel to AIR, remove frozen ICE quanta in this cell (never delete liquid quanta!)
  if (mat === MaterialID.AIR && prevMat === MaterialID.ICE) {
    for (let i = room.fluidQuanta.length - 1; i >= 0; i--) {
      const q = room.fluidQuanta[i];
      if (q.mat !== MaterialID.ICE) continue;
      const qvx = Math.floor(q.x / VOXEL_SIZE);
      const qvy = Math.floor(q.y / VOXEL_SIZE);
      const qvz = Math.floor(q.z / VOXEL_SIZE);
      if (qvx === x && qvy === y && qvz === z) {
        room.fluidQuanta.splice(i, 1);
      }
    }
  }

  // If placing a fluid voxel, add quanta without destroying existing fluid in the cell
  if ((MATERIAL_TABLE[mat].isFluid || mat === MaterialID.ICE) && clampedVol > 0) {
    const prevVol =
      MATERIAL_TABLE[prevMat].isFluid || prevMat === MaterialID.ICE
        ? room.volGrid[idx]
        : 0.0;
    room.matGrid[idx] = mat;
    room.volGrid[idx] = prevVol + clampedVol;
    room.tempGrid[idx] = MATERIAL_TABLE[mat].defaultTemp;
    room.voltGrid[idx] = 0.0;
    room.vxGrid[idx] = vx;
    room.vyGrid[idx] = vy;
    room.vzGrid[idx] = vz;

    const wx0 = (x + 0.1) * VOXEL_SIZE;
    const wx1 = (x + 0.9) * VOXEL_SIZE;
    const wy0 = (y + 0.08) * VOXEL_SIZE;
    const wy1 = (y + 0.45) * VOXEL_SIZE;
    const wz0 = (z + 0.1) * VOXEL_SIZE;
    const wz1 = (z + 0.9) * VOXEL_SIZE;
    spawnFluidQuantaInBox(
      room,
      mat,
      clampedVol,
      wx0,
      wy0,
      wz0,
      wx1,
      wy1,
      wz1,
      vx,
      vy,
      vz
    );
  } else if (mat === MaterialID.AIR && MATERIAL_TABLE[prevMat].isFluid) {
    // Right-click carving on a liquid cell leaves liquid quanta intact
    return;
  } else {
    room.matGrid[idx] = mat;
    room.volGrid[idx] = clampedVol;
    room.tempGrid[idx] = MATERIAL_TABLE[mat].defaultTemp;
    room.voltGrid[idx] = 0.0;
    room.vxGrid[idx] = vx;
    room.vyGrid[idx] = vy;
    room.vzGrid[idx] = vz;
  }

  if (
    mat === MaterialID.HULL_STEEL ||
    mat === MaterialID.ICE ||
    mat === MaterialID.GLASS_VAT ||
    prevMat === MaterialID.HULL_STEEL ||
    prevMat === MaterialID.ICE ||
    prevMat === MaterialID.GLASS_VAT
  ) {
    room.dirtyStaticRender = true;
  }
  room.dirtyFluidRender = true;
}

export function recountActiveCells(room: RoomGrid): number {
  let gridFluid = 0;
  let iceVol = 0;

  for (let i = 0; i < room.fluidQuanta.length; i++) {
    const q = room.fluidQuanta[i];
    if (q.mat === MaterialID.ICE) {
      iceVol += q.vol;
    } else if (MATERIAL_TABLE[q.mat].isFluid) {
      gridFluid += q.vol;
    }
  }

  let vatFluid = 0;
  for (const vat of room.vats) {
    vatFluid += vat.fluidVolume;
  }

  room.activeStencilCount = room.fluidQuanta.length + room.entities.length;
  room.gridFluidVolume = gridFluid;
  room.iceVolume = iceVol;
  room.vatFluidVolume = vatFluid;
  room.totalFluidVolume = gridFluid + iceVol + vatFluid;
  return room.activeStencilCount;
}

let nextEntityId = 1;
let nextVatId = 1;

export function spawnDynamicEntity(
  room: RoomGrid,
  kind: 'crate' | 'alien',
  x: number,
  y: number,
  z: number
): DynamicEntity {
  const isAlien = kind === 'alien';
  const ent: DynamicEntity = {
    id: nextEntityId++,
    kind,
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: isAlien ? Math.PI * 0.15 : 0,
    radius: isAlien ? 0.36 : 0.34,
    height: isAlien ? 1.3 : 0.72,
    mass: isAlien ? 70 : 45,
    hp: isAlien ? 120 : 60,
    maxHp: isAlien ? 120 : 60,
    grounded: true,
    floorY: y,
    hitStunTimer: 0,
    slamFlashTimer: 0,
    lastImpactDamage: 0,
    proxyVoxelIdx: -1,
  };
  room.entities.push(ent);
  recountActiveCells(room);
  return ent;
}

export function spawnCylindricalVat(
  room: RoomGrid,
  cx: number,
  baseY: number,
  cz: number,
  fluidMat: MaterialID
): GlassVatTank {
  const voxelIndices: number[] = [];
  for (let dy = 0; dy <= 2; dy++) {
    const vy = baseY + dy;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const vx = cx + dx;
        const vz = cz + dz;
        if (inRoomBounds(room, vx, vy, vz)) {
          setVoxel(room, vx, vy, vz, MaterialID.GLASS_VAT, 1.0);
          voxelIndices.push(getVoxelIndex(room, vx, vy, vz));
        }
      }
    }
  }

  const vat: GlassVatTank = {
    id: nextVatId++,
    x: (cx + 1.0) * VOXEL_SIZE,
    y: baseY * VOXEL_SIZE,
    z: (cz + 1.0) * VOXEL_SIZE,
    radius: 0.62,
    height: 1.45,
    fluidMat,
    fluidVolume: voxelIndices.length * MAX_CELL_VOLUME,
    voxelIndices,
  };
  room.vats.push(vat);
  recountActiveCells(room);
  return vat;
}

export function generateMilestoneTestRoom(
  width = 48,
  height = 12,
  depth = 48
): RoomGrid {
  const room = createRoomGrid(width, height, depth);

  const pitMinX = Math.floor(width * 0.5);
  const pitMaxX = width - 7;
  const pitMinZ = Math.floor(depth * 0.42);
  const pitMaxZ = depth - 9;

  const isPitFloor = (x: number, z: number): boolean =>
    x >= pitMinX && x <= pitMaxX && z >= pitMinZ && z <= pitMaxZ;

  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      setVoxel(room, x, 0, z, MaterialID.HULL_STEEL);
      if (!isPitFloor(x, z)) {
        setVoxel(room, x, 1, z, MaterialID.HULL_STEEL);
        setVoxel(room, x, 2, z, MaterialID.HULL_STEEL);
      }
    }
  }

  for (let z = pitMinZ + 5; z <= Math.min(pitMaxZ - 2, pitMinZ + 12); z++) {
    setVoxel(room, pitMinX, 1, z, MaterialID.HULL_STEEL);
  }
  for (let x = pitMinX + 5; x <= Math.min(pitMaxX - 2, pitMinX + 11); x++) {
    setVoxel(room, x, 1, pitMinZ, MaterialID.HULL_STEEL);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setVoxel(room, x, y, 0, MaterialID.HULL_STEEL);
      setVoxel(room, x, y, depth - 1, MaterialID.HULL_STEEL);
    }
    for (let z = 0; z < depth; z++) {
      setVoxel(room, 0, y, z, MaterialID.HULL_STEEL);
      setVoxel(room, width - 1, y, z, MaterialID.HULL_STEEL);
    }
  }

  const catwalkDepth = Math.max(7, Math.floor(depth * 0.18));
  const eastWingStart = width - 8;
  for (let z = 1; z <= catwalkDepth; z++) {
    for (let x = 1; x <= width - 2; x++) {
      setVoxel(room, x, 7, z, MaterialID.HULL_STEEL);
    }
  }
  for (let z = catwalkDepth + 1; z <= Math.floor(depth * 0.46); z++) {
    for (let x = eastWingStart; x <= width - 2; x++) {
      setVoxel(room, x, 7, z, MaterialID.HULL_STEEL);
    }
  }

  for (let px = 8; px < width - 6; px += 12) {
    for (let y = 3; y < 7; y++) {
      setVoxel(room, px, y, catwalkDepth, MaterialID.HULL_STEEL);
    }
  }

  const pilX = Math.floor(width * 0.34);
  const pilZ = Math.floor(depth * 0.46);
  for (let y = 3; y <= 9; y++) {
    for (let z = pilZ; z <= pilZ + 2; z++) {
      for (let x = pilX; x <= pilX + 2; x++) {
        setVoxel(room, x, y, z, MaterialID.HULL_STEEL);
      }
    }
  }

  let stepZ = catwalkDepth + 10;
  for (let stepY = 3; stepY <= 7; stepY++) {
    for (let dz = 0; dz < 2; dz++) {
      const z = stepZ - dz;
      for (let x = 1; x <= 5; x++) {
        for (let y = 3; y <= stepY; y++) {
          setVoxel(room, x, y, z, MaterialID.HULL_STEEL);
        }
      }
    }
    stepZ -= 2;
  }

  spawnCylindricalVat(room, 17, 8, catwalkDepth - 2, MaterialID.WATER);
  spawnCylindricalVat(room, 11, 3, 15, MaterialID.OIL);
  spawnCylindricalVat(room, pitMinX + 4, 3, pitMinZ - 3, MaterialID.CRYO);

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const vol = dx === 0 && dz === 0 ? 0.8 : 0.65;
      setVoxel(room, pitMinX + 4 + dx, 1, pitMinZ + 4 + dz, MaterialID.WATER, vol);
      setVoxel(room, pitMinX + 11 + dx, 1, pitMinZ + 9 + dz, MaterialID.OIL, vol);
      setVoxel(room, pitMinX + 5 + dx, 1, pitMinZ + 13 + dz, MaterialID.CRYO, vol);
    }
  }

  spawnDynamicEntity(room, 'crate', 7.0, 1.5, 13.5);
  spawnDynamicEntity(room, 'crate', 8.2, 1.5, 13.5);
  spawnDynamicEntity(room, 'crate', 11.5, 1.5, 11.5);
  spawnDynamicEntity(room, 'crate', 19.5, 4.0, 2.5);

  spawnDynamicEntity(room, 'alien', 10.5, 1.5, 18.5);
  spawnDynamicEntity(room, 'alien', 12.0, 1.5, 2.5);
  spawnDynamicEntity(room, 'alien', 16.5, 0.5, 14.5);
  spawnDynamicEntity(room, 'alien', 14.0, 4.0, 2.5);

  recountActiveCells(room);
  return room;
}
