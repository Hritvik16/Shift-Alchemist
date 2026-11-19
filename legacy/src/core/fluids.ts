// Pure Emergent 60 FPS 3D Incompressible SPH & Capillary Cohesion Engine
// - 1G: Vertical stacking collapses outward into flat sheets, while horizontal capillary cohesion
//       (eqDist = 0.09m) + XSPH velocity coupling binds contiguous drops into cohesive pools & streams.
// - 0G: Isotropic 3D surface-tension cohesion pulls nearby droplets into compact floating orbs.

import {
  VOXEL_SIZE,
  MaterialID,
  MATERIAL_TABLE,
  getVoxelIndex,
  inRoomBounds,
} from './types';
import type { RoomGrid, GlassVatTank, FluidQuantum } from './types';
import { recountActiveCells, spawnFluidQuantaInBox } from './roomGen';

export const MIN_FLUID_VOL = 0.05;
const QUANTUM_RADIUS = 0.042;
// Must be >= the largest neighbor radius below (0.32 in 0G), otherwise droplets
// exactly two hash cells apart never enter the same 3x3 search window.
const HASH_CELL_SIZE = 0.32;

export function isFluidMaterial(mat: MaterialID): boolean {
  return (
    mat === MaterialID.WATER ||
    mat === MaterialID.OIL ||
    mat === MaterialID.CRYO
  );
}

function isRigidObstacleVoxel(
  room: RoomGrid,
  vx: number,
  vy: number,
  vz: number,
  includeIce = false
): boolean {
  if (!inRoomBounds(room, vx, vy, vz)) return true;
  const mat = room.matGrid[getVoxelIndex(room, vx, vy, vz)] as MaterialID;
  if (includeIce && mat === MaterialID.ICE) return true;
  return (
    mat === MaterialID.HULL_STEEL ||
    mat === MaterialID.GLASS_VAT ||
    mat === MaterialID.WOOD_CRATE
  );
}

/**
 * Quanta already inside an ICE cell need to be able to leave that cell;
 * otherwise they are born inside a collider and can never move. They must still
 * collide with any *other* ICE cell. This applies to water as well as ice
 * quanta: a mixed cell can contain both.
 */
function isBlockedQuantumVoxel(
  room: RoomGrid,
  nextVx: number,
  nextVy: number,
  nextVz: number,
  curVx: number,
  curVy: number,
  curVz: number
): boolean {
  const sameCell =
    nextVx === curVx && nextVy === curVy && nextVz === curVz;
  return isRigidObstacleVoxel(
    room,
    nextVx,
    nextVy,
    nextVz,
    !sameCell
  );
}

function isBlockedByRigidWall(
  room: RoomGrid,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
): boolean {
  const vx0 = Math.floor(x0 / VOXEL_SIZE);
  const vy0 = Math.floor(y0 / VOXEL_SIZE);
  const vz0 = Math.floor(z0 / VOXEL_SIZE);
  const vx1 = Math.floor(x1 / VOXEL_SIZE);
  const vy1 = Math.floor(y1 / VOXEL_SIZE);
  const vz1 = Math.floor(z1 / VOXEL_SIZE);

  if (vx0 === vx1 && vy0 === vy1 && vz0 === vz1) return false;

  const midVx = Math.floor(((x0 + x1) * 0.5) / VOXEL_SIZE);
  const midVy = Math.floor(((y0 + y1) * 0.5) / VOXEL_SIZE);
  const midVz = Math.floor(((z0 + z1) * 0.5) / VOXEL_SIZE);
  if (isRigidObstacleVoxel(room, midVx, midVy, midVz, true)) return true;

  if (vx0 !== vx1 && isRigidObstacleVoxel(room, vx1, vy0, vz0, true)) return true;
  if (vy0 !== vy1 && isRigidObstacleVoxel(room, vx0, vy1, vz0, true)) return true;
  if (vz0 !== vz1 && isRigidObstacleVoxel(room, vx0, vy0, vz1, true)) return true;

  return false;
}

export function shatterCylindricalVat(room: RoomGrid, vat: GlassVatTank): void {
  for (const idx of vat.voxelIndices) {
    room.matGrid[idx] = MaterialID.AIR;
    room.volGrid[idx] = 0;
  }

  const vIdx = room.vats.indexOf(vat);
  if (vIdx >= 0) room.vats.splice(vIdx, 1);

  const r = vat.radius * 0.72;
  spawnFluidQuantaInBox(
    room,
    vat.fluidMat,
    vat.fluidVolume,
    vat.x - r,
    vat.y + 0.06,
    vat.z - r,
    vat.x + r,
    vat.y + vat.height * 0.88,
    vat.z + r,
    0,
    0,
    0
  );

  room.dirtyStaticRender = true;
  room.dirtyFluidRender = true;
  syncQuantaToVoxelGrid(room);
  recountActiveCells(room);
}

