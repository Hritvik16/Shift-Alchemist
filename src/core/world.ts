import {
  BRUISER_D_M,
  BRUISER_DRY_MASS_KG,
  BRUISER_GLAND_CAP_L,
  BRUISER_H_M,
  BRUISER_MAX_HP,
  BRUISER_W_M,
  CRATE_DRY_MASS_KG,
  FLOATER_D_M,
  FLOATER_DRY_MASS_KG,
  FLOATER_GLAND_CAP_L,
  FLOATER_HEIGHT_M,
  FLOATER_MAX_HP,
  FLOATER_W_M,
  CRATE_MAX_HP,
  CRATE_SIZE_M,
  GRAV_CRUSH_S,
  GRAV_INVERT_S,
  GRAVITY_MODE,
  LIFT_0G_TICKS,
  MAT,
  MATERIAL_SPEC,
  PLAYER_AABB_D,
  PLAYER_AABB_H,
  PLAYER_AABB_W,
  PLAYER_DRY_MASS_KG,
  PLAYER_MAX_HP,
  POD_D_M,
  POD_DRY_MASS_KG,
  POD_H_M,
  POD_MAX_HP,
  NOZZLE_MODE,
  POD_W_M,
  SKITTERER_D_M,
  SKITTERER_DRY_MASS_KG,
  SKITTERER_GLAND_CAP_L,
  SKITTERER_H_M,
  SKITTERER_MAX_HP,
  SKITTERER_W_M,
  SPITTER_D_M,
  SPITTER_DRY_MASS_KG,
  SPITTER_GLAND_CAP_L,
  SPITTER_H_M,
  SPITTER_MAX_HP,
  SPITTER_W_M,
  TEMP_BYTE,
  gravCooldownS,
  tankBaffledChamberCapL,
  tankStarterCapL,
  type GravityMode,
  type MaterialId,
  type NozzleMode,
} from './balance.ts';
import type { DeckGraph } from './deckGen.ts';
import { createEmptyRoomState, type ConservationLedgers, type DoorRecord, type RoomState } from './types.ts';

export interface GlandState {
  mat: MaterialId;
  liters: number;
  capL: number;
  tempByte: number;
  chargeUnits: number;
}

export interface Entity {
  id: number;
  kind: 'player' | 'alien' | 'crate';
  x: number;
  y: number; // Strictly AABB minimum Y (bottom)
  z: number;
  vx: number;
  vy: number;
  vz: number;
  halfW: number;
  height: number;
  halfD: number;
  upSign: 1 | -1;
  dryMassKg: number;
  hp: number;
  maxHp: number;
  tempByte: number;
  chargeUnits: number;
  burnTicks: number;
  wetTicks: number;
  shockTicks: number;
  stunTicks: number;
  stunImmunityTicks: number;
  dashTimer: number;
  dashGraceTimer: number;
  impactIFrames: number;
  impulseTimer: number;
  reflectCooldown: number;
  locomotion: 'humanoid' | 'skitterer' | 'spitter' | 'floater' | 'crusher' | 'boss' | 'prop' | 'pod';
  glands: GlandState[];
  carapace: 'none' | 'thermal' | 'insulated' | 'spined' | 'armored';
  deathHusk: boolean;
  grounded: boolean;
  bioCache: boolean;
  aiState: 'idle' | 'chase' | 'telegraph' | 'lunge' | 'recover';
  aiTimer: number;
  aiAttackKind: 'none' | 'melee' | 'spit';
  attackCdTicks: number;
  telegraphDirX: number;
  telegraphDirY: number;
  telegraphDirZ: number;
  meleeHitDone: boolean;
}

export interface TankChamberState {
  mat: MaterialId;
  liters: number;
  capL: number;
  tempByte: number;
  chargeUnits: number;
  lockedSpill: boolean;
}

export interface PlayerTankState {
  baffled: boolean;
  activeChamber: 0 | 1;
  chambers: [TankChamberState, TankChamberState];
}

export interface GravityPulseState {
  activePulse: 'none' | 'crush' | 'invert';
  pulseTicksLeft: number;
  cooldownTicks: number;
  ownPulseExempt: boolean;
  ownPulseGraceTicks: number;
}

export interface LockOnTarget {
  kind: 'alien' | 'crate' | 'vat' | 'fluid0g';
  id: number;
  x: number;
  y: number;
  z: number;
  radiusM: number;
}

