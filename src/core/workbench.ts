import {
  MAT,
  MAX_UPGRADE_RANK,
  PLAYER_PATCH_HEAL,
  TEMP_BYTE,
  WORKBENCH_COSTS,
  computeBaffledAutoSplit,
  tankBaffledChamberCapL,
} from './balance.ts';
import { hash32 } from './hash.ts';
import { setTankCapRank, type WorldState } from './world.ts';

export const WORKBENCH_INTERACT_RANGE_M = 1.5;
export const ALCOVE_1_NON_PATCH_CAP = 4;
// Tier B exposes Phase-Lock Fuse ranks 1-2 (rank 3 X manual trigger is Tier C, §9)
export const MAX_FUSE_RANK_ACTIVE = 2;

export type WorkbenchOfferId =
  | 'patch'
  | 'baffled'
  | 'tankCap'
  | 'siphon'
  | 'nozzlePressure'
  | 'gravCd'
  | 'fuse'
  | 'lining'
  | 'sparkPlug'
  | 'piezoArc'
  | 'cryoNozzle'
  | 'overdrive3G'
  | 'gyroStabilizer'
  | 'ablativePlating';

export type WorkbenchTerminalStatus =
  | 'available'
  | 'cant_afford'
  | 'full_hp'
  | 'sold_out'
  | 'offline';

export interface WorkbenchOfferView {
  terminalIndex: 0 | 1 | 2 | 3;
  status: WorkbenchTerminalStatus;
  offerId: WorkbenchOfferId | null;
  title: string;
  subtitle: string;
  cost: number;
  alcoveCapRemaining: number | null;
}

interface PoolCandidate {
  id: WorkbenchOfferId;
  title: string;
  subtitle: string;
  cost: number;
}

/**
 * Converts Starter Tank -> Baffled Dual-Chamber Tank at current shared tankCapRank
 * with zero-overflow auto-split (§3.2, §9).
 */
export function upgradeToBaffledTank(world: WorldState): void {
  const tank = world.playerTank;
  if (tank.baffled) return;

  const oldA = tank.chambers[0];
  const rank = world.tankCapRank;
  const chamberCap = tankBaffledChamberCapL(rank);
  const { toA, toB } = computeBaffledAutoSplit(oldA.liters, rank);

  tank.baffled = true;
  tank.activeChamber = 0;

  tank.chambers[0].capL = chamberCap;
  tank.chambers[0].liters = toA;
  if (toA <= 0) {
    tank.chambers[0].mat = MAT.AIR;
    tank.chambers[0].tempByte = TEMP_BYTE.AMBIENT;
    tank.chambers[0].chargeUnits = 0;
  }

  tank.chambers[1].capL = chamberCap;
  if (toB > 0) {
    tank.chambers[1].mat = oldA.mat;
    tank.chambers[1].liters = toB;
    tank.chambers[1].tempByte = oldA.tempByte;
    tank.chambers[1].chargeUnits = oldA.chargeUnits;
    tank.chambers[1].lockedSpill = false;
  } else {
    tank.chambers[1].mat = MAT.AIR;
    tank.chambers[1].liters = 0;
    tank.chambers[1].tempByte = TEMP_BYTE.AMBIENT;
    tank.chambers[1].chargeUnits = 0;
    tank.chambers[1].lockedSpill = false;
  }
}

function getAlcoveRemainingNonPatch(world: WorldState): number | null {
  if (world.room.workbenchAlcoveIndex !== 1) return null;
  return Math.max(0, ALCOVE_1_NON_PATCH_CAP - world.room.workbenchState.nonPatchCount);
}

