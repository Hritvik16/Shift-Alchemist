import { CARGO_DECK_TOP_Y, MAT, TEMP_BYTE, VOXEL_SIZE_M, type MaterialId } from '../core/balance.ts';
import {
  generateDeckGraph,
  pickParametricCombatDims,
  pickParametricSetpieces,
  type DeckRoomNode,
} from '../core/deckGen.ts';
import { placeOrDeferFluid } from '../core/fluids.ts';
import { generateParametricArena, populateParametricArenaEntities } from '../core/setpieces.ts';
import { loadInitialDeckRoom } from '../core/snapshot.ts';
import {
  cellIndex,
  chunkIndex,
  createDefaultWorkbenchState,
  inRoomBounds,
  packVoxel,
  recomputeRoomLedgers,
  recountChunkFluids,
  resetRoomRuntimeTransient,
  type RoomState,
} from '../core/types.ts';
import { upgradeToBaffledTank } from '../core/workbench.ts';
import {
  createBruiserEntity,
  createCrateEntity,
  createFloaterEntity,
  createSkittererEntity,
  createSpitterEntity,
  getActiveChamber,
  type WorldState,
} from '../core/world.ts';
import type { SuitHud } from './hud.ts';

function syncSandboxLedgers(world: WorldState): void {
  recomputeRoomLedgers(world.room, world.playerTank);
  world.entryLedgers = { ...world.room.ledgers };
}

function buildCleanArenaShell(room: RoomState, W: number, H: number, D: number, seed: number): void {
  resetRoomRuntimeTransient(room);
  room.roomSeed = seed >>> 0;
  room.setpieces = [];
  room.cleared = false;
  room.workbenchAlcoveIndex = 0;
  room.workbenchTerminals.length = 0;
  room.workbenchState = createDefaultWorkbenchState();
  room.roomW = W;
  room.roomH = H;
  room.roomD = D;
  room.vats.length = 0;
  room.emitters.length = 0;
  room.doors.length = 0;
  room.ledgers = { water: 0, oil: 0, cryo: 0, acid: 0, oilCombusted: 0, cryoBoiledOff: 0, acidConsumed: 0 };
  room.grid.fill(packVoxel(MAT.AIR, TEMP_BYTE.AMBIENT));

  const put = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MaterialId, t: number = TEMP_BYTE.AMBIENT): void => {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          room.grid[cellIndex(x, y, z)] = packVoxel(mat, t);
        }
      }
    }
  };
  put(0, 0, 0, W - 1, 0, D - 1, MAT.BOUNDARY_HULL);
  put(0, H - 1, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  put(0, 0, 0, W - 1, H - 1, 0, MAT.BOUNDARY_HULL);
  put(0, 0, D - 1, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  put(0, 0, 0, 0, H - 1, D - 1, MAT.BOUNDARY_HULL);
  put(W - 1, 0, 0, W - 1, H - 1, D - 1, MAT.BOUNDARY_HULL);
  put(1, H - 2, 1, W - 2, H - 2, D - 2, MAT.HULL_STEEL);
  put(1, 1, 1, W - 2, CARGO_DECK_TOP_Y - 1, D - 2, MAT.HULL_STEEL);
}

function finalizeCleanArena(room: RoomState): void {
  const cxMax = room.roomW >> 4;
  const cyMax = room.roomH >> 4;
  const czMax = room.roomD >> 4;
  for (let cy = 0; cy < 4; cy++) {
    for (let cz = 0; cz < 15; cz++) {
      for (let cx = 0; cx < 15; cx++) {
        const cIdx = chunkIndex(cx, cy, cz);
        const oob = cx >= cxMax || cy >= cyMax || cz >= czMax;
        room.outOfBounds[cIdx] = oob ? 1 : 0;
        room.dirtySolidMesh[cIdx] = oob ? 0 : 1;
        room.dirtyFluidRender[cIdx] = oob ? 0 : 1;
        room.dirtyDecals[cIdx] = 0;
        room.dirtySnapshot[cIdx] = 0;
      }
    }
  }
  recountChunkFluids(room);
}

function addArenaVat(room: RoomState, x0: number, y0: number, z0: number, mat: MaterialId): void {
  const w = 16;
  const h = 14;
  const d = 14;
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  const z1 = z0 + d - 1;
  const t = mat === MAT.CRYO ? TEMP_BYTE.CRYO : TEMP_BYTE.AMBIENT;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const shell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
        room.grid[cellIndex(x, y, z)] = packVoxel(shell ? MAT.GLASS_VAT : mat, t);
      }
    }
  }
  room.vats.push({
    id: room.vats.length,
    mat,
    minX: x0,
    minY: y0,
    minZ: z0,
    maxX: x1,
    maxY: y1,
    maxZ: z1,
    centerX: (x0 + x1 + 1) * 0.5 * VOXEL_SIZE_M,
    centerY: (y0 + y1 + 1) * 0.5 * VOXEL_SIZE_M,
    centerZ: (z0 + z1 + 1) * 0.5 * VOXEL_SIZE_M,
    interiorLiters: (w - 2) * (h - 2) * (d - 2),
  });
}