export interface SuitActionState {
  nozzleTapBurstShotsLeft: number;
  nozzleTapSpacingTicks: number;
  nozzleTapWaitTicks: number;
  nozzleMode: NozzleMode;
  nozzleTapCdTicks: number;
  nozzleHoseActive: boolean;
  airBurstCdTicks: number;
  airBurstFlashTicks: number;
  prevPrimaryHeld: boolean;
  dashCdTicks: number;
  dashDirX: number;
  dashDirY: number;
  dashDirZ: number;
  aimDirX: number;
  aimDirY: number;
  aimDirZ: number;
  siphonActive: boolean;
  siphonMat: MaterialId;
  siphonTargetX: number;
  siphonTargetY: number;
  siphonTargetZ: number;
  siphonLitersThisTick: number;
  piezoArcCdTicks: number;
  streamShockCdTicks: number;
}

export interface InputFrame {
  moveX: number;
  moveZ: number;
  ascend: boolean; // E in 0G
  descend: boolean; // Left-Shift in 0G
  pressQ: boolean; // Edge-triggered
  pressC: boolean; // Edge-triggered
  pressV: boolean; // Edge-triggered
  aimX: number; // Normalized & quantized to 1/1024
  aimY: number;
  aimZ: number;
  hasAimPoint: boolean;
  aimPointX: number; // Quantized cursor hit on torso plane (used for nearest lock-on)
  aimPointY: number;
  aimPointZ: number;
  primaryHeld: boolean; // Left-Click
  siphonHeld: boolean; // Right-Click
  pressDash: boolean; // Space (edge-triggered)
  pressInteract: boolean; // F (edge-triggered)
  pressSwapChamber: boolean; // R (edge-triggered)
  pressCycleNozzle: boolean; // Tab (edge-triggered)
}

export interface ImpactTelemetry {
  lastImpactSpeed: number;
  lastWallSplatDmg: number;
  lastImpactExempt: boolean;
  lastImpactTick: number;
}

export interface WorldState {
  runSeed: number;
  simTick: number;
  deck: DeckGraph | null;
  currentRoomId: number;
  nearbyDoor: DoorRecord | null;
  pendingAirlock: DoorRecord | null;
  tankCapRank: number;
  siphonRank: number;
  nozzlePressureRank: number;
  gravCdRank: number;
  fuseRank: number;
  liningRank: number;
  hasSparkPlug: boolean;
  hasPiezoArc: boolean;
  hasCryoNozzle: boolean;
  has3GOverdrive: boolean;
  hasGyroStabilizer: boolean;
  hasAblativePlating: boolean;
  nearbyTerminalIndex: number | null;
  scrap: number;
  kills: number;
  podsTotal: number;
  podsRemaining: number;
  runCleared: boolean;
  clearTimeS: number;
  nextEntityId: number;
  player: Entity;
  entities: Entity[];
  lockOn: LockOnTarget | null;
  playerTank: PlayerTankState;
  gravityPulse: GravityPulseState;
  suit: SuitActionState;
  impactTelemetry: ImpactTelemetry;
  zeroGLoftTicksLeft: number;
  zeroGLoftDirY: -1 | 1;
  gravityChangedThisTick: boolean;
  entryLedgers: ConservationLedgers;
  room: RoomState;
}

export function createEmptyInput(): InputFrame {
  return {
    moveX: 0,
    moveZ: 0,
    ascend: false,
    descend: false,
    pressQ: false,
    pressC: false,
    pressV: false,
    aimX: 0,
    aimY: 0,
    aimZ: 1,
    hasAimPoint: false,
    aimPointX: 0,
    aimPointY: 0,
    aimPointZ: 0,
    primaryHeld: false,
    siphonHeld: false,
    pressDash: false,
    pressInteract: false,
    pressSwapChamber: false,
    pressCycleNozzle: false,
  };
}

