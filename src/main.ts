/**
 * Shift Alchemist — Zero-HUD Diegetic 3D Entry Point
 */

import { createWorldState } from './core/types';
import { generateVoronoiWorld } from './core/procGen';
import { type InputState, stepWorld } from './core/caStep';
import { Scene3D } from './viewer/scene3D';

function init(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app container missing');

  const world = createWorldState();
  generateVoronoiWorld(world, 20261116);

  const viewer = new Scene3D(app, world);

  // Minimal toggleable keybind hint in bottom-left (Zero health bars, zero menus!)
  const hint = document.createElement('div');
  hint.style.cssText = `
    position: fixed; bottom: 14px; left: 18px; pointer-events: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px; color: rgba(226, 232, 240, 0.55); letter-spacing: 0.04em;
    background: rgba(7, 6, 13, 0.45); padding: 6px 10px; border-radius: 6px;
    user-select: none; transition: opacity 0.25s;
  `;
  hint.textContent =
    '[WASD] Liquid Skate & Absorb  |  [L-Click] Solid Ferrofluid Cleave  |  [R-Click] Place/Swap Droplet  |  [Space] Gas Shrapnel Shift  |  [Tab] Zoom  |  [H] Hide Hint';
  app.appendChild(hint);

  const input: InputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    leftClickCleave: false,
    rightClickSwap: false,
    spaceGasShift: false,
    aimWorldX: world.player.x,
    aimWorldZ: world.player.z - 8,
  };

  let lastClientX = window.innerWidth * 0.5;
  let lastClientY = window.innerHeight * 0.4;

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    const code = e.code;
    if (code === 'KeyA' || code === 'ArrowLeft') input.left = true;
    if (code === 'KeyD' || code === 'ArrowRight') input.right = true;
    if (code === 'KeyW' || code === 'ArrowUp') input.up = true;
    if (code === 'KeyS' || code === 'ArrowDown') input.down = true;

    if (code === 'Space') {
      e.preventDefault();
      input.spaceGasShift = true;
    }
    if (code === 'Tab') {
      e.preventDefault();
      viewer.overviewMode = !viewer.overviewMode;
    }
    if (code === 'KeyH') {
      hint.style.opacity = hint.style.opacity === '0' ? '1' : '0';
    }
    if (code === 'KeyR') {
      generateVoronoiWorld(world, world.seed + 137);
    }
  });

  window.addEventListener('keyup', (e) => {
    const code = e.code;
    if (code === 'KeyA' || code === 'ArrowLeft') input.left = false;
    if (code === 'KeyD' || code === 'ArrowRight') input.right = false;
    if (code === 'KeyW' || code === 'ArrowUp') input.up = false;
    if (code === 'KeyS' || code === 'ArrowDown') input.down = false;
  });

  viewer.domElement.addEventListener('pointerdown', (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    if (e.button === 0) {
      input.leftClickCleave = true;
    } else if (e.button === 2) {
      input.rightClickSwap = true;
    }
  });

  window.addEventListener('pointermove', (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
  });

  function frame(): void {
    const aim = viewer.screenToWorldXZ(
      lastClientX,
      lastClientY,
      world.player.x,
      world.player.z
    );
    input.aimWorldX = aim.x;
    input.aimWorldZ = aim.z;

    stepWorld(world, input);
    viewer.render(world);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

init();
