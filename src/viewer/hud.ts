import { GRAV_CRUSH_S, GRAV_INVERT_S, GRAVITY_MODE, gravCooldownS } from '../core/balance.ts';
import type { WorldState } from '../core/world.ts';

export class SuitHud {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'left:14px',
      'z-index:15',
      'background:rgba(10,14,22,0.82)',
      'border:1px solid rgba(94,242,214,0.35)',
      'border-radius:6px',
      'padding:10px 14px',
      'color:#dcecf8',
      'font-size:12px',
      'line-height:1.5',
      'pointer-events:none',
      'min-width:235px',
    ].join(';');
    parent.appendChild(this.el);
  }

  public update(world: WorldState): void {
    const p = world.player;
    const gp = world.gravityPulse;
    const mode = world.room.gravityMode;
    const hpDisplay = Math.ceil(p.hp);
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));

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

    const chamberA = world.playerTank.chambers[0];
    this.el.innerHTML =
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px">` +
      `<span>SUIT HP</span><strong style="color:${hpDisplay <= 30 ? '#ff6b6b' : '#5ef2d6'}">${hpDisplay} / ${p.maxHp}</strong>` +
      `</div>` +
      `<div style="height:6px;background:#1c2433;border-radius:3px;overflow:hidden;margin-bottom:8px">` +
      `<div style="height:100%;width:${hpPct.toFixed(1)}%;background:${hpDisplay <= 30 ? '#ff6b6b' : '#3be8b0'}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px">` +
      `<span>GRAVITY <strong style="color:${modeColor}">${mode}</strong></span>` +
      `<span style="color:#9db2cc">${barLabel}</span>` +
      `</div>` +
      `<div style="height:6px;background:#1c2433;border-radius:3px;overflow:hidden;margin-bottom:8px">` +
      `<div style="height:100%;width:${barPct.toFixed(1)}%;background:${barColor}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;color:#9db2cc;font-size:11px">` +
      `<span>TANK A: ${chamberA.liters}/${chamberA.capL} L</span>` +
      `<span>SCRAP: ${world.scrap}</span>` +
      `</div>`;
  }
}
