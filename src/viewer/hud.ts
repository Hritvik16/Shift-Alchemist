import * as THREE from 'three';
import {
  DASH_CD_TICKS,
  GRAV_CRUSH_S,
  GRAV_INVERT_S,
  GRAVITY_MODE,
  MAT,
  MATERIAL_SPEC,
  TEMP_BYTE,
  byteToTempC,
  gravCooldownS,
} from '../core/balance.ts';
import { getWorkbenchOffer } from '../core/workbench.ts';
import { getEffectiveMassKg, type TankChamberState, type WorldState } from '../core/world.ts';

function formatHexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function formatSetpieceLabel(id: string): string {
  return id.replace(/_/g, ' ').toUpperCase();
}

function renderChamberBlock(
  label: string,
  chamber: TankChamberState,
  isActive: boolean,
  showActiveTag: boolean,
): string {
  const pct = Math.max(0, Math.min(100, (chamber.liters / Math.max(1, chamber.capL)) * 100));
  const empty = chamber.liters <= 0 || chamber.mat === MAT.AIR;
  const spec = MATERIAL_SPEC[chamber.mat];
  const matName = empty ? 'AIR BURST' : spec.name;
  const barCol = empty
    ? '#3a4659'
    : chamber.mat === MAT.OIL
      ? '#c88d55'
      : formatHexCss(spec.colorHex);
  const tempStr = empty ? '' : ` ${byteToTempC(chamber.tempByte)}°C`;
  const chargeStr = !empty && chamber.chargeUnits > 0 ? ` +${chamber.chargeUnits * 2}V` : '';
  const activeBadge =
    showActiveTag && isActive
      ? ' <span style="color:#5ef2d6;font-size:10px">[ACTIVE]</span>'
      : '';

  return (
    `<div style="margin-bottom:6px">` +
    `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">` +
    `<span>${label}${activeBadge} <strong style="color:${empty ? '#8ecae6' : barCol}">${matName}</strong>${tempStr}` +
    `${chargeStr ? `<strong style="color:#7ef9ff">${chargeStr}</strong>` : ''}</span>` +
    `<span>${chamber.liters}/${chamber.capL} L</span>` +
    `</div>` +
    `<div style="height:6px;background:#151d2b;border-radius:3px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,0.6)">` +
    `<div style="height:100%;width:${pct.toFixed(1)}%;background:${barCol};box-shadow:0 0 8px ${barCol}66"></div>` +
    `</div>` +
    `</div>`
  );
}

interface FloatingCallout {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
}

export class SuitHud {
  private readonly vignetteEl: HTMLDivElement;
  private readonly statusEdgeEl: HTMLDivElement;
  private readonly arrivalHintEl: HTMLDivElement;
  private readonly el: HTMLDivElement;
  private readonly objectiveEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly minimapEl: HTMLDivElement;
  private readonly callouts: FloatingCallout[] = [];
  private readonly tmpProj = new THREE.Vector3();
  private readonly visitedRooms = new Set<number>();
  private lastMapDeckSeed = -1;
  private lastMapRoomId = -1;
  private lastMapVisitedCount = -1;
  private lastStatusStyle = '';

  constructor(parent: HTMLElement) {
    // Subtle dark atmospheric edge vignette for isometric arena focus
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:5',
      'pointer-events:none',
      'background:radial-gradient(ellipse at center, rgba(6,10,18,0) 58%, rgba(4,7,13,0.46) 100%)',
    ].join(';');
    parent.appendChild(this.vignetteEl);

