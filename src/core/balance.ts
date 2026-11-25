// Grid & Chunks
export const VOXEL_SIZE_M = 0.1;
export const ARENA_W = 240;
export const ARENA_H = 64;
export const ARENA_D = 240;
export const ARENA_CELLS = ARENA_W * ARENA_H * ARENA_D; // 3,686,400
export const SLICE_STRIDE = ARENA_W * ARENA_D; // 57,600
export const CHUNK_SIZE = 16;
export const CHUNKS_X = ARENA_W / CHUNK_SIZE; // 15
export const CHUNKS_Y = ARENA_H / CHUNK_SIZE; // 4
export const CHUNKS_Z = ARENA_D / CHUNK_SIZE; // 15
export const TOTAL_CHUNKS = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 900
export const GRATE_MAX_RUN = 2;

// Clocks & Gravity
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.05;
export const CELLULAR_CLOCK_DIV = 4; // 15 Hz
export const AMBIENT_RELAX_DIV = 60; // 1 Hz
export const GRAVITY_ACCEL_M_S2 = 14.0;

export const GRAVITY_MODE = {
  G1: '1G',
  G2: '2G',
  G3: '3G',
  GN1: '-1G',
  G0: '0G',
} as const;
export type GravityMode = (typeof GRAVITY_MODE)[keyof typeof GRAVITY_MODE];

export const GRAVITY_ACCEL_BY_MODE: Record<GravityMode, number> = {
  '1G': -GRAVITY_ACCEL_M_S2,
  '2G': -2 * GRAVITY_ACCEL_M_S2,
  '3G': -3 * GRAVITY_ACCEL_M_S2,
  '-1G': GRAVITY_ACCEL_M_S2,
  '0G': 0.0,
};

// Pools & Caps
export const MAX_ACTIVE_GRID_FLUID = 16_384;
export const MAX_ACTIVE_THERMAL_SOLIDS = 8_192;
export const MAX_ACTIVE_BALLISTIC = 4_096;
export const MAX_PRIMED_QUANTA = 512;
export const FUSE_TICKS = [0, 30, 90, 300] as const;
export const MAX_DEFERRED_FLUID = 4_096;
export const MAX_RENDERED_GRID_FLUID = 24_576;
export const MAX_RENDERED_TOTAL_FLUID = MAX_RENDERED_GRID_FLUID + MAX_ACTIVE_BALLISTIC; // 28,672
export const MAX_FLUID_CACHE_REBUILDS_PER_FRAME = 16;
export const MAX_FLUID_CACHE_REBUILDS_FALLBACK = 8;
export const MAX_REMESHES_PER_FRAME = 16;
export const MAX_REMESHES_FALLBACK = 8;
export const MAX_MESH_MEM_MB = 48;
export const SNAP_DEFLATE_MB = 24;
export const MAX_SNAP_MEM_MB = 32;
export const MAX_DAMAGE_DECALS = 512;
export const MAX_BFS_EMITTER = 2_048;
export const MAX_BFS_GLOBAL = 4_096;
export const BFS_MANHATTAN_RADIUS = 120;
export const MAX_EXPLOSIONS_PER_TICK = 4;
export const MAX_EXPLOSIONS_PER_TICK_REDUCED = 2;
export const MAX_EXPLOSION_QUEUE = 32;
export const EXPLOSION_COALESCE_M = 1.2;
export const EXPLOSION_RADIUS_M = 1.8;
export const EXPLOSION_RAYS = 26;
export const EXPLOSION_DMG_NOM = 20;
export const EXPLOSION_IMPULSE_NOM = 720;
export const EXPLOSION_MAX_PROMOS = 64;
export const MAX_ENTITIES = 32;
export const MAX_ALIENS_PER_ROOM = 12;
export const MAX_CRATES_PER_ROOM = 16;
export const NAV_LAYERS = 3;
export const NAV_CELL_M = 1.0;
export const NAV_MAX_NODES = 24 * 24 * NAV_LAYERS; // 1,728

// Room Templates
export const DECK_ROOMS_MIN = 10;
export const DECK_ROOMS_MAX = 14;
export const DECK_MAX_DEGREE = 4;

export interface RoomDims {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly chunks: number;
}

export const ARRIVAL_DIMS: RoomDims = { w: 80, h: 48, d: 80, chunks: 75 };
export const CORRIDOR_DIMS: RoomDims = { w: 80, h: 48, d: 240, chunks: 225 };
export const REACTOR_DIMS: RoomDims = { w: 160, h: 64, d: 160, chunks: 400 };
export const CARGO_HOLD_DIMS: RoomDims = { w: 240, h: 64, d: 240, chunks: 900 };
export const BOSS_SANCTUM_DIMS: RoomDims = { w: 240, h: 64, d: 240, chunks: 900 };