function getTrackPoolCandidates(world: WorldState): PoolCandidate[] {
  const out: PoolCandidate[] = [];

  // §9: Once Baffled Tank is owned, Tank Cap is sold only by Terminal 2 (index 1)
  if (!world.playerTank.baffled && world.tankCapRank < MAX_UPGRADE_RANK) {
    const next = world.tankCapRank + 1;
    out.push({
      id: 'tankCap',
      title: `TANK CAP RK ${next}`,
      subtitle: '+30 L Starter Capacity',
      cost: WORKBENCH_COSTS.baseTrack[world.tankCapRank],
    });
  }
  if (world.siphonRank < MAX_UPGRADE_RANK) {
    const next = world.siphonRank + 1;
    out.push({
      id: 'siphon',
      title: `SIPHON TURBINE RK ${next}`,
      subtitle: '+60 L/s Intake Rate',
      cost: WORKBENCH_COSTS.baseTrack[world.siphonRank],
    });
  }
  if (world.nozzlePressureRank < MAX_UPGRADE_RANK) {
    const next = world.nozzlePressureRank + 1;
    out.push({
      id: 'nozzlePressure',
      title: `NOZZLE PRESSURE RK ${next}`,
      subtitle: '+20% Velocity & Air Burst',
      cost: WORKBENCH_COSTS.baseTrack[world.nozzlePressureRank],
    });
  }
  if (world.gravCdRank < MAX_UPGRADE_RANK) {
    const next = world.gravCdRank + 1;
    out.push({
      id: 'gravCd',
      title: `GRAVITY CAPACITOR RK ${next}`,
      subtitle: '-0.5 s Pulse Cooldown',
      cost: WORKBENCH_COSTS.baseTrack[world.gravCdRank],
    });
  }
  if (world.fuseRank < MAX_FUSE_RANK_ACTIVE) {
    const next = world.fuseRank + 1;
    out.push({
      id: 'fuse',
      title: `PHASE-LOCK FUSE RK ${next}`,
      subtitle: next === 1 ? '0.5 s Delayed Impact Fuse' : '1.5 s Delayed Impact Fuse',
      cost: WORKBENCH_COSTS.hazardTrack[world.fuseRank],
    });
  }
  if (world.liningRank < MAX_UPGRADE_RANK) {
    const next = world.liningRank + 1;
    const sub =
      next === 1
        ? 'Own-Blast Immunity'
        : next === 2
          ? 'Flame Weave (Burn Immune)'
          : 'Shock Stun & Frost Insulation';
    out.push({
      id: 'lining',
      title: `HAZARD LINING RK ${next}`,
      subtitle: sub,
      cost: WORKBENCH_COSTS.hazardTrack[world.liningRank],
    });
  }

  return out;
}

function getAttachmentPoolCandidates(world: WorldState): PoolCandidate[] {
  const out: PoolCandidate[] = [];
  const cost = WORKBENCH_COSTS.attachment;
  if (!world.hasSparkPlug) {
    out.push({
      id: 'sparkPlug',
      title: 'SPARK-PLUG IGNITER',
      subtitle: 'Auto-Ignites Final Oil Liter',
      cost,
    });
  }
  if (!world.hasPiezoArc) {
    out.push({
      id: 'piezoArc',
      title: 'PIEZO-ARC COIL',
      subtitle: 'Electrifies Fired Water (+120 V)',
      cost,
    });
  }
  if (!world.hasCryoNozzle) {
    out.push({
      id: 'cryoNozzle',
      title: 'CRYO-EXPANSION NOZZLE',
      subtitle: 'Freezes Fired Water into ICE',
      cost,
    });
  }
  if (!world.has3GOverdrive) {
    out.push({
      id: 'overdrive3G',
      title: '3G OVERDRIVE',
      subtitle: 'Upgrades C Pulse (2G -> 3G)',
      cost,
    });
  }
  if (!world.hasGyroStabilizer) {
    out.push({
      id: 'gyroStabilizer',
      title: 'GYRO STABILIZER',
      subtitle: 'Halves 0G Recoil Impulses',
      cost,
    });
  }
  if (!world.hasAblativePlating) {
    out.push({
      id: 'ablativePlating',
      title: 'ABLATIVE PLATING',
      subtitle: '-30% Wall-Splat Impact Dmg',
      cost,
    });
  }
  return out;
}

