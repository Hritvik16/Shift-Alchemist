import {
  FIXED_DT,
  MAX_FLUID_CACHE_REBUILDS_FALLBACK,
  MAX_FLUID_CACHE_REBUILDS_PER_FRAME,
  MAX_FRAME_DT,
  MAX_REMESHES_FALLBACK,
  MAX_REMESHES_PER_FRAME,
} from './core/balance.ts';
import { computePlumbLine, stepWorldTick } from './core/physics.ts';
import { generateCargoHold } from './core/roomGen.ts';
import {
  applyStructuralDamage,
  carveSphereDebug,
  recomputeRoomLedgers,
  type VoxelRayHit,
} from './core/types.ts';
import { createWorldState, type InputFrame } from './core/world.ts';
import { DebugOverlay } from './viewer/debugOverlay.ts';
import { FluidRenderer } from './viewer/fluidRenderer.ts';
import { SuitHud } from './viewer/hud.ts';
import { PlayerRig } from './viewer/playerRig.ts';
import { Scene3D } from './viewer/scene3D.ts';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app mount');

const urlSeed = new URLSearchParams(window.location.search).get('seed');
const runSeed = urlSeed ? Number(urlSeed) >>> 0 : Date.now() >>> 0;

const world = createWorldState(runSeed);
generateCargoHold(world.room, runSeed);
world.entryLedgers = { ...world.room.ledgers };

const scene3D = new Scene3D(app);
const fluidRenderer = new FluidRenderer(scene3D.scene);
const playerRig = new PlayerRig(scene3D.scene);
const hud = new SuitHud(app);
const overlay = new DebugOverlay(app);

scene3D.focusPos.set(world.player.x, world.player.y, world.player.z);
let remainingMesh = 1;
while (remainingMesh > 0) {
  remainingMesh = scene3D.processDirtyMeshes(world.room, 900, 100);
}
let remainingFluid = 1;
while (remainingFluid > 0) {
  remainingFluid = fluidRenderer.update(world.room, scene3D.focusPos, 0, 900, 100);
}

const keys = new Set<string>();
let queuedQ = false;
let queuedC = false;
let queuedV = false;
let pointerX = window.innerWidth * 0.5;
let pointerY = window.innerHeight * 0.5;
let lastHit: VoxelRayHit | null = null;

window.addEventListener('resize', () => {
  scene3D.resize(app.clientWidth, app.clientHeight);
});

window.addEventListener('pointermove', (e) => {
  pointerX = e.clientX;
  pointerY = e.clientY;
});

window.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && overlay.visible && lastHit) {
    applyStructuralDamage(world.room, lastHit.x, lastHit.y, lastHit.z, 2, false, world.simTick);
  }
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
});

function sampleInput(): InputFrame {
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
  const frame: InputFrame = {
    moveX,
    moveZ,
    ascend: keys.has('KeyE'),
    descend: keys.has('ShiftLeft'),
    pressQ: queuedQ,
    pressC: queuedC,
    pressV: queuedV,
  };
  queuedQ = false;
  queuedC = false;
  queuedV = false;
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

  // Adaptive fallback updated after measuring simMs + renderMs below

  accumulator += clampedDt;
  const simStart = performance.now();
  let ticksThisFrame = 0;
  while (accumulator >= FIXED_DT && ticksThisFrame < 3) {
    stepWorldTick(world, sampleInput());
    accumulator -= FIXED_DT;
    ticksThisFrame++;
  }
  const simMs = performance.now() - simStart;

  const renderStart = performance.now();
  const plumb = computePlumbLine(world.room, world.player);
  playerRig.update(world.player, world.room.gravityMode, plumb, clampedDt);

  scene3D.focusPos.set(world.player.x, world.player.y, world.player.z);
  scene3D.updateCamera();
  lastHit = scene3D.pickVoxel(world.room, pointerX, pointerY);

  const remeshCap = adaptiveFallback ? MAX_REMESHES_FALLBACK : MAX_REMESHES_PER_FRAME;
  const fluidRebuildCap = adaptiveFallback
    ? MAX_FLUID_CACHE_REBUILDS_FALLBACK
    : MAX_FLUID_CACHE_REBUILDS_PER_FRAME;

  const dirtyQueue = scene3D.processDirtyMeshes(world.room, remeshCap, 0);
  scene3D.processDirtyDecals(world.room);
  const dirtyFluidQueue = fluidRenderer.update(world.room, scene3D.focusPos, now * 0.001, fluidRebuildCap, 0);
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
      recomputeRoomLedgers(world.room);
    }

    const slice = frameWindow.slice(0, frameFilled).sort();
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += slice[i];
    const avgMs = sum / Math.max(1, slice.length);

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
      ballisticCount: world.room.ballistic.count,
      deferredCount: world.room.deferredFluid.count,
      renderedGridFluid: fluidRenderer.renderedGridCount,
      renderedBallistic: fluidRenderer.renderedBallisticCount,
      adaptiveFallback,
      playerX: world.player.x,
      playerY: world.player.y,
      playerZ: world.player.z,
      playerVy: world.player.vy,
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