export const PARAMETRIC_CORRIDOR_DIMS: readonly RoomDims[] = [
  { w: 112, h: 64, d: 160, chunks: (112 / 16) * 4 * (160 / 16) },
  { w: 128, h: 64, d: 176, chunks: (128 / 16) * 4 * (176 / 16) },
  { w: 144, h: 64, d: 128, chunks: (144 / 16) * 4 * (128 / 16) },
];

export const PARAMETRIC_REACTOR_DIMS: readonly RoomDims[] = [
  { w: 112, h: 64, d: 112, chunks: (112 / 16) * 4 * (112 / 16) },
  { w: 128, h: 64, d: 128, chunks: (128 / 16) * 4 * (128 / 16) },
  { w: 144, h: 64, d: 144, chunks: (144 / 16) * 4 * (144 / 16) },
  { w: 160, h: 64, d: 144, chunks: (160 / 16) * 4 * (144 / 16) },
];

export const PARAMETRIC_CARGO_DIMS: readonly RoomDims[] = [
  { w: 160, h: 64, d: 160, chunks: (160 / 16) * 4 * (160 / 16) },
  { w: 176, h: 64, d: 144, chunks: (176 / 16) * 4 * (144 / 16) },
  { w: 208, h: 64, d: 176, chunks: (208 / 16) * 4 * (176 / 16) },
];

export const ALL_ROOM_DIMS: readonly RoomDims[] = [
  ARRIVAL_DIMS,
  CORRIDOR_DIMS,
  REACTOR_DIMS,
  CARGO_HOLD_DIMS,
  BOSS_SANCTUM_DIMS,
];

// Geometry constants (voxels)
export const DOOR_Y_MIN = 2;
export const DOOR_Y_MAX = 29; // 28 voxels = 2.8 m
export const DOOR_WIDTH_VOXELS = 30; // 3.0 m
export const CARGO_DECK_TOP_Y = 12; // 1.2 m
export const CARGO_CATWALK_Y_MIN = 36; // underside 3.6 m
export const CARGO_CATWALK_Y_MAX = 37; // top 3.8 m
export const BOSS_GRATE_Y_MIN = 40; // underside 4.0 m
export const BOSS_GRATE_Y_MAX = 41; // top 4.2 m
export const TALL_CEILING_UNDERSIDE_Y = 62; // 6.2 m

// Player & Suit
export const PLAYER_AABB_W = 0.6;
export const PLAYER_AABB_H = 1.6;
export const PLAYER_AABB_D = 0.6;
export const PLAYER_TORSO_OFFSET_M = 0.8;
export const PLAYER_DRY_MASS_KG = 90;
export const PLAYER_MAX_HP = 100;
export const PLAYER_PATCH_HEAL = 25;
export const PLAYER_SPEED_1G = 6.5;
export const PLAYER_SPEED_2G = 4.2;
export const PLAYER_SPEED_3G = 2.8;
export const PLAYER_SPEED_N1G = 4.5;
export const PLAYER_SPEED_0G_HORIZ = 5.5;
export const PLAYER_SPEED_0G_VERT = 4.0;

export const MAX_UPGRADE_RANK = 3;

export function tankStarterCapL(rank: number): number {
  return 120 + 30 * rank;
}

export function tankBaffledChamberCapL(rank: number): number {
  return 90 + 15 * rank;
}

export function tankBaffledTotalCapL(rank: number): number {
  return 2 * tankBaffledChamberCapL(rank);
}

export function computeBaffledAutoSplit(
  liters: number,
  rank: number,
): { toA: number; toB: number; spareB: number } {
  const chamberCap = tankBaffledChamberCapL(rank);
  const toA = Math.min(liters, chamberCap);
  const toB = liters - toA;
  return { toA, toB, spareB: chamberCap - toB };
}

export const NOZZLE_TAP_BURST_L = 15;
export const NOZZLE_TAP_SHOT_L = 5;
export const NOZZLE_TAP_SHOTS = 3;
export const NOZZLE_TAP_SPACING_TICKS = 4;
export const NOZZLE_TAP_CD_S = 0.3;
export const NOZZLE_TAP_CD_TICKS = 18; // 0.30 s @ 60 Hz
export const NOZZLE_TAP_WAIT_TICKS = 15; // 0.25 s pool-full wait before canceling unused shots
export const NOZZLE_TAP_SPEED_M_S = 10.0;
export const NOZZLE_TAP_RECOIL_0G = 0.7;
export const NOZZLE_CLUSTER_RADIUS_M = 0.15;
export const NOZZLE_HOLD_RATE_LPS = 60;
export const NOZZLE_HOLD_SPEED_M_S = 9.0;
export const NOZZLE_HOLD_RECOIL_0G = 0.08;

