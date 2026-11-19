// Pure TypeScript simulation types & constants (Zero Three.js or DOM imports)

export const VOXEL_SIZE = 0.5; // 0.5m macro collision & stencil resolution
export const MAX_CELL_VOLUME = 1.0;
export const QUANTUM_VOLUME = 0.05; // 20 discrete micro-droplets per 1.0L (240 per 12L vat!)

export const MaterialID = {
  AIR: 0,
  HULL_STEEL: 1,
  WOOD_CRATE: 2,
  GLASS_VAT: 3,
  WATER: 4,
  OIL: 5,
  CRYO: 6,
  ICE: 7,
} as const;

export type MaterialID = (typeof MaterialID)[keyof typeof MaterialID];

export interface MaterialProps {
  id: MaterialID;
  name: string;
  isSolid: boolean;
  isFluid: boolean;
  conductivity: number;
  flammability: number;
  viscosity: number;
  density: number;
  surfaceTension: number;
  structuralIntegrity: number;
  defaultTemp: number;
}

export const MATERIAL_TABLE: Record<MaterialID, MaterialProps> = {
  [MaterialID.AIR]: {
    id: MaterialID.AIR,
    name: 'Air',
    isSolid: false,
    isFluid: false,
    conductivity: 0.0,
    flammability: 0.0,
    viscosity: 0.0,
    density: 0.001,
    surfaceTension: 0.0,
    structuralIntegrity: 0,
    defaultTemp: 20,
  },
  [MaterialID.HULL_STEEL]: {
    id: MaterialID.HULL_STEEL,
    name: 'Hull Steel',
    isSolid: true,
    isFluid: false,
    conductivity: 1.0,
    flammability: 0.0,
    viscosity: 0.0,
    density: 7.8,
    surfaceTension: 0.0,
    structuralIntegrity: 9999,
    defaultTemp: 20,
  },
  [MaterialID.WOOD_CRATE]: {
    id: MaterialID.WOOD_CRATE,
    name: 'Wood Crate',
    isSolid: true,
    isFluid: false,
    conductivity: 0.0,
    flammability: 0.7,
    viscosity: 0.0,
    density: 0.6,
    surfaceTension: 0.0,
    structuralIntegrity: 40,
    defaultTemp: 20,
  },
  [MaterialID.GLASS_VAT]: {
    id: MaterialID.GLASS_VAT,
    name: 'Glass Vat',
    isSolid: true,
    isFluid: false,
    conductivity: 0.0,
    flammability: 0.0,
    viscosity: 0.0,
    density: 2.5,
    surfaceTension: 0.0,
    structuralIntegrity: 15,
    defaultTemp: 20,
  },
  [MaterialID.WATER]: {
    id: MaterialID.WATER,
    name: 'Water',
    isSolid: false,
    isFluid: true,
    conductivity: 0.9,
    flammability: 0.0,
    viscosity: 0.12,
    density: 1.0,
    surfaceTension: 0.72,
    structuralIntegrity: 0,
    defaultTemp: 20,
  },
  [MaterialID.OIL]: {
    id: MaterialID.OIL,
    name: 'Hydrocarbon Oil',
    isSolid: false,
    isFluid: true,
    conductivity: 0.0,
    flammability: 1.0,
    viscosity: 0.45,
    density: 0.82,
    surfaceTension: 0.58,
    structuralIntegrity: 0,
    defaultTemp: 20,
  },
  [MaterialID.CRYO]: {
    id: MaterialID.CRYO,
    name: 'Cryo-Coolant (LN2)',
    isSolid: false,
    isFluid: true,
    conductivity: 0.0,
    flammability: 0.0,
    viscosity: 0.04,
    density: 0.81,
    surfaceTension: 0.48,
    structuralIntegrity: 0,
    defaultTemp: -196,
  },
  [MaterialID.ICE]: {
    id: MaterialID.ICE,
    name: 'Ice Crystal',
    isSolid: true,
    isFluid: false,
    conductivity: 0.0,
    flammability: 0.0,
    viscosity: 0.0,
    density: 0.92,
    surfaceTension: 0.0,
    structuralIntegrity: 25,
    defaultTemp: -10,
  },
};

