import {
  GRAV_CRUSH_S,
  GRAV_INVERT_S,
  GRAVITY_MODE,
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
import { createEmptyRoomState, type RoomState } from './types.ts';

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

export interface InputFrame {
  moveX: number; // -1..+1 screen-aligned or world-aligned input (normalized in stage 1)
  moveZ: number;
  ascend: boolean; // E in 0G
  descend: boolean; // Left-Shift in 0G
  pressQ: boolean; // Edge-triggered
  pressC: boolean; // Edge-triggered
  pressV: boolean; // Edge-triggered
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
  gravCdRank: number;
  has3GOverdrive: boolean;
  scrap: number;
  player: Entity;
  playerTank: PlayerTankState;
  gravityPulse: GravityPulseState;
  impactTelemetry: ImpactTelemetry;
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

export function createWorldState(runSeed: number): WorldState {
  const seed = runSeed >>> 0;
  return {
    runSeed: seed,
    simTick: 0,
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
    impactTelemetry: {
      lastImpactSpeed: 0,
      lastWallSplatDmg: 0,
      lastImpactExempt: false,
      lastImpactTick: -1,
    },
    room: createEmptyRoomState(seed),
  };
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
  const gp = world.gravityPulse;
  const cdTicks = Math.round(gravCooldownS(world.gravCdRank) * 60);

  // 1. Tick active timed pulse or cooldown
  if (gp.activePulse !== 'none') {
    gp.pulseTicksLeft--;
    if (gp.pulseTicksLeft <= 0) {
      gp.activePulse = 'none';
      gp.pulseTicksLeft = 0;
      world.room.gravityMode = GRAVITY_MODE.G1;
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks; // Cooldown starts when C/V ends
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60; // 1.0 s grace or until ground touch
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

  // 2. Process Q / C / V edges deterministically
  if (input.pressQ) {
    if (gp.activePulse !== 'none') {
      // Early cancel of active C/V back to 1G; starts GRAV_CD now; does NOT also toggle 0G
      gp.activePulse = 'none';
      gp.pulseTicksLeft = 0;
      world.room.gravityMode = GRAVITY_MODE.G1;
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60;
    } else if (gp.cooldownTicks === 0) {
      // Toggle 1G <-> 0G, starting GRAV_CD immediately
      world.room.gravityMode =
        world.room.gravityMode === GRAVITY_MODE.G0 ? GRAVITY_MODE.G1 : GRAVITY_MODE.G0;
      world.player.upSign = 1;
      gp.cooldownTicks = cdTicks;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 60;
    }
  } else if (input.pressC) {
    // Baseline 2G Crush (3G with Overdrive); mutually blocked while C/V active
    if (gp.activePulse === 'none' && gp.cooldownTicks === 0) {
      gp.activePulse = 'crush';
      gp.pulseTicksLeft = Math.round(GRAV_CRUSH_S * 60);
      world.room.gravityMode = world.has3GOverdrive ? GRAVITY_MODE.G3 : GRAVITY_MODE.G2;
      world.player.upSign = 1;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 0;
    }
  } else if (input.pressV) {
    // Baseline -1G Inversion; mutually blocked while C/V active
    if (gp.activePulse === 'none' && gp.cooldownTicks === 0) {
      gp.activePulse = 'invert';
      gp.pulseTicksLeft = Math.round(GRAV_INVERT_S * 60);
      world.room.gravityMode = GRAVITY_MODE.GN1;
      world.player.upSign = -1;
      gp.ownPulseExempt = true;
      gp.ownPulseGraceTicks = 0;
    }
  }

  // Keep upSign aligned with room gravity
  world.player.upSign = world.room.gravityMode === GRAVITY_MODE.GN1 ? -1 : 1;
}