export const NOZZLE_MODE = {
  STREAM: 'stream',
  SCATTER: 'scatter',
  LOBBER: 'lobber',
} as const;
export type NozzleMode = (typeof NOZZLE_MODE)[keyof typeof NOZZLE_MODE];

export const NOZZLE_SCATTER_SHOT_L = 10;
export const NOZZLE_SCATTER_SPEED_M_S = 11.5;
export const NOZZLE_SCATTER_CD_TICKS = 25; // 0.42 s
export const NOZZLE_SCATTER_RECOIL_0G = 1.05;

export const NOZZLE_LOBBER_SHOT_L = 12;
export const NOZZLE_LOBBER_SPEED_M_S = 10.5;
export const NOZZLE_LOBBER_CD_TICKS = 30; // 0.50 s
export const NOZZLE_LOBBER_RECOIL_0G = 1.15;

export const SKITTERER_DRY_MASS_KG = 45;
export const SKITTERER_MAX_HP = 45;
export const BRUISER_DRY_MASS_KG = 165;
export const BRUISER_MAX_HP = 150;
export const BRUISER_W_M = 1.4;
export const BRUISER_H_M = 1.6;
export const BRUISER_D_M = 1.4;
export const BRUISER_GLAND_CAP_L = 24;
export const ARMORED_RAW_DMG_MULT = 0.25;
export const SPITTER_DRY_MASS_KG = 50;
export const SPITTER_MAX_HP = 55;
export const SPITTER_W_M = 1.0;
export const SPITTER_H_M = 1.1;
export const SPITTER_D_M = 1.0;
export const SPITTER_GLAND_CAP_L = 36;
export const FLOATER_DRY_MASS_KG = 35;
export const FLOATER_MAX_HP = 50;
export const FLOATER_W_M = 1.1;
export const FLOATER_D_M = 1.1;
export const FLOATER_GLAND_CAP_L = 24;
export const FLOATER_CRUSH_MULT = 2.5;
export const SKITTERER_W_M = 1.1;
export const SKITTERER_H_M = 0.9;
export const SKITTERER_D_M = 1.1;
export const SKITTERER_GLAND_CAP_L = 18;
export const STUN_DURATION_TICKS = 45; // 0.75 s (§8.2)
export const STUN_IMMUNITY_TICKS = 120; // 2.0 s (§8.2)

export function nozzlePressureMult(rank: number): number {
  return 1.0 + 0.2 * rank;
}

export const AIR_BURST_RANGE_M = 5.5;
export const AIR_BURST_CD_S = 0.25;
export const AIR_BURST_IMPULSE_NOM = 960;
export const AIR_BURST_CONE_DEG = 25;
export const AIR_BURST_DMG = 0; // Pure kinetic tool: kills require Wall-Splat, Gravity-Slam, Cryo Shatter, or Alchemy
export const AIR_BURST_DELTAV_MIN = 2.5;
export const AIR_BURST_DELTAV_MAX = 14.0;
export const AIR_BURST_RAYS = 25;
export const AIR_BURST_CD_TICKS = 15; // 0.25 s @ 60 Hz
export const AIR_BURST_CONE_COS = 0.9063077870366499; // cos(25 deg), deterministic constant
export const AIR_BURST_CONE_COS_SQ = AIR_BURST_CONE_COS * AIR_BURST_CONE_COS;
export const AIR_BURST_RECOIL_0G = 2.5;
export const AIR_BURST_TIER1_DMG = 4;
export const AIR_BURST_TIER2_DMG = 2;

// Dynamic Crates & Brood Pods (M1.3-lite / §8.2, §10.0)
export const CRATE_DRY_MASS_KG = 60;
export const CRATE_MAX_HP = 60;
export const CRATE_SIZE_M = 1.0;
export const POD_DRY_MASS_KG = 80;
export const POD_MAX_HP = 100;
export const POD_W_M = 0.9;
export const POD_H_M = 1.2;
export const POD_D_M = 0.9;
export const CARGO_POD_COUNT = 6;
export const ENTITY_RESTITUTION = 0.4;

