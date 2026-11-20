import {
  FIXED_DT,
  GRAVITY_ACCEL_BY_MODE,
  MAT,
  MATERIAL_SPEC,
  MAX_FLUID_CACHE_REBUILDS_FALLBACK,
  MAX_FLUID_CACHE_REBUILDS_PER_FRAME,
  MAX_FRAME_DT,
  MAX_REMESHES_FALLBACK,
  MAX_REMESHES_PER_FRAME,
  NOZZLE_HOLD_SPEED_M_S,
  NOZZLE_TAP_SPEED_M_S,
  PLAYER_TORSO_OFFSET_M,
  VOXEL_SIZE_M,
  nozzlePressureMult,
  byteToTempC,
} from './core/balance.ts';
import { computeBallisticAimDir } from './core/combat.ts';
import { computePlumbLine, stepWorldTick } from './core/physics.ts';
import { generateCargoHold, populateCargoHoldEntities } from './core/roomGen.ts';
import {
  applyStructuralDamage,
  carveSphereDebug,
  isSolidMat,
  recomputeRoomLedgers,
  type VoxelRayHit,
} from './core/types.ts';
import {
  createPlayerEntity,
  createStarterTank,
  createSuitActionState,
  createWorldState,
  getActiveChamber,
  getEffectiveMassKg,
  type InputFrame,
} from './core/world.ts';
import { DebugOverlay } from './viewer/debugOverlay.ts';
import { EntityRenderer } from './viewer/entityRenderer.ts';
import { FluidRenderer } from './viewer/fluidRenderer.ts';
import { SuitHud } from './viewer/hud.ts';
import { PlayerRig } from './viewer/playerRig.ts';
import { Scene3D } from './viewer/scene3D.ts';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app mount');

const urlSeed = new URLSearchParams(window.location.search).get('seed');
const initialSeed = urlSeed ? Number(urlSeed) >>> 0 : Date.now() >>> 0;

const world = createWorldState(initialSeed);
const scene3D = new Scene3D(app);
const fluidRenderer = new FluidRenderer(scene3D.scene);
const entityRenderer = new EntityRenderer(scene3D.scene);
const playerRig = new PlayerRig(scene3D.scene);
const hud = new SuitHud(app);
const overlay = new DebugOverlay(app);

function startNewRun(seed: number): void {
  const s = seed >>> 0;
  world.runSeed = s;
  world.simTick = 0;
  world.tankCapRank = 0;
  world.siphonRank = 0;
  world.nozzlePressureRank = 0;
  world.gravCdRank = 0;
  world.has3GOverdrive = false;
  world.scrap = 0;
  world.player = createPlayerEntity(12.0, 0.2, 1.0);
  world.playerTank = createStarterTank(0);
  world.suit = createSuitActionState();
  world.gravityPulse = {
    activePulse: 'none',
    pulseTicksLeft: 0,
    cooldownTicks: 0,
    ownPulseExempt: false,
    ownPulseGraceTicks: 0,
  };
  world.impactTelemetry = {
    lastImpactSpeed: 0,
    lastWallSplatDmg: 0,
    lastImpactExempt: false,
    lastImpactTick: -1,
  };
  world.zeroGLoftTicksLeft = 0;
  world.zeroGLoftDirY = 1;
  world.gravityChangedThisTick = false;

  generateCargoHold(world.room, s);
  populateCargoHoldEntities(world);
  recomputeRoomLedgers(world.room, world.playerTank);
  world.entryLedgers = { ...world.room.ledgers };

  scene3D.resetRoomVisuals();
  fluidRenderer.resetAll();
  entityRenderer.reset();
  scene3D.focusPos.set(world.player.x, world.player.y, world.player.z);

  let remainingMesh = 1;
  while (remainingMesh > 0) {
    remainingMesh = scene3D.processDirtyMeshes(world.room, 900, 100);
  }
  let remainingFluid = 1;
  while (remainingFluid > 0) {
    remainingFluid = fluidRenderer.update(world.room, scene3D.focusPos, 0, 900, 100);
  }
}

startNewRun(initialSeed);

