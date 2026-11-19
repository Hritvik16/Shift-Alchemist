import { MAX_REMESHES_PER_FRAME } from './core/balance.ts';
import { generateCargoHold } from './core/roomGen.ts';
import {
  applyStructuralDamage,
  carveSphereDebug,
  createEmptyRoomState,
  type VoxelRayHit,
} from './core/types.ts';
import { DebugOverlay } from './viewer/debugOverlay.ts';
import { Scene3D } from './viewer/scene3D.ts';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app mount');

const urlSeed = new URLSearchParams(window.location.search).get('seed');
const runSeed = urlSeed ? Number(urlSeed) >>> 0 : (Date.now() >>> 0);

const room = createEmptyRoomState(runSeed);
generateCargoHold(room, runSeed);

const scene3D = new Scene3D(app);
const overlay = new DebugOverlay(app);

// Initial synchronous-budgeted mesh pass so Cargo Hold loads cleanly before first frame
let remaining = 1;
while (remaining > 0) {
  remaining = scene3D.processDirtyMeshes(room, 900, 100);
}

const keys = new Set<string>();
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
    applyStructuralDamage(room, lastHit.x, lastHit.y, lastHit.z, 2, false);
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
  keys.add(e.code);

  // Debug carve hotkeys 1..6 (active when F3 overlay is open, §8.1)
  if (overlay.visible && lastHit && e.key >= '1' && e.key <= '6') {
    carveSphereDebug(room, lastHit.x, lastHit.y, lastHit.z, Number(e.key));
  }
});

window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

// Rolling frame-time stats for F3 overlay
const frameWindow = new Float64Array(120);
let frameWrite = 0;
let frameFilled = 0;
let prevTime = performance.now();

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function tick(now: number): void {
  const dtMs = Math.min(50, Math.max(0.001, now - prevTime));
  prevTime = now;
  const dt = dtMs * 0.001;

  frameWindow[frameWrite] = dtMs;
  frameWrite = (frameWrite + 1) % frameWindow.length;
  if (frameFilled < frameWindow.length) frameFilled++;

  const simStart = performance.now();
  // Isometric camera-aligned pan for M1.1 sightline/catwalk inspection
  const panSpeed = 9.0 * dt;
  const vertSpeed = 5.0 * dt;
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
  const len = Math.hypot(moveX, moveZ);
  if (len > 0) {
    scene3D.focusPos.x = Math.max(1.0, Math.min(23.0, scene3D.focusPos.x + (moveX / len) * panSpeed));
    scene3D.focusPos.z = Math.max(1.0, Math.min(23.0, scene3D.focusPos.z + (moveZ / len) * panSpeed));
  }
  if (keys.has('KeyE')) {
    scene3D.focusPos.y = Math.min(4.6, scene3D.focusPos.y + vertSpeed);
  }
  if (keys.has('ShiftLeft')) {
    scene3D.focusPos.y = Math.max(0.2, scene3D.focusPos.y - vertSpeed);
  }
  const simMs = performance.now() - simStart;

  const renderStart = performance.now();
  scene3D.updateCamera();
  lastHit = scene3D.pickVoxel(room, pointerX, pointerY);
  const dirtyQueue = scene3D.processDirtyMeshes(room, MAX_REMESHES_PER_FRAME, 0);
  scene3D.processDirtyDecals(room);
  scene3D.render();
  const renderMs = performance.now() - renderStart;

  // Compute rolling stats
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
    drawCalls: scene3D.renderer.info.render.calls,
    triangles: scene3D.renderer.info.render.triangles,
    meshedChunks: scene3D.getMeshedChunkCount(),
    dirtyQueue,
    meshMemMB: scene3D.getTotalMeshMemMB(),
    decalCount: scene3D.getDecalCount(),
    focusX: scene3D.focusPos.x,
    focusY: scene3D.focusPos.y,
    focusZ: scene3D.focusPos.z,
    hoveredInfo: scene3D.describeHit(lastHit),
    ledgers: room.ledgers,
  });

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