export function siphonRateLps(rank: number): number {
  return 120 + 60 * rank;
}

export function siphonRateLPerTick(rank: number): number {
  return 2 + rank;
}

export const SIPHON_RANGE_M = 6.0;
export const SIPHON_CONE_DEG = 35;
export const SIPHON_CONE_COS = 0.8191520442889918; // cos(35 deg), deterministic constant
export const SIPHON_CONE_COS_SQ = SIPHON_CONE_COS * SIPHON_CONE_COS;

export const DASH_SPEED_M_S = 13.5;
export const DASH_EXHAUST_L = 14;
export const DASH_EXHAUST_SPEED_M_S = 0.5;
export const DASH_CD_S = 0.85;
export const DASH_CD_TICKS = 51; // 0.85 s @ 60 Hz
export const DASH_DURATION_TICKS = 14; // 0.23 s (~3.15 m) @ 60 Hz
export const DASH_GRACE_TICKS = 9; // 0.15 s @ 60 Hz

export const GRAV_CD_BASE_S = 4.0;
export const GRAV_CD_STEP_S = 0.5;
export const GRAV_CD_MIN = 2.5;
export const GRAV_CRUSH_S = 3.0;
export const GRAV_INVERT_S = 3.5;

export function gravCooldownS(rank: number): number {
  return Math.max(GRAV_CD_MIN, GRAV_CD_BASE_S - GRAV_CD_STEP_S * rank);
}

export const LOCKON_RANGE_M = 7.5;
export const LOCKON_CURSOR_SNAP_M = 0.8;

// Combat, Vats & 0G Loft
export const WALL_SPLAT_BASE_CAP = 120;
export const WALL_SPLAT_EMBRITTLED_CAP = 360;
export const WALL_SPLAT_V_MIN = 7.5;
export const WALL_SPLAT_COEFF = 0.025;
export const IMPACT_IFRAMES_TICKS = 15; // 0.25 s
export const BACKFIRE_SELF_DMG = 25;
export const BACKFIRE_IMPULSE_NOM = 720;
export const VAT_VOLUME_MIN_L = 2_000;
export const VAT_VOLUME_MAX_L = 3_000;
export const LIFT_0G_VEL_MIN = 2.2;
export const LIFT_0G_VEL_MAX = 3.4;
export const LIFT_0G_DRAG = 0.95;
export const LIFT_0G_STOP_SPEED = 0.35;
export const LIFT_0G_TICKS = 36;

export function simulateZeroGLoft(v0: number): {
  heightM: number;
  ticks: number;
  durationS: number;
} {
  let y = 0;
  let v = v0;
  let ticks = 0;
  while (v >= LIFT_0G_STOP_SPEED) {
    y += v * FIXED_DT;
    v *= LIFT_0G_DRAG;
    ticks++;
  }
  return { heightM: y, ticks, durationS: ticks * FIXED_DT };
}

// Alien / Boss Heights for clearance checks
export const FLOATER_HEIGHT_M = 1.4;
export const CRUSHER_HEIGHT_M = 1.8;
export const BOSS_HEIGHT_M = 2.2;

// Salvage Economy
export const SCRAP_DROPS = {
  skitterer: 15,
  floater: 15,
  crusher: 35,
  bioCache: 25,
  roomClear: 30,
} as const;

export const WORKBENCH_COSTS = {
  patch: 30,
  baffled: 80,
  baseTrack: [40, 65, 90] as const,
  hazardTrack: [60, 90, 120] as const,
  attachment: 90,
} as const;

// Quantized Temperature Bytes: T_C = (byte * 4) - 200
export const TEMP_BYTE = {
  MIN: 0, // -200°C
  CRYO: 1, // -196°C
  EMBRITTLED: 38, // -48°C
  FREEZE: 50, // 0°C
  MELT: 51, // +4°C
  AMBIENT: 55, // +20°C
  STEAM_CONDENSE: 70, // +80°C
  BOIL: 75, // +100°C
  OIL_IGNITE: 95, // +180°C
  PYRO_NAPALM: 100, // +200°C
  WOOD_IGNITE: 105, // +220°C
  BAFFLED_SAFE_MAX: 110, // +240°C
  THERMAL_VENT: 125, // +300°C
  FIRE: 212, // +648°C
  MAX: 255, // +820°C
} as const;