export interface FluidQuantum {
  id: number;
  mat: MaterialID; // WATER, OIL, CRYO, or ICE
  vol: number;     // Immutable quantum volume (~0.05L)
  x: number;       // Continuous 3D world X (meters)
  y: number;       // Continuous 3D world Y (meters)
  z: number;       // Continuous 3D world Z (meters)
  vx: number;
  vy: number;
  vz: number;
  temp: number;
  volt: number;
  shimmer: number;       // Per-quantum Noita color shimmer offset (0..1)
  neighborCount: number; // Local density count for pool-lens vs airborne-streak rendering
  grounded: boolean;
}

export type DynamicEntityKind = 'crate' | 'alien';

export interface DynamicEntity {
  id: number;
  kind: DynamicEntityKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  radius: number;
  height: number;
  mass: number;
  hp: number;
  maxHp: number;
  grounded: boolean;
  floorY: number;
  hitStunTimer: number;
  slamFlashTimer: number;
  lastImpactDamage: number;
  proxyVoxelIdx: number;
}

export interface GlassVatTank {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  fluidMat: MaterialID;
  fluidVolume: number;
  voxelIndices: number[];
}

export interface LockOnTarget {
  kind: 'entity' | 'fluidCluster' | 'vat';
  entityId?: number;
  vatId?: number;
  voxelCoords?: { x: number; y: number; z: number };
  x: number;
  y: number;
  z: number;
  label: string;
}

export interface AirBurstVisual {
  startX: number;
  startY: number;
  startZ: number;
  endX: number;
  endY: number;
  endZ: number;
  timer: number;
  maxTimer: number;
}

export interface RoomGrid {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly matGrid: Uint8Array;
  readonly volGrid: Float32Array;
  readonly tempGrid: Float32Array;
  readonly voltGrid: Float32Array;
  readonly vxGrid: Float32Array;
  readonly vyGrid: Float32Array;
  readonly vzGrid: Float32Array;
  gravityG: number;
  dirtyStaticRender: boolean;
  dirtyFluidRender: boolean;
  activeStencilCount: number;
  gridFluidVolume: number;
  iceVolume: number;
  vatFluidVolume: number;
  totalFluidVolume: number;
  fluidQuanta: FluidQuantum[];
  entities: DynamicEntity[];
  vats: GlassVatTank[];
  airBursts: AirBurstVisual[];
  lastCombatLog: string;
}

export interface PlayerInputState {
  moveX: number;
  moveZ: number;
  moveY: number;
  aimWorldX: number;
  aimWorldY: number;
  aimWorldZ: number;
  cursorHitGeometry: boolean;
}

export interface PlayerRigState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  radius: number;
  height: number;
  mass: number;
  grounded: boolean;
  floorY: number;
  walkPhase: number;
  walkBlend: number;
  dashTimer: number;
  dashCooldown: number;
  nozzleCooldown: number;
  jetpackActive: boolean;
  inOilTar: boolean;
  lastSlamDamage: number;
  slamFlashTimer: number;
}

export function getVoxelIndex(
  room: RoomGrid,
  x: number,
  y: number,
  z: number
): number {
  return y * (room.width * room.depth) + z * room.width + x;
}

export function inRoomBounds(
  room: RoomGrid,
  x: number,
  y: number,
  z: number
): boolean {
  return (
    x >= 0 &&
    x < room.width &&
    y >= 0 &&
    y < room.height &&
    z >= 0 &&
    z < room.depth
  );
}

export function isSolidVoxel(
  room: RoomGrid,
  x: number,
  y: number,
  z: number
): boolean {
  if (!inRoomBounds(room, x, y, z)) return false;
  const mat = room.matGrid[getVoxelIndex(room, x, y, z)] as MaterialID;
  return MATERIAL_TABLE[mat].isSolid;
}
