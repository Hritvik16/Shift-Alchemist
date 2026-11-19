import { generateMilestoneTestRoom } from './core/roomGen';
import { createPlayerRig } from './core/physics';
import { Scene3DViewer } from './viewer/scene3D';

const appContainer = document.getElementById('app') || document.body;
const room = generateMilestoneTestRoom();
const player = createPlayerRig();
const viewer = new Scene3DViewer(appContainer, room, player);

function animate(): void {
  requestAnimationFrame(animate);
  viewer.render();
}

animate();