function addFloorHazard(room: RoomState, kind: 'conduit' | 'vent', cx: number, cy: number, cz: number): void {
  for (let dy = 0; dy <= 2; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (inRoomBounds(room, cx + dx, cy + dy, cz + dz)) {
          room.grid[cellIndex(cx + dx, cy + dy, cz + dz)] = packVoxel(MAT.HULL_STEEL, TEMP_BYTE.AMBIENT);
        }
      }
    }
  }
  room.emitters.push({
    kind,
    x: cx,
    y: kind === 'conduit' ? cy + 1 : cy,
    z: cz,
    faceDir: kind === 'vent' ? '+Y' : '+Z',
    timer: 0,
    reserveL: 0,
  });
}

export class PlaytestBar {
  private readonly toggleBtn: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly guideEl: HTMLDivElement;
  private open = false;

  constructor(
    parent: HTMLElement,
    world: WorldState,
    hud: SuitHud,
    onRoomReset: () => void,
  ) {
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.textContent = '[F4] TEST SCENARIOS';
    this.toggleBtn.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:30',
      'background:rgba(12,18,28,0.88)',
      'border:1px solid rgba(255,209,102,0.6)',
      'border-radius:5px',
      'padding:4px 12px',
      'color:#ffd166',
      'font-family:monospace',
      'font-size:11px',
      'font-weight:bold',
      'cursor:pointer',
    ].join(';');
    this.toggleBtn.addEventListener('click', () => this.toggle());
    parent.appendChild(this.toggleBtn);

    this.panel = document.createElement('div');
    this.panel.style.cssText = [
      'position:fixed',
      'top:38px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:30',
      'background:rgba(10,14,22,0.94)',
      'border:1px solid rgba(255,209,102,0.55)',
      'border-radius:6px',
      'padding:8px 10px',
      'color:#dcecf8',
      'font-family:monospace',
      'font-size:11px',
      'display:none',
      'flex-direction:column',
      'gap:6px',
      'max-width:760px',
    ].join(';');
    parent.appendChild(this.panel);

