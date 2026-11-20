import {
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
  TEMP_BYTE,
  gravCooldownS,
  tankBaffledChamberCapL,
  tankStarterCapL,
  type GravityMode,
  type MaterialId,
} from './balance.ts';
import { createEmptyRoomState, type ConservationLedgers, type RoomState } from './types.ts';

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
  stunTicks: number;
  stunImmunityTicks: number;
  dashTimer: number;
  dashGraceTimer: number;
  impactIFrames: number;
  impulseTimer: number;
  reflectCooldown: number;
  locomotion: 'humanoid' | 'skitterer' | 'floater' | 'crusher' | 'boss' | 'prop';
  glands: GlandState[];
  carapace: 'none' | 'thermal' | 'insulated' | 'spined';
  deathHusk: boolean;
  grounded: boolean;
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

export interface SuitActionState {
  nozzleTapBurstShotsLeft: number;
  nozzleTapSpacingTicks: number;
  nozzleTapWaitTicks: number;
  nozzleTapCdTicks: number;
  nozzleHoseActive: boolean;
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
  primaryHeld: boolean; // Left-Click
  siphonHeld: boolean; // Right-Click
  pressDash: boolean; // Space (edge-triggered)
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
  tankCapRank: number;
  siphonRank: number;
  nozzlePressureRank: number;
  gravCdRank: number;
  has3GOverdrive: boolean;
  scrap: number;
  player: Entity;
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
    primaryHeld: false,
    siphonHeld: false,
    pressDash: false,
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
    nozzleTapBurstShotsLeft: 0,
    nozzleTapSpacingTicks: 0,
    nozzleTapWaitTicks: 0,
    nozzleTapCdTicks: 0,
    nozzleHoseActive: false,
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
  };
}

export function createWorldState(runSeed: number): WorldState {
  const seed = runSeed >>> 0;
  return {
    runSeed: seed,
    simTick: 0,
    tankCapRank: 0,
    siphonRank: 0,
    nozzlePressureRank: 0,
    gravCdRank: 0,
    has3GOverdrive: false,
    scrap: 0,
    player: createPlayerEntity(12.0, 0.2, 1.0),
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
    room: createEmptyRoomState(seed),
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
  world.player.upSign = world.room.gravityMode === GRAVITY_MODE.GN1 ? -1 : 1;
}
