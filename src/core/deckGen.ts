import {
  ARRIVAL_DIMS,
  BOSS_SANCTUM_DIMS,
  CARGO_HOLD_DIMS,
  CORRIDOR_DIMS,
  DECK_ROOMS_MIN,
  PARAMETRIC_CARGO_DIMS,
  PARAMETRIC_CORRIDOR_DIMS,
  PARAMETRIC_REACTOR_DIMS,
  REACTOR_DIMS,
  VOXEL_SIZE_M,
  type RoomDims,
} from './balance.ts';
import { hash32 } from './hash.ts';
import type { AlchemySetpieceId, DoorFace, SetpieceId, ShiftSetpieceId } from './types.ts';

export type RoomTemplate = 'arrival' | 'corridor' | 'reactor' | 'cargo' | 'side' | 'boss';

export interface DeckDoorLink {
  face: DoorFace;
  targetRoomId: number | null;
  targetFace: DoorFace | null;
  isExtraction: boolean;
}

export interface DeckRoomNode {
  id: number;
  roomSeed: number;
  template: RoomTemplate;
  dims: RoomDims;
  setpieces: SetpieceId[];
  combatIndex: number; // 0 for arrival/side/boss, 1..C for critical-path combat rooms
  alcoveIndex: 0 | 1 | 2; // 1 for Combat 3, 2 for Combat 6, else 0
  doors: DeckDoorLink[];
}

export interface DeckGraph {
  runSeed: number;
  arrivalRoomId: number;
  finalRoomId: number;
  combatCount: number;
  sideCount: number;
  includeBoss: boolean;
  nodes: DeckRoomNode[];
}

const ALL_FACES: readonly DoorFace[] = ['N', 'S', 'E', 'W'];
const COMBAT_TEMPLATES: readonly RoomTemplate[] = ['corridor', 'reactor', 'cargo'];

export const SHIFT_SETPIECES: readonly ShiftSetpieceId[] = [
  'flooded_sump',
  'split_chasm',
  'ceiling_vats',
];

export const ALCHEMY_SETPIECES: readonly AlchemySetpieceId[] = [
  'tinderbox_loft',
  'tesla_pit',
  'cryo_spillway',
  'fuel_choke',
];

export const ALL_SETPIECES: readonly SetpieceId[] = [
  ...SHIFT_SETPIECES,
  ...ALCHEMY_SETPIECES,
];

export function getOppositeFace(face: DoorFace): DoorFace {
  switch (face) {
    case 'N':
      return 'S';
    case 'S':
      return 'N';
    case 'E':
      return 'W';
    case 'W':
      return 'E';
  }
}

export function getRoomDimsForTemplate(template: RoomTemplate): RoomDims {
  switch (template) {
    case 'arrival':
    case 'side':
      return ARRIVAL_DIMS;
    case 'corridor':
      return CORRIDOR_DIMS;
    case 'reactor':
      return REACTOR_DIMS;
    case 'cargo':
      return CARGO_HOLD_DIMS;
    case 'boss':
      return BOSS_SANCTUM_DIMS;
  }
}

export function pickParametricCombatDims(template: RoomTemplate, roomSeed: number): RoomDims {
  if (template === 'corridor') {
    return PARAMETRIC_CORRIDOR_DIMS[hash32(roomSeed, 811, 0) % PARAMETRIC_CORRIDOR_DIMS.length];
  }
  if (template === 'reactor') {
    return PARAMETRIC_REACTOR_DIMS[hash32(roomSeed, 811, 1) % PARAMETRIC_REACTOR_DIMS.length];
  }
  if (template === 'cargo') {
    return PARAMETRIC_CARGO_DIMS[hash32(roomSeed, 811, 2) % PARAMETRIC_CARGO_DIMS.length];
  }
  return getRoomDimsForTemplate(template);
}

