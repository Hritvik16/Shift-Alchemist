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
  meshMemMB: number;
  decalCount: number;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerVy: number;
  upSign: 1 | -1;
  grounded: boolean;
  gravityMode: GravityMode;
  plumbDistM: number;
  lastImpactV: number;
  lastSplatDmg: number;
  lastImpactExempt: boolean;
  hoveredInfo: string;
  ledgers: ConservationLedgers;
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
      'line-height:1.42',
      'pointer-events:none',
      'white-space:pre',
      'min-width:305px',
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
    this.el.textContent =
      `SHIFT ALCHEMIST v2 [M1.2 Controller]\n` +
      `FPS: ${m.fps.toFixed(1)} | p95: ${m.p95Ms.toFixed(2)}ms | p99: ${m.p99Ms.toFixed(2)}ms\n` +
      `Sim: ${m.simMs.toFixed(2)}ms | Render: ${m.renderMs.toFixed(2)}ms | Tick: ${m.simTick}\n` +
      `Draw Calls: ${m.drawCalls} | Tris: ${m.triangles.toLocaleString()}\n` +
      `Chunks: ${m.meshedChunks} | Dirty Q: ${m.dirtyQueue} | Mem: ${m.meshMemMB.toFixed(2)}MB\n` +
      `Pos: (${m.playerX.toFixed(2)}, ${m.playerY.toFixed(2)}, ${m.playerZ.toFixed(2)}) vy=${m.playerVy.toFixed(1)}\n` +
      `Grav: ${m.gravityMode} | upSign=${m.upSign > 0 ? '+1' : '-1'} | Grounded=${m.grounded ? 'Y' : 'N'} | Plumb=${m.plumbDistM.toFixed(2)}m\n` +
      `Last Impact: ${impTag}\n` +
      `Hover: ${m.hoveredInfo} | Decals: ${m.decalCount}/512\n` +
      `Ledgers (L): W=${m.ledgers.water} O=${m.ledgers.oil} C=${m.ledgers.cryo} A=${m.ledgers.acid}\n` +
      `───────────────────────────────────────\n` +
      `WASD: Move | E/Shift: 0G +/-Y | Wheel: Zoom\n` +
      `Q: 1G<->0G / Cancel | C: 2G (3s) | V: -1G (3.5s)\n` +
      `1-6: Carve | LMB: Damage | F3: Overlay`;
  }
}
