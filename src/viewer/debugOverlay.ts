import type { GravityMode } from '../core/balance.ts';
import type { ConservationLedgers } from '../core/types.ts';

export interface DebugMetrics {
  fps: number;
  p95Ms: number;
  p99Ms: number;
  simMs: number;
  renderMs: number;
  simTick: number;
  drawCalls: number;
  triangles: number;
  meshedChunks: number;
  dirtyQueue: number;
  dirtyFluidQueue: number;
  meshMemMB: number;
  snapMemMB: number;
  roomInfo: string;
  decalCount: number;
  activeFluidCount: number;
  activeThermalCount: number;
  explosionQueueCount: number;
  ballisticCount: number;
  deferredCount: number;
  renderedGridFluid: number;
  renderedBallistic: number;
  adaptiveFallback: boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerVy: number;
  playerMassKg: number;
  tankSummary: string;
  siphonActive: boolean;
  lockOnInfo: string;
  podsInfo: string;
  entityCount: number;
  upSign: 1 | -1;
  grounded: boolean;
  gravityMode: GravityMode;
  plumbDistM: number;
  lastImpactV: number;
  lastSplatDmg: number;
  lastImpactExempt: boolean;
  hoveredInfo: string;
  ledgers: ConservationLedgers;
  ledgerDrift: { water: number; oil: number; cryo: number; acid: number };
}

export class DebugOverlay {
  private readonly el: HTMLDivElement;
  public visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:10px',
      'z-index:20',
      'background:rgba(10,14,22,0.84)',
      'border:1px solid rgba(110,190,255,0.35)',
      'border-radius:6px',
      'padding:10px 12px',
      'color:#d8e8f8',
      'font-size:12px',
      'line-height:1.4',
      'pointer-events:none',
      'white-space:pre',
      'min-width:345px',
    ].join(';');
    parent.appendChild(this.el);
  }

  public toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  public update(m: DebugMetrics): void {
    if (!this.visible) return;
    const impTag =
      m.lastImpactV > 0
        ? `${m.lastImpactV.toFixed(1)} m/s -> ${m.lastSplatDmg} dmg${m.lastImpactExempt ? ' (exempt)' : ''}`
        : 'none';
    const d = m.ledgerDrift;
    const totalDrift = Math.abs(d.water) + Math.abs(d.oil) + Math.abs(d.cryo) + Math.abs(d.acid);
    this.el.textContent =
      `SHIFT ALCHEMIST v2 [Tier B • M4.2-lite]${m.adaptiveFallback ? ' [FALLBACK 8/f]' : ''}\n` +
      `FPS: ${m.fps.toFixed(1)} | p95: ${m.p95Ms.toFixed(2)}ms | p99: ${m.p99Ms.toFixed(2)}ms\n` +
      `Sim: ${m.simMs.toFixed(2)}ms | Render: ${m.renderMs.toFixed(2)}ms | Tick: ${m.simTick}\n` +
      `Draw Calls: ${m.drawCalls} | Tris: ${m.triangles.toLocaleString()}\n` +
      `Chunks: ${m.meshedChunks} | Mesh Q: ${m.dirtyQueue} | Fluid Q: ${m.dirtyFluidQueue} | Mesh: ${m.meshMemMB.toFixed(2)}MB | Snap: ${m.snapMemMB.toFixed(2)}MB\n` +
      `Fluid Active: ${m.activeFluidCount}/16384 | Thermal: ${m.activeThermalCount}/8192 | Ball: ${m.ballisticCount}/4096 | ExplQ: ${m.explosionQueueCount}\n` +
      `Fluid Inst: ${m.renderedGridFluid} grid + ${m.renderedBallistic} ball = ${m.renderedGridFluid + m.renderedBallistic}/28672\n` +
      `Pos: (${m.playerX.toFixed(2)}, ${m.playerY.toFixed(2)}, ${m.playerZ.toFixed(2)}) vy=${m.playerVy.toFixed(1)} | Mass=${m.playerMassKg.toFixed(0)}kg\n` +
      `Tank: ${m.tankSummary} | Siphon=${m.siphonActive ? 'ON' : 'off'}\n` +
      `Lock: ${m.lockOnInfo} | Room: ${m.roomInfo} | Pods: ${m.podsInfo} | Ent: ${m.entityCount}/32\n` +
      `Grav: ${m.gravityMode} | upSign=${m.upSign > 0 ? '+1' : '-1'} | Grounded=${m.grounded ? 'Y' : 'N'} | Plumb=${m.plumbDistM.toFixed(2)}m\n` +
      `Last Impact: ${impTag}\n` +
      `Hover: ${m.hoveredInfo} | Decals: ${m.decalCount}/512\n` +
      `Ledgers (L): W=${m.ledgers.water} O=${m.ledgers.oil}(comb:${m.ledgers.oilCombusted}) C=${m.ledgers.cryo}(sub:${m.ledgers.cryoBoiledOff}) A=${m.ledgers.acid} | Drift=${totalDrift}\n` +
      `───────────────────────────────────────────────\n` +
      `WASD: Move | E/Shift: 0G +/-Y | Space: Jetpack Dash (14L)\n` +
      `LMB: Air Burst / Nozzle [Tab: Mode] | RMB: Siphon (6m)\n` +
      `Q: 1G<->0G / Cancel | C: 2G (3s) | V: -1G (3.5s) | F: Airlock / Interact\n` +
      `1-6: Carve Sphere | MMB: 2 Dmg Poke | F3: Overlay`;
  }
}
