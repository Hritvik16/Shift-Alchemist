import * as THREE from 'three';
import {
  ARENA_D,
  ARENA_H,
  ARENA_W,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  CHUNK_SIZE,
  MATERIAL_SPEC,
  MAX_DAMAGE_DECALS,
  MAX_MESH_MEM_MB,
  MAX_REMESHES_PER_FRAME,
  TOTAL_CHUNKS,
  GRAVITY_MODE,
  VOXEL_SIZE_M,
  type GravityMode,
} from '../core/balance.ts';
import {
  cellIndex,
  getDamage,
  getMat,
  isSolidMat,
  raycastSolidVoxel,
  type RoomState,
  type VoxelRayHit,
} from '../core/types.ts';
import { buildChunkSolidMeshes, SOLID_BUCKET } from './greedyMesher.ts';

interface BucketSlot {
  geoId: number;
  instId: number;
  verts: number;
  indices: number;
  bytes: number;
}

interface BucketPool {
  mesh: THREE.BatchedMesh;
  maxVerts: number;
  maxIndices: number;
  bytesPerVert: number;
  usedVerts: number;
  usedIndices: number;
  usedBytes: number;
  slots: Array<BucketSlot | null>;
}

const BUCKET_CONFIG = [
  { maxInstances: TOTAL_CHUNKS, maxVerts: 420_000, maxIndices: 630_000, bytesPerVert: 36 },
  { maxInstances: TOTAL_CHUNKS, maxVerts: 200_000, maxIndices: 300_000, bytesPerVert: 40 },
  { maxInstances: TOTAL_CHUNKS, maxVerts: 120_000, maxIndices: 180_000, bytesPerVert: 36 },
] as const;

export class Scene3D {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly focusPos = new THREE.Vector3(12.0, 1.2, 12.0);
  public zoomDist = 16.5;
  private currentPitchDeg = 35.0;
  private currentZoomDist = 16.5;
  private readonly lookAhead = new THREE.Vector3();
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly targetBgColor = new THREE.Color(0x0b0f17);
  private readonly targetHemiSky = new THREE.Color(0xc4e0ff);
  private readonly targetHemiGround = new THREE.Color(0x454e63);
  private readonly moteMesh: THREE.InstancedMesh;
  private readonly motePos: Float32Array;
  private readonly moteSpeed: Float32Array;
  private readonly moteScale = new THREE.Vector3(1, 1, 1);
  private readonly moteQuat = new THREE.Quaternion();
  private readonly motePosVec = new THREE.Vector3();
  private readonly moteColor = new THREE.Color(0x90c8ff);

  private readonly buckets: [BucketPool, BucketPool, BucketPool];
  private readonly chunkLastUsed = new Int32Array(TOTAL_CHUNKS);
  private frameCounter = 0;