export function tempCToByte(tempC: number): number {
  const b = (tempC + 200) >> 2;
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

export function byteToTempC(byte: number): number {
  return byte * 4 - 200;
}

// Universal Material Schema (ID 0..12)
export const MAT = {
  AIR: 0,
  WATER: 1,
  OIL: 2,
  CRYO: 3,
  STEAM: 4,
  FIRE: 5,
  ICE: 6,
  GLASS_VAT: 7,
  WOOD_BARRIER: 8,
  HULL_STEEL: 9,
  STEEL_GRATE: 10,
  ACID: 11,
  BOUNDARY_HULL: 12,
} as const;

export type MaterialId = (typeof MAT)[keyof typeof MAT];

export const MAT_KIND = {
  EMPTY: 'empty',
  FLUID: 'fluid',
  GAS: 'gas',
  PLASMA: 'plasma',
  SOLID: 'solid',
} as const;
export type MaterialKind = (typeof MAT_KIND)[keyof typeof MAT_KIND];

export interface MaterialSpec {
  readonly id: MaterialId;
  readonly name: string;
  readonly kind: MaterialKind;
  readonly densityKgPerL: number;
  readonly viscositySteps: number;
  readonly elecCond: number;
  readonly structHp: number;
  readonly structTier: 0 | 1 | 2 | 3;
  readonly colorHex: number;
}

export const MATERIAL_SPEC: readonly MaterialSpec[] = [
  { id: MAT.AIR, name: 'AIR', kind: MAT_KIND.EMPTY, densityKgPerL: 0.0, viscositySteps: 0, elecCond: 0.0, structHp: 0, structTier: 0, colorHex: 0x000000 },
  { id: MAT.WATER, name: 'WATER', kind: MAT_KIND.FLUID, densityKgPerL: 1.0, viscositySteps: 2, elecCond: 0.9, structHp: 0, structTier: 0, colorHex: 0x2b95d6 },
  { id: MAT.OIL, name: 'OIL', kind: MAT_KIND.FLUID, densityKgPerL: 0.8, viscositySteps: 1, elecCond: 0.0, structHp: 0, structTier: 0, colorHex: 0x3b2a1d },
  { id: MAT.CRYO, name: 'CRYO', kind: MAT_KIND.FLUID, densityKgPerL: 1.1, viscositySteps: 3, elecCond: 0.0, structHp: 0, structTier: 0, colorHex: 0x5be7ff },
  { id: MAT.STEAM, name: 'STEAM', kind: MAT_KIND.GAS, densityKgPerL: 0.1, viscositySteps: 3, elecCond: 0.0, structHp: 0, structTier: 0, colorHex: 0xdbe7f0 },
  { id: MAT.FIRE, name: 'FIRE', kind: MAT_KIND.PLASMA, densityKgPerL: 0.05, viscositySteps: 1, elecCond: 0.0, structHp: 0, structTier: 0, colorHex: 0xff6b1a },
  { id: MAT.ICE, name: 'ICE', kind: MAT_KIND.SOLID, densityKgPerL: 0.92, viscositySteps: 0, elecCond: 0.0, structHp: 4, structTier: 1, colorHex: 0x99e8ff },
  { id: MAT.GLASS_VAT, name: 'GLASS_VAT', kind: MAT_KIND.SOLID, densityKgPerL: 2.5, viscositySteps: 0, elecCond: 0.0, structHp: 4, structTier: 1, colorHex: 0x80d8c8 },
  { id: MAT.WOOD_BARRIER, name: 'WOOD_BARRIER', kind: MAT_KIND.SOLID, densityKgPerL: 0.7, viscositySteps: 0, elecCond: 0.0, structHp: 12, structTier: 2, colorHex: 0x9b6b3e },
  { id: MAT.HULL_STEEL, name: 'HULL_STEEL', kind: MAT_KIND.SOLID, densityKgPerL: 7.8, viscositySteps: 0, elecCond: 1.0, structHp: 15, structTier: 3, colorHex: 0x4b5668 },
  { id: MAT.STEEL_GRATE, name: 'STEEL_GRATE', kind: MAT_KIND.SOLID, densityKgPerL: 7.8, viscositySteps: 0, elecCond: 1.0, structHp: 15, structTier: 3, colorHex: 0x67758a },
  { id: MAT.ACID, name: 'ACID', kind: MAT_KIND.FLUID, densityKgPerL: 1.15, viscositySteps: 2, elecCond: 0.4, structHp: 0, structTier: 0, colorHex: 0x7dff3b },
  { id: MAT.BOUNDARY_HULL, name: 'BOUNDARY_HULL', kind: MAT_KIND.SOLID, densityKgPerL: 7.8, viscositySteps: 0, elecCond: 0.0, structHp: Infinity, structTier: 3, colorHex: 0x2c3442 },
];