    // Reactive diegetic suit-status screen-edge pulse (burn / shock / brittle / low HP)
    this.statusEdgeEl = document.createElement('div');
    this.statusEdgeEl.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:6',
      'pointer-events:none',
      'transition:box-shadow 120ms ease-out',
    ].join(';');
    parent.appendChild(this.statusEdgeEl);

    // Clean Arrival Airlock controls footer (auto-hides once entering combat rooms)
    this.arrivalHintEl = document.createElement('div');
    this.arrivalHintEl.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'z-index:14',
      'background:rgba(10,14,22,0.78)',
      'backdrop-filter:blur(4px)',
      'border:1px solid rgba(94,242,214,0.28)',
      'border-radius:6px',
      'padding:7px 12px',
      'color:#b9d1e8',
      'font-size:11px',
      'line-height:1.5',
      'pointer-events:none',
      'display:none',
    ].join(';');
    this.arrivalHintEl.innerHTML =
      `<div style="color:#ffd166;font-weight:bold;margin-bottom:2px">SHIFT GATE: PRESS [Q] (0G) + [E] TO FLOAT OVER EXIT WALL</div>` +
      `<div><strong style="color:#ffd166">[LMB]</strong> Air Burst / Spray &nbsp; <strong style="color:#ffd166">[RMB]</strong> Siphon &nbsp; <strong style="color:#ffd166">[TAB]</strong> Nozzle</div>` +
      `<div><strong style="color:#62f2ff">[Q]</strong> 0G Float &nbsp; <strong style="color:#ffb347">[C]</strong> 2G Crush &nbsp; <strong style="color:#ff6be6">[V]</strong> -1G Flip &nbsp; <strong style="color:#3be8b0">[SPACE]</strong> Dash</div>`;
    parent.appendChild(this.arrivalHintEl);

    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'left:14px',
      'z-index:15',
      'background:rgba(9,13,21,0.84)',
      'backdrop-filter:blur(5px)',
      'border:1px solid rgba(94,242,214,0.38)',
      'box-shadow:0 4px 18px rgba(0,0,0,0.45)',
      'border-radius:6px',
      'padding:10px 14px',
      'color:#dcecf8',
      'font-size:12px',
      'line-height:1.45',
      'pointer-events:none',
      'min-width:268px',
    ].join(';');
    parent.appendChild(this.el);

    this.objectiveEl = document.createElement('div');
    this.objectiveEl.style.cssText = [
      'position:fixed',
      'top:14px',
      'right:14px',
      'z-index:15',
      'background:rgba(9,13,21,0.84)',
      'backdrop-filter:blur(5px)',
      'border:1px solid rgba(255,77,121,0.45)',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
      'border-radius:6px',
      'padding:8px 14px',
      'color:#dcecf8',
      'font-size:12px',
      'line-height:1.45',
      'pointer-events:none',
      'text-align:right',
    ].join(';');
    parent.appendChild(this.objectiveEl);

    this.bannerEl = document.createElement('div');
    this.bannerEl.style.cssText = [
      'position:fixed',
      'top:22%',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:25',
      'background:rgba(9,15,24,0.94)',
      'backdrop-filter:blur(6px)',
      'border:2px solid #5ef2d6',
      'box-shadow:0 0 28px rgba(94,242,214,0.28)',
      'border-radius:8px',
      'padding:16px 26px',
      'color:#e8f6ff',
      'font-size:14px',
      'line-height:1.6',
      'text-align:center',
      'pointer-events:none',
      'display:none',
    ].join(';');
    parent.appendChild(this.bannerEl);

    this.promptEl = document.createElement('div');
    this.promptEl.style.cssText = [
      'position:fixed',
      'bottom:26px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:20',
      'background:rgba(9,15,24,0.92)',
      'backdrop-filter:blur(5px)',
      'border:1px solid #5ef2d6',
      'box-shadow:0 4px 16px rgba(0,0,0,0.5)',
      'border-radius:6px',
      'padding:8px 16px',
      'color:#e8f6ff',
      'font-size:13px',
      'font-weight:bold',
      'pointer-events:none',
      'display:none',
    ].join(';');
    parent.appendChild(this.promptEl);

    this.minimapEl = document.createElement('div');
    this.minimapEl.style.cssText = [
      'position:fixed',
      'top:96px',
      'right:14px',
      'z-index:15',
      'background:rgba(9,13,21,0.82)',
      'backdrop-filter:blur(4px)',
      'border:1px solid rgba(94,242,214,0.32)',
      'box-shadow:0 4px 14px rgba(0,0,0,0.4)',
      'border-radius:6px',
      'padding:6px',
      'pointer-events:none',
      'width:128px',
      'height:128px',
      'display:none',
    ].join(';');
    parent.appendChild(this.minimapEl);

    for (let i = 0; i < 18; i++) {
      const cel = document.createElement('div');
      cel.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'z-index:22',
        'font-size:13px',
        'font-weight:bold',
        'letter-spacing:0.4px',
        'text-shadow:0 1px 5px rgba(0,0,0,0.95)',
        'pointer-events:none',
        'white-space:nowrap',
        'display:none',
      ].join(';');
      parent.appendChild(cel);
      this.callouts.push({ el: cel, x: 0, y: 0, z: 0, age: 0, life: 0 });
    }
  }

  public resetRun(): void {
    this.visitedRooms.clear();
    this.lastMapDeckSeed = -1;
    this.lastMapRoomId = -1;
    this.lastMapVisitedCount = -1;
    this.lastStatusStyle = '';
    this.statusEdgeEl.style.boxShadow = 'none';
    for (let i = 0; i < this.callouts.length; i++) {
      this.callouts[i].life = 0;
      this.callouts[i].el.style.display = 'none';
    }
  }

  public spawnCallout(x: number, y: number, z: number, text: string, colorHex: number): void {
    if (!text) return;
    let slot = this.callouts[0];
    let oldest = -1;
    for (let i = 0; i < this.callouts.length; i++) {
      const c = this.callouts[i];
      if (c.life <= 0) {
        slot = c;
        break;
      }
      if (c.age > oldest) {
        oldest = c.age;
        slot = c;
      }
    }
    slot.x = x;
    slot.y = y + 0.35;
    slot.z = z;
    slot.age = 0;
    slot.life = 0.9;
    slot.el.textContent = text;
    slot.el.style.color = formatHexCss(colorHex);
    slot.el.style.display = 'block';
  }

  public updateCallouts(camera: THREE.Camera, dt: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < this.callouts.length; i++) {
      const c = this.callouts[i];
      if (c.life <= 0) continue;
      c.age += dt;
      if (c.age >= c.life) {
        c.life = 0;
        c.el.style.display = 'none';
        continue;
      }
      c.y += 1.15 * dt;
      this.tmpProj.set(c.x, c.y, c.z).project(camera);
      if (this.tmpProj.z > 1) {
        c.el.style.display = 'none';
        continue;
      }
      const sx = (this.tmpProj.x * 0.5 + 0.5) * w;
      const sy = (-this.tmpProj.y * 0.5 + 0.5) * h;
      const alpha = Math.max(0, 1 - Math.max(0, (c.age / c.life - 0.55) / 0.45));
      c.el.style.display = 'block';
      c.el.style.opacity = alpha.toFixed(2);
      c.el.style.transform = `translate(${(sx - 24).toFixed(0)}px, ${sy.toFixed(0)}px)`;
    }
  }

  private renderMinimap(world: WorldState): void {
    const deck = world.deck;
    if (!deck) {
      this.minimapEl.style.display = 'none';
      return;
    }
    this.minimapEl.style.display = 'block';
    this.visitedRooms.add(world.currentRoomId);

    if (
      this.lastMapDeckSeed === deck.runSeed &&
      this.lastMapRoomId === world.currentRoomId &&
      this.lastMapVisitedCount === this.visitedRooms.size
    ) {
      return;
    }
    this.lastMapDeckSeed = deck.runSeed;
    this.lastMapRoomId = world.currentRoomId;
    this.lastMapVisitedCount = this.visitedRooms.size;

    const coords = new Map<number, [number, number]>();
    coords.set(0, [0, 0]);
    const queue = [0];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const [gx, gy] = coords.get(id)!;
      for (const d of deck.nodes[id].doors) {
        if (d.targetRoomId === null || coords.has(d.targetRoomId)) continue;
        const nx = gx + (d.face === 'E' ? 1 : d.face === 'W' ? -1 : 0);
        const ny = gy + (d.face === 'S' ? 1 : d.face === 'N' ? -1 : 0);
        coords.set(d.targetRoomId, [nx, ny]);
        queue.push(d.targetRoomId);
      }
    }

    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (const [gx, gy] of coords.values()) {
      if (gx < minX) minX = gx;
      if (gx > maxX) maxX = gx;
      if (gy < minY) minY = gy;
      if (gy > maxY) maxY = gy;
    }
    const span = Math.max(2, maxX - minX, maxY - minY);
    const pad = 16;
    const usable = 116 - pad * 2;
    const toPx = (gx: number, gy: number): [number, number] => [
      pad + ((gx - minX + (span - (maxX - minX)) * 0.5) / span) * usable,
      pad + ((gy - minY + (span - (maxY - minY)) * 0.5) / span) * usable,
    ];

    const lines: string[] = [];
    const nodesSvg: string[] = [];
    const drawnEdges = new Set<string>();

    for (const node of deck.nodes) {
      const posA = coords.get(node.id);
      if (!posA) continue;
      const [x1, y1] = toPx(posA[0], posA[1]);
      for (const d of node.doors) {
        if (d.targetRoomId === null) continue;
        const key =
          node.id < d.targetRoomId ? `${node.id}-${d.targetRoomId}` : `${d.targetRoomId}-${node.id}`;
        if (drawnEdges.has(key)) continue;
        drawnEdges.add(key);
        const posB = coords.get(d.targetRoomId);
        if (!posB) continue;
        const [x2, y2] = toPx(posB[0], posB[1]);
        const seen = this.visitedRooms.has(node.id) || this.visitedRooms.has(d.targetRoomId);
        lines.push(
          `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${seen ? '#48607a' : '#1e2938'}" stroke-width="2" />`,
        );
      }
    }

    for (const node of deck.nodes) {
      const pos = coords.get(node.id);
      if (!pos) continue;
      const [px, py] = toPx(pos[0], pos[1]);
      const isCur = node.id === world.currentRoomId;
      const visited = this.visitedRooms.has(node.id);
      const isExt = node.doors.some((d) => d.isExtraction);
      const fill = isCur
        ? '#5ef2d6'
        : isExt
          ? '#ffd166'
          : node.template === 'side'
            ? '#38b6ff'
            : visited
              ? '#3b5f66'
              : '#1a2433';
      const stroke = isCur ? '#ffffff' : visited ? '#8ecae6' : '#3a4a60';
      const r = isCur ? 6.5 : 5;
      nodesSvg.push(
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />`,
      );

      let tag = '';
      if (isExt) tag = '★';
      else if (node.alcoveIndex > 0) tag = 'W';
      else if (node.template === 'side') tag = '$';
      if (tag) {
        nodesSvg.push(
          `<text x="${px.toFixed(1)}" y="${(py + 3).toFixed(1)}" text-anchor="middle" font-size="7.5" font-weight="bold" fill="#091018">${tag}</text>`,
        );
      }
    }

    this.minimapEl.innerHTML =
      `<svg width="116" height="116" viewBox="0 0 116 116">` +
      lines.join('') +
      nodesSvg.join('') +
      `<text x="108" y="10" text-anchor="end" font-size="8" fill="#6f87a3">N↑</text></svg>`;
  }

  public update(world: WorldState, cyclingAirlock = false): void {
    const p = world.player;
    const gp = world.gravityPulse;
    const mode = world.room.gravityMode;
    const hpDisplay = Math.ceil(p.hp);
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));

    // Diegetic screen-edge status feedback
    let edgeShadow = 'none';
    if (p.shockTicks > 0) {
      edgeShadow = 'inset 0 0 70px rgba(90, 232, 255, 0.36)';
    } else if (p.burnTicks > 0) {
      edgeShadow = 'inset 0 0 75px rgba(255, 107, 26, 0.34)';
    } else if (p.tempByte <= TEMP_BYTE.EMBRITTLED) {
      edgeShadow = 'inset 0 0 80px rgba(110, 240, 255, 0.34)';
    } else if (hpDisplay <= 30) {
      edgeShadow = 'inset 0 0 85px rgba(255, 56, 85, 0.32)';
    }
    if (edgeShadow !== this.lastStatusStyle) {
      this.lastStatusStyle = edgeShadow;
      this.statusEdgeEl.style.boxShadow = edgeShadow;
    }

    const badges: string[] = [];
    if (p.burnTicks > 0) {
      badges.push('<span style="color:#ff7b29;font-weight:bold">BURN</span>');
    }
    if (p.shockTicks > 0) {
      badges.push('<span style="color:#7ef9ff;font-weight:bold">SHOCK</span>');
    }
    if (p.tempByte <= TEMP_BYTE.EMBRITTLED) {
      badges.push('<span style="color:#7ef9ff;font-weight:bold">BRITTLE 3x</span>');
    } else if (p.tempByte !== TEMP_BYTE.AMBIENT) {
      badges.push(`<span style="color:#9db2cc">${byteToTempC(p.tempByte)}°C</span>`);
    }
    if (p.wetTicks > 0) {
      badges.push('<span style="color:#48bfe3;font-weight:bold">WET</span>');
    }
    const statusHtml = badges.length > 0 ? ` ${badges.join(' ')}` : '';

    let modeColor = '#5ef2d6';
    if (mode === GRAVITY_MODE.G0) modeColor = '#58c4ff';
    else if (mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3) modeColor = '#ffaa2b';
    else if (mode === GRAVITY_MODE.GN1) modeColor = '#ff5cd6';

    let barLabel = 'READY';
    let barPct = 100;
    let barColor = '#5ef2d6';

    if (gp.activePulse !== 'none') {
      const total = gp.activePulse === 'crush' ? GRAV_CRUSH_S * 60 : GRAV_INVERT_S * 60;
      barPct = Math.max(0, Math.min(100, (gp.pulseTicksLeft / total) * 100));
      barLabel = `PULSE ${(gp.pulseTicksLeft / 60).toFixed(1)}s (Q cancel)`;
      barColor = modeColor;
    } else if (gp.cooldownTicks > 0) {
      const total = gravCooldownS(world.gravCdRank) * 60;
      barPct = Math.max(0, Math.min(100, ((total - gp.cooldownTicks) / total) * 100));
      barLabel = `CD ${(gp.cooldownTicks / 60).toFixed(1)}s`;
      barColor = '#6c7a91';
    }

    const dashPct =
      p.dashTimer > 0
        ? 100
        : world.suit.dashCdTicks > 0
          ? Math.max(0, Math.min(100, ((DASH_CD_TICKS - world.suit.dashCdTicks) / DASH_CD_TICKS) * 100))
          : 100;
    const dashLabel =
      p.dashTimer > 0
        ? 'BOOST'
        : world.suit.dashCdTicks > 0
          ? `${(world.suit.dashCdTicks / 60).toFixed(1)}s`
          : 'READY';
    const dashCol = p.dashTimer > 0 ? '#ffd166' : world.suit.dashCdTicks > 0 ? '#6c7a91' : '#3be8b0';

    const tank = world.playerTank;
    const tankHtml =
      renderChamberBlock('TANK A', tank.chambers[0], tank.activeChamber === 0, tank.baffled) +
      (tank.baffled
        ? renderChamberBlock('TANK B', tank.chambers[1], tank.activeChamber === 1, true) +
          '<div style="font-size:10px;color:#5ef2d6;margin-top:-3px;margin-bottom:5px">[R] Swap Active Chamber</div>'
        : '');

    const massKg = getEffectiveMassKg(p, tank);

    this.el.innerHTML =
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px">` +
      `<span>SUIT HP${statusHtml}</span><strong style="color:${hpDisplay <= 30 ? '#ff6b6b' : '#5ef2d6'}">${hpDisplay} / ${p.maxHp}</strong>` +
      `</div>` +
      `<div style="height:6px;background:#151d2b;border-radius:3px;overflow:hidden;margin-bottom:8px;box-shadow:inset 0 1px 2px rgba(0,0,0,0.6)">` +
      `<div style="height:100%;width:${hpPct.toFixed(1)}%;background:${hpDisplay <= 30 ? '#ff6b6b' : '#3be8b0'}"></div>` +
      `</div>` +
      tankHtml +
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px;margin-top:4px">` +
      `<span>GRAVITY <strong style="color:${modeColor}">${mode}</strong></span>` +
      `<span style="color:#9db2cc">${barLabel}</span>` +
      `</div>` +
      `<div style="height:6px;background:#151d2b;border-radius:3px;overflow:hidden;margin-bottom:6px">` +
      `<div style="height:100%;width:${barPct.toFixed(1)}%;background:${barColor}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">` +
      `<span>JETPACK DASH</span><span style="color:${dashCol}">${dashLabel}</span>` +
      `</div>` +
      `<div style="height:5px;background:#151d2b;border-radius:3px;overflow:hidden;margin-bottom:7px">` +
      `<div style="height:100%;width:${dashPct.toFixed(1)}%;background:${dashCol}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;color:#9db2cc">` +
      `<span>NOZZLE [TAB]</span><strong style="color:#ffd166">${world.suit.nozzleMode.toUpperCase()}</strong>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;color:#9db2cc;font-size:11px">` +
      `<span>MASS: ${massKg.toFixed(0)} kg</span>` +
      `<span>SCRAP: ${world.scrap}</span>` +
      `</div>`;

    let roomLine = 'CARGO HOLD';
    let isArrival = false;
    if (world.deck !== null) {
      const node = world.deck.nodes[world.currentRoomId];
      if (node.template === 'arrival') {
        roomLine = 'ARRIVAL AIRLOCK';
        isArrival = true;
      } else if (node.template === 'side') {
        roomLine = 'SALVAGE BAY (SIDE)';
      } else if (node.template === 'boss') {
        roomLine = 'BOSS SANCTUM';
      } else {
        roomLine = `COMBAT ${node.combatIndex}/${world.deck.combatCount} • ${node.template.toUpperCase()}`;
      }
    }
    this.arrivalHintEl.style.display = isArrival && !world.runCleared ? 'block' : 'none';

    const setpieceLine =
      world.room.setpieces.length > 0
        ? `<div style="font-size:10px;color:#5ef2d6;letter-spacing:0.3px">${world.room.setpieces.map(formatSetpieceLabel).join(' • ')}</div>`
        : '';

    const podStatus =
      world.podsTotal === 0
        ? 'NO HOSTILES'
        : world.podsRemaining === 0
          ? 'SECTOR CLEARED'
          : `${world.deck !== null ? 'HOSTILES' : 'BROOD PODS'}: ${world.podsTotal - world.podsRemaining} / ${world.podsTotal}`;
    const lockTag = world.lockOn ? `LOCK: ${world.lockOn.kind.toUpperCase()}` : 'LOCK: NONE';
    this.objectiveEl.innerHTML =
      `<div style="color:#ffd166;font-weight:bold;font-size:11px;margin-bottom:1px">${roomLine}</div>` +
      setpieceLine +
      `<div style="color:${world.podsRemaining === 0 ? '#5ef2d6' : '#ff4d79'};font-weight:bold">` +
      `${podStatus}` +
      `</div>` +
      `<div style="font-size:11px;color:#9db2cc">${lockTag} | SEED #${world.runSeed}</div>`;

    if (cyclingAirlock) {
      this.promptEl.style.display = 'block';
      this.promptEl.style.borderColor = '#5ef2d6';
      this.promptEl.style.color = '#5ef2d6';
      this.promptEl.textContent = 'CYCLING AIRLOCK BULKHEAD...';
    } else if (world.nearbyTerminalIndex !== null && !world.runCleared) {
      const offer = getWorkbenchOffer(world, world.nearbyTerminalIndex as 0 | 1 | 2 | 3);
      const capTag =
        offer.alcoveCapRemaining !== null && offer.terminalIndex !== 0
          ? ` <span style="color:#9db2cc;font-size:11px">(${offer.alcoveCapRemaining}/4 Alcove 1 buys left)</span>`
          : '';
      this.promptEl.style.display = 'block';
      if (offer.status === 'offline') {
        this.promptEl.style.borderColor = '#ff595e';
        this.promptEl.style.color = '#ff8fa3';
        this.promptEl.innerHTML = `WORKBENCH OFFLINE — CLEAR ALL HOSTILES`;
      } else if (offer.status === 'sold_out') {
        this.promptEl.style.borderColor = '#6c7a91';
        this.promptEl.style.color = '#9db2cc';
        this.promptEl.innerHTML = `${offer.title} — <strong>SOLD OUT</strong>`;
      } else if (offer.status === 'full_hp') {
        this.promptEl.style.borderColor = '#3be8b0';
        this.promptEl.style.color = '#dcecf8';
        this.promptEl.innerHTML = `${offer.title} — <span style="color:#3be8b0">FULL HP</span>`;
      } else if (offer.status === 'cant_afford') {
        this.promptEl.style.borderColor = '#ff595e';
        this.promptEl.style.color = '#dcecf8';
        this.promptEl.innerHTML =
          `${offer.title} <span style="color:#9db2cc;font-weight:normal">(${offer.subtitle})</span> — ` +
          `<span style="color:#ff595e">${offer.cost} SCRAP</span>${capTag}`;
      } else {
        this.promptEl.style.borderColor = '#5ef2d6';
        this.promptEl.style.color = '#e8f6ff';
        this.promptEl.innerHTML =
          `<span style="color:#ffd166">[F]</span> ${offer.title} ` +
          `<span style="color:#9db2cc;font-weight:normal">(${offer.subtitle})</span> — ` +
          `<span style="color:#5ef2d6">${offer.cost} SCRAP</span>${capTag}`;
      }
    } else if (world.nearbyDoor && !world.runCleared) {
      this.promptEl.style.display = 'block';
      if (world.nearbyDoor.locked) {
        this.promptEl.style.borderColor = '#ff595e';
        this.promptEl.style.color = '#ff8fa3';
        this.promptEl.textContent = 'AIRLOCK LOCKED — CLEAR ALL HOSTILES';
      } else if (world.nearbyDoor.isExtraction) {
        this.promptEl.style.borderColor = '#ffd166';
        this.promptEl.style.color = '#ffd166';
        this.promptEl.textContent = '[F] EXTRACT — COMPLETE DECK RUN';
      } else {
        this.promptEl.style.borderColor = '#5ef2d6';
        this.promptEl.style.color = '#e8f6ff';
        const dest =
          world.deck && world.nearbyDoor.targetRoomId !== null
            ? world.deck.nodes[world.nearbyDoor.targetRoomId]
            : null;
        const destLabel = dest
          ? dest.template === 'arrival'
            ? 'ARRIVAL'
            : dest.template === 'side'
              ? 'SALVAGE BAY'
              : `COMBAT ${dest.combatIndex} (${dest.template.toUpperCase()})`
          : 'NEXT ROOM';
        this.promptEl.textContent = `[F] ENTER AIRLOCK -> ${destLabel}`;
      }
    } else {
      this.promptEl.style.display = 'none';
    }

    this.renderMinimap(world);

    if (world.runCleared) {
      this.bannerEl.style.display = 'block';
      const title = world.deck !== null ? 'FREIGHTER DECK EXTRACTED' : 'CARGO HOLD CLEARED';
      this.bannerEl.innerHTML =
        `<div style="font-size:18px;font-weight:bold;color:#5ef2d6;margin-bottom:4px">${title}</div>` +
        `<div>Time: <strong>${world.clearTimeS.toFixed(1)}s</strong> | Hostiles: <strong>${world.kills}</strong> | Scrap: <strong>${world.scrap}</strong></div>` +
        `<div style="margin-top:6px;color:#ffd166;font-size:12px">Press <strong>F</strong> for New Seed Run</div>`;
    } else {
      this.bannerEl.style.display = 'none';
    }
  }
}
