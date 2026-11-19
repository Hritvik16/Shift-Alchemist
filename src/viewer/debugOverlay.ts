import type { ConservationLedgers } from '../core/types.ts';

export interface DebugMetrics {
  fps: number;
  p95Ms: number;
  p99Ms: number;
  simMs: number;
  renderMs: number;
  drawCalls: number;
  triangles: number;
  meshedChunks: number;
  dirtyQueue: number;
  meshMemMB: number;
  decalCount: number;
  focusX: number;
  focusY: number;
  focusZ: number;
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
      'line-height:1.45',
      'pointer-events:none',
      'white-space:pre',
      'min-width:290px',
    ].join(';');
    parent.appendChild(this.el);
  }

  public toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  public update(m: DebugMetrics): void {
    if (!this.visible) return;
    this.el.textContent =
      `SHIFT ALCHEMIST v2 [M1.1 Cargo Hold]\n` +
      `FPS: ${m.fps.toFixed(1)} | p95: ${m.p95Ms.toFixed(2)}ms | p99: ${m.p99Ms.toFixed(2)}ms\n` +
      `Sim: ${m.simMs.toFixed(2)}ms | Render: ${m.renderMs.toFixed(2)}ms\n` +
      `Draw Calls: ${m.drawCalls} | Tris: ${m.triangles.toLocaleString()}\n` +
      `Chunks Meshed: ${m.meshedChunks} | Dirty Q: ${m.dirtyQueue}\n` +
      `Mesh Mem: ${m.meshMemMB.toFixed(2)} / 48.00 MB | Decals: ${m.decalCount} / 512\n` +
      `Focus: (${m.focusX.toFixed(1)}, ${m.focusY.toFixed(1)}, ${m.focusZ.toFixed(1)}) m\n` +
      `Hover: ${m.hoveredInfo}\n` +
      `Ledgers (L): W=${m.ledgers.water} O=${m.ledgers.oil} C=${m.ledgers.cryo} A=${m.ledgers.acid}\n` +
      `─────────────────────────────────────\n` +
      `WASD: Pan Focus | E/Shift: Focus +/-Y\n` +
      `Wheel: Zoom | 1-6: Carve Sphere | LMB: Damage\n` +
      `F3: Toggle Overlay`;
  }
}