export function applyZeroGLiftImpulseToGrid(room: RoomGrid): void {
  for (let i = 0; i < room.fluidQuanta.length; i++) {
    const q = room.fluidQuanta[i];
    if (!isFluidMaterial(q.mat)) continue;
    const vx = Math.floor(q.x / VOXEL_SIZE);
    const footVy = Math.floor((q.y - QUANTUM_RADIUS - 0.08) / VOXEL_SIZE);
    const vz = Math.floor(q.z / VOXEL_SIZE);
    if (q.grounded || isRigidObstacleVoxel(room, vx, footVy, vz, true)) {
      q.vy = Math.max(q.vy, 2.2 + (q.shimmer - 0.5) * 0.4);
    }
    q.grounded = false;
  }
  room.dirtyFluidRender = true;
}

const RELOCATION_DIRS = [
  [0, 1, 0],
  [0, -1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
] as const;

/**
 * A voxel edit (for example placing a wall over a puddle) can leave a quantum
 * embedded in a solid cell. The next sync relocates it to the nearest free
 * neighbour instead of silently dropping it from the render grid. A quantum
 * that is completely enclosed remains hidden and is left for the caller to
 * resolve (rather than deleting its mass).
 */
function relocateQuantumOutOfSolid(
  room: RoomGrid,
  q: FluidQuantum,
  vx: number,
  vy: number,
  vz: number
): boolean {
  for (const [dx, dy, dz] of RELOCATION_DIRS) {
    const nx = vx + dx;
    const ny = vy + dy;
    const nz = vz + dz;
    if (
      !inRoomBounds(room, nx, ny, nz) ||
      isRigidObstacleVoxel(room, nx, ny, nz)
    ) {
      continue;
    }
    q.x = (nx + 0.5) * VOXEL_SIZE;
    q.y = (ny + 0.5) * VOXEL_SIZE;
    q.z = (nz + 0.5) * VOXEL_SIZE;
    q.vx = 0;
    q.vy = 0;
    q.vz = 0;
    q.grounded = false;
    return true;
  }
  return false;
}

export function syncQuantaToVoxelGrid(room: RoomGrid): void {
  const { matGrid, volGrid, vxGrid, vyGrid, vzGrid } = room;
  const total = matGrid.length;

  for (let i = 0; i < total; i++) {
    const m = matGrid[i] as MaterialID;
    if (isFluidMaterial(m) || m === MaterialID.ICE) {
      matGrid[i] = MaterialID.AIR;
      volGrid[i] = 0;
      vxGrid[i] = 0;
      vyGrid[i] = 0;
      vzGrid[i] = 0;
    }
  }

  for (let i = 0; i < room.fluidQuanta.length; i++) {
    const q = room.fluidQuanta[i];
    let vx = Math.max(1, Math.min(room.width - 2, Math.floor(q.x / VOXEL_SIZE)));
    let vy = Math.max(1, Math.min(room.height - 2, Math.floor(q.y / VOXEL_SIZE)));
    let vz = Math.max(1, Math.min(room.depth - 2, Math.floor(q.z / VOXEL_SIZE)));

    if (isRigidObstacleVoxel(room, vx, vy, vz)) {
      if (!relocateQuantumOutOfSolid(room, q, vx, vy, vz)) continue;
      vx = Math.max(1, Math.min(room.width - 2, Math.floor(q.x / VOXEL_SIZE)));
      vy = Math.max(1, Math.min(room.height - 2, Math.floor(q.y / VOXEL_SIZE)));
      vz = Math.max(1, Math.min(room.depth - 2, Math.floor(q.z / VOXEL_SIZE)));
    }

    const idx = getVoxelIndex(room, vx, vy, vz);

    const existingMat = matGrid[idx] as MaterialID;
    if (
      existingMat === MaterialID.AIR ||
      isFluidMaterial(existingMat) ||
      existingMat === MaterialID.ICE
    ) {
      const prevVol = volGrid[idx];
      const newVol = prevVol + q.vol;
      // A single ice quantum must not turn a mostly-liquid cell into a solid
      // collider. Keep the cell fluid as soon as it contains any liquid, and
      // only label it ICE when all of its contents are frozen.
      if (
        existingMat === MaterialID.AIR ||
        (existingMat === MaterialID.ICE && isFluidMaterial(q.mat)) ||
        (q.mat !== MaterialID.ICE && prevVol < q.vol)
      ) {
        matGrid[idx] = q.mat;
      } else if (q.mat === MaterialID.ICE && !isFluidMaterial(existingMat)) {
        matGrid[idx] = MaterialID.ICE;
      }
      volGrid[idx] = newVol;
      vxGrid[idx] = q.vx;
      vyGrid[idx] = q.vy;
      vzGrid[idx] = q.vz;
    }
  }
}

export function step3DFluidStencil(room: RoomGrid, dt: number): void {
  const quanta = room.fluidQuanta;
  const count = quanta.length;
  if (count === 0) return;

  const clampedDt = Math.min(dt, 0.035);
  const { width, height, depth } = room;

  // 1. Build 3D Spatial Hash Table
  const spatialBuckets = new Map<number, number[]>();
  const invHash = 1.0 / HASH_CELL_SIZE;

  for (let i = 0; i < count; i++) {
    const q = quanta[i];
    q.neighborCount = 0;
    const hx = Math.floor(q.x * invHash);
    const hy = Math.floor(q.y * invHash);
    const hz = Math.floor(q.z * invHash);
    const key = (hy * 16384 + hz) * 16384 + hx;
    const bucket = spatialBuckets.get(key);
    if (bucket) {
      bucket.push(i);
    } else {
      spatialBuckets.set(key, [i]);
    }
  }

  // 2. Pairwise SPH Pressure, Vertical Pile-Collapse, Horizontal Capillary Cohesion & Freezing
  const hRadius = room.gravityG === 0 ? 0.32 : 0.24;
  const hRadiusSq = hRadius * hRadius;

  const neighborRange = Math.ceil(hRadius / HASH_CELL_SIZE);

  for (let i = 0; i < count; i++) {
    const a = quanta[i];
    const hx = Math.floor(a.x * invHash);
    const hy = Math.floor(a.y * invHash);
    const hz = Math.floor(a.z * invHash);

    for (let dy = -neighborRange; dy <= neighborRange; dy++) {
      for (let dz = -neighborRange; dz <= neighborRange; dz++) {
        for (let dx = -neighborRange; dx <= neighborRange; dx++) {
          const key = ((hy + dy) * 16384 + (hz + dz)) * 16384 + (hx + dx);
          const bucket = spatialBuckets.get(key);
          if (!bucket) continue;

          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k];
            if (j <= i) continue;
            const b = quanta[j];

            const rx = b.x - a.x;
            const ry = b.y - a.y;
            const rz = b.z - a.z;
            const distSq = rx * rx + ry * ry + rz * rz;
            if (distSq >= hRadiusSq || distSq < 1e-8) continue;

            if (isBlockedByRigidWall(room, a.x, a.y, a.z, b.x, b.y, b.z)) {
              continue;
            }

            const dist = Math.sqrt(distSq);
            const nx = rx / dist;
            const ny = ry / dist;
            const nz = rz / dist;

            a.neighborCount++;
            b.neighborCount++;

            // A. Conductive Heat Exchange -> Water freezes at T <= 0°C
            if (dist < 0.22 && a.temp !== b.temp) {
              const heatRate = 22.0 * (1.0 - dist / 0.22) * clampedDt;
              const dT = (b.temp - a.temp) * Math.min(0.49, heatRate);
              a.temp += dT;
              b.temp -= dT;

              if (a.mat === MaterialID.WATER && a.temp <= 0) {
                a.mat = MaterialID.ICE;
                a.vx = 0;
                a.vz = 0;
                room.dirtyStaticRender = true;
                room.lastCombatLog = 'Water cooled below 0°C and crystallized into Ice!';
              }
              if (b.mat === MaterialID.WATER && b.temp <= 0) {
                b.mat = MaterialID.ICE;
                b.vx = 0;
                b.vz = 0;
                room.dirtyStaticRender = true;
                room.lastCombatLog = 'Water cooled below 0°C and crystallized into Ice!';
              }
            }

            if (a.mat === MaterialID.ICE || b.mat === MaterialID.ICE) {
              if (dist < 0.12) {
                const push = (0.12 - dist) * 22.0 * clampedDt;
                if (a.mat !== MaterialID.ICE) {
                  a.vx -= nx * push;
                  a.vy -= ny * push * 0.5;
                  a.vz -= nz * push;
                } else if (b.mat !== MaterialID.ICE) {
                  b.vx += nx * push;
                  b.vy += ny * push * 0.5;
                  b.vz += nz * push;
                } else {
                  a.vx -= nx * push * 0.5;
                  a.vz -= nz * push * 0.5;
                  b.vx += nx * push * 0.5;
                  b.vz += nz * push * 0.5;
                }
              }
              continue;
            }

            if (room.gravityG > 0) {
              // B. 1G Anisotropic Pile-Collapse + Horizontal Capillary Cohesion:
              // - Equilibrium spacing eqDist = 0.088m (tighter than visual radius 0.11m so puddles fuse!)
              // - Vertical stacking (|ry| > 0.03m) converts weight into horizontal outward spreading
              // - Horizontal neighbors beyond eqDist (0.088m .. 0.24m) attract along X/Z so drops stay in pools!
              const eqDist1G = 0.088;
              const horizDist = Math.hypot(rx, rz);
              let hnx = nx;
              let hnz = nz;
              if (horizDist > 1e-4) {
                hnx = rx / horizDist;
                hnz = rz / horizDist;
              } else {
                const angle = (i * 1.618 + j) * Math.PI * 2;
                hnx = Math.cos(angle);
                hnz = Math.sin(angle);
              }

              // 1) Vertical pile collapse: if one droplet is stacked above another, slide outward horizontally
              if (Math.abs(ry) > 0.032 && dist < 0.16) {
                const stackOverlap = (0.16 - dist) / 0.16;
                const collapsePush = stackOverlap * (Math.abs(ry) / dist) * 26.0 * clampedDt;
                a.vx -= hnx * collapsePush;
                a.vz -= hnz * collapsePush;
                b.vx += hnx * collapsePush;
                b.vz += hnz * collapsePush;
              }

              // 2) Horizontal core repulsion vs. capillary surface-tension attraction
              if (dist < eqDist1G) {
                const overlap = (eqDist1G - dist) / eqDist1G;
                const repulse = overlap * 22.0 * clampedDt;
                a.vx -= hnx * repulse;
                a.vz -= hnz * repulse;
                b.vx += hnx * repulse;
                b.vz += hnz * repulse;
                if (dist < 0.075) {
                  const vPush = ((0.075 - dist) / 0.075) * 6.0 * clampedDt;
                  a.vy -= ny * vPush;
                  b.vy += ny * vPush;
                }
              } else if (a.mat === b.mat && horizDist > eqDist1G) {
                // Horizontal-only capillary attraction binds puddles together without pulling upward into a 3D ball!
                const gamma = MATERIAL_TABLE[a.mat].surfaceTension;
                const pull = gamma * (1.0 - dist / hRadius) * 14.5 * clampedDt;
                a.vx += hnx * pull;
                a.vz += hnz * pull;
                b.vx -= hnx * pull;
                b.vz -= hnz * pull;
              }

              // Archimedes Buoyancy in 1G (Water = 1.0 sinks below Oil = 0.82)
              if (a.mat !== b.mat) {
                const rhoA = MATERIAL_TABLE[a.mat].density;
                const rhoB = MATERIAL_TABLE[b.mat].density;
                const buoy = (rhoA - rhoB) * room.gravityG * 8.0 * clampedDt;
                a.vy -= buoy;
                b.vy += buoy;
              }
            } else {
              // C. 0G Cohesive 3D Surface-Tension Clustering (forms compact mid-air spheres!)
              const eqDist0G = 0.092;
              if (dist < eqDist0G) {
                const push = ((eqDist0G - dist) / eqDist0G) * 22.0 * clampedDt;
                a.vx -= nx * push;
                a.vy -= ny * push;
                a.vz -= nz * push;
                b.vx += nx * push;
                b.vy += ny * push;
                b.vz += nz * push;
              } else if (a.mat === b.mat) {
                const gamma = MATERIAL_TABLE[a.mat].surfaceTension;
                const pull = gamma * 15.0 * clampedDt;
                a.vx += nx * pull;
                a.vy += ny * pull;
                a.vz += nz * pull;
                b.vx -= nx * pull;
                b.vy -= ny * pull;
                b.vz -= nz * pull;
              }
            }

            // D. Strong XSPH Viscous Velocity Coupling (makes contiguous droplets flow as a unified stream!)
            const visc =
              0.5 *
              (MATERIAL_TABLE[a.mat].viscosity + MATERIAL_TABLE[b.mat].viscosity);
            const shear = (2.8 + visc * 8.0) * (1.0 - dist / hRadius) * clampedDt;
            const dvx = b.vx - a.vx;
            const dvy = b.vy - a.vy;
            const dvz = b.vz - a.vz;
            a.vx += dvx * shear;
            a.vy += dvy * shear * 0.4;
            a.vz += dvz * shear;
            b.vx -= dvx * shear;
            b.vy -= dvy * shear * 0.4;
            b.vz -= dvz * shear;
          }
        }
      }
    }
  }

  // 3. Integrate 3D Motion under Gravity, Air Drag & Solid World Boundaries
  const minBoundX = VOXEL_SIZE + QUANTUM_RADIUS;
  const maxBoundX = (width - 1) * VOXEL_SIZE - QUANTUM_RADIUS;
  const minBoundZ = VOXEL_SIZE + QUANTUM_RADIUS;
  const maxBoundZ = (depth - 1) * VOXEL_SIZE - QUANTUM_RADIUS;
  const maxBoundY = (height - 1) * VOXEL_SIZE - QUANTUM_RADIUS;

  for (let i = 0; i < count; i++) {
    const q = quanta[i];
    const props = MATERIAL_TABLE[q.mat];
    const isIce = q.mat === MaterialID.ICE;
    const startVx = Math.floor(q.x / VOXEL_SIZE);
    const startVy = Math.floor(q.y / VOXEL_SIZE);
    const startVz = Math.floor(q.z / VOXEL_SIZE);

    q.vy -= 19.5 * room.gravityG * clampedDt;

    const airDrag = room.gravityG === 0 ? 2.5 : 0.35;
    const contactFriction = q.grounded
      ? isIce
        ? 14.0
        : 2.4 + props.viscosity * 8.5
      : 0.0;
    const horizDamp = Math.max(0.1, 1.0 - (airDrag + contactFriction) * clampedDt);
    const vertDamp = Math.max(0.1, 1.0 - airDrag * clampedDt);

    q.vx *= horizDamp;
    q.vy *= vertDamp;
    q.vz *= horizDamp;

    // Step X
    const nextX = Math.max(minBoundX, Math.min(maxBoundX, q.x + q.vx * clampedDt));
    const nextVx = Math.floor((nextX + Math.sign(q.vx) * QUANTUM_RADIUS) / VOXEL_SIZE);
    if (
      !isBlockedQuantumVoxel(
        room,
        nextVx,
        startVy,
        startVz,
        startVx,
        startVy,
        startVz
      )
    ) {
      q.x = nextX;
    } else {
      q.vx = -q.vx * 0.35;
    }

    // Step Z
    const curVx = Math.floor(q.x / VOXEL_SIZE);
    const curVzBeforeZ = Math.floor(q.z / VOXEL_SIZE);
    const nextZ = Math.max(minBoundZ, Math.min(maxBoundZ, q.z + q.vz * clampedDt));
    const nextVz = Math.floor((nextZ + Math.sign(q.vz) * QUANTUM_RADIUS) / VOXEL_SIZE);
    if (
      !isBlockedQuantumVoxel(
        room,
        curVx,
        startVy,
        nextVz,
        curVx,
        startVy,
        curVzBeforeZ
      )
    ) {
      q.z = nextZ;
    } else {
      q.vz = -q.vz * 0.35;
    }

    // Step Y & Ground Contact Probe (No random 360-degree marble scattering on landing!)
    const curVz = Math.floor(q.z / VOXEL_SIZE);
    const nextY = Math.max(
      VOXEL_SIZE + QUANTUM_RADIUS,
      Math.min(maxBoundY, q.y + q.vy * clampedDt)
    );

    if (q.vy <= 0) {
      const footVy = Math.floor((nextY - QUANTUM_RADIUS - 0.005) / VOXEL_SIZE);
      if (
        isBlockedQuantumVoxel(
          room,
          curVx,
          footVy,
          curVz,
          curVx,
          startVy,
          curVz
        )
      ) {
        const floorTop = (footVy + 1) * VOXEL_SIZE + QUANTUM_RADIUS;
        q.y = floorTop;
        q.vy = 0;
        q.grounded = room.gravityG > 0;
      } else {
        q.y = nextY;
        const probeVy = Math.floor((q.y - QUANTUM_RADIUS - 0.02) / VOXEL_SIZE);
        q.grounded =
          room.gravityG > 0 &&
          isBlockedQuantumVoxel(
            room,
            curVx,
            probeVy,
            curVz,
            curVx,
            startVy,
            curVz
          );
      }
    } else {
      const headVy = Math.floor((nextY + QUANTUM_RADIUS) / VOXEL_SIZE);
      if (
        isBlockedQuantumVoxel(
          room,
          curVx,
          headVy,
          curVz,
          curVx,
          startVy,
          curVz
        )
      ) {
        q.y = headVy * VOXEL_SIZE - QUANTUM_RADIUS;
        q.vy = -q.vy * 0.35;
      } else {
        q.y = nextY;
      }
      q.grounded = false;
    }
  }

  room.dirtyFluidRender = true;
  syncQuantaToVoxelGrid(room);
  recountActiveCells(room);
}