/**
 * Computes the deterministic world-space offer & status for a Workbench terminal (§9).
 */
export function getWorkbenchOffer(
  world: WorldState,
  terminalIndex: 0 | 1 | 2 | 3,
): WorkbenchOfferView {
  const room = world.room;
  const wb = room.workbenchState;
  const alcoveCapRemaining = getAlcoveRemainingNonPatch(world);

  if (!room.cleared) {
    return {
      terminalIndex,
      status: 'offline',
      offerId: null,
      title: 'WORKBENCH OFFLINE',
      subtitle: 'Clear All Brood Pods to Power',
      cost: 0,
      alcoveCapRemaining,
    };
  }

  // Terminal 0 (Spec Terminal 1): Suit Patch (30 Scrap, max 1/alcove)
  if (terminalIndex === 0) {
    if (wb.patchBought) {
      return {
        terminalIndex,
        status: 'sold_out',
        offerId: null,
        title: 'SUIT PATCH',
        subtitle: '1 Per Alcove Used',
        cost: WORKBENCH_COSTS.patch,
        alcoveCapRemaining,
      };
    }
    if (world.player.hp >= world.player.maxHp) {
      return {
        terminalIndex,
        status: 'full_hp',
        offerId: 'patch',
        title: 'SUIT PATCH (+25 HP)',
        subtitle: 'FULL HP',
        cost: WORKBENCH_COSTS.patch,
        alcoveCapRemaining,
      };
    }
    return {
      terminalIndex,
      status: world.scrap >= WORKBENCH_COSTS.patch ? 'available' : 'cant_afford',
      offerId: 'patch',
      title: `SUIT PATCH (+${PLAYER_PATCH_HEAL} HP)`,
      subtitle: 'Hull Sealant Injection',
      cost: WORKBENCH_COSTS.patch,
      alcoveCapRemaining,
    };
  }

  // Alcove 1 non-patch cap check (4 purchases max across terminals 1, 2, 3)
  if (alcoveCapRemaining !== null && alcoveCapRemaining <= 0) {
    return {
      terminalIndex,
      status: 'sold_out',
      offerId: null,
      title: 'ALCOVE 1 LIMIT REACHED',
      subtitle: '4/4 Non-Patch Purchases Used',
      cost: 0,
      alcoveCapRemaining: 0,
    };
  }

  // Terminal 1 (Spec Terminal 2): Baffled Dual-Chamber Tank -> Tank Cap ranks
  if (terminalIndex === 1) {
    if (!world.playerTank.baffled) {
      const cost = WORKBENCH_COSTS.baffled;
      return {
        terminalIndex,
        status: world.scrap >= cost ? 'available' : 'cant_afford',
        offerId: 'baffled',
        title: 'BAFFLED DUAL TANK',
        subtitle: '2 Pressurized Chambers (R Swap)',
        cost,
        alcoveCapRemaining,
      };
    }
    if (world.tankCapRank >= MAX_UPGRADE_RANK) {
      return {
        terminalIndex,
        status: 'sold_out',
        offerId: null,
        title: 'TANK CAP MAXED',
        subtitle: 'Rank 3 Reached',
        cost: 0,
        alcoveCapRemaining,
      };
    }
    const next = world.tankCapRank + 1;
    const cost = WORKBENCH_COSTS.baseTrack[world.tankCapRank];
    return {
      terminalIndex,
      status: world.scrap >= cost ? 'available' : 'cant_afford',
      offerId: 'tankCap',
      title: `TANK CAP RK ${next}`,
      subtitle: '+15 L Per Baffled Chamber',
      cost,
      alcoveCapRemaining,
    };
  }

  // Terminal 2 (Spec Terminal 3): Seeded Base + Hazard Track pool
  if (terminalIndex === 2) {
    const pool = getTrackPoolCandidates(world);
    if (pool.length === 0) {
      return {
        terminalIndex,
        status: 'sold_out',
        offerId: null,
        title: 'ALL TRACKS MAXED',
        subtitle: 'No Upgrades Remaining',
        cost: 0,
        alcoveCapRemaining,
      };
    }
    const pick =
      pool[hash32(room.roomSeed, 2, wb.terminalPurchases[2]) % pool.length];
    return {
      terminalIndex,
      status: world.scrap >= pick.cost ? 'available' : 'cant_afford',
      offerId: pick.id,
      title: pick.title,
      subtitle: pick.subtitle,
      cost: pick.cost,
      alcoveCapRemaining,
    };
  }

  // Terminal 3 (Spec Terminal 4): Seeded Suit Attachment pool
  const attPool = getAttachmentPoolCandidates(world);
  if (attPool.length === 0) {
    return {
      terminalIndex,
      status: 'sold_out',
      offerId: null,
      title: 'ALL ATTACHMENTS OWNED',
      subtitle: '6/6 Installed',
      cost: 0,
      alcoveCapRemaining,
    };
  }
  const pick =
    attPool[hash32(room.roomSeed, 3, wb.terminalPurchases[3]) % attPool.length];
  return {
    terminalIndex,
    status: world.scrap >= pick.cost ? 'available' : 'cant_afford',
    offerId: pick.id,
    title: pick.title,
    subtitle: pick.subtitle,
    cost: pick.cost,
    alcoveCapRemaining,
  };
}