  private readonly cutawayUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uFocusPos: { value: new THREE.Vector3(12.0, 1.2, 12.0) },
  };

  private readonly hoverBox: THREE.LineSegments;
  private readonly hoverNormalLine: THREE.Line;
  private readonly hoverNormalPositions = new Float32Array(6);
  private readonly focusMarker: THREE.Mesh;
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly decalPositionsByChunk: Array<number[]> = Array.from(
    { length: TOTAL_CHUNKS },
    () => [],
  );
  private decalCount = 0;
  private totalDecalCandidates = 0;
  private readonly lastDecalSortPos = new THREE.Vector3(-999, -999, -999);
  private readonly sun: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly archGroup = new THREE.Group();
  private readonly roomLights: THREE.PointLight[] = [];
  private readonly archRibMat = new THREE.MeshStandardMaterial({ color: 0x202836, roughness: 0.48, metalness: 0.72 });
  private readonly archPipeMat = new THREE.MeshStandardMaterial({ color: 0x6b5344, roughness: 0.36, metalness: 0.76 });
  private readonly archLampCoolMat = new THREE.MeshBasicMaterial({ color: 0x9ce2ff });
  private readonly archLampWarmMat = new THREE.MeshBasicMaterial({ color: 0xffc670 });
  private readonly archBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly archPipeGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 8);
  private readonly doorVisuals: Array<{
    group: THREE.Group;
    fullDoorGroup: THREE.Group;
    cutawayGroup: THREE.Group;
    beaconMat: THREE.MeshStandardMaterial;
    chevronMat: THREE.MeshBasicMaterial;
    gateMat: THREE.MeshBasicMaterial;
  }> = [];

  private readonly tmpMat4 = new THREE.Matrix4();
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouseNdc = new THREE.Vector2();
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly aimHit = new THREE.Vector3();
  private dirtySortBuf: number[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d15);
    this.scene.fog = new THREE.FogExp2(0x090d15, 0.0155);

    const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.5, 120);

    // High-contrast freighter lighting: lower ambient fill + crisp directional key + cool NW rim light
    const hemi = new THREE.HemisphereLight(0x88b4de, 0x161c28, 0.44);
    this.hemiLight = hemi;
    this.scene.add(hemi);

    const rimLight = new THREE.DirectionalLight(0x6ea8df, 0.46);
    rimLight.position.set(-16, 20, -14);
    this.rimLight = rimLight;
    this.scene.add(rimLight);
    this.scene.add(rimLight.target);
    this.scene.add(this.archGroup);

    const sun = new THREE.DirectionalLight(0xfff1dc, 1.36);
    this.sun = sun;
    sun.position.set(22, 34, 18);
    sun.target.position.set(12, 1.2, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 75;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun);
    this.scene.add(sun.target);

    const opaqueMat = this.createVoxelMaterial({
      transparent: false,
      roughness: 0.78,
      metalness: 0.28,
      isGrate: false,
      enableCutaway: true,
    });
    const transMat = this.createVoxelMaterial({
      transparent: true,
      roughness: 0.16,
      metalness: 0.1,
      isGrate: false,
      enableCutaway: false,
    });
    const grateMat = this.createVoxelMaterial({
      transparent: false,
      roughness: 0.52,
      metalness: 0.65,
      isGrate: true,
      enableCutaway: true,
    });

    this.buckets = [
      this.createBucketPool(SOLID_BUCKET.OPAQUE, opaqueMat, true, true, false),
      this.createBucketPool(SOLID_BUCKET.TRANSPARENT, transMat, false, false, true),
      this.createBucketPool(SOLID_BUCKET.GRATE, grateMat, true, true, false),
    ];
    // Render transparent Glass Vats & Ice AFTER translucent fluids (renderOrder 2)
    this.buckets[SOLID_BUCKET.TRANSPARENT].mesh.renderOrder = 4;

    const decalGeo = new THREE.BoxGeometry(0.105, 0.105, 0.105);
    const decalMat = new THREE.MeshBasicMaterial({
      color: 0x120a08,
      wireframe: false,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    this.decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, MAX_DAMAGE_DECALS);
    this.decalMesh.count = 0;
    this.decalMesh.frustumCulled = false;
    this.scene.add(this.decalMesh);

    const markerGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.5, 16);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0x3be8b0,
      emissive: 0x115544,
      roughness: 0.35,
      metalness: 0.4,
    });
    this.focusMarker = new THREE.Mesh(markerGeo, markerMat);
    this.focusMarker.castShadow = true;
    this.focusMarker.visible = false;
    this.scene.add(this.focusMarker);

    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.11, 0.11, 0.11));
    this.hoverBox = new THREE.LineSegments(
      boxEdges,
      new THREE.LineBasicMaterial({ color: 0xffd166 }),
    );
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    const normGeo = new THREE.BufferGeometry();
    normGeo.setAttribute('position', new THREE.BufferAttribute(this.hoverNormalPositions, 3));
    this.hoverNormalLine = new THREE.Line(
      normGeo,
      new THREE.LineBasicMaterial({ color: 0xff595e }),
    );
    this.hoverNormalLine.visible = false;
    this.scene.add(this.hoverNormalLine);

    // Room-clamped gravity shift field streaks (completely OFF in 1G; strictly inside room bounds)
    const moteCount = 64;
    this.motePos = new Float32Array(moteCount * 3);
    this.moteSpeed = new Float32Array(moteCount);
    for (let i = 0; i < moteCount; i++) {
      this.motePos[i * 3] = ((i * 73 + 11) % 97) / 97;
      this.motePos[i * 3 + 1] = ((i * 37 + 7) % 89) / 89;
      this.motePos[i * 3 + 2] = ((i * 53 + 19) % 83) / 83;
      this.moteSpeed[i] = 0.7 + ((i * 19) % 10) * 0.08;
    }
    const moteGeo = new THREE.BoxGeometry(0.022, 0.28, 0.022);
    const moteMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    this.moteMesh = new THREE.InstancedMesh(moteGeo, moteMat, moteCount);
    this.moteMesh.count = 0;
    this.moteMesh.frustumCulled = false;
    this.scene.add(this.moteMesh);

    this.updateCamera();
  }

  private createBucketPool(
    idx: number,
    material: THREE.Material,
    castShadow: boolean,
    receiveShadow: boolean,
    sortObjects: boolean,
  ): BucketPool {
    const cfg = BUCKET_CONFIG[idx];
    const mesh = new THREE.BatchedMesh(
      cfg.maxInstances,
      cfg.maxVerts,
      cfg.maxIndices,
      material,
    );
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.sortObjects = sortObjects;
    mesh.perObjectFrustumCulled = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    return {
      mesh,
      maxVerts: cfg.maxVerts,
      maxIndices: cfg.maxIndices,
      bytesPerVert: cfg.bytesPerVert,
      usedVerts: 0,
      usedIndices: 0,
      usedBytes: 0,
      slots: new Array<BucketSlot | null>(TOTAL_CHUNKS).fill(null),
    };
  }

  private createVoxelMaterial(opts: {
    transparent: boolean;
    roughness: number;
    metalness: number;
    isGrate: boolean;
    enableCutaway: boolean;
  }): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: opts.roughness,
      metalness: opts.metalness,
      transparent: opts.transparent,
      depthWrite: !opts.transparent,
      side: THREE.FrontSide,
    });

    const uniforms = this.cutawayUniforms;
    const isGrate = opts.isGrate;
    const enableCutaway = opts.enableCutaway;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCamPos = uniforms.uCamPos;
      shader.uniforms.uFocusPos = uniforms.uFocusPos;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vVoxelWorldPos;
           varying vec3 vVoxelWorldNormal;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec4 customWp = vec4( transformed, 1.0 );
           #ifdef USE_BATCHING
             customWp = batchingMatrix * customWp;
           #endif
           #ifdef USE_INSTANCING
             customWp = instanceMatrix * customWp;
           #endif
           customWp = modelMatrix * customWp;
           vVoxelWorldPos = customWp.xyz;
           vVoxelWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uCamPos;
           uniform vec3 uFocusPos;
           varying vec3 vVoxelWorldPos;
           varying vec3 vVoxelWorldNormal;

           float voxelHash(vec3 p) {
             p = fract(p * 0.1031);
             p += dot(p, p.yzx + 33.33);
             return fract((p.x + p.y) * p.z);
           }

           float bayer4(vec2 coord) {
             int x = int(mod(coord.x, 4.0));
             int y = int(mod(coord.y, 4.0));
             int idx = y * 4 + x;
             if (idx == 0) return 0.0 / 16.0;
             if (idx == 1) return 8.0 / 16.0;
             if (idx == 2) return 2.0 / 16.0;
             if (idx == 3) return 10.0 / 16.0;
             if (idx == 4) return 12.0 / 16.0;
             if (idx == 5) return 4.0 / 16.0;
             if (idx == 6) return 14.0 / 16.0;
             if (idx == 7) return 6.0 / 16.0;
             if (idx == 8) return 3.0 / 16.0;
             if (idx == 9) return 11.0 / 16.0;
             if (idx == 10) return 1.0 / 16.0;
             if (idx == 11) return 9.0 / 16.0;
             if (idx == 12) return 15.0 / 16.0;
             if (idx == 13) return 7.0 / 16.0;
             if (idx == 14) return 13.0 / 16.0;
             return 5.0 / 16.0;
           }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           vec3 cellCoord = floor(vVoxelWorldPos * 10.0 - vVoxelWorldNormal * 0.05);
           float sh = voxelHash(cellCoord);
           diffuseColor.rgb *= (0.93 + 0.13 * sh);
           vec3 vNorm = normalize(vVoxelWorldNormal);
           vec3 vView = normalize(uCamPos - vVoxelWorldPos);
           float vNdv = clamp(abs(dot(vNorm, vView)), 0.0, 1.0);
           float vFresnel = pow(1.0 - vNdv, 2.4);
           ${
             opts.transparent
               ? `
           // Glass Vat vs. Crystalline Ice physical refraction glint & Fresnel opacity
           float isIceMat = step(1.03, diffuseColor.b / max(diffuseColor.g, 0.001));
           vec3 refDir = reflect(-vView, vNorm);
           vec3 keyDir = normalize(vec3(0.55, 0.78, 0.42));
           float specGlint = pow(max(dot(refDir, keyDir), 0.0), 34.0);
           float refractBand = 0.5 + 0.5 * sin(vVoxelWorldPos.y * 4.5 + (vVoxelWorldPos.x - vVoxelWorldPos.z) * 3.5 + vNdv * 3.0);
           float iceFacet = voxelHash(floor(vVoxelWorldPos * 20.0));

           vec3 glassCol = diffuseColor.rgb * (0.85 + 0.25 * refractBand) + vec3(0.62, 0.96, 1.0) * (vFresnel * 0.65 + specGlint * 1.15);
           float glassAlpha = clamp(0.16 + 0.66 * vFresnel + specGlint * 0.45, 0.15, 0.88);

           vec3 iceCol = mix(diffuseColor.rgb, vec3(0.84, 0.98, 1.0), 0.28 + 0.45 * vFresnel) + vec3(0.75, 0.96, 1.0) * (iceFacet * 0.16 + specGlint * 0.85);
           float iceAlpha = clamp(0.56 + 0.36 * vFresnel + specGlint * 0.25, 0.52, 0.94);

           diffuseColor.rgb = mix(glassCol, iceCol, isIceMat);
           diffuseColor.a = mix(glassAlpha, iceAlpha, isIceMat);
           `
               : `
           // Procedural Industrial Architecture: hazard caution ledges, timber planks, and riveted 1.6 m steel panels
           float rbRatio = diffuseColor.r / max(diffuseColor.b, 0.001);
           float isHazardTrim = step(3.6, rbRatio);
           float isWoodMat = (1.0 - isHazardTrim) * step(1.35, rbRatio);
           if (isHazardTrim > 0.5) {
             // Diagonal black-and-amber caution striping along pit rims, chasm edges & high-ground ledges
             float diagCoord = abs(vNorm.y) > 0.5 ? (vVoxelWorldPos.x + vVoxelWorldPos.z) : (vVoxelWorldPos.x + vVoxelWorldPos.z + vVoxelWorldPos.y * 0.6);
             float stripe = step(0.46, fract(diagCoord * 2.6));
             vec3 darkBand = vec3(0.11, 0.13, 0.17);
             diffuseColor.rgb = mix(darkBand, diffuseColor.rgb * 1.06, stripe);
           } else if (isWoodMat > 0.5) {
             float plankY = fract(vVoxelWorldPos.y * 5.0);
             float plankSeam = smoothstep(0.0, 0.09, plankY) * smoothstep(1.0, 0.91, plankY);
             float grain = voxelHash(vec3(floor(vVoxelWorldPos.y * 10.0), floor((vVoxelWorldPos.x + vVoxelWorldPos.z) * 4.5), 7.0));
             diffuseColor.rgb *= (0.78 + 0.24 * plankSeam) * (0.90 + 0.18 * grain);
           } else {
             if (abs(vNorm.y) > 0.5) {
               vec2 pUv = fract(vVoxelWorldPos.xz / 1.6);
               float edgeX = min(pUv.x, 1.0 - pUv.x);
               float edgeZ = min(pUv.y, 1.0 - pUv.y);
               float seam = smoothstep(0.012, 0.042, min(edgeX, edgeZ));
               float subGrid = smoothstep(0.01, 0.03, min(abs(pUv.x - 0.5), abs(pUv.y - 0.5)));
               float rivetDist = length(vec2(edgeX, edgeZ) - vec2(0.09, 0.09));
               float rivet = 1.0 - 0.18 * smoothstep(0.035, 0.012, rivetDist);
               float pitDepth = mix(0.80, 1.03, smoothstep(0.2, 1.18, vVoxelWorldPos.y));
               diffuseColor.rgb *= (0.74 + 0.26 * seam) * (0.93 + 0.07 * subGrid) * rivet * pitDepth;
             } else {
               float band = smoothstep(0.02, 0.06, fract(vVoxelWorldPos.y / 1.2));
               float skirt = mix(0.82, 1.0, smoothstep(0.2, 0.55, vVoxelWorldPos.y));
               float panelW = smoothstep(0.015, 0.04, min(fract((vVoxelWorldPos.x + vVoxelWorldPos.z) / 1.6), 1.0 - fract((vVoxelWorldPos.x + vVoxelWorldPos.z) / 1.6)));
               diffuseColor.rgb *= (0.86 + 0.14 * band) * (0.88 + 0.12 * panelW) * skirt;
             }
             diffuseColor.rgb += vec3(0.14, 0.19, 0.28) * vFresnel * 0.22;
           }
           `
           }
           ${
             isGrate
               ? `
           if (abs(vVoxelWorldNormal.y) > 0.5) {
             vec2 gSub = fract(vVoxelWorldPos.xz * 15.0);
             if (gSub.x > 0.24 && gSub.x < 0.76 && gSub.y > 0.24 && gSub.y < 0.76) {
               discard;
             }
           }`
               : ''
           }
           ${
             enableCutaway
               ? `
           if (vVoxelWorldPos.y > uFocusPos.y + 1.55) {
             vec3 toFocus = (uFocusPos + vec3(0.0, 0.8, 0.0)) - uCamPos;
             float rayLen = length(toFocus);
             vec3 rayDir = toFocus / max(rayLen, 0.001);
             vec3 toFrag = vVoxelWorldPos - uCamPos;
             float proj = dot(toFrag, rayDir);
             if (proj > 0.5 && proj < rayLen - 0.35) {
               vec3 closest = uCamPos + rayDir * proj;
               float perpDist = length(vVoxelWorldPos - closest);
               if (perpDist < 2.1) {
                 float fade = smoothstep(1.1, 2.1, perpDist);
                 if (bayer4(gl_FragCoord.xy) > fade) {
                   discard;
                 }
               }
             }
           }`
               : ''
           }`,
        );
    };

    mat.customProgramCacheKey = () =>
      `voxel_${opts.transparent ? 1 : 0}_${opts.isGrate ? 1 : 0}_${opts.enableCutaway ? 1 : 0}`;
    return mat;
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public updateCamera(
    mode: GravityMode = GRAVITY_MODE.G1,
    roomW = 240,
    aimDirX = 0,
    aimDirZ = 0,
    dt = 0.016,
  ): void {
    // Smart dynamic 3/4 action framing (no manual camera controls needed):
    // Lower pitch (~28-29 deg) in 0G/-1G makes floating height read crisply against the floor
    let targetPitch = 35.0;
    if (mode === GRAVITY_MODE.G0) targetPitch = 28.0;
    else if (mode === GRAVITY_MODE.GN1) targetPitch = 29.5;
    else if (mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3) targetPitch = 38.0;

    const roomZoomBias = roomW <= 80 ? -2.0 : roomW <= 160 ? -0.6 : 0.0;
    const targetZoom = Math.max(11.0, Math.min(28.0, this.zoomDist + roomZoomBias));

    const ease = 1 - Math.exp(-6.5 * dt);
    this.currentPitchDeg += (targetPitch - this.currentPitchDeg) * ease;
    this.currentZoomDist += (targetZoom - this.currentZoomDist) * ease;

    // Gentle damped cursor look-ahead (max ~1.0 m) so incoming vats/enemies stay readable
    const laEase = 1 - Math.exp(-5.0 * dt);
    this.lookAhead.x += (aimDirX * 1.0 - this.lookAhead.x) * laEase;
    this.lookAhead.z += (aimDirZ * 1.0 - this.lookAhead.z) * laEase;

    const lookX = this.focusPos.x + this.lookAhead.x;
    const lookY = this.focusPos.y + 0.85;
    const lookZ = this.focusPos.z + this.lookAhead.z;

    const pitchRad = (this.currentPitchDeg * Math.PI) / 180;
    const dy = this.currentZoomDist * Math.sin(pitchRad);
    const dh = this.currentZoomDist * Math.cos(pitchRad);
    const dXZ = dh * Math.SQRT1_2;

    this.camera.position.set(lookX + dXZ, lookY + dy, lookZ + dXZ);
    this.camera.lookAt(lookX, lookY, lookZ);

    this.cutawayUniforms.uCamPos.value.copy(this.camera.position);
    this.cutawayUniforms.uFocusPos.value.copy(this.focusPos);
    this.focusMarker.position.set(this.focusPos.x, this.focusPos.y + 0.75, this.focusPos.z);
  }

  public updateGravityAtmosphere(
    room: RoomState,
    dt: number,
    timeSec: number,
  ): void {
    const mode = room.gravityMode;
    let moteHex = 0x90c8ff;
    let vyBase = 0.0;
    let streakY = 1.0;
    let streakW = 1.0;

    if (mode === GRAVITY_MODE.G0) {
      this.targetBgColor.setHex(0x091624);
      this.targetHemiSky.setHex(0x8eeeff);
      this.targetHemiGround.setHex(0x284359);
      moteHex = 0x62f2ff;
      vyBase = 0.0;
      streakY = 0.22;
      streakW = 1.9;
    } else if (mode === GRAVITY_MODE.GN1) {
      this.targetBgColor.setHex(0x190b21);
      this.targetHemiSky.setHex(0xf3a6ff);
      this.targetHemiGround.setHex(0x4b2a5c);
      moteHex = 0xff6be6;
      vyBase = 0.72;
      streakY = 2.4;
      streakW = 0.9;
    } else if (mode === GRAVITY_MODE.G2 || mode === GRAVITY_MODE.G3) {
      this.targetBgColor.setHex(0x1b1209);
      this.targetHemiSky.setHex(0xffd08a);
      this.targetHemiGround.setHex(0x5c3c22);
      moteHex = 0xffb347;
      vyBase = mode === GRAVITY_MODE.G3 ? -1.45 : -0.95;
      streakY = mode === GRAVITY_MODE.G3 ? 3.2 : 2.3;
      streakW = 0.9;
    } else {
      this.targetBgColor.setHex(0x090d15);
      this.targetHemiSky.setHex(0x88b4de);
      this.targetHemiGround.setHex(0x161c28);
      moteHex = 0xaec8e8;
      vyBase = 0.035;
      streakY = 0.14;
      streakW = 1.4;
    }

    const lerpT = 1 - Math.exp(-5.0 * dt);
    (this.scene.background as THREE.Color).lerp(this.targetBgColor, lerpT);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(this.scene.background as THREE.Color);
      const targetDensity = mode === GRAVITY_MODE.G0 ? 0.012 : mode === GRAVITY_MODE.GN1 ? 0.017 : 0.0155;
      this.scene.fog.density += (targetDensity - this.scene.fog.density) * lerpT;
    }
    this.hemiLight.color.lerp(this.targetHemiSky, lerpT);
    this.hemiLight.groundColor.lerp(this.targetHemiGround, lerpT);

    const pad = 0.45;
    const minX = pad;
    const spanX = Math.max(1.0, room.roomW * VOXEL_SIZE_M - pad * 2);
    const minY = 0.45;
    const spanY = Math.max(1.0, (room.roomH - 4) * VOXEL_SIZE_M - minY);
    const minZ = pad;
    const spanZ = Math.max(1.0, room.roomD * VOXEL_SIZE_M - pad * 2);

    this.moteColor.setHex(moteHex);
    const mat = this.moteMesh.material as THREE.MeshBasicMaterial;
    mat.color.copy(this.moteColor);
    mat.opacity = mode === GRAVITY_MODE.G1 ? 0.13 : mode === GRAVITY_MODE.G0 ? 0.34 : 0.42;

    const count = this.moteSpeed.length;
    for (let i = 0; i < count; i++) {
      const b = i * 3;
      const sp = this.moteSpeed[i];
      let ny = this.motePos[b + 1] + vyBase * sp * dt;
      if (ny < 0) ny += 1;
      else if (ny > 1) ny -= 1;
      this.motePos[b + 1] = ny;

      let wy = minY + ny * spanY;
      if (mode === GRAVITY_MODE.G0) {
        wy += Math.sin(timeSec * 1.9 + i * 0.7) * 0.14;
      }

      this.motePosVec.set(
        minX + this.motePos[b] * spanX,
        wy,
        minZ + this.motePos[b + 2] * spanZ,
      );
      this.moteScale.set(streakW, streakY, streakW);
      this.tmpMat4.compose(this.motePosVec, this.moteQuat, this.moteScale);
      this.moteMesh.setMatrixAt(i, this.tmpMat4);
    }
    this.moteMesh.count = count;
    this.moteMesh.instanceMatrix.needsUpdate = true;
  }

  public getTotalMeshMemMB(): number {
    const bytes =
      this.buckets[0].usedBytes + this.buckets[1].usedBytes + this.buckets[2].usedBytes;
    return bytes / (1024 * 1024);
  }

  public getMeshedChunkCount(): number {
    let count = 0;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (
        this.buckets[0].slots[c] !== null ||
        this.buckets[1].slots[c] !== null ||
        this.buckets[2].slots[c] !== null
      ) {
        count++;
      }
    }
    return count;
  }

  public getDecalCount(): number {
    return this.decalCount;
  }

  private removeChunkFromBucket(pool: BucketPool, cIdx: number): void {
    const slot = pool.slots[cIdx];
    if (!slot) return;
    pool.mesh.deleteInstance(slot.instId);
    pool.mesh.deleteGeometry(slot.geoId);
    pool.usedVerts -= slot.verts;
    pool.usedIndices -= slot.indices;
    pool.usedBytes -= slot.bytes;
    pool.slots[cIdx] = null;
  }

  private evictFarthestChunk(room: RoomState, protectedChunk: number): boolean {
    let victim = -1;
    let bestDistSq = -1;
    let oldestUsed = 0x7fffffff;
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (c === protectedChunk) continue;
      const hasMesh =
        this.buckets[0].slots[c] !== null ||
        this.buckets[1].slots[c] !== null ||
        this.buckets[2].slots[c] !== null;
      if (!hasMesh) continue;
      const dSq = this.chunkDistSq(c);
      const lastUsed = this.chunkLastUsed[c];
      if (
        dSq > bestDistSq + 1.0 ||
        (Math.abs(dSq - bestDistSq) <= 1.0 && lastUsed < oldestUsed)
      ) {
        bestDistSq = dSq;
        oldestUsed = lastUsed;
        victim = c;
      }
    }
    if (victim === -1) return false;
    for (let b = 0; b < 3; b++) {
      this.removeChunkFromBucket(this.buckets[b], victim);
    }
    room.dirtySolidMesh[victim] = 1;
    return true;
  }

  private uploadBucketGeometry(
    room: RoomState,
    bIdx: number,
    cIdx: number,
    cx: number,
    cy: number,
    cz: number,
    geo: THREE.BufferGeometry | null,
    verts: number,
    indices: number,
  ): void {
    const pool = this.buckets[bIdx];
    this.removeChunkFromBucket(pool, cIdx);
    if (!geo || verts === 0) return;

    const bytes = verts * pool.bytesPerVert + indices * 4;
    const capBytes = MAX_MESH_MEM_MB * 1024 * 1024;

    let guard = 0;
    while (
      guard < 64 &&
      (this.buckets[0].usedBytes +
        this.buckets[1].usedBytes +
        this.buckets[2].usedBytes +
        bytes >
        capBytes ||
        pool.usedVerts + verts > pool.maxVerts ||
        pool.usedIndices + indices > pool.maxIndices)
    ) {
      if (!this.evictFarthestChunk(room, cIdx)) break;
      guard++;
    }

    let geoId: number;
    try {
      geoId = pool.mesh.addGeometry(geo);
    } catch {
      pool.mesh.optimize();
      geoId = pool.mesh.addGeometry(geo);
    }

    const instId = pool.mesh.addInstance(geoId);
    this.tmpMat4.makeTranslation(
      cx * CHUNK_SIZE * VOXEL_SIZE_M,
      cy * CHUNK_SIZE * VOXEL_SIZE_M,
      cz * CHUNK_SIZE * VOXEL_SIZE_M,
    );
    pool.mesh.setMatrixAt(instId, this.tmpMat4);

    pool.usedVerts += verts;
    pool.usedIndices += indices;
    pool.usedBytes += bytes;
    pool.slots[cIdx] = { geoId, instId, verts, indices, bytes };

    geo.dispose();
  }

  private chunkDistSq(cIdx: number): number {
    const plane = CHUNKS_X * CHUNKS_Z;
    const cy = Math.floor(cIdx / plane);
    const rem = cIdx - cy * plane;
    const cz = Math.floor(rem / CHUNKS_X);
    const cx = rem - cz * CHUNKS_X;
    const mx = (cx + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const my = (cy + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const mz = (cz + 0.5) * CHUNK_SIZE * VOXEL_SIZE_M;
    const dx = mx - this.focusPos.x;
    const dy = my - this.focusPos.y;
    const dz = mz - this.focusPos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  public processDirtyMeshes(room: RoomState, maxRemeshes = MAX_REMESHES_PER_FRAME, timeBudgetMs = 0): number {
    this.frameCounter++;
    this.dirtySortBuf.length = 0;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (room.dirtySolidMesh[c] && !room.outOfBounds[c]) {
        this.dirtySortBuf.push(c);
      }
    }

    if (this.dirtySortBuf.length === 0) return 0;

    this.dirtySortBuf.sort((a, b) => this.chunkDistSq(a) - this.chunkDistSq(b));

    const startMs = performance.now();
    let budgetedCount = 0;
    let attempted = 0;
    const plane = CHUNKS_X * CHUNKS_Z;

    for (let i = 0; i < this.dirtySortBuf.length; i++) {
      if (timeBudgetMs > 0) {
        if (budgetedCount > 0 && performance.now() - startMs >= timeBudgetMs) break;
      } else if (budgetedCount >= maxRemeshes) {
        break;
      }

      const cIdx = this.dirtySortBuf[i];
      const cy = Math.floor(cIdx / plane);
      const rem = cIdx - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;

      const res = buildChunkSolidMeshes(room, cx, cy, cz);
      const hadFaces =
        res.vertexCounts[0] > 0 || res.vertexCounts[1] > 0 || res.vertexCounts[2] > 0;

      for (let b = 0; b < 3; b++) {
        this.uploadBucketGeometry(
          room,
          b,
          cIdx,
          cx,
          cy,
          cz,
          res.geometries[b],
          res.vertexCounts[b],
          res.indexCounts[b],
        );
      }

      room.dirtySolidMesh[cIdx] = 0;
      this.chunkLastUsed[cIdx] = this.frameCounter;
      attempted++;
      if (hadFaces || timeBudgetMs === 0) {
        budgetedCount++;
      }
    }

    return Math.max(0, this.dirtySortBuf.length - attempted);
  }

  public processDirtyDecals(room: RoomState): void {
    let anyDirty = false;
    const plane = CHUNKS_X * CHUNKS_Z;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      if (!room.dirtyDecals[c]) continue;
      anyDirty = true;
      room.dirtyDecals[c] = 0;
      const list = this.decalPositionsByChunk[c];
      list.length = 0;
      if (room.outOfBounds[c]) continue;

      const cy = Math.floor(c / plane);
      const rem = c - cy * plane;
      const cz = Math.floor(rem / CHUNKS_X);
      const cx = rem - cz * CHUNKS_X;
      const x0 = cx * CHUNK_SIZE;
      const y0 = cy * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;

      for (let y = y0; y < y0 + CHUNK_SIZE && y < room.roomH; y++) {
        for (let z = z0; z < z0 + CHUNK_SIZE && z < room.roomD; z++) {
          for (let x = x0; x < x0 + CHUNK_SIZE && x < room.roomW; x++) {
            const val = room.grid[cellIndex(x, y, z)];
            if (isSolidMat(getMat(val)) && getDamage(val) > 0) {
              list.push(
                (x + 0.5) * VOXEL_SIZE_M,
                (y + 0.5) * VOXEL_SIZE_M,
                (z + 0.5) * VOXEL_SIZE_M,
              );
            }
          }
        }
      }
    }

    const movedFar = this.focusPos.distanceToSquared(this.lastDecalSortPos) > 1.0;
    if (!anyDirty && !(movedFar && this.totalDecalCandidates > MAX_DAMAGE_DECALS)) return;

    const all: Array<{ x: number; y: number; z: number; dSq: number; c: number }> = [];
    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      const list = this.decalPositionsByChunk[c];
      for (let i = 0; i < list.length; i += 3) {
        const x = list[i];
        const y = list[i + 1];
        const z = list[i + 2];
        const dx = x - this.focusPos.x;
        const dy = y - this.focusPos.y;
        const dz = z - this.focusPos.z;
        all.push({ x, y, z, dSq: dx * dx + dy * dy + dz * dz, c });
      }
    }

    this.totalDecalCandidates = all.length;
    this.lastDecalSortPos.copy(this.focusPos);

    if (all.length > MAX_DAMAGE_DECALS) {
      all.sort((a, b) => a.dSq - b.dSq);
      for (let i = MAX_DAMAGE_DECALS; i < all.length; i++) {
        room.dirtyDecals[all[i].c] = 1;
      }
    }

    const count = Math.min(all.length, MAX_DAMAGE_DECALS);
    for (let i = 0; i < count; i++) {
      this.tmpMat4.makeTranslation(all[i].x, all[i].y, all[i].z);
      this.decalMesh.setMatrixAt(i, this.tmpMat4);
    }
    this.decalMesh.count = count;
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.decalCount = count;
  }

  public pickVoxel(
    room: RoomState,
    clientX: number,
    clientY: number,
  ): VoxelRayHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const hit = raycastSolidVoxel(
      room,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      80,
      true,
    );

    if (hit) {
      const cx = (hit.x + 0.5) * VOXEL_SIZE_M;
      const cy = (hit.y + 0.5) * VOXEL_SIZE_M;
      const cz = (hit.z + 0.5) * VOXEL_SIZE_M;
      this.hoverBox.visible = true;
      this.hoverBox.position.set(cx, cy, cz);
      this.hoverNormalPositions[0] = cx + hit.nx * 0.05;
      this.hoverNormalPositions[1] = cy + hit.ny * 0.05;
      this.hoverNormalPositions[2] = cz + hit.nz * 0.05;
      this.hoverNormalPositions[3] = cx + hit.nx * 0.35;
      this.hoverNormalPositions[4] = cy + hit.ny * 0.35;
      this.hoverNormalPositions[5] = cz + hit.nz * 0.35;
      (this.hoverNormalLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.hoverNormalLine.visible = true;
    } else {
      this.hoverBox.visible = false;
      this.hoverNormalLine.visible = false;
    }
    return hit;
  }

  public computeTorsoAim(
    playerX: number,
    playerY: number,
    playerZ: number,
    clientX: number,
    clientY: number,
  ): {
    aimX: number;
    aimY: number;
    aimZ: number;
    hasAimPoint: boolean;
    aimPointX: number;
    aimPointY: number;
    aimPointZ: number;
  } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);

    const torsoY = playerY + 0.8;
    this.aimPlane.constant = -torsoY;
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.aimHit);
    if (!hit) {
      return {
        aimX: 0,
        aimY: 0,
        aimZ: 1,
        hasAimPoint: false,
        aimPointX: playerX,
        aimPointY: torsoY,
        aimPointZ: playerZ + 4,
      };
    }

    const dx = this.aimHit.x - playerX;
    const dz = this.aimHit.z - playerZ;
    const len = Math.sqrt(dx * dx + dz * dz);
    const qx = len >= 1e-4 ? Math.round((dx / len) * 1024) / 1024 : 0;
    const qz = len >= 1e-4 ? Math.round((dz / len) * 1024) / 1024 : 1;
    return {
      aimX: qx,
      aimY: 0,
      aimZ: qz,
      hasAimPoint: true,
      aimPointX: Math.round(this.aimHit.x * 1024) / 1024,
      aimPointY: Math.round(torsoY * 1024) / 1024,
      aimPointZ: Math.round(this.aimHit.z * 1024) / 1024,
    };
  }

  public syncDoors(room: RoomState, timeSec = 0): void {
    while (this.doorVisuals.length > room.doors.length) {
      const dv = this.doorVisuals.pop()!;
      this.scene.remove(dv.group);
      dv.beaconMat.dispose();
      dv.chevronMat.dispose();
      dv.gateMat.dispose();
    }
    while (this.doorVisuals.length < room.doors.length) {
      const group = new THREE.Group();
      const frameMat = new THREE.MeshStandardMaterial({
        color: 0x1c2432,
        roughness: 0.42,
        metalness: 0.78,
      });
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x303e54,
        roughness: 0.45,
        metalness: 0.68,
      });
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0x26d97a,
        emissive: 0x26d97a,
        emissiveIntensity: 1.1,
        roughness: 0.2,
        metalness: 0.2,
      });
      const chevronMat = new THREE.MeshBasicMaterial({
        color: 0x26d97a,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const gateMat = new THREE.MeshBasicMaterial({
        color: 0x26d97a,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      // Full-height twin blast door (used strictly on back N & W walls)
      const fullDoorGroup = new THREE.Group();
      const leftJamb = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.95, 0.34), frameMat);
      leftJamb.position.set(-1.52, 1.48, 0.04);
      const rightJamb = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.95, 0.34), frameMat);
      rightJamb.position.set(1.52, 1.48, 0.04);
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.28, 0.28, 0.38), frameMat);
      lintel.position.set(0, 2.9, 0.06);
      const leftLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.38, 2.74, 0.16), leafMat);
      leftLeaf.position.set(-0.71, 1.38, 0.0);
      const rightLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.38, 2.74, 0.16), leafMat);
      rightLeaf.position.set(0.71, 1.38, 0.0);
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.12), beaconMat);
      beacon.position.set(0, 2.9, 0.24);
      fullDoorGroup.add(leftJamb, rightJamb, lintel, leftLeaf, rightLeaf, beacon);

      // Low-profile cutaway threshold frame (used on foreground S & E walls — never occludes player!)
      const cutawayGroup = new THREE.Group();
      const stubL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.56, 0.26), frameMat);
      stubL.position.set(-1.52, 0.28, 0.0);
      const stubR = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.56, 0.26), frameMat);
      stubR.position.set(1.52, 0.28, 0.0);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(3.28, 0.14, 0.28), frameMat);
      sill.position.set(0, 0.07, 0.0);
      const lowBeacon = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 0.14), beaconMat);
      lowBeacon.position.set(0, 0.18, 0.08);
      const holoCurtain = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.42), gateMat);
      holoCurtain.position.set(0, 0.36, 0.0);
      cutawayGroup.add(stubL, stubR, sill, lowBeacon, holoCurtain);

      // Shared glowing floor threshold pad inside the room
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.44), chevronMat);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(0, 0.03, 0.56);

      group.add(fullDoorGroup, cutawayGroup, strip);
      this.scene.add(group);
      this.doorVisuals.push({ group, fullDoorGroup, cutawayGroup, beaconMat, chevronMat, gateMat });
    }

    const pulse = 0.8 + 0.25 * Math.sin(timeSec * 5.0);
    for (let i = 0; i < room.doors.length; i++) {
      const d = room.doors[i];
      const vis = this.doorVisuals[i];
      const cx = (d.minX + d.maxX + 1) * 0.5 * VOXEL_SIZE_M;
      const cz = (d.minZ + d.maxZ + 1) * 0.5 * VOXEL_SIZE_M;
      const floorY = d.minY * VOXEL_SIZE_M;

      const isForeground = d.face === 'S' || d.face === 'E';
      vis.fullDoorGroup.visible = !isForeground;
      vis.cutawayGroup.visible = isForeground;

      if (d.face === 'N') {
        vis.group.position.set(cx, floorY, 0.1);
        vis.group.rotation.y = 0;
      } else if (d.face === 'S') {
        vis.group.position.set(cx, floorY, room.roomD * VOXEL_SIZE_M - 0.1);
        vis.group.rotation.y = Math.PI;
      } else if (d.face === 'W') {
        vis.group.position.set(0.1, floorY, cz);
        vis.group.rotation.y = Math.PI * 0.5;
      } else {
        vis.group.position.set(room.roomW * VOXEL_SIZE_M - 0.1, floorY, cz);
        vis.group.rotation.y = -Math.PI * 0.5;
      }

      const hex = d.locked ? 0xff3855 : d.isExtraction ? 0xffc83d : 0x3be8b0;
      vis.beaconMat.color.setHex(hex);
      vis.beaconMat.emissive.setHex(hex);
      vis.beaconMat.emissiveIntensity = (d.isExtraction ? 1.4 : 1.1) * pulse;
      vis.chevronMat.color.setHex(hex);
      vis.chevronMat.opacity = d.locked ? 0.32 : 0.65 * pulse;
      vis.gateMat.color.setHex(hex);
      vis.gateMat.opacity = d.locked ? 0.18 : 0.11;
    }
  }

  public resetRoomVisuals(room?: RoomState): void {
    // Clear every chunk slot from all 3 BatchedMesh buckets so smaller rooms leave zero ghost chunks
    for (let b = 0; b < 3; b++) {
      const pool = this.buckets[b];
      for (let c = 0; c < TOTAL_CHUNKS; c++) {
        if (pool.slots[c] !== null) {
          this.removeChunkFromBucket(pool, c);
        }
      }
      pool.usedVerts = 0;
      pool.usedIndices = 0;
      pool.usedBytes = 0;
      pool.mesh.optimize();
    }
    this.chunkLastUsed.fill(0);

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
      this.decalPositionsByChunk[c].length = 0;
    }
    this.decalCount = 0;
    this.totalDecalCandidates = 0;
    this.decalMesh.count = 0;
    this.decalMesh.instanceMatrix.needsUpdate = true;

    if (room) {
      const cx = room.roomW * 0.5 * VOXEL_SIZE_M;
      const cz = room.roomD * 0.5 * VOXEL_SIZE_M;
      this.sun.target.position.set(cx, 1.2, cz);
      this.sun.position.set(cx + 10, 34, cz + 6);
      this.sun.target.updateMatrixWorld();
      this.rimLight.target.position.set(cx, 1.2, cz);
      this.rimLight.position.set(cx - 14, 18, cz - 14);
      this.rimLight.target.updateMatrixWorld();
      this.rebuildRoomArchitecture(room);
      this.syncDoors(room);
    }
  }

  private rebuildRoomArchitecture(room: RoomState): void {
    while (this.archGroup.children.length > 0) {
      this.archGroup.remove(this.archGroup.children[this.archGroup.children.length - 1]);
    }
    while (this.roomLights.length > 0) {
      this.scene.remove(this.roomLights.pop()!);
    }

    const wM = room.roomW * VOXEL_SIZE_M;
    const hM = (room.roomH - 2) * VOXEL_SIZE_M;
    const dM = room.roomD * VOXEL_SIZE_M;
    const floorM = room.roomH >= 64 ? 1.2 : 0.2;
    const ribH = Math.max(1.5, hM - floorM);
    const ribMidY = floorM + ribH * 0.5;

    const blocksNorth = (xM: number): boolean => {
      for (const d of room.doors) {
        if (d.face === 'N' && xM >= d.minX * VOXEL_SIZE_M - 0.55 && xM <= (d.maxX + 1) * VOXEL_SIZE_M + 0.55) return true;
      }
      for (const t of room.workbenchTerminals) {
        if (t.z < 1.6 && Math.abs(xM - t.x) < 0.7) return true;
      }
      return false;
    };
    const blocksWest = (zM: number): boolean => {
      for (const d of room.doors) {
        if (d.face === 'W' && zM >= d.minZ * VOXEL_SIZE_M - 0.55 && zM <= (d.maxZ + 1) * VOXEL_SIZE_M + 0.55) return true;
      }
      for (const t of room.workbenchTerminals) {
        if (t.x < 1.6 && Math.abs(zM - t.z) < 0.7) return true;
      }
      return false;
    };

    const addRib = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      const m = new THREE.Mesh(this.archBoxGeo, this.archRibMat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.archGroup.add(m);
    };

    const addSconce = (x: number, y: number, z: number, onNorth: boolean, warm: boolean): void => {
      const housing = new THREE.Mesh(this.archBoxGeo, this.archRibMat);
      housing.position.set(x, y, z);
      housing.scale.set(onNorth ? 0.92 : 0.16, 0.14, onNorth ? 0.16 : 0.92);
      const lamp = new THREE.Mesh(this.archBoxGeo, warm ? this.archLampWarmMat : this.archLampCoolMat);
      lamp.position.set(x + (onNorth ? 0 : 0.08), y - 0.04, z + (onNorth ? 0.08 : 0));
      lamp.scale.set(onNorth ? 0.76 : 0.06, 0.06, onNorth ? 0.06 : 0.76);
      this.archGroup.add(housing, lamp);
    };

    // North bulkhead 3D structural ribs + alternating sconces
    let lampToggle = 0;
    for (let x = 1.6; x <= wM - 1.5; x += 3.2) {
      if (blocksNorth(x)) continue;
      addRib(x, ribMidY, 0.17, 0.24, ribH, 0.24);
      if (x + 1.6 <= wM - 1.4 && !blocksNorth(x + 1.6)) {
        addSconce(x + 1.6, Math.min(hM - 0.5, floorM + 2.55), 0.16, true, (lampToggle++ & 1) === 1);
      }
    }
    // West bulkhead 3D structural ribs + alternating sconces
    for (let z = 1.6; z <= dM - 1.5; z += 3.2) {
      if (blocksWest(z)) continue;
      addRib(0.17, ribMidY, z, 0.24, ribH, 0.24);
      if (z + 1.6 <= dM - 1.4 && !blocksWest(z + 1.6)) {
        addSconce(0.16, Math.min(hM - 0.5, floorM + 2.55), z + 1.6, false, (lampToggle++ & 1) === 1);
      }
    }
    // Corner structural stanchion at NW intersection
    addRib(0.18, ribMidY, 0.18, 0.34, ribH, 0.34);

    // Upper industrial conduit pipes running along North & West bulkheads
    const pipeY = Math.max(floorM + 1.8, hM - 0.65);
    const nPipe = new THREE.Mesh(this.archPipeGeo, this.archPipeMat);
    nPipe.rotation.z = Math.PI * 0.5;
    nPipe.position.set(wM * 0.5, pipeY, 0.16);
    nPipe.scale.set(1, Math.max(1, wM - 0.5), 1);
    const wPipe = new THREE.Mesh(this.archPipeGeo, this.archPipeMat);
    wPipe.rotation.x = Math.PI * 0.5;
    wPipe.position.set(0.16, pipeY - 0.16, dM * 0.5);
    wPipe.scale.set(1, Math.max(1, dM - 0.5), 1);
    this.archGroup.add(nPipe, wPipe);

    // Localized non-shadow warm/cool work-light pools to carve depth across the arena
    const addPoolLight = (x: number, y: number, z: number, hex: number, intensity: number, dist: number): void => {
      const pl = new THREE.PointLight(hex, intensity, dist, 1.55);
      pl.position.set(x, y, z);
      this.scene.add(pl);
      this.roomLights.push(pl);
    };
    const lightY = Math.min(hM - 0.4, floorM + 2.8);
    if (wM <= 10 && dM <= 10) {
      addPoolLight(wM * 0.32, lightY, dM * 0.32, 0x8fd6ff, 2.4, 8.5);
      addPoolLight(wM * 0.72, lightY, dM * 0.68, 0xffbe73, 2.0, 8.5);
    } else {
      addPoolLight(wM * 0.28, lightY, dM * 0.28, 0x8fd6ff, 3.0, 11.5);
      addPoolLight(wM * 0.72, lightY, dM * 0.30, 0xffbc6b, 2.6, 11.5);
      addPoolLight(wM * 0.34, lightY, dM * 0.74, 0xffbc6b, 2.4, 11.5);
      addPoolLight(wM * 0.72, lightY, dM * 0.72, 0x8fd6ff, 2.8, 11.5);
    }
  }

  public describeHit(hit: VoxelRayHit | null): string {
    if (!hit) return 'none';
    const name = MATERIAL_SPEC[hit.mat]?.name ?? `#${hit.mat}`;
    return `${name} (${hit.x},${hit.y},${hit.z})`;
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public getRoomBoundsM(): { w: number; h: number; d: number } {
    return {
      w: ARENA_W * VOXEL_SIZE_M,
      h: ARENA_H * VOXEL_SIZE_M,
      d: ARENA_D * VOXEL_SIZE_M,
    };
  }
}

export function getChunkCountCheck(): number {
  return CHUNKS_X * CHUNKS_Y * CHUNKS_Z;
}