export function pickParametricSetpieces(roomSeed: number, combatIndex: number): [SetpieceId, SetpieceId] {
  // Every combat arena pairs 1 Shift-Architecture layout (Q/C/V mandatory) + 1 Alchemy-Trap setpiece
  const shiftPick = SHIFT_SETPIECES[(hash32(roomSeed, 823, combatIndex) + combatIndex) % SHIFT_SETPIECES.length];
  const alchPick = ALCHEMY_SETPIECES[hash32(roomSeed, 829, combatIndex) % ALCHEMY_SETPIECES.length];
  return [shiftPick, alchPick];
}

export function getRoomDimsForNode(node: DeckRoomNode): RoomDims {
  return node.dims;
}

/**
 * Exact spawn point 1.0 m inside an entered airlock doorway on the y = 2 (0.2 m) floor (§4.2).
 */
export function getDoorSpawnPoint(
  dims: RoomDims,
  face: DoorFace,
): { x: number; y: number; z: number } {
  const cx = dims.w * 0.5 * VOXEL_SIZE_M;
  const cz = dims.d * 0.5 * VOXEL_SIZE_M;
  switch (face) {
    case 'N':
      return { x: cx, y: 0.2, z: 1.0 };
    case 'S':
      return { x: cx, y: 0.2, z: dims.d * VOXEL_SIZE_M - 1.0 };
    case 'W':
      return { x: 1.0, y: 0.2, z: cz };
    case 'E':
      return { x: dims.w * VOXEL_SIZE_M - 1.0, y: 0.2, z: cz };
  }
}

export function getArrivalInitialSpawn(): { x: number; y: number; z: number } {
  return {
    x: ARRIVAL_DIMS.w * 0.5 * VOXEL_SIZE_M,
    y: 0.2,
    z: ARRIVAL_DIMS.d * 0.5 * VOXEL_SIZE_M,
  };
}

function getFreeFaces(node: DeckRoomNode): DoorFace[] {
  const used = new Set<DoorFace>();
  for (let i = 0; i < node.doors.length; i++) {
    used.add(node.doors[i].face);
  }
  const free: DoorFace[] = [];
  for (let i = 0; i < ALL_FACES.length; i++) {
    if (!used.has(ALL_FACES[i])) free.push(ALL_FACES[i]);
  }
  return free;
}

/**
 * Concrete v1 Graph-Grammar Freighter Deck Generator (§9, §10.0) + Step 4 Parametric Arenas:
 * - 1 Arrival -> C in [6..8] Combat rooms (no consecutive template repeats, variable 112..208 x 112..176 dims, 2 setpieces each)
 *   -> Extraction airlock (Tier B) or Boss Sanctum (includeBoss = true)
 * - S in [2..4] leaf Side rooms attached to distinct non-alcove combat rooms
 * - Total rooms strictly in [10, 14], degree <= 4, symmetric opposite faces per edge.
 */
