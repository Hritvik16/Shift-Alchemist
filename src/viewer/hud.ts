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
import { getEffectiveMassKg, type TankChamberState, type WorldState } from '../core/world.ts';

function formatHexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
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
  const barCol = empty ? '#3a4659' : formatHexCss(spec.colorHex);
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
    `<div style="height:6px;background:#1c2433;border-radius:3px;overflow:hidden">` +
    `<div style="height:100%;width:${pct.toFixed(1)}%;background:${barCol}"></div>` +
    `</div>` +
    `</div>`
  );
}

export class SuitHud {
  private readonly el: HTMLDivElement;
  private readonly objectiveEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'left:14px',
      'z-index:15',
      'background:rgba(10,14,22,0.84)',
      'border:1px solid rgba(94,242,214,0.35)',
      'border-radius:6px',
      'padding:10px 14px',
      'color:#dcecf8',
      'font-size:12px',
      'line-height:1.45',
      'pointer-events:none',
      'min-width:265px',
    ].join(';');
    parent.appendChild(this.el);

    this.objectiveEl = document.createElement('div');
    this.objectiveEl.style.cssText = [
      'position:fixed',
      'top:14px',
      'right:14px',
      'z-index:15',
      'background:rgba(10,14,22,0.84)',
      'border:1px solid rgba(255,77,121,0.45)',
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
      'background:rgba(10,16,26,0.92)',
      'border:2px solid #5ef2d6',
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
  }

  public update(world: WorldState): void {
    const p = world.player;
    const gp = world.gravityPulse;
    const mode = world.room.gravityMode;
    const hpDisplay = Math.ceil(p.hp);
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));

    const badges: string[] = [];
    if (p.burnTicks > 0) {
      badges.push('<span style="color:#ff7b29;font-weight:bold">BURN</span>');
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
        ? renderChamberBlock('TANK B', tank.chambers[1], tank.activeChamber === 1, true)
        : '');

    const massKg = getEffectiveMassKg(p, tank);

    this.el.innerHTML =
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px">` +
      `<span>SUIT HP${statusHtml}</span><strong style="color:${hpDisplay <= 30 ? '#ff6b6b' : '#5ef2d6'}">${hpDisplay} / ${p.maxHp}</strong>` +
      `</div>` +
      `<div style="height:6px;background:#1c2433;border-radius:3px;overflow:hidden;margin-bottom:8px">` +
      `<div style="height:100%;width:${hpPct.toFixed(1)}%;background:${hpDisplay <= 30 ? '#ff6b6b' : '#3be8b0'}"></div>` +
      `</div>` +
      tankHtml +
      `<div style="display:flex;justify-content:space-between;margin-bottom:3px;margin-top:4px">` +
      `<span>GRAVITY <strong style="color:${modeColor}">${mode}</strong></span>` +
      `<span style="color:#9db2cc">${barLabel}</span>` +
      `</div>` +
      `<div style="height:6px;background:#1c2433;border-radius:3px;overflow:hidden;margin-bottom:6px">` +
      `<div style="height:100%;width:${barPct.toFixed(1)}%;background:${barColor}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">` +
      `<span>JETPACK DASH</span><span style="color:${dashCol}">${dashLabel}</span>` +
      `</div>` +
      `<div style="height:5px;background:#1c2433;border-radius:3px;overflow:hidden;margin-bottom:7px">` +
      `<div style="height:100%;width:${dashPct.toFixed(1)}%;background:${dashCol}"></div>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;color:#9db2cc;font-size:11px">` +
      `<span>MASS: ${massKg.toFixed(0)} kg</span>` +
      `<span>SCRAP: ${world.scrap}</span>` +
      `</div>`;

    const lockTag = world.lockOn ? `LOCK: ${world.lockOn.kind.toUpperCase()}` : 'LOCK: NONE';
    this.objectiveEl.innerHTML =
      `<div style="color:${world.podsRemaining === 0 ? '#5ef2d6' : '#ff4d79'};font-weight:bold">` +
      `BROOD PODS: ${world.podsTotal - world.podsRemaining} / ${world.podsTotal}` +
      `</div>` +
      `<div style="font-size:11px;color:#9db2cc">${lockTag} | SEED #${world.runSeed}</div>`;

    if (world.runCleared) {
      this.bannerEl.style.display = 'block';
      this.bannerEl.innerHTML =
        `<div style="font-size:18px;font-weight:bold;color:#5ef2d6;margin-bottom:4px">CARGO HOLD CLEARED</div>` +
        `<div>Time: <strong>${world.clearTimeS.toFixed(1)}s</strong> | Pods: <strong>${world.kills}</strong> | Scrap: <strong>${world.scrap}</strong></div>` +
        `<div style="margin-top:6px;color:#ffd166;font-size:12px">Press <strong>F</strong> for New Seed Run</div>`;
    } else {
      this.bannerEl.style.display = 'none';
    }
  }
}