export function createPlayerEntity(spawnX = 12.0, spawnY = 0.2, spawnZ = 1.0): Entity {
  return {
    id: 0,
    kind: 'player',
    x: spawnX,
    y: spawnY,
    z: spawnZ,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: PLAYER_AABB_W * 0.5,
    height: PLAYER_AABB_H,
    halfD: PLAYER_AABB_D * 0.5,
    upSign: 1,
    dryMassKg: PLAYER_DRY_MASS_KG,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'humanoid',
    glands: [],
    carapace: 'none',
    deathHusk: false,
    grounded: false,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 30,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createCrateEntity(
  id: number,
  x: number,
  y: number,
  z: number,
  bioCache = false,
): Entity {
  return {
    id,
    kind: 'crate',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: CRATE_SIZE_M * 0.5,
    height: CRATE_SIZE_M,
    halfD: CRATE_SIZE_M * 0.5,
    upSign: 1,
    dryMassKg: CRATE_DRY_MASS_KG,
    hp: CRATE_MAX_HP,
    maxHp: CRATE_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'prop',
    glands: [],
    carapace: 'none',
    deathHusk: false,
    grounded: true,
    bioCache,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 30,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createBroodPodEntity(
  id: number,
  x: number,
  y: number,
  z: number,
): Entity {
  return {
    id,
    kind: 'alien',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: POD_W_M * 0.5,
    height: POD_H_M,
    halfD: POD_D_M * 0.5,
    upSign: 1,
    dryMassKg: POD_DRY_MASS_KG,
    hp: POD_MAX_HP,
    maxHp: POD_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'pod',
    glands: [],
    carapace: 'none',
    deathHusk: false,
    grounded: true,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 30,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createSkittererEntity(
  id: number,
  x: number,
  y: number,
  z: number,
  glandMat: MaterialId = MAT.OIL,
): Entity {
  const glandTemp = glandMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  return {
    id,
    kind: 'alien',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: SKITTERER_W_M * 0.5,
    height: SKITTERER_H_M,
    halfD: SKITTERER_D_M * 0.5,
    upSign: 1,
    dryMassKg: SKITTERER_DRY_MASS_KG,
    hp: SKITTERER_MAX_HP,
    maxHp: SKITTERER_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'skitterer',
    glands: [
      {
        mat: glandMat,
        liters: SKITTERER_GLAND_CAP_L,
        capL: SKITTERER_GLAND_CAP_L,
        tempByte: glandTemp,
        chargeUnits: 0,
      },
    ],
    carapace: 'none',
    deathHusk: false,
    grounded: true,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 35,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createBruiserEntity(
  id: number,
  x: number,
  y: number,
  z: number,
  glandMat: MaterialId = MAT.OIL,
): Entity {
  const glandTemp = glandMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  return {
    id,
    kind: 'alien',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: BRUISER_W_M * 0.5,
    height: BRUISER_H_M,
    halfD: BRUISER_D_M * 0.5,
    upSign: 1,
    dryMassKg: BRUISER_DRY_MASS_KG,
    hp: BRUISER_MAX_HP,
    maxHp: BRUISER_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'crusher',
    glands: [
      {
        mat: glandMat,
        liters: BRUISER_GLAND_CAP_L,
        capL: BRUISER_GLAND_CAP_L,
        tempByte: glandTemp,
        chargeUnits: 0,
      },
    ],
    carapace: 'armored',
    deathHusk: false,
    grounded: true,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 50,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createSpitterEntity(
  id: number,
  x: number,
  y: number,
  z: number,
  glandMat: MaterialId = MAT.OIL,
): Entity {
  const glandTemp = glandMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  return {
    id,
    kind: 'alien',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: SPITTER_W_M * 0.5,
    height: SPITTER_H_M,
    halfD: SPITTER_D_M * 0.5,
    upSign: 1,
    dryMassKg: SPITTER_DRY_MASS_KG,
    hp: SPITTER_MAX_HP,
    maxHp: SPITTER_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'spitter',
    glands: [
      {
        mat: glandMat,
        liters: SPITTER_GLAND_CAP_L,
        capL: SPITTER_GLAND_CAP_L,
        tempByte: glandTemp,
        chargeUnits: 0,
      },
    ],
    carapace: 'none',
    deathHusk: false,
    grounded: true,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 40,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createFloaterEntity(
  id: number,
  x: number,
  y: number,
  z: number,
  glandMat: MaterialId = MAT.OIL,
): Entity {
  const glandTemp = glandMat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  return {
    id,
    kind: 'alien',
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    halfW: FLOATER_W_M * 0.5,
    height: FLOATER_HEIGHT_M,
    halfD: FLOATER_D_M * 0.5,
    upSign: 1,
    dryMassKg: FLOATER_DRY_MASS_KG,
    hp: FLOATER_MAX_HP,
    maxHp: FLOATER_MAX_HP,
    tempByte: TEMP_BYTE.AMBIENT,
    chargeUnits: 0,
    burnTicks: 0,
    wetTicks: 0,
    shockTicks: 0,
    stunTicks: 0,
    stunImmunityTicks: 0,
    dashTimer: 0,
    dashGraceTimer: 0,
    impactIFrames: 0,
    impulseTimer: 0,
    reflectCooldown: 0,
    locomotion: 'floater',
    glands: [
      {
        mat: glandMat,
        liters: FLOATER_GLAND_CAP_L,
        capL: FLOATER_GLAND_CAP_L,
        tempByte: glandTemp,
        chargeUnits: 0,
      },
    ],
    carapace: 'none',
    deathHusk: false,
    grounded: false,
    bioCache: false,
    aiState: 'idle',
    aiTimer: 0,
    aiAttackKind: 'none',
    attackCdTicks: 45,
    telegraphDirX: 0,
    telegraphDirY: 0,
    telegraphDirZ: 1,
    meleeHitDone: false,
  };
}

export function createStarterTank(tankCapRank = 0): PlayerTankState {
  return {
    baffled: false,
    activeChamber: 0,
    chambers: [
      {
        mat: MAT.AIR,
        liters: 0,
        capL: tankStarterCapL(tankCapRank),
        tempByte: TEMP_BYTE.AMBIENT,
        chargeUnits: 0,
        lockedSpill: false,
      },
      {
        mat: MAT.AIR,
        liters: 0,
        capL: tankBaffledChamberCapL(tankCapRank),
        tempByte: TEMP_BYTE.AMBIENT,
        chargeUnits: 0,
        lockedSpill: false,
      },
    ],
  };
}

export function createSuitActionState(): SuitActionState {
  return {
    nozzleMode: NOZZLE_MODE.STREAM,
    nozzleTapBurstShotsLeft: 0,
    nozzleTapSpacingTicks: 0,
    nozzleTapWaitTicks: 0,
    nozzleTapCdTicks: 0,
    nozzleHoseActive: false,
    airBurstCdTicks: 0,
    airBurstFlashTicks: 0,
    prevPrimaryHeld: false,
    dashCdTicks: 0,
    dashDirX: 0,
    dashDirY: 0,
    dashDirZ: 1,
    aimDirX: 0,
    aimDirY: 0,
    aimDirZ: 1,
    siphonActive: false,
    siphonMat: MAT.AIR,
    siphonTargetX: 0,
    siphonTargetY: 0,
    siphonTargetZ: 0,
    siphonLitersThisTick: 0,
    piezoArcCdTicks: 0,
    streamShockCdTicks: 0,
  };
}

export function createWorldState(runSeed: number): WorldState {
  const seed = runSeed >>> 0;
  const entities: Entity[] = [];
  const room = createEmptyRoomState(seed);
  room.entitiesRef = entities;
  return {
    runSeed: seed,
    simTick: 0,
    deck: null,
    currentRoomId: 0,
    nearbyDoor: null,
    pendingAirlock: null,
    tankCapRank: 0,
    siphonRank: 0,
    nozzlePressureRank: 0,
    gravCdRank: 0,
    fuseRank: 0,
    liningRank: 0,
    hasSparkPlug: false,
    hasPiezoArc: false,
    hasCryoNozzle: false,
    has3GOverdrive: false,
    hasGyroStabilizer: false,
    hasAblativePlating: false,
    nearbyTerminalIndex: null,
    scrap: 0,
    kills: 0,
    podsTotal: 0,
    podsRemaining: 0,
    runCleared: false,
    clearTimeS: 0,
    nextEntityId: 1,
    player: createPlayerEntity(12.0, 0.2, 1.0),
    entities,
    lockOn: null,
    playerTank: createStarterTank(0),
    gravityPulse: {
      activePulse: 'none',
      pulseTicksLeft: 0,
      cooldownTicks: 0,
      ownPulseExempt: false,
      ownPulseGraceTicks: 0,
    },
    suit: createSuitActionState(),
    impactTelemetry: {
      lastImpactSpeed: 0,
      lastWallSplatDmg: 0,
      lastImpactExempt: false,
      lastImpactTick: -1,
    },
    zeroGLoftTicksLeft: 0,
    zeroGLoftDirY: 1,
    gravityChangedThisTick: false,
    entryLedgers: {
      water: 0,
      oil: 0,
      cryo: 0,
      acid: 0,
      oilCombusted: 0,
      cryoBoiledOff: 0,
      acidConsumed: 0,
    },
    room,
  };
}

export function getActiveChamber(tank: PlayerTankState): TankChamberState {
  return tank.baffled ? tank.chambers[tank.activeChamber] : tank.chambers[0];
}

export function setTankCapRank(world: WorldState, rank: number): void {
  const clamped = Math.max(0, Math.min(3, rank | 0));
  world.tankCapRank = clamped;
  if (world.playerTank.baffled) {
    const cap = tankBaffledChamberCapL(clamped);
    world.playerTank.chambers[0].capL = cap;
    world.playerTank.chambers[1].capL = cap;
  } else {
    world.playerTank.chambers[0].capL = tankStarterCapL(clamped);
    world.playerTank.chambers[1].capL = tankBaffledChamberCapL(clamped);
  }
}

export function getFeetY(e: Entity): number {
  return e.upSign === 1 ? e.y : e.y + e.height;
}

export function getEffectiveMassKg(e: Entity, playerTank?: PlayerTankState): number {
  let fluidMass = 0;
  for (let i = 0; i < e.glands.length; i++) {
    const g = e.glands[i];
    if (g.liters > 0) {
      fluidMass += g.liters * MATERIAL_SPEC[g.mat].densityKgPerL;
    }
  }
  if (e.kind === 'player' && playerTank) {
    const count = playerTank.baffled ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const c = playerTank.chambers[i];
      if (c.liters > 0) {
        fluidMass += c.liters * MATERIAL_SPEC[c.mat].densityKgPerL;
      }
    }
  }
  return e.dryMassKg + fluidMass;
}

export function getPlumbDir(mode: GravityMode): -1 | 1 {
  return mode === GRAVITY_MODE.GN1 ? 1 : -1;
}

/**
 * Stage 1: Input & Suit Gravity Pulse State Machine (§6.1, §8.1, §8.2).
 */
export function stepSuitGravityState(world: WorldState, input: InputFrame): void {
  const prevGravityMode = world.room.gravityMode;
  const gp = world.gravityPulse;
  const cdTicks = Math.round(gravCooldownS(world.gravCdRank) * 60);

  if (gp.activePulse !== 'none') {
    gp.pulseTicksLeft--;
    if (gp.pulseTicksLeft <= 0) {
      gp.activePulse = 'none';
      gp.pulseTicksLeft = 0;
      world.room.gravityMode = GRAVITY_MODE.G1;
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60;
    }
  } else if (gp.cooldownTicks > 0) {
    gp.cooldownTicks--;
  }

  if (gp.ownPulseExempt && gp.activePulse === 'none') {
    if (gp.ownPulseGraceTicks > 0) {
      gp.ownPulseGraceTicks--;
      if (gp.ownPulseGraceTicks === 0) {
        gp.ownPulseExempt = false;
      }
    }
  }

  if (input.pressQ) {
    if (gp.activePulse !== 'none') {
      gp.activePulse = 'none';
      gp.pulseTicksLeft = 0;
      world.room.gravityMode = GRAVITY_MODE.G1;
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60;
    } else if (gp.cooldownTicks === 0) {
      const prevMode = world.room.gravityMode;
      world.room.gravityMode =
        prevMode === GRAVITY_MODE.G0 ? GRAVITY_MODE.G1 : GRAVITY_MODE.G0;
      if (world.room.gravityMode === GRAVITY_MODE.G0 && prevMode !== GRAVITY_MODE.G0) {
        world.zeroGLoftTicksLeft = LIFT_0G_TICKS;
        world.zeroGLoftDirY = prevMode === GRAVITY_MODE.GN1 ? -1 : 1;
      }
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60;
    }
  } else if (input.pressC) {
    if (gp.activePulse === 'none' && gp.cooldownTicks === 0) {
      gp.activePulse = 'crush';
      gp.pulseTicksLeft = Math.round(GRAV_CRUSH_S * 60);
      world.room.gravityMode = world.has3GOverdrive ? GRAVITY_MODE.G3 : GRAVITY_MODE.G2;
      world.player.upSign = 1;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 0;
    }
  } else if (input.pressV) {
    if (gp.activePulse === 'none' && gp.cooldownTicks === 0) {
      gp.activePulse = 'invert';
      gp.pulseTicksLeft = Math.round(GRAV_INVERT_S * 60);
      world.room.gravityMode = GRAVITY_MODE.GN1;
      world.player.upSign = -1;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 0;
    }
  }

  if (world.room.gravityMode !== prevGravityMode) {
    world.gravityChangedThisTick = true;
    if (world.room.gravityMode !== GRAVITY_MODE.G0) {
      world.zeroGLoftTicksLeft = 0;
    }
  }
  const targetUp: 1 | -1 = world.room.gravityMode === GRAVITY_MODE.GN1 ? -1 : 1;
  world.player.upSign = targetUp;
  for (let i = 0; i < world.entities.length; i++) {
    world.entities[i].upSign = targetUp;
  }
}
