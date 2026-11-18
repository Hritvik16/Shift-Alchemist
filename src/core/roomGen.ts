// Parameterized 3D Voxel Room Generator (Pure Grid State — Zero Three.js or DOM imports)

import {
  VOXEL_SIZE,
  MAX_CELL_VOLUME,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
} from './types';
import type { RoomGrid, DynamicEntity, GlassVatTank } from './types';

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
    entities: [],
    vats: [],
    airBursts: [],
    lastCombatLog:
      'Shatter the Catwalk Water Tank in 1G to test the Waterfall & Strict Mass Conservation!',
  };
}

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

  room.matGrid[idx] = mat;
  room.volGrid[idx] = clampedVol;
  room.tempGrid[idx] = MATERIAL_TABLE[mat].defaultTemp;
  room.voltGrid[idx] = 0.0;
  room.vxGrid[idx] = vx;
  room.vyGrid[idx] = vy;
  room.vzGrid[idx] = vz;

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
  let count = 0;
  let gridFluid = 0;
  let iceVol = 0;
  const total = room.matGrid.length;

  for (let i = 0; i < total; i++) {
    const mat = room.matGrid[i] as MaterialID;
    if (mat !== MaterialID.AIR && mat !== MaterialID.HULL_STEEL) {
      count++;
      if (MATERIAL_TABLE[mat].isFluid) {
        gridFluid += room.volGrid[i];
      } else if (mat === MaterialID.ICE) {
        iceVol += room.volGrid[i];
      }
    }
  }

  let vatFluid = 0;
  for (const vat of room.vats) {
    vatFluid += vat.fluidVolume;
  }

  room.activeStencilCount = count + room.entities.length;
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

  // 12 voxels x 1.0L max cell volume = 12.0L exact fluid capacity per tank
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

  // 1. Solid Main Deck Floor (y = 0..2) & Sunken Bilge Pit (y = 0)
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      setVoxel(room, x, 0, z, MaterialID.HULL_STEEL);
      if (!isPitFloor(x, z)) {
        setVoxel(room, x, 1, z, MaterialID.HULL_STEEL);
        setVoxel(room, x, 2, z, MaterialID.HULL_STEEL);
      }
    }
  }

  // Walkable steps out of the sunken pit
  for (let z = pitMinZ + 5; z <= Math.min(pitMaxZ - 2, pitMinZ + 12); z++) {
    setVoxel(room, pitMinX, 1, z, MaterialID.HULL_STEEL);
  }
  for (let x = pitMinX + 5; x <= Math.min(pitMaxX - 2, pitMinX + 11); x++) {
    setVoxel(room, x, 1, pitMinZ, MaterialID.HULL_STEEL);
  }

  // 2. All 4 Outer Bulkheads (North, West, East, and South) built to full height
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

  // 3. Elevated North Catwalk (y = 7 -> 4.0m deck) & East Overlook Wing
  const catwalkDepth = Math.max(7, Math.floor(depth * 0.18)); // z = 8 for depth = 48
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

  // Support columns under the catwalk
  for (let px = 8; px < width - 6; px += 12) {
    for (let y = 3; y < 7; y++) {
      setVoxel(room, px, y, catwalkDepth, MaterialID.HULL_STEEL);
    }
  }

  // 4. Central Heavy Reactor Pillar
  const pilX = Math.floor(width * 0.34);
  const pilZ = Math.floor(depth * 0.46);
  for (let y = 3; y <= 9; y++) {
    for (let z = pilZ; z <= pilZ + 2; z++) {
      for (let x = pilX; x <= pilX + 2; x++) {
        setVoxel(room, x, y, z, MaterialID.HULL_STEEL);
      }
    }
  }

  // 5. West Stairs (x = 1..5) climbing from y = 3 up to y = 7 catwalk:
  // Starts at catwalkDepth + 10 (z = 18) so the top step (y = 7 at z = 9..10) connects flush to z = 8!
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

  // 6. Spawn Cylindrical Pressurized Glass Vats (3 x 12.0L = 36.0L contained fluid)
  spawnCylindricalVat(room, 17, 8, catwalkDepth - 2, MaterialID.WATER);
  spawnCylindricalVat(room, 11, 3, 15, MaterialID.OIL);
  spawnCylindricalVat(room, pitMinX + 4, 3, pitMinZ - 3, MaterialID.CRYO);

  // 7. Initial Fluid Pools in Sunken Bilge Pit (18.0L Grid Fluid -> 54.0L Total with Vats)
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const vol = dx === 0 && dz === 0 ? 0.8 : 0.65; // 6.0L per pool x 3 pools = 18.0L
      setVoxel(room, pitMinX + 4 + dx, 1, pitMinZ + 4 + dz, MaterialID.WATER, vol);
      setVoxel(room, pitMinX + 11 + dx, 1, pitMinZ + 9 + dz, MaterialID.OIL, vol);
      setVoxel(room, pitMinX + 5 + dx, 1, pitMinZ + 13 + dz, MaterialID.CRYO, vol);
    }
  }

  // 8. Spawn Dynamic Loose Wood Crates (Crate #4 safely on catwalk at x = 19.5m, away from East wall!)
  spawnDynamicEntity(room, 'crate', 7.0, 1.5, 13.5);
  spawnDynamicEntity(room, 'crate', 8.2, 1.5, 13.5);
  spawnDynamicEntity(room, 'crate', 11.5, 1.5, 11.5);
  spawnDynamicEntity(room, 'crate', 19.5, 4.0, 2.5);

  // 9. Spawn Alien Target Dummies
  spawnDynamicEntity(room, 'alien', 10.5, 1.5, 18.5);
  spawnDynamicEntity(room, 'alien', 12.0, 1.5, 2.5); // Under North Catwalk
  spawnDynamicEntity(room, 'alien', 16.5, 0.5, 14.5);
  spawnDynamicEntity(room, 'alien', 14.0, 4.0, 2.5);

  recountActiveCells(room);
  return room;
}