export function generateDeckGraph(runSeed: number, includeBoss = false): DeckGraph {
  const seed = runSeed >>> 0;
  const combatCount = 6 + (hash32(seed, 101, 0) % 3); // 6..8
  let sideCount = 2 + (hash32(seed, 102, 0) % 3); // 2..4
  if (!includeBoss && 1 + combatCount + sideCount < DECK_ROOMS_MIN) {
    sideCount = DECK_ROOMS_MIN - 1 - combatCount; // 3 when combatCount === 6
  }

  const nodes: DeckRoomNode[] = [];

  // Node 0: Arrival Airlock
  nodes.push({
    id: 0,
    roomSeed: hash32(seed, 0, 0),
    template: 'arrival',
    dims: ARRIVAL_DIMS,
    setpieces: [],
    combatIndex: 0,
    alcoveIndex: 0,
    doors: [],
  });

  // Nodes 1..combatCount: Critical-path parametric setpiece combat arenas
  let prevTemplate: RoomTemplate | null = null;
  for (let c = 1; c <= combatCount; c++) {
    const candidates: RoomTemplate[] = [];
    for (let i = 0; i < COMBAT_TEMPLATES.length; i++) {
      if (COMBAT_TEMPLATES[i] !== prevTemplate) {
        candidates.push(COMBAT_TEMPLATES[i]);
      }
    }
    const chosen = candidates[hash32(seed, 200, c) % candidates.length];
    prevTemplate = chosen;

    const rSeed = hash32(seed, c, 0);
    const alcoveIndex: 0 | 1 | 2 = c === 3 ? 1 : c === 6 ? 2 : 0;
    nodes.push({
      id: c,
      roomSeed: rSeed,
      template: chosen,
      dims: pickParametricCombatDims(chosen, rSeed),
      setpieces: pickParametricSetpieces(rSeed, c),
      combatIndex: c,
      alcoveIndex,
      doors: [],
    });
  }

  // Optional Boss Sanctum (Tier C)
  if (includeBoss) {
    const bossId = combatCount + 1;
    nodes.push({
      id: bossId,
      roomSeed: hash32(seed, bossId, 0),
      template: 'boss',
      dims: BOSS_SANCTUM_DIMS,
      setpieces: [],
      combatIndex: 0,
      alcoveIndex: 0,
      doors: [],
    });
  }

  // Wire critical-path chain edges with opposite faces
  const chainEndId = includeBoss ? combatCount + 1 : combatCount;
  for (let uId = 0; uId < chainEndId; uId++) {
    const u = nodes[uId];
    const v = nodes[uId + 1];
    const freeU = getFreeFaces(u);
    const faceU = freeU[hash32(seed, 300, uId) % freeU.length];
    const faceV = getOppositeFace(faceU);
    u.doors.push({ face: faceU, targetRoomId: v.id, targetFace: faceV, isExtraction: false });
    v.doors.push({ face: faceV, targetRoomId: u.id, targetFace: faceU, isExtraction: false });
  }

  // Tier B Extraction Airlock on a free face of the final combat room
  if (!includeBoss) {
    const finalNode = nodes[combatCount];
    const freeFinal = getFreeFaces(finalNode);
    const extFace = freeFinal[hash32(seed, 350, combatCount) % freeFinal.length];
    finalNode.doors.push({
      face: extFace,
      targetRoomId: null,
      targetFace: null,
      isExtraction: true,
    });
  }

  // Attach S leaf side-rooms to distinct combat rooms (preferring non-alcove rooms)
  const preferredHosts: number[] = [];
  const fallbackHosts: number[] = [];
  for (let c = 1; c <= combatCount; c++) {
    if (getFreeFaces(nodes[c]).length === 0) continue;
    if (nodes[c].alcoveIndex === 0) preferredHosts.push(c);
    else fallbackHosts.push(c);
  }

  for (let i = preferredHosts.length - 1; i > 0; i--) {
    const j = hash32(seed, 400, i) % (i + 1);
    const tmp = preferredHosts[i];
    preferredHosts[i] = preferredHosts[j];
    preferredHosts[j] = tmp;
  }
  const hostOrder = preferredHosts.concat(fallbackHosts);

  for (let s = 0; s < sideCount && s < hostOrder.length; s++) {
    const host = nodes[hostOrder[s]];
    const freeHost = getFreeFaces(host);
    if (freeHost.length === 0) continue;

    const sideId = nodes.length;
    const faceHost = freeHost[hash32(seed, 450, sideId) % freeHost.length];
    const faceSide = getOppositeFace(faceHost);

    const sideNode: DeckRoomNode = {
      id: sideId,
      roomSeed: hash32(seed, sideId, 0),
      template: 'side',
      dims: ARRIVAL_DIMS,
      setpieces: [],
      combatIndex: 0,
      alcoveIndex: 0,
      doors: [
        {
          face: faceSide,
          targetRoomId: host.id,
          targetFace: faceHost,
          isExtraction: false,
        },
      ],
    };
    host.doors.push({
      face: faceHost,
      targetRoomId: sideId,
      targetFace: faceSide,
      isExtraction: false,
    });
    nodes.push(sideNode);
  }

  return {
    runSeed: seed,
    arrivalRoomId: 0,
    finalRoomId: chainEndId,
    combatCount,
    sideCount,
    includeBoss,
    nodes,
  };
}