const keys = new Set<string>();
let queuedQ = false;
let queuedC = false;
let queuedV = false;
let queuedDash = false;
let queuedInteract = false;
let primaryHeld = false;
let siphonHeld = false;
let pointerX = window.innerWidth * 0.5;
let pointerY = window.innerHeight * 0.5;
let lastHit: VoxelRayHit | null = null;

window.addEventListener('resize', () => {
  scene3D.resize(app.clientWidth, app.clientHeight);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  pointerX = e.clientX;
  pointerY = e.clientY;
});

window.addEventListener('pointerdown', (e) => {
  if (e.button === 0) {
    primaryHeld = true;
  } else if (e.button === 2) {
    siphonHeld = true;
  } else if (e.button === 1 && overlay.visible && lastHit) {
    e.preventDefault();
    applyStructuralDamage(world.room, lastHit.x, lastHit.y, lastHit.z, 2, false, world.simTick);
  }
});

window.addEventListener('pointerup', (e) => {
  if (e.button === 0) primaryHeld = false;
  else if (e.button === 2) siphonHeld = false;
});

window.addEventListener(
  'wheel',
  (e) => {
    scene3D.zoomDist = Math.max(12, Math.min(36, scene3D.zoomDist + e.deltaY * 0.015));
  },
  { passive: true },
);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'F3') {
    e.preventDefault();
  }
  if (e.code === 'F3') {
    overlay.toggle();
    return;
  }
  if (!e.repeat) {
    if (e.code === 'KeyQ') queuedQ = true;
    else if (e.code === 'KeyC') queuedC = true;
    else if (e.code === 'KeyV') queuedV = true;
    else if (e.code === 'Space') queuedDash = true;
    else if (e.code === 'KeyF') queuedInteract = true;
  }
  keys.add(e.code);

  if (overlay.visible && lastHit && e.key >= '1' && e.key <= '6') {
    carveSphereDebug(world.room, lastHit.x, lastHit.y, lastHit.z, Number(e.key), world.simTick);
  }
});

window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

window.addEventListener('blur', () => {
  keys.clear();
  primaryHeld = false;
  siphonHeld = false;
});

function sampleInput(hoverHit: VoxelRayHit | null): InputFrame {
  let moveX = 0;
  let moveZ = 0;
  if (keys.has('KeyW')) {
    moveX -= 1;
    moveZ -= 1;
  }
  if (keys.has('KeyS')) {
    moveX += 1;
    moveZ += 1;
  }
  if (keys.has('KeyA')) {
    moveX -= 1;
    moveZ += 1;
  }
  if (keys.has('KeyD')) {
    moveX += 1;
    moveZ -= 1;
  }

  let hasAimPoint = false;
  let aimPointX = 0;
  let aimPointY = 0;
  let aimPointZ = 0;

  if (hoverHit) {
    hasAimPoint = true;
    aimPointX = Math.round((hoverHit.x + 0.5) * VOXEL_SIZE_M * 1024) / 1024;
    aimPointY =
      Math.round((hoverHit.y + (isSolidMat(hoverHit.mat) ? 1.0 : 0.5)) * VOXEL_SIZE_M * 1024) / 1024;
    aimPointZ = Math.round((hoverHit.z + 0.5) * VOXEL_SIZE_M * 1024) / 1024;
  } else {
    const planeAim = scene3D.computeTorsoAim(
      world.player.x,
      world.player.y,
      world.player.z,
      pointerX,
      pointerY,
    );
    hasAimPoint = planeAim.hasAimPoint;
    aimPointX = planeAim.aimPointX;
    aimPointY = planeAim.aimPointY;
    aimPointZ = planeAim.aimPointZ;
  }

  const ch = getActiveChamber(world.playerTank);
  const loaded = ch.liters > 0 && ch.mat !== MAT.AIR;
  const speed = loaded
    ? (world.suit.nozzleHoseActive ? NOZZLE_HOLD_SPEED_M_S : NOZZLE_TAP_SPEED_M_S) *
      nozzlePressureMult(world.nozzlePressureRank)
    : 0;
  const [rawAX, rawAY, rawAZ] = computeBallisticAimDir(
    world.player.x,
    world.player.y + PLAYER_TORSO_OFFSET_M,
    world.player.z,
    aimPointX,
    aimPointY,
    aimPointZ,
    speed,
    GRAVITY_ACCEL_BY_MODE[world.room.gravityMode],
  );
  const aimX = Math.round(rawAX * 1024) / 1024;
  const aimY = Math.round(rawAY * 1024) / 1024;
  const aimZ = Math.round(rawAZ * 1024) / 1024;

  const frame: InputFrame = {
    moveX,
    moveZ,
    ascend: keys.has('KeyE'),
    descend: keys.has('ShiftLeft'),
    pressQ: queuedQ,
    pressC: queuedC,
    pressV: queuedV,
    aimX,
    aimY,
    aimZ,
    hasAimPoint,
    aimPointX,
    aimPointY,
    aimPointZ,
    primaryHeld,
    siphonHeld,
    pressDash: queuedDash,
    pressInteract: queuedInteract,
  };
  queuedQ = false;
  queuedC = false;
  queuedV = false;
  queuedDash = false;
  queuedInteract = false;
  return frame;
}