/**
 * Executes an immediate F-key purchase at the specified terminal if eligible (§9).
 */
export function purchaseWorkbenchTerminal(
  world: WorldState,
  terminalIndex: 0 | 1 | 2 | 3,
): boolean {
  const offer = getWorkbenchOffer(world, terminalIndex);
  if (offer.status !== 'available' || offer.offerId === null) return false;
  if (world.scrap < offer.cost) return false;

  world.scrap -= offer.cost;
  const wb = world.room.workbenchState;
  wb.terminalPurchases[terminalIndex]++;

  switch (offer.offerId) {
    case 'patch':
      world.player.hp = Math.min(world.player.maxHp, world.player.hp + PLAYER_PATCH_HEAL);
      wb.patchBought = true;
      return true;
    case 'baffled':
      upgradeToBaffledTank(world);
      wb.nonPatchCount++;
      return true;
    case 'tankCap':
      setTankCapRank(world, world.tankCapRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'siphon':
      world.siphonRank = Math.min(MAX_UPGRADE_RANK, world.siphonRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'nozzlePressure':
      world.nozzlePressureRank = Math.min(MAX_UPGRADE_RANK, world.nozzlePressureRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'gravCd':
      world.gravCdRank = Math.min(MAX_UPGRADE_RANK, world.gravCdRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'fuse':
      world.fuseRank = Math.min(MAX_FUSE_RANK_ACTIVE, world.fuseRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'lining':
      world.liningRank = Math.min(MAX_UPGRADE_RANK, world.liningRank + 1);
      wb.nonPatchCount++;
      return true;
    case 'sparkPlug':
      world.hasSparkPlug = true;
      wb.nonPatchCount++;
      return true;
    case 'piezoArc':
      world.hasPiezoArc = true;
      wb.nonPatchCount++;
      return true;
    case 'cryoNozzle':
      world.hasCryoNozzle = true;
      wb.nonPatchCount++;
      return true;
    case 'overdrive3G':
      world.has3GOverdrive = true;
      wb.nonPatchCount++;
      return true;
    case 'gyroStabilizer':
      world.hasGyroStabilizer = true;
      wb.nonPatchCount++;
      return true;
    case 'ablativePlating':
      world.hasAblativePlating = true;
      wb.nonPatchCount++;
      return true;
  }
}