    const makeRow = (title: string): HTMLDivElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:5px';
      const lbl = document.createElement('span');
      lbl.textContent = title;
      lbl.style.cssText = 'color:#9db2cc;min-width:68px;font-weight:bold';
      row.appendChild(lbl);
      this.panel.appendChild(row);
      return row;
    };

    const addBtn = (row: HTMLDivElement, text: string, accent: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = [
        'background:#182233',
        `border:1px solid ${accent}`,
        'border-radius:4px',
        'padding:4px 8px',
        'color:#e8f6ff',
        'font-family:monospace',
        'font-size:11px',
        'cursor:pointer',
      ].join(';');
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
        (ev.currentTarget as HTMLButtonElement).blur();
      });
      row.appendChild(b);
    };

    this.guideEl = document.createElement('div');
    this.guideEl.style.cssText =
      'color:#5ef2d6;font-size:11px;line-height:1.4;border-top:1px solid rgba(94,242,214,0.2);padding-top:5px;display:none';
    const setGuide = (msg: string): void => {
      this.guideEl.textContent = msg;
      this.guideEl.style.display = 'block';
    };

    const loadTank = (mat: MaterialId, tempByte: number, liters = 80): void => {
      const ch = getActiveChamber(world.playerTank);
      ch.mat = mat;
      ch.liters = Math.min(ch.capL, liters);
      ch.tempByte = tempByte;
      ch.chargeUnits = 0;
      ch.lockedSpill = false;
    };

    const placePlayerClean = (x: number, y: number, z: number): void => {
      world.player.x = x;
      world.player.y = y;
      world.player.z = z;
      world.player.vx = 0;
      world.player.vy = 0;
      world.player.vz = 0;
      world.player.hp = world.player.maxHp;
      world.player.grounded = true;
    };

    const dropPuddle = (cx: number, cy: number, cz: number, rx: number, rz: number, mat: MaterialId, tempByte: number): void => {
      for (let dz = -rz; dz <= rz; dz++) {
        for (let dx = -rx; dx <= rx; dx++) {
          placeOrDeferFluid(world.room, mat, tempByte, 0, cx + dx, cy, cz + dz, true, world.player, world.simTick);
        }
      }
    };

    // Row 1: Clean Purpose-Built Arena Scenarios (each resets cleanly into a spacious playable room!)
    const rArenas = makeRow('ARENAS:');
    let arenaSeed = 4201;

    addBtn(rArenas, '1. Roll Setpiece Arena', '#5ef2d6', () => {
      arenaSeed = (arenaSeed + 137) >>> 0;
      const templates = ['corridor', 'reactor', 'cargo'] as const;
      const tpl = templates[arenaSeed % templates.length];
      const dims = pickParametricCombatDims(tpl, arenaSeed);
      const sp = pickParametricSetpieces(arenaSeed, 2);
      const mockDeck = generateDeckGraph(arenaSeed, false);
      const targetNode: DeckRoomNode = {
        id: 1,
        roomSeed: arenaSeed,
        template: tpl,
        dims,
        setpieces: sp,
        combatIndex: 2,
        alcoveIndex: 0,
        doors: [{ face: 'N', targetRoomId: 0, targetFace: 'S', isExtraction: false }],
      };
      mockDeck.nodes[1] = targetNode;
      world.deck = mockDeck;
      world.currentRoomId = 1;
      generateParametricArena(world.room, targetNode);
      populateParametricArenaEntities(world, targetNode);
      placePlayerClean(dims.w * 0.5 * VOXEL_SIZE_M, 0.2, 1.0);
      syncSandboxLedgers(world);
      onRoomReset();
      setGuide(
        `PARAMETRIC ARENA: ${dims.w}x${dims.d} stitching [${sp[0]} + ${sp[1]}]. Click again to roll another setpiece combo & layout!`,
      );
      hud.spawnCallout(world.player.x, world.player.y + 1.6, world.player.z, `${sp[0].toUpperCase()} + ${sp[1].toUpperCase()}`, 0x5ef2d6);
    });

    addBtn(rArenas, '1b. Flooded Sump (-1G)', '#ff6be6', () => {
      arenaSeed = (arenaSeed + 73) >>> 0;
      const dims = { w: 144, h: 64, d: 144, chunks: (144 / 16) * 4 * (144 / 16) };
      const mockDeck = generateDeckGraph(arenaSeed, false);
      const targetNode: DeckRoomNode = {
        id: 1,
        roomSeed: arenaSeed,
        template: 'reactor',
        dims,
        setpieces: ['flooded_sump', 'tesla_pit'],
        combatIndex: 2,
        alcoveIndex: 0,
        doors: [{ face: 'N', targetRoomId: 0, targetFace: 'S', isExtraction: false }],
      };
      mockDeck.nodes[1] = targetNode;
      world.deck = mockDeck;
      world.currentRoomId = 1;
      generateParametricArena(world.room, targetNode);
      populateParametricArenaEntities(world, targetNode);
      placePlayerClean(dims.w * 0.5 * VOXEL_SIZE_M, 0.2, 1.0);
      syncSandboxLedgers(world);
      onRoomReset();
      setGuide(
        'FLOODED SUMP: Press [V] (-1G) to rain the sub-floor fluid UPWARD through the steel grates, then [C] (2G Crush) to smash hovering Floaters straight into the flooded deck!',
      );
      hud.spawnCallout(world.player.x, world.player.y + 1.6, world.player.z, 'FLOODED SUMP • PRESS [V] / [C]', 0xff6be6);
    });

    addBtn(rArenas, '2. Bruiser Counter Arena', '#9aa7b8', () => {
      const room = world.room;
      buildCleanArenaShell(room, 144, 64, 144, 6002);
      world.entities.length = 0;

      // Clean open 14.4x14.4 m deck with 3 distinct vats + Floor Tesla Pylon + Wide Floor Furnace Grate
      addArenaVat(room, 14, CARGO_DECK_TOP_Y, 14, MAT.CRYO);
      addArenaVat(room, 114, CARGO_DECK_TOP_Y, 14, MAT.WATER);
      addArenaVat(room, 14, CARGO_DECK_TOP_Y, 114, MAT.OIL);
      addFloorHazard(room, 'conduit', 96, CARGO_DECK_TOP_Y, 54);
      addFloorHazard(room, 'vent', 56, CARGO_DECK_TOP_Y, 96);

      // Floor water moat beside the Tesla Pylon + oil slick beside the Furnace Grate
      dropPuddle(90, CARGO_DECK_TOP_Y, 54, 7, 6, MAT.WATER, TEMP_BYTE.AMBIENT);
      dropPuddle(64, CARGO_DECK_TOP_Y, 96, 6, 5, MAT.OIL, TEMP_BYTE.AMBIENT);

      world.entities.push(createBruiserEntity(world.nextEntityId++, 7.6, 1.2, 7.2, MAT.OIL));
      world.entities.push(createCrateEntity(world.nextEntityId++, 5.0, 1.2, 5.2, false));
      world.room.entitiesRef = world.entities;
      world.podsTotal = 1;
      world.podsRemaining = 1;

      finalizeCleanArena(room);
      placePlayerClean(3.6, 1.2, 7.2);
      loadTank(MAT.CRYO, TEMP_BYTE.CRYO, 90);
      syncSandboxLedgers(world);
      onRoomReset();
      setGuide(
        'BRUISER ARENA (90L CRYO loaded): Spray Cryo directly on the Bruiser until FROZEN -> Air Burst for 3x CRYO SHATTER (-45)! Or lure it into the yellow Tesla Pylon water / glowing Furnace Grate!',
      );
      hud.spawnCallout(world.player.x, world.player.y + 1.6, world.player.z, 'BRUISER COUNTER ARENA', 0x9aa7b8);
    });

    addBtn(rArenas, '3. Scaffold & Pack Arena', '#ff9f1c', () => {
      const room = world.room;
      buildCleanArenaShell(room, 144, 64, 144, 6003);
      world.entities.length = 0;

      // Central flammable WOOD_BARRIER scaffolding (legs + elevated deck)
      const lx0 = 64;
      const lz0 = 56;
      const platY0 = CARGO_DECK_TOP_Y + 20;
      const platY1 = CARGO_DECK_TOP_Y + 21;
      for (const [gx, gz] of [[lx0, lz0], [lx0 + 18, lz0], [lx0, lz0 + 18], [lx0 + 18, lz0 + 18]]) {
        for (let y = CARGO_DECK_TOP_Y; y < platY0; y++) {
          for (let dz = 0; dz < 3; dz++) {
            for (let dx = 0; dx < 3; dx++) {
              room.grid[cellIndex(gx + dx, y, gz + dz)] = packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT);
            }
          }
        }
      }
      for (let y = platY0; y <= platY1; y++) {
        for (let z = lz0; z <= lz0 + 20; z++) {
          for (let x = lx0; x <= lx0 + 20; x++) {
            room.grid[cellIndex(x, y, z)] = packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT);
          }
        }
      }

      addArenaVat(room, 16, CARGO_DECK_TOP_Y, 16, MAT.OIL);
      addArenaVat(room, 112, CARGO_DECK_TOP_Y, 16, MAT.WATER);
      addFloorHazard(room, 'vent', 74, CARGO_DECK_TOP_Y, 92);
      dropPuddle(74, CARGO_DECK_TOP_Y, 66, 11, 10, MAT.OIL, TEMP_BYTE.AMBIENT);

      world.entities.push(createSpitterEntity(world.nextEntityId++, 7.4, (platY1 + 1) * VOXEL_SIZE_M, 6.6, MAT.OIL));
      for (let k = 0; k < 3; k++) {
        const sk = createSkittererEntity(world.nextEntityId++, 6.0 + k * 1.6, 1.2, 10.6, MAT.OIL);
        sk.attackCdTicks = 15 + k * 14;
        world.entities.push(sk);
      }
      world.room.entitiesRef = world.entities;
      world.podsTotal = 4;
      world.podsRemaining = 4;

      finalizeCleanArena(room);
      placePlayerClean(3.4, 1.2, 9.2);
      world.hasSparkPlug = true;
      loadTank(MAT.OIL, TEMP_BYTE.AMBIENT, 90);
      syncSandboxLedgers(world);
      onRoomReset();
      setGuide(
        'SCAFFOLD & PACK ARENA (Spark-Plug ON + 90L Oil): Ignite the oil beneath the wooden legs -> sustained flames climb the scaffold, burn for several seconds, drop the Spitter, and roast the 3-Skitterer pack!',
      );
      hud.spawnCallout(world.player.x, world.player.y + 1.6, world.player.z, 'SCAFFOLD & PACK ARENA', 0xff9f1c);
    });

    addBtn(rArenas, '4. Open Alchemy Sandbox', '#ffe84d', () => {
      const room = world.room;
      buildCleanArenaShell(room, 128, 64, 128, 6004);
      world.entities.length = 0;

      addArenaVat(room, 12, CARGO_DECK_TOP_Y, 12, MAT.WATER);
      addArenaVat(room, 56, CARGO_DECK_TOP_Y, 12, MAT.OIL);
      addArenaVat(room, 100, CARGO_DECK_TOP_Y, 12, MAT.CRYO);

      // Floor Tesla Pylon with a big ready water pool + adjacent oil strip to test full-puddle yellow electricity & spark-ignition
      addFloorHazard(room, 'conduit', 94, CARGO_DECK_TOP_Y, 68);
      dropPuddle(80, CARGO_DECK_TOP_Y, 68, 12, 8, MAT.WATER, TEMP_BYTE.AMBIENT);
      dropPuddle(64, CARGO_DECK_TOP_Y, 68, 3, 6, MAT.OIL, TEMP_BYTE.AMBIENT);

      // Wide Furnace Grate + flammable Wood Barricade on the west side
      addFloorHazard(room, 'vent', 32, CARGO_DECK_TOP_Y, 68);
      for (let z = 54; z <= 82; z++) {
        for (let y = CARGO_DECK_TOP_Y; y < CARGO_DECK_TOP_Y + 10; y++) {
          room.grid[cellIndex(44, y, z)] = packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT);
          room.grid[cellIndex(45, y, z)] = packVoxel(MAT.WOOD_BARRIER, TEMP_BYTE.AMBIENT);
        }
      }

      world.entities.push(createCrateEntity(world.nextEntityId++, 5.4, 1.2, 9.6, false));
      world.room.entitiesRef = world.entities;
      world.podsTotal = 0;
      world.podsRemaining = 0;

      finalizeCleanArena(room);
      placePlayerClean(6.4, 1.2, 10.6);
      loadTank(MAT.WATER, TEMP_BYTE.AMBIENT, 90);
      syncSandboxLedgers(world);
      onRoomReset();
      setGuide(
        'ALCHEMY SANDBOX: Spray the yellow Floor Tesla Pylon to electrify the entire water pool & spark the oil into sustained wood fire, or shatter any vat and spawn enemies below!',
      );
      hud.spawnCallout(world.player.x, world.player.y + 1.6, world.player.z, 'OPEN ALCHEMY SANDBOX', 0xffe84d);
    });

    addBtn(rArenas, '5. Workbench Alcove', '#3be8b0', () => {
      const deck = world.deck;
      if (deck) {
        const wbNode = deck.nodes.find((n) => n.alcoveIndex === 1);
        if (wbNode) {
          const d = wbNode.doors[0];
          loadInitialDeckRoom(world, deck, wbNode.id, d ? d.face : null);
          for (const e of world.entities) {
            if (e.kind === 'alien') e.hp = 0;
          }
          onRoomReset();
        }
      }
      world.scrap = Math.max(world.scrap, 500);
      if (!world.playerTank.baffled) upgradeToBaffledTank(world);
      syncSandboxLedgers(world);
      setGuide('WORKBENCH READY (+500 Scrap & Baffled Tank [R]): Walk to the 4 pedestals and press [F] to buy upgrades.');
    });

    // Row 2: Instant Tank Fill, Suit Mods & On-Demand Enemy Spawners
    const rQuick = makeRow('TOOLS:');
    addBtn(rQuick, 'Fill: Water', '#3da8ff', () => { loadTank(MAT.WATER, TEMP_BYTE.AMBIENT, 90); syncSandboxLedgers(world); });
    addBtn(rQuick, 'Fill: Oil', '#e8a14a', () => { loadTank(MAT.OIL, TEMP_BYTE.AMBIENT, 90); syncSandboxLedgers(world); });
    addBtn(rQuick, 'Fill: Cryo', '#5be7ff', () => { loadTank(MAT.CRYO, TEMP_BYTE.CRYO, 90); syncSandboxLedgers(world); });
    addBtn(rQuick, 'Spark-Plug', '#ff9f1c', () => {
      world.hasSparkPlug = !world.hasSparkPlug;
      setGuide(world.hasSparkPlug ? 'SPARK-PLUG ON: Final Oil liter auto-ignites!' : 'SPARK-PLUG OFF.');
    });
    addBtn(rQuick, 'Piezo-Arc', '#ffe84d', () => {
      world.hasPiezoArc = !world.hasPiezoArc;
      setGuide(world.hasPiezoArc ? 'PIEZO-ARC ON: Fired Water lands charged +120V!' : 'PIEZO-ARC OFF.');
    });
    addBtn(rQuick, 'Cryo-Nozzle', '#5be7ff', () => {
      world.hasCryoNozzle = !world.hasCryoNozzle;
      setGuide(world.hasCryoNozzle ? 'CRYO-NOZZLE ON: Fired Water freezes to ICE on impact!' : 'CRYO-NOZZLE OFF.');
    });
    addBtn(rQuick, '+Bruiser', '#9aa7b8', () => {
      const room = world.room;
      const sx = Math.max(1.5, Math.min(room.roomW * VOXEL_SIZE_M - 1.5, world.player.x + 3.2));
      const sz = Math.max(1.5, Math.min(room.roomD * VOXEL_SIZE_M - 1.5, world.player.z));
      world.entities.push(createBruiserEntity(world.nextEntityId++, sx, world.player.y, sz, MAT.OIL));
      world.room.entitiesRef = world.entities;
      syncSandboxLedgers(world);
    });
    addBtn(rQuick, '+Spitter', '#3be8b0', () => {
      const room = world.room;
      const sx = Math.max(1.5, Math.min(room.roomW * VOXEL_SIZE_M - 1.5, world.player.x + 3.2));
      const sz = Math.max(1.5, Math.min(room.roomD * VOXEL_SIZE_M - 1.5, world.player.z));
      world.entities.push(createSpitterEntity(world.nextEntityId++, sx, world.player.y, sz, MAT.OIL));
      world.room.entitiesRef = world.entities;
      syncSandboxLedgers(world);
    });
    addBtn(rQuick, '+Floater', '#e082ff', () => {
      const room = world.room;
      const sx = Math.max(1.5, Math.min(room.roomW * VOXEL_SIZE_M - 1.5, world.player.x + 3.4));
      const sz = Math.max(1.5, Math.min(room.roomD * VOXEL_SIZE_M - 1.5, world.player.z));
      world.entities.push(createFloaterEntity(world.nextEntityId++, sx, world.player.y + 1.5, sz, MAT.OIL));
      world.room.entitiesRef = world.entities;
      syncSandboxLedgers(world);
    });
    addBtn(rQuick, '+Skitterer', '#ff4d79', () => {
      const room = world.room;
      const sx = Math.max(1.5, Math.min(room.roomW * VOXEL_SIZE_M - 1.5, world.player.x + 3.0));
      const sz = Math.max(1.5, Math.min(room.roomD * VOXEL_SIZE_M - 1.5, world.player.z));
      world.entities.push(createSkittererEntity(world.nextEntityId++, sx, world.player.y, sz, MAT.OIL));
      world.room.entitiesRef = world.entities;
      syncSandboxLedgers(world);
    });
    addBtn(rQuick, 'Next Room', '#38b6ff', () => {
      const deck = world.deck;
      if (!deck) return;
      const node = deck.nodes[world.currentRoomId];
      const nextDoor =
        node.doors.find((d) => d.targetRoomId !== null && d.targetRoomId > world.currentRoomId) ??
        node.doors.find((d) => d.targetRoomId !== null);
      if (!nextDoor || nextDoor.targetRoomId === null) return;
      const oppFace = nextDoor.face === 'N' ? 'S' : nextDoor.face === 'S' ? 'N' : nextDoor.face === 'E' ? 'W' : 'E';
      loadInitialDeckRoom(world, deck, nextDoor.targetRoomId, oppFace);
      onRoomReset();
    });

    this.panel.appendChild(this.guideEl);
  }

  public toggle(): void {
    this.open = !this.open;
    this.panel.style.display = this.open ? 'flex' : 'none';
  }
}