const frameWindow = new Float64Array(120);
let frameWrite = 0;
let frameFilled = 0;
let prevTime = performance.now();
let accumulator = 0;
let slowFrameStreak = 0;
let fastFrameStreak = 0;
let adaptiveFallback = false;
let ledgerCheckCounter = 0;
let cameraShake = 0;

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function tick(now: number): void {
  const rawDtMs = Math.max(0.001, now - prevTime);
  prevTime = now;
  const clampedDt = Math.min(MAX_FRAME_DT, rawDtMs * 0.001);

  frameWindow[frameWrite] = Math.min(50, rawDtMs);
  frameWrite = (frameWrite + 1) % frameWindow.length;
  if (frameFilled < frameWindow.length) frameFilled++;


  accumulator += clampedDt;
  const simStart = performance.now();
  let ticksThisFrame = 0;
  while (accumulator >= FIXED_DT && ticksThisFrame < 3) {
    const inp = sampleInput(lastHit);
    if (inp.pressInteract && world.runCleared) {
      startNewRun((world.runSeed + 1) >>> 0);
      accumulator = 0;
      break;
    }
    stepWorldTick(world, inp);
    if (world.player.hp <= 0) {
      startNewRun(Date.now() >>> 0);
      accumulator = 0;
      break;
    }
    accumulator -= FIXED_DT;
    ticksThisFrame++;
  }
  const simMs = performance.now() - simStart;

  const renderStart = performance.now();
  const timeSec = now * 0.001;
  const plumb = computePlumbLine(world.room, world.player);
  playerRig.update(
    world.room,
    world.player,
    world.playerTank,
    world.suit,
    world.room.gravityMode,
    plumb,
    world.nozzlePressureRank,
    clampedDt,
    timeSec,
  );

  for (let i = 0; i < world.room.recentExplosions.length; i++) {
    const ev = world.room.recentExplosions[i];
    const dist = Math.hypot(ev.x - world.player.x, ev.y - world.player.y, ev.z - world.player.z);
    if (dist < 12.0) {
      cameraShake = Math.min(0.22, cameraShake + 0.16 * (1 - dist / 12.0));
    }
  }
  cameraShake *= Math.exp(-15.0 * clampedDt);
  if (cameraShake < 0.002) cameraShake = 0;
  const shakeX = cameraShake > 0 ? Math.sin(timeSec * 67.0) * cameraShake : 0;
  const shakeY = cameraShake > 0 ? Math.cos(timeSec * 83.0) * cameraShake * 0.6 : 0;
  const shakeZ = cameraShake > 0 ? Math.sin(timeSec * 73.0 + 1.3) * cameraShake : 0;

  scene3D.focusPos.set(world.player.x + shakeX, world.player.y + shakeY, world.player.z + shakeZ);
  scene3D.updateCamera();
  entityRenderer.update(world, scene3D.camera, timeSec, clampedDt);
  lastHit = scene3D.pickVoxel(world.room, pointerX, pointerY);

  const remeshCap = adaptiveFallback ? MAX_REMESHES_FALLBACK : MAX_REMESHES_PER_FRAME;
  const fluidRebuildCap = adaptiveFallback
    ? MAX_FLUID_CACHE_REBUILDS_FALLBACK
    : MAX_FLUID_CACHE_REBUILDS_PER_FRAME;

  const dirtyQueue = scene3D.processDirtyMeshes(world.room, remeshCap, 0);
  scene3D.processDirtyDecals(world.room);
  const dirtyFluidQueue = fluidRenderer.update(
    world.room,
    scene3D.focusPos,
    timeSec,
    fluidRebuildCap,
    0,
  );
  scene3D.render();
  const renderMs = performance.now() - renderStart;
  const workMs = simMs + renderMs;
  if (workMs > 15.0 || rawDtMs > 19.0) {
    slowFrameStreak++;
    fastFrameStreak = 0;
    if (slowFrameStreak >= 4) adaptiveFallback = true;
  } else if (workMs < 12.0 && rawDtMs < 18.0) {
    fastFrameStreak++;
    slowFrameStreak = 0;
    if (fastFrameStreak >= 4) adaptiveFallback = false;
  } else {
    slowFrameStreak = 0;
    fastFrameStreak = 0;
  }

  hud.update(world);

  if (overlay.visible) {
    ledgerCheckCounter++;
    if (ledgerCheckCounter % 15 === 0) {
      recomputeRoomLedgers(world.room, world.playerTank);
    }

    const slice = frameWindow.slice(0, frameFilled).sort();
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += slice[i];
    const avgMs = sum / Math.max(1, slice.length);

    const ch = getActiveChamber(world.playerTank);
    const tankSummary =
      ch.liters > 0 && ch.mat !== MAT.AIR
        ? `${MATERIAL_SPEC[ch.mat].name} ${ch.liters}/${ch.capL}L (${byteToTempC(ch.tempByte)}C)`
        : `EMPTY 0/${ch.capL}L (Air Burst)`;
    const lockOnInfo = world.lockOn
      ? `${world.lockOn.kind}#${world.lockOn.id}`
      : 'none';

    overlay.update({
      fps: 1000 / Math.max(0.001, avgMs),
      p95Ms: percentile(slice, 0.95),
      p99Ms: percentile(slice, 0.99),
      simMs,
      renderMs,
      simTick: world.simTick,
      drawCalls: scene3D.renderer.info.render.calls,
      triangles: scene3D.renderer.info.render.triangles,
      meshedChunks: scene3D.getMeshedChunkCount(),
      dirtyQueue,
      dirtyFluidQueue,
      meshMemMB: scene3D.getTotalMeshMemMB(),
      decalCount: scene3D.getDecalCount(),
      activeFluidCount: world.room.activeFluidCurCount,
      activeThermalCount: world.room.activeThermalCurCount,
      explosionQueueCount: world.room.explosionQueue.length,
      ballisticCount: world.room.ballistic.count,
      deferredCount: world.room.deferredFluid.count,
      renderedGridFluid: fluidRenderer.renderedGridCount,
      renderedBallistic: fluidRenderer.renderedBallisticCount,
      adaptiveFallback,
      playerX: world.player.x,
      playerY: world.player.y,
      playerZ: world.player.z,
      playerVy: world.player.vy,
      playerMassKg: getEffectiveMassKg(world.player, world.playerTank),
      tankSummary,
      siphonActive: world.suit.siphonActive,
      lockOnInfo,
      podsInfo: `${world.podsTotal - world.podsRemaining}/${world.podsTotal}`,
      entityCount: 1 + world.entities.length,
      upSign: world.player.upSign,
      grounded: world.player.grounded,
      gravityMode: world.room.gravityMode,
      plumbDistM: plumb.visible ? plumb.distanceM : 0,
      lastImpactV: world.impactTelemetry.lastImpactSpeed,
      lastSplatDmg: world.impactTelemetry.lastWallSplatDmg,
      lastImpactExempt: world.impactTelemetry.lastImpactExempt,
      hoveredInfo: scene3D.describeHit(lastHit),
      ledgers: world.room.ledgers,
      ledgerDrift: {
        water: world.room.ledgers.water - world.entryLedgers.water,
        oil: world.room.ledgers.oil - world.entryLedgers.oil,
        cryo: world.room.ledgers.cryo - world.entryLedgers.cryo,
        acid: world.room.ledgers.acid - world.entryLedgers.acid,
      },
    });
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
