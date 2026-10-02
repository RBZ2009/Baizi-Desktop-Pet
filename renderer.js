/**
 * Responsibility: Render and animate the VRM pet and display gateway conversation events.
 * Implementation: 1. Preserve model interaction. 2. Track one active reply. 3. Finalize text without waiting for speech.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpressionPresetName
} from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip
} from '@pixiv/three-vrm-animation';

const petContainer = document.getElementById('pet-container');
const canvas = document.getElementById('pet-canvas');
const fallback = document.getElementById('pet-fallback');
const debugEl = document.getElementById('debug');
const speechBubbleEl = document.getElementById('speech-bubble');
const chatPanelEl = document.getElementById('chat-panel');
const chatInputEl = document.getElementById('chat-input');
const chatSendEl = document.getElementById('chat-send');
let showPetBounds = false;

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function restartClassAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function spawnParticles(anchorRect, count = 6) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const startX = anchorRect.left + anchorRect.width * rand(0.35, 0.65);
    const startY = anchorRect.top + anchorRect.height * rand(0.35, 0.6);

    const dx = rand(-80, 80);
    const dy = rand(-120, -40);
    p.style.left = `${startX}px`;
    p.style.top = `${startY}px`;
    p.style.setProperty('--dx', `${dx}px`);
    p.style.setProperty('--dy', `${dy}px`);

    const hue = rand(190, 230);
    p.style.background = `radial-gradient(circle at 30% 30%, #ffffff, hsl(${hue} 90% 72%))`;

    document.body.appendChild(p);
    p.addEventListener(
      'animationend',
      () => {
        p.remove();
      },
      { once: true }
    );
  }
}

// --------------------
// 3D / VRM
// --------------------

const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
camera.position.set(0, 1.35, 2.2);

const hemi = new THREE.HemisphereLight(0xffffff, 0x666677, 0.9);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(1.2, 2.5, 1.6);
scene.add(dir);

let vrm = null;
const bones = {};
const baseQuat = new Map();
let hipsBaseY = 0;
let hipsBaseX = 0;
let hipsBaseZ = 0;
let baseModelHeight = 0;
let baseScaleMedium = 1;
let headLookCurrent = { x: 0, y: 0 };
let lastAppliedSizeMode = 'medium';

function getBone(name) {
  return vrm?.humanoid?.getNormalizedBoneNode(name) || null;
}

function captureBasePose() {
  baseQuat.clear();
  Object.values(bones).forEach((b) => {
    if (b) baseQuat.set(b, b.quaternion.clone());
  });
  if (bones.hips) {
    hipsBaseY = bones.hips.position.y;
    hipsBaseX = bones.hips.position.x;
    hipsBaseZ = bones.hips.position.z;
  }
}

function resetToBasePose() {
  for (const [b, q] of baseQuat.entries()) {
    b.quaternion.copy(q);
  }
}

function setExpression(presetName, value) {
  if (!vrm?.expressionManager) return;
  vrm.expressionManager.setValue(presetName, value);
}

function blinkOnce() {
  if (!vrm?.expressionManager) return;
  setExpression(VRMExpressionPresetName.Blink, 1);
  window.setTimeout(() => setExpression(VRMExpressionPresetName.Blink, 0), 90);
}

function scheduleBlink() {
  const next = rand(2800, 6500);
  window.setTimeout(() => {
    if (!isDragging && vrm) blinkOnce();
    scheduleBlink();
  }, next);
}

function fitVRMToWindow(forceMode) {
  if (!vrm) return;

  const mode = forceMode || currentSizeMode;
  const framing = SIZE_MODE_CONFIG[mode] || SIZE_MODE_CONFIG.medium;

  // 固定化：每次都从同一基准变换开始，避免累计误差
  vrm.scene.position.set(0, 0, 0);
  vrm.scene.scale.setScalar(1);

  // 仅用“中档位基准缩放 * 固定倍率”来控制大小，完全切断动态包围盒影响
  const baseMultiplier = {
    // 基础倍率（再乘以用户在“尺寸微调”里配置的倍率）
    small: 0.58,
    medium: 1.0,
    large: 1.24
  }[mode] ?? 1.0;

  const userMultiplier = Number(sizeScaleOverrides?.[mode]) || 1;
  const sizeMultiplier = baseMultiplier * userMultiplier;

  const scale = baseScaleMedium * sizeMultiplier;
  vrm.scene.scale.setScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(vrm.scene);
  const center = new THREE.Vector3();
  scaledBox.getCenter(center);

  // 固定落地并居中
  vrm.scene.position.set(-center.x, -scaledBox.min.y, -center.z);

  const finalBox = new THREE.Box3().setFromObject(vrm.scene);
  const rect = petContainer.getBoundingClientRect();
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();

  const fovRad = THREE.MathUtils.degToRad(camera.fov);

  // 关键修复：相机距离不再使用“当前缩放后高度”计算（否则会抵消 scale 变化）
  // 用固定的中档参考距离，保证 small/medium/large 的模型缩放能真实体现在屏幕尺寸上。
  const mediumRef = SIZE_MODE_CONFIG.medium;
  const referenceDistance = ((mediumRef.targetHeight / 2) / Math.tan(fovRad / 2)) * mediumRef.margin;

  const midY = (finalBox.max.y + finalBox.min.y) / 2;
  camera.position.set(0, midY + framing.eyeOffsetY, referenceDistance);
  camera.lookAt(0, midY * framing.lookAtFactor, 0);
}

/** 从 T 姿态改为双臂自然下垂，并把手掌朝内（更自然） */
function applyInitialPose() {
  if (!vrm) return;
  const halfPi = Math.PI / 2;
  // 上臂：垂下
  if (bones.rightUpperArm) bones.rightUpperArm.rotation.z = halfPi;
  if (bones.leftUpperArm) bones.leftUpperArm.rotation.z = -halfPi;
  // 前臂微调
  if (bones.rightLowerArm) bones.rightLowerArm.rotation.x = 0.02;
  if (bones.leftLowerArm) bones.leftLowerArm.rotation.x = 0.02;
  // 手掌：掌心朝向身体（按当前模型骨骼轴，左右手 Y 方向与之前相反）
  if (bones.rightHand) {
    bones.rightHand.rotation.y = halfPi;
    bones.rightHand.rotation.x = 0.08;
  }
  if (bones.leftHand) {
    bones.leftHand.rotation.y = -halfPi;
    bones.leftHand.rotation.x = 0.08;
  }
  vrm.update(0);
}

async function loadVRM() {
  const url = './assets/model.vrm';
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        // cleanup
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);

        vrm = gltf.userData.vrm;
        vrm.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });
        scene.add(vrm.scene);

        // 动画混合器需要在加载各个动作前就创建好
        animationMixer = new THREE.AnimationMixer(vrm.scene);

        bones.hips = getBone('hips');
        bones.spine = getBone('spine');
        bones.chest = getBone('chest');
        bones.upperChest = getBone('upperChest');
        bones.neck = getBone('neck');
        bones.head = getBone('head');

        bones.leftUpperArm = getBone('leftUpperArm');
        bones.leftLowerArm = getBone('leftLowerArm');
        bones.leftHand = getBone('leftHand');
        bones.rightUpperArm = getBone('rightUpperArm');
        bones.rightLowerArm = getBone('rightLowerArm');
        bones.rightHand = getBone('rightHand');

        // fingers
        [
          'leftThumbProximal', 'leftThumbDistal',
          'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
          'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
          'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
          'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
          'rightThumbProximal', 'rightThumbDistal',
          'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
          'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
          'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
          'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'
        ].forEach((name) => {
          bones[name] = getBone(name);
        });

        bones.leftUpperLeg = getBone('leftUpperLeg');
        bones.leftLowerLeg = getBone('leftLowerLeg');
        bones.leftFoot = getBone('leftFoot');
        bones.rightUpperLeg = getBone('rightUpperLeg');
        bones.rightLowerLeg = getBone('rightLowerLeg');
        bones.rightFoot = getBone('rightFoot');

        fitVRMToWindow();
        applyInitialPose();
        captureBasePose();

        // 记录模型初始基准高度（用于后续 size 切换的稳定缩放）
        vrm.scene.position.set(0, 0, 0);
        vrm.scene.scale.setScalar(1);
        const modelBaseBox = new THREE.Box3().setFromObject(vrm.scene);
        const modelBaseSize = new THREE.Vector3();
        modelBaseBox.getSize(modelBaseSize);
        baseModelHeight = modelBaseSize.y > 0 ? modelBaseSize.y : 1;

        // 固定中档位基准缩放（后续档位切换仅做固定倍率，不再受当前状态影响）
        const mediumFraming = SIZE_MODE_CONFIG.medium;
        baseScaleMedium = mediumFraming.targetHeight / baseModelHeight;

        // 重新应用当前档位 fit
        fitVRMToWindow();
        scheduleBlink();
        scheduleRandomAction();
        loadDefaultVRMA();
        loadWalkVRMA();
        loadSillyDanceVRMA();
        loadHipHopVRMA();
        loadPrayingVRMA();
        loadJumpVRMA();
        loadDyingVRMA();

        fallback.classList.remove('active');
        updateDebug();
        resolve();
      },
      undefined,
      reject
    );
  });
}

function resize() {
  const rect = petContainer.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();

  // 关键：窗口真实尺寸发生变化时，必须重新 fit，避免从大切回小时沿用大尺寸构图
  if (vrm) {
    fitVRMToWindow();
  }
}

window.addEventListener('resize', () => {
  resize();
});
resize();
initPetWindowPosition();

if (window.desktopPet?.onBehaviorStyleChanged) {
  window.desktopPet.onBehaviorStyleChanged((style) => {
    setBehaviorStyle(style);
  });
}

if (window.desktopPet?.onPauseChanged) {
  window.desktopPet.onPauseChanged((paused) => {
    setPausedState(paused);
  });
}

if (window.desktopPet?.onSizeChanged) {
  window.desktopPet.onSizeChanged((mode) => {
    if (!SIZE_MODE_CONFIG[mode]) return;

    const applyMode = () => {
      currentSizeMode = mode;
      resize();

      // 你要求的策略：目标是 small 时，先按 medium 对齐基准，再应用 small
      if (mode === 'small') {
        fitVRMToWindow('medium');
      }
      fitVRMToWindow(mode);
      lastAppliedSizeMode = mode;
    };

    // 双帧等待，确保主进程 setSize 完成并且 DOM 尺寸稳定
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyMode();
      });
    });
  });
}

if (window.desktopPet?.getSizeMode) {
  window.desktopPet.getSizeMode().then((mode) => {
    if (!SIZE_MODE_CONFIG[mode]) return;
    currentSizeMode = mode;
    resize();

    // 冷启动直接 small 时，也走“先 medium 后 small”的统一路径
    if (mode === 'small') {
      fitVRMToWindow('medium');
    }
    fitVRMToWindow(mode);
    lastAppliedSizeMode = mode;
  }).catch(() => {});
}

if (window.desktopPet?.getPauseState) {
  window.desktopPet.getPauseState().then((paused) => {
    setPausedState(paused);
  }).catch(() => {});
}

if (window.desktopPet?.getSizeScaleOverrides) {
  window.desktopPet.getSizeScaleOverrides().then((overrides) => {
    sizeScaleOverrides = {
      small: Number(overrides?.small) || 1,
      medium: Number(overrides?.medium) || 1,
      large: Number(overrides?.large) || 1
    };
    if (vrm) {
      fitVRMToWindow();
      updateDebug();
    }
  }).catch(() => {});
}

if (window.desktopPet?.getDialogueSettings) {
  window.desktopPet.getDialogueSettings().then((settings) => {
    dialogueSettings = {
      bubbleAutoClose: (settings?.bubbleAutoClose ?? true) !== false,
      bubblePerCharMs: Math.max(10, Number(settings?.bubblePerCharMs) || 180),
      charsPerLine: Math.max(5, Number(settings?.charsPerLine) || 15)
    };
  }).catch(() => {});
}

if (window.desktopPet?.onBreathingModeChanged) {
  window.desktopPet.onBreathingModeChanged((mode) => {
    if (!breathingConfigs[mode]) return;
    currentBreathingMode = mode;
    updateDebug();
  });
}

if (window.desktopPet?.getBreathingMode) {
  window.desktopPet.getBreathingMode().then((mode) => {
    if (!breathingConfigs[mode]) return;
    currentBreathingMode = mode;
    updateDebug();
  }).catch(() => {});
}

loadVRM().catch(() => {
  fallback.classList.add('active');
});

const SIZE_MODE_CONFIG = {
  // 每档位固定：模型基准高度 + 相机构图（不依赖切换历史）
  // 需求：small 稍微变大，medium/large 各自缩小约一半
  small: { targetHeight: 0.24, margin: 2.1, eyeOffsetY: 0.025, lookAtFactor: 0.968 },
  medium: { targetHeight: 0.48, margin: 1.5, eyeOffsetY: 0.06, lookAtFactor: 0.945 },
  large: { targetHeight: 0.56, margin: 1.38, eyeOffsetY: 0.075, lookAtFactor: 0.938 }
};

let sizeScaleOverrides = { small: 1, medium: 1, large: 1 };

let currentSizeMode = 'medium';

const clock = new THREE.Clock();
let t = 0;
let react = null; // { type, startMs }
let currentAction = 'idle'; // idle | wave | walk | sit | sillyDance | hipHop | praying | jump | dying
let actionUntilMs = 0;

let randomActionTimer = null;
let isPaused = false;

const behaviorStyles = {
  playful: {
    randomMinMs: 5 * 60 * 1000,
    randomMaxMs: 10 * 60 * 1000,
    lookSensitivityX: 0.28,
    lookSensitivityY: 0.16,
    name: 'playful'
  },
  balanced: {
    randomMinMs: 5 * 60 * 1000,
    randomMaxMs: 15 * 60 * 1000,
    lookSensitivityX: 0.22,
    lookSensitivityY: 0.12,
    name: 'balanced'
  },
  calm: {
    randomMinMs: 10 * 60 * 1000,
    randomMaxMs: 18 * 60 * 1000,
    lookSensitivityX: 0.16,
    lookSensitivityY: 0.09,
    name: 'calm'
  }
};

const WINDOW_POSITION_STORAGE_KEY = 'desktop_pet_window_position';

let currentBehaviorStyle = behaviorStyles.balanced;

const breathingConfigs = {
  off: { x: 0, z: 0, label: 'off' },
  subtle: { x: 0.001, z: 0.00025, label: 'subtle' },
  normal: { x: 0.004, z: 0.001, label: 'normal' }
};

let currentBreathingMode = 'subtle';

let animationMixer = null;
let defaultAnimationAction = null;
let walkAnimationAction = null;
let sillyDanceAnimationAction = null;
let hipHopAnimationAction = null;
let prayingAnimationAction = null;
let jumpAnimationAction = null;
let dyingAnimationAction = null;

let hasExternalDefaultAnimation = false;
let hasExternalWalkAnimation = false;
let hasExternalSillyDanceAnimation = false;
let hasExternalHipHopAnimation = false;
let hasExternalPrayingAnimation = false;
let hasExternalJumpAnimation = false;
let hasExternalDyingAnimation = false;

let defaultAnimationLoadedFrom = '';
let walkAnimationLoadedFrom = '';
let sillyDanceAnimationLoadedFrom = '';
let hipHopAnimationLoadedFrom = '';
let prayingAnimationLoadedFrom = '';
let jumpAnimationLoadedFrom = '';
let dyingAnimationLoadedFrom = '';

let isDefaultClipPlaying = false;
let isWalkClipPlaying = false;
let isSillyDanceClipPlaying = false;
let isHipHopClipPlaying = false;
let isPrayingClipPlaying = false;
let isJumpClipPlaying = false;
let isDyingClipPlaying = false;

let petWindowPos = { x: 0, y: 0 };
let petWindowPosReady = false;
let walkDirection = 1; // 1: 向右, -1: 向左
const walkSpeedPxPerSec = 110;

function loadSavedWindowPosition() {
  try {
    const raw = window.localStorage.getItem(WINDOW_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null;
    return { x: parsed.x, y: parsed.y };
  } catch (_) {
    return null;
  }
}

function saveWindowPosition(pos) {
  try {
    window.localStorage.setItem(
      WINDOW_POSITION_STORAGE_KEY,
      JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) })
    );
  } catch (_) {
    // ignore storage errors
  }
}

async function initPetWindowPosition() {
  try {
    const pos = await window.desktopPet.getPosition();
    petWindowPos = { x: pos.x, y: pos.y };
    petWindowPosReady = true;

    const savedPos = loadSavedWindowPosition();
    if (savedPos) {
      petWindowPos = { x: savedPos.x, y: savedPos.y };
      window.desktopPet.setPosition(savedPos.x, savedPos.y);
    }
  } catch (_) {
    petWindowPos = { x: 0, y: 0 };
    petWindowPosReady = false;
  }
}

function applyDesktopWalk(delta) {
  if (!petWindowPosReady || isDragging || currentAction !== 'walk') return;

  const screenWidth = window.screen?.availWidth ?? window.screen?.width ?? 1920;
  const minX = 0;
  const maxX = Math.max(minX, screenWidth - window.innerWidth);

  let nextX = petWindowPos.x + walkDirection * walkSpeedPxPerSec * delta;

  if (nextX <= minX) {
    nextX = minX;
    walkDirection = 1;
    updateWalkFacing();
  } else if (nextX >= maxX) {
    nextX = maxX;
    walkDirection = -1;
    updateWalkFacing();
  }

  petWindowPos.x = nextX;
  window.desktopPet.setPosition(petWindowPos.x, petWindowPos.y);
  saveWindowPosition(petWindowPos);
}

async function loadVRMAFromCandidates(candidateUrls) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  for (const url of candidateUrls) {
    try {
      const gltf = await loader.loadAsync(url);
      const vrmAnimation = gltf.userData.vrmAnimations?.[0];
      if (!vrmAnimation) continue;
      return { vrmAnimation, url };
    } catch (_) {
      // try next candidate
    }
  }

  return null;
}

async function loadDefaultVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/default.vrma',
    './assets/Default.vrma'
  ]);

  if (!result) {
    hasExternalDefaultAnimation = false;
    defaultAnimationLoadedFrom = '';
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  defaultAnimationAction = animationMixer.clipAction(clip);
  defaultAnimationAction.setLoop(THREE.LoopRepeat, Infinity);
  defaultAnimationAction.clampWhenFinished = false;
  defaultAnimationAction.enabled = true;
  defaultAnimationAction.zeroSlopeAtStart = false;
  defaultAnimationAction.zeroSlopeAtEnd = false;
  defaultAnimationAction.paused = true;

  hasExternalDefaultAnimation = true;
  defaultAnimationLoadedFrom = result.url;
  syncDefaultAnimationPlayback();
  updateDebug();
}

async function loadWalkVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/walk.vrma',
    './assets/Walk.vrma'
  ]);

  if (!result) {
    hasExternalWalkAnimation = false;
    walkAnimationLoadedFrom = '';
    console.warn('walk.vrma 加载失败，回退到手写 walk 动作。');
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  walkAnimationAction = animationMixer.clipAction(clip);
  // 改为单次播放，避免循环拼接处的滑步/顿挫
  walkAnimationAction.setLoop(THREE.LoopOnce, 1);
  walkAnimationAction.clampWhenFinished = true;
  walkAnimationAction.enabled = true;
  walkAnimationAction.zeroSlopeAtStart = false;
  walkAnimationAction.zeroSlopeAtEnd = false;
  walkAnimationAction.paused = true;

  animationMixer.addEventListener('finished', (event) => {
    if (event.action === walkAnimationAction) {
      isWalkClipPlaying = false;
      if (currentAction === 'walk') setAction('idle');
    }

    if (event.action === sillyDanceAnimationAction) {
      isSillyDanceClipPlaying = false;
      if (currentAction === 'sillyDance') setAction('idle');
    }

    if (event.action === hipHopAnimationAction) {
      isHipHopClipPlaying = false;
      if (currentAction === 'hipHop') setAction('idle');
    }

    if (event.action === prayingAnimationAction) {
      isPrayingClipPlaying = false;
      if (currentAction === 'praying') setAction('idle');
    }

    if (event.action === jumpAnimationAction) {
      isJumpClipPlaying = false;
      if (currentAction === 'jump') setAction('idle');
    }

    if (event.action === dyingAnimationAction) {
      isDyingClipPlaying = false;
      if (currentAction === 'dying') setAction('idle');
    }
  });

  hasExternalWalkAnimation = true;
  walkAnimationLoadedFrom = result.url;
  updateDebug();
}

async function loadSillyDanceVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/silly_dance.vrma',
    './assets/silly dance.vrma',
    './assets/silly-dance.vrma',
    './assets/Silly_Dance.vrma'
  ]);

  if (!result) {
    hasExternalSillyDanceAnimation = false;
    sillyDanceAnimationLoadedFrom = '';
    console.warn('silly dance 动作未加载成功，请检查导出的 vrma 是否有效。');
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  sillyDanceAnimationAction = animationMixer.clipAction(clip);
  // 循环两遍
  sillyDanceAnimationAction.setLoop(THREE.LoopRepeat, 2);
  sillyDanceAnimationAction.clampWhenFinished = true;
  sillyDanceAnimationAction.enabled = true;
  sillyDanceAnimationAction.zeroSlopeAtStart = false;
  sillyDanceAnimationAction.zeroSlopeAtEnd = false;
  sillyDanceAnimationAction.paused = true;

  hasExternalSillyDanceAnimation = true;
  sillyDanceAnimationLoadedFrom = result.url;
  updateDebug();
}

async function loadHipHopVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/hip_hop.vrma',
    './assets/hip hop.vrma',
    './assets/hip-hop.vrma',
    './assets/Hip_Hop.vrma'
  ]);

  if (!result) {
    hasExternalHipHopAnimation = false;
    hipHopAnimationLoadedFrom = '';
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  hipHopAnimationAction = animationMixer.clipAction(clip);
  // 循环两遍
  hipHopAnimationAction.setLoop(THREE.LoopRepeat, 2);
  hipHopAnimationAction.clampWhenFinished = true;
  hipHopAnimationAction.enabled = true;
  hipHopAnimationAction.zeroSlopeAtStart = false;
  hipHopAnimationAction.zeroSlopeAtEnd = false;
  hipHopAnimationAction.paused = true;

  hasExternalHipHopAnimation = true;
  hipHopAnimationLoadedFrom = result.url;
  updateDebug();
}

async function loadPrayingVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/praying.vrma',
    './assets/Praying.vrma'
  ]);

  if (!result) {
    hasExternalPrayingAnimation = false;
    prayingAnimationLoadedFrom = '';
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  prayingAnimationAction = animationMixer.clipAction(clip);
  prayingAnimationAction.setLoop(THREE.LoopOnce, 1);
  prayingAnimationAction.clampWhenFinished = true;
  prayingAnimationAction.enabled = true;
  prayingAnimationAction.zeroSlopeAtStart = false;
  prayingAnimationAction.zeroSlopeAtEnd = false;
  prayingAnimationAction.paused = true;

  hasExternalPrayingAnimation = true;
  prayingAnimationLoadedFrom = result.url;
  updateDebug();
}

async function loadJumpVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/jump.vrma',
    './assets/Jump.vrma'
  ]);

  if (!result) {
    hasExternalJumpAnimation = false;
    jumpAnimationLoadedFrom = '';
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  jumpAnimationAction = animationMixer.clipAction(clip);
  jumpAnimationAction.setLoop(THREE.LoopOnce, 1);
  jumpAnimationAction.clampWhenFinished = true;
  jumpAnimationAction.enabled = true;
  jumpAnimationAction.zeroSlopeAtStart = false;
  jumpAnimationAction.zeroSlopeAtEnd = false;
  jumpAnimationAction.paused = true;

  hasExternalJumpAnimation = true;
  jumpAnimationLoadedFrom = result.url;
  updateDebug();
}

async function loadDyingVRMA() {
  if (!vrm || !animationMixer) return;

  const result = await loadVRMAFromCandidates([
    './assets/dying.vrma',
    './assets/Dying.vrma'
  ]);

  if (!result) {
    hasExternalDyingAnimation = false;
    dyingAnimationLoadedFrom = '';
    updateDebug();
    return;
  }

  const clip = createVRMAnimationClip(result.vrmAnimation, vrm);
  dyingAnimationAction = animationMixer.clipAction(clip);
  dyingAnimationAction.setLoop(THREE.LoopOnce, 1);
  dyingAnimationAction.clampWhenFinished = true;
  dyingAnimationAction.enabled = true;
  dyingAnimationAction.zeroSlopeAtStart = false;
  dyingAnimationAction.zeroSlopeAtEnd = false;
  dyingAnimationAction.paused = true;

  hasExternalDyingAnimation = true;
  dyingAnimationLoadedFrom = result.url;
  updateDebug();
}

function syncDefaultAnimationPlayback() {
  if (!defaultAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'idle' && hasExternalDefaultAnimation && !isPaused;

  if (shouldPlay) {
    if (!isDefaultClipPlaying) {
      defaultAnimationAction.reset();
      defaultAnimationAction.weight = 1;
      defaultAnimationAction.enabled = true;
      defaultAnimationAction.paused = false;
      defaultAnimationAction.play();
      isDefaultClipPlaying = true;
    }
  } else {
    defaultAnimationAction.stop();
    defaultAnimationAction.paused = true;
    defaultAnimationAction.weight = 0;
    isDefaultClipPlaying = false;
  }
}

function syncWalkAnimationPlayback() {
  if (!walkAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'walk';

  if (shouldPlay) {
    if (!isWalkClipPlaying) {
      walkAnimationAction.reset();
      walkAnimationAction.weight = 1;
      walkAnimationAction.enabled = true;
      walkAnimationAction.paused = false;
      walkAnimationAction.play();
      isWalkClipPlaying = true;
    }
  } else {
    walkAnimationAction.stop();
    walkAnimationAction.paused = true;
    walkAnimationAction.weight = 0;
    isWalkClipPlaying = false;
  }
}

function syncSillyDanceAnimationPlayback() {
  if (!sillyDanceAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'sillyDance';

  if (shouldPlay) {
    if (!isSillyDanceClipPlaying) {
      sillyDanceAnimationAction.reset();
      sillyDanceAnimationAction.weight = 1;
      sillyDanceAnimationAction.enabled = true;
      sillyDanceAnimationAction.paused = false;
      sillyDanceAnimationAction.play();
      isSillyDanceClipPlaying = true;
    }
  } else {
    sillyDanceAnimationAction.stop();
    sillyDanceAnimationAction.paused = true;
    sillyDanceAnimationAction.weight = 0;
    isSillyDanceClipPlaying = false;
  }
}

function syncHipHopAnimationPlayback() {
  if (!hipHopAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'hipHop';

  if (shouldPlay) {
    if (!isHipHopClipPlaying) {
      hipHopAnimationAction.reset();
      hipHopAnimationAction.weight = 1;
      hipHopAnimationAction.enabled = true;
      hipHopAnimationAction.paused = false;
      hipHopAnimationAction.play();
      isHipHopClipPlaying = true;
    }
  } else {
    hipHopAnimationAction.stop();
    hipHopAnimationAction.paused = true;
    hipHopAnimationAction.weight = 0;
    isHipHopClipPlaying = false;
  }
}

function syncPrayingAnimationPlayback() {
  if (!prayingAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'praying';

  if (shouldPlay) {
    if (!isPrayingClipPlaying) {
      prayingAnimationAction.reset();
      prayingAnimationAction.weight = 1;
      prayingAnimationAction.enabled = true;
      prayingAnimationAction.paused = false;
      prayingAnimationAction.play();
      isPrayingClipPlaying = true;
    }
  } else {
    prayingAnimationAction.stop();
    prayingAnimationAction.paused = true;
    prayingAnimationAction.weight = 0;
    isPrayingClipPlaying = false;
  }
}

function syncJumpAnimationPlayback() {
  if (!jumpAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'jump';

  if (shouldPlay) {
    if (!isJumpClipPlaying) {
      jumpAnimationAction.reset();
      jumpAnimationAction.weight = 1;
      jumpAnimationAction.enabled = true;
      jumpAnimationAction.paused = false;
      jumpAnimationAction.play();
      isJumpClipPlaying = true;
    }
  } else {
    jumpAnimationAction.stop();
    jumpAnimationAction.paused = true;
    jumpAnimationAction.weight = 0;
    isJumpClipPlaying = false;
  }
}

function syncDyingAnimationPlayback() {
  if (!dyingAnimationAction || !animationMixer) return;

  const shouldPlay = currentAction === 'dying';

  if (shouldPlay) {
    if (!isDyingClipPlaying) {
      dyingAnimationAction.reset();
      dyingAnimationAction.weight = 1;
      dyingAnimationAction.enabled = true;
      dyingAnimationAction.paused = false;
      dyingAnimationAction.play();
      isDyingClipPlaying = true;
    }
  } else {
    dyingAnimationAction.stop();
    dyingAnimationAction.paused = true;
    dyingAnimationAction.weight = 0;
    isDyingClipPlaying = false;
  }
}

function updateWalkFacing() {
  if (!vrm) return;
  if (currentAction === 'walk') {
    // 侧身行走：向右时看向屏幕右侧，向左时看向屏幕左侧
    vrm.scene.rotation.y = walkDirection === 1 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    // 其它动作恢复正面
    vrm.scene.rotation.y = 0;
  }
}

function setAction(name, durationMs = 0) {
  currentAction = name;
  actionUntilMs = durationMs > 0 ? performance.now() + durationMs : 0;
  syncDefaultAnimationPlayback();
  syncWalkAnimationPlayback();
  syncSillyDanceAnimationPlayback();
  syncHipHopAnimationPlayback();
  syncPrayingAnimationPlayback();
  syncJumpAnimationPlayback();
  syncDyingAnimationPlayback();
  updateWalkFacing();
  updateDebug();
}

// 鼠标全屏跟随：即使鼠标不在桌宠窗口内，也会持续看向鼠标
let look = { x: 0, y: 0 };

async function updateLookFromGlobalCursor() {
  if (!window.desktopPet?.getCursorPoint || !petWindowPosReady) return;

  try {
    const cursor = await window.desktopPet.getCursorPoint();
    const centerX = petWindowPos.x + window.innerWidth / 2;
    const centerY = petWindowPos.y + window.innerHeight / 2;

    const nx = (cursor.x - centerX) / (window.innerWidth / 2);
    const ny = (cursor.y - centerY) / (window.innerHeight / 2);

    look.x = THREE.MathUtils.clamp(nx, -1, 1);
    look.y = THREE.MathUtils.clamp(ny, -1, 1);
  } catch (_) {
    // ignore ipc error
  }
}

window.setInterval(updateLookFromGlobalCursor, 80);

function applyIdle(time) {
  const spine = bones.spine || bones.chest || bones.upperChest;
  if (spine) {
    spine.rotation.x += Math.sin(time * 1.2) * 0.04;
    spine.rotation.z += Math.sin(time * 0.9) * 0.03;
  }
}

function applyWave(time, k01) {
  // 右手挥手：抬臂 + 小摆动
  const ua = bones.rightUpperArm;
  const la = bones.rightLowerArm;
  const h = bones.rightHand;
  if (ua) {
    ua.rotation.z += -1.0; // 抬起
    ua.rotation.x += -0.25;
  }
  if (la) {
    la.rotation.z += -0.55;
  }
  const w = Math.sin(time * 8.5) * 0.5 * (1 - Math.pow(1 - k01, 2));
  if (la) la.rotation.y += w;
  if (h) h.rotation.y += w * 0.8;
}

function applyFist(side, amount = 1) {
  // amount: 0~1，1 为完全握拳
  const a = THREE.MathUtils.clamp(amount, 0, 1);

  const proximal = 0.85 * a;
  const intermediate = 1.0 * a;
  const distal = 0.8 * a;
  const thumb = 0.6 * a;

  // 关键：很多 VRM 左右手局部坐标是镜像的，弯曲方向需要反号
  const curlSign = side === 'left' ? 1 : -1;
  const thumbYSign = side === 'left' ? -1 : 1;

  const fingerKeys = [
    [`${side}ThumbProximal`, thumb, true],
    [`${side}ThumbDistal`, thumb * 0.85, true],

    [`${side}IndexProximal`, proximal, false],
    [`${side}IndexIntermediate`, intermediate, false],
    [`${side}IndexDistal`, distal, false],

    [`${side}MiddleProximal`, proximal, false],
    [`${side}MiddleIntermediate`, intermediate, false],
    [`${side}MiddleDistal`, distal, false],

    [`${side}RingProximal`, proximal, false],
    [`${side}RingIntermediate`, intermediate, false],
    [`${side}RingDistal`, distal, false],

    [`${side}LittleProximal`, proximal, false],
    [`${side}LittleIntermediate`, intermediate, false],
    [`${side}LittleDistal`, distal, false]
  ];

  fingerKeys.forEach(([key, bend, isThumb]) => {
    const b = bones[key];
    if (!b) return;

    // 以 X 为主做弯曲，Z 只做轻微辅助，避免“拧麻花”
    b.rotation.x += curlSign * bend;
    b.rotation.z += curlSign * bend * 0.12;

    // 拇指轻微内收
    if (isThumb) {
      b.rotation.y += thumbYSign * bend * 0.22;
    }
  });
}

function applyWalk(time) {
  // 原地走路：腿摆动 + 手臂反向摆动 + hips 上下起伏 + 走路握拳
  const phase = time * 5.2;
  const s = Math.sin(phase);
  const c = Math.cos(phase);

  if (bones.hips) bones.hips.position.y = hipsBaseY + (c + 1) * 0.01;

  const lul = bones.leftUpperLeg;
  const rul = bones.rightUpperLeg;
  const lll = bones.leftLowerLeg;
  const rll = bones.rightLowerLeg;
  const lf = bones.leftFoot;
  const rf = bones.rightFoot;

  if (lul) lul.rotation.x += 0.65 * s;
  if (rul) rul.rotation.x += -0.65 * s;
  if (lll) lll.rotation.x += Math.max(0, -0.75 * s);
  if (rll) rll.rotation.x += Math.max(0, 0.75 * s);
  if (lf) lf.rotation.x += -0.15 * s;
  if (rf) rf.rotation.x += 0.15 * s;

  const lua = bones.leftUpperArm;
  const rua = bones.rightUpperArm;
  const lla = bones.leftLowerArm;
  const rla = bones.rightLowerArm;
  if (lua) lua.rotation.x += -0.35 * s;
  if (rua) rua.rotation.x += 0.35 * s;
  if (lla) lla.rotation.x += -0.15 * s;
  if (rla) rla.rotation.x += 0.15 * s;

  // 走路时双手握拳
  applyFist('left', 0.95);
  applyFist('right', 0.95);
}

function applySit(k01) {
  // 坐下：髋前倾、膝盖弯曲（若权重不对，这里会非常明显）
  const hips = bones.hips;
  const spine = bones.spine || bones.chest;
  if (hips) hips.rotation.x += 0.55 * k01;
  if (spine) spine.rotation.x += -0.25 * k01;

  const bend = 1.15 * k01;
  if (bones.leftUpperLeg) bones.leftUpperLeg.rotation.x += -0.85 * k01;
  if (bones.rightUpperLeg) bones.rightUpperLeg.rotation.x += -0.85 * k01;
  if (bones.leftLowerLeg) bones.leftLowerLeg.rotation.x += bend;
  if (bones.rightLowerLeg) bones.rightLowerLeg.rotation.x += bend;
  if (bones.leftFoot) bones.leftFoot.rotation.x += -0.35 * k01;
  if (bones.rightFoot) bones.rightFoot.rotation.x += -0.35 * k01;
}

function pickRandomAction() {
  const candidates = [];

  if (hasExternalSillyDanceAnimation) candidates.push('sillyDance');
  if (hasExternalHipHopAnimation) candidates.push('hipHop');
  if (hasExternalPrayingAnimation) candidates.push('praying');
  if (hasExternalJumpAnimation) candidates.push('jump');

  // wave 保留在随机池
  candidates.push('wave');

  // 按需求：random 池明确不包含 dying
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function scheduleRandomAction() {
  if (randomActionTimer) {
    clearTimeout(randomActionTimer);
    randomActionTimer = null;
  }

  const delay = rand(currentBehaviorStyle.randomMinMs, currentBehaviorStyle.randomMaxMs);
  randomActionTimer = window.setTimeout(() => {
    if (!isPaused && !isDragging && currentAction === 'idle') {
      const action = pickRandomAction();
      if (action) {
        if (action === 'wave') {
          setAction('wave', 1600);
        } else {
          setAction(action);
        }
      }
    }
    scheduleRandomAction();
  }, delay);
}

function setPausedState(nextPaused) {
  isPaused = !!nextPaused;

  if (isPaused) {
    if (randomActionTimer) {
      clearTimeout(randomActionTimer);
      randomActionTimer = null;
    }
    setAction('idle');
  } else {
    scheduleRandomAction();
  }

  syncDefaultAnimationPlayback();
  updateDebug();
}

function setBehaviorStyle(styleName) {
  const next = behaviorStyles[styleName];
  if (!next) return;
  currentBehaviorStyle = next;
  scheduleRandomAction();
  updateDebug();
}

function showSpeech(text, durationMs = 6000) {
  const content = formatSpeechText(text);
  // 始终允许长按关闭，自动关闭与手动关闭可并存
  const closable = true;
  const charsPerLine = Math.max(5, Number(dialogueSettings.charsPerLine) || 15);
  if (window.desktopPet?.setSpeechText) {
    window.desktopPet.setSpeechText({ text: content, closable, charsPerLine });
  }

  if (speechHideTimer) {
    clearTimeout(speechHideTimer);
    speechHideTimer = null;
  }

  if (!dialogueSettings.bubbleAutoClose) {
    return;
  }

  const autoMs = Math.max(1200, (content.length || 0) * Math.max(10, Number(dialogueSettings.bubblePerCharMs) || 180));
  const finalMs = Math.max(durationMs, autoMs);

  speechHideTimer = window.setTimeout(() => {
    if (window.desktopPet?.hideSpeech) window.desktopPet.hideSpeech();
    speechHideTimer = null;
  }, finalMs);
}

function setChatPanelVisible(visible) {
  chatPanelVisible = !!visible;
  if (!chatPanelEl) return;
  chatPanelEl.classList.toggle('show', chatPanelVisible);

  // 对话框显隐不改变 pet-container 尺寸，只需轻量同步一次相机
  window.requestAnimationFrame(() => {
    resize();
    if (vrm) {
      fitVRMToWindow();
    }
  });

  if (chatPanelVisible && chatInputEl) {
    window.setTimeout(() => chatInputEl.focus(), 0);
  }
}

function formatSpeechText(raw) {
  if (!raw) return '';
  // 只保留原始换行，不再按固定字符数硬切行，避免出现“追\n剧”这种生硬断字。
  return raw.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n');
}

function renderStreamingSpeech(text) {
  const content = formatSpeechText(text || '...');
  const charsPerLine = Math.max(5, Number(dialogueSettings.charsPerLine) || 15);
  if (window.desktopPet?.setSpeechText) {
    window.desktopPet.setSpeechText({ text: content, closable: false, charsPerLine });
  }
}

let chatUnsubscribe = null;
let lastChatRequestId = null;
let lastChatText = '';
// Surface playback errors only for the current reply, without discarding its text.
window.desktopPet?.onSpeechStatus?.(status => {
  if (status.requestId === lastChatRequestId && status.type === 'error') {
    showSpeech(`${lastChatText || '语音提示'}\n\n${status.error}`, 12000);
  }
});
// Submit to the gateway, detach stale listeners and finalize text independently of speech.
async function submitChatPrompt() {
  if (!chatInputEl || !window.desktopPet?.chatQueryStream) return;
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatUnsubscribe?.();
  chatUnsubscribe = null;
  window.desktopPet.cancelChat?.();
  chatInputEl.value = '';
  setChatPanelVisible(false);
  if (speechHideTimer) { clearTimeout(speechHideTimer); speechHideTimer = null; }
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeChatRequestId = requestId;
  lastChatRequestId = requestId;
  lastChatText = '';
  let latestText = '';
  renderStreamingSpeech('思考中…');
  chatUnsubscribe = window.desktopPet.onChatStream(payload => {
    if (!payload || payload.requestId !== activeChatRequestId) return;
    if (payload.type === 'chunk') {
      latestText += payload.text || '';
      lastChatText = latestText;
      renderStreamingSpeech(latestText);
    } else if (['done', 'error', 'cancelled'].includes(payload.type)) {
      const text = payload.type === 'done' ? (payload.text || latestText) :
        (payload.type === 'cancelled' ? (latestText || '已停止回复。') : `${payload.error || '对话失败。'}${latestText ? '\n\n' + latestText : ''}`);
      lastChatText = text;
      const note = payload.truncated ? '\n\n（回复达到输出上限，可让白子继续。）' : '';
      showSpeech((text || '没有收到可读回复。') + note, 12000);
      activeChatRequestId = null;
      chatUnsubscribe?.();
      chatUnsubscribe = null;
    }
  });
  window.desktopPet.chatQueryStream(requestId, text);
}

function updateDebug() {
  if (!debugEl) return;
  const b = (x) => (x ? 'OK' : '—');
  const lines = [
    `Action: ${currentAction}`,
    `Bones: head(${b(bones.head)}) spine(${b(bones.spine)}) hips(${b(bones.hips)})`,
    `Arms: R(UA:${b(bones.rightUpperArm)} LA:${b(bones.rightLowerArm)} H:${b(bones.rightHand)}) L(UA:${b(bones.leftUpperArm)} LA:${b(bones.leftLowerArm)} H:${b(bones.leftHand)})`,
    `Legs: R(UL:${b(bones.rightUpperLeg)} LL:${b(bones.rightLowerLeg)} F:${b(bones.rightFoot)}) L(UL:${b(bones.leftUpperLeg)} LL:${b(bones.leftLowerLeg)} F:${b(bones.leftFoot)})`,
    `Expressions: ${vrm?.expressionManager ? 'OK' : '—'}`,
    `default.vrma: ${hasExternalDefaultAnimation ? `OK (${defaultAnimationLoadedFrom})` : '—'}`,
    `walk.vrma: ${hasExternalWalkAnimation ? `OK (${walkAnimationLoadedFrom})` : 'fallback(manual)'}`,
    `silly_dance.vrma: ${hasExternalSillyDanceAnimation ? `OK (${sillyDanceAnimationLoadedFrom})` : '—'}`,
    `hip_hop.vrma: ${hasExternalHipHopAnimation ? `OK (${hipHopAnimationLoadedFrom})` : '—'}`,
    `praying.vrma: ${hasExternalPrayingAnimation ? `OK (${prayingAnimationLoadedFrom})` : '—'}`,
    `jump.vrma: ${hasExternalJumpAnimation ? `OK (${jumpAnimationLoadedFrom})` : '—'}`,
    `dying.vrma: ${hasExternalDyingAnimation ? `OK (${dyingAnimationLoadedFrom})` : '—'}`,
    `Style: ${currentBehaviorStyle.name}`,
    `Size: ${currentSizeMode}`,
    `Breathing: ${breathingConfigs[currentBreathingMode]?.label || 'subtle'}`,
    `Paused: ${isPaused ? 'YES' : 'NO'}`,
    '',
    'Keys: 1 idle | 2 wave | 3 walk | 4 sit | 5 sillyDance | 6 hipHop | 7 praying | 8 jump | 9 dying | D debug',
    'Creative: triple-click => dance | long-press => praying | fast drag-release => jump'
  ];
  debugEl.textContent = lines.join('\n');
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  t += delta;

  if (isPaused) {
    renderer.render(scene, camera);
    return;
  }

  if (vrm) {
    const useExternalIdle = currentAction === 'idle' && hasExternalDefaultAnimation;

    // 只有在不使用外部 default idle 时才重置到基姿态，避免覆盖默认动画
    if (!useExternalIdle) {
      resetToBasePose();
      applyIdle(t);
    }

    if (actionUntilMs && performance.now() > actionUntilMs) {
      setAction('idle');
    }

    // 动作叠加
    if (currentAction === 'wave') {
      const k01 = Math.min((actionUntilMs - performance.now() + 900) / 900, 1);
      applyWave(t, THREE.MathUtils.clamp(1 - k01, 0, 1));
    } else if (currentAction === 'walk') {
      if (!hasExternalWalkAnimation) {
        applyWalk(t);
      }
    } else if (currentAction === 'sit') {
      // sit 是一个慢过渡
      const k = 0.35 + 0.35 * Math.sin(t * 1.0);
      applySit(THREE.MathUtils.clamp(k, 0, 1));
    }

    // reaction
    if (react) {
      const ms = performance.now() - react.startMs;
      const k = Math.min(ms / 320, 1);
      if (bones.head) {
        if (react.type === 'pat') {
          bones.head.rotation.x += -0.22 * Math.sin(k * Math.PI);
          if (bones.spine) bones.spine.rotation.x += -0.08 * Math.sin(k * Math.PI);
        } else {
          bones.head.rotation.z += 0.22 * Math.sin(k * Math.PI * 2);
        }
      }
      if (k >= 1) {
        react = null;
        setExpression(VRMExpressionPresetName.Joy, 0);
        setExpression(VRMExpressionPresetName.Angry, 0);
      }
    }

    applyDesktopWalk(delta);

    if (animationMixer) {
      animationMixer.update(delta);
    }

    // default idle 上叠加轻量呼吸（在 mixer.update 之后，避免被动画覆盖）
    if (useExternalIdle) {
      const spine = bones.spine || bones.chest || bones.upperChest;
      if (spine) {
        const cfg = breathingConfigs[currentBreathingMode] || breathingConfigs.subtle;
        spine.rotation.x += Math.sin(t * 1.0) * cfg.x;
        spine.rotation.z += Math.sin(t * 0.8) * cfg.z;
      }
    }

    // 头部看向鼠标：采用“绝对目标角 + 平滑 + 限幅”，避免持续累加导致越转越离谱
    if (bones.head) {
      const maxYaw = 0.35;
      const maxPitch = 0.2;
      const targetYaw = THREE.MathUtils.clamp(look.x * currentBehaviorStyle.lookSensitivityX, -maxYaw, maxYaw);
      const targetPitch = THREE.MathUtils.clamp(look.y * currentBehaviorStyle.lookSensitivityY, -maxPitch, maxPitch);

      // 平滑靠近目标，鼠标不动时会稳定停住
      const lerpK = THREE.MathUtils.clamp(delta * 9.0, 0, 1);
      headLookCurrent.x = THREE.MathUtils.lerp(headLookCurrent.x, targetPitch, lerpK);
      headLookCurrent.y = THREE.MathUtils.lerp(headLookCurrent.y, targetYaw, lerpK);

      // 覆盖到当前帧头部旋转（不使用 +=）
      bones.head.rotation.x = headLookCurrent.x;
      bones.head.rotation.y = headLookCurrent.y;
    }

    // 外部 walk.vrma 往往包含根位移（root motion），会导致循环回跳和角色出框。
    // 这里锁定 hips 的 X/Z，只保留 Y 起伏与肢体动画。
    if (currentAction === 'walk' && hasExternalWalkAnimation && bones.hips) {
      bones.hips.position.x = hipsBaseX;
      bones.hips.position.z = hipsBaseZ;
    }

    vrm.update(delta);
  }

  renderer.render(scene, camera);
}

animate();

// --------------------
// Interaction: drag / click / menu
// --------------------

let isDragging = false;
let hasMoved = false;
let dragStart = { x: 0, y: 0 };
let windowStart = { x: 0, y: 0 };

// 创意触发：长按 / 连击
let longPressTimer = null;
let longPressConsumed = false;
let clickBurstCount = 0;
let clickBurstTimer = null;
let danceToggle = 0;
let speechHideTimer = null;
let chatPanelVisible = false;
let activeChatRequestId = null;
let currentSpeechAudio = null;
let dialogueSettings = {
  bubbleAutoClose: true,
  bubblePerCharMs: 180,
  charsPerLine: 15
};

function applyPetBoundsDebug(show) {
  showPetBounds = !!show;
  // outline 会画在元素外侧，透明窗体 + overflow hidden 下容易被裁掉，改为内描边
  petContainer.style.boxShadow = showPetBounds ? 'inset 0 0 0 1px rgba(79, 70, 229, 0.95)' : 'none';
}

if (window.desktopPet?.getShowPetBounds) {
  window.desktopPet.getShowPetBounds().then((show) => {
    applyPetBoundsDebug(show);
  }).catch(() => {});
}

if (window.desktopPet?.onShowPetBoundsChanged) {
  window.desktopPet.onShowPetBoundsChanged((show) => {
    applyPetBoundsDebug(show);
  });
}

petContainer.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  isDragging = true;
  hasMoved = false;
  petContainer.classList.add('dragging');
  dragStart = { x: e.screenX, y: e.screenY };
  longPressConsumed = false;

  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  // 创意触发 1：按住 700ms 不拖动 => praying
  longPressTimer = window.setTimeout(() => {
    if (!hasMoved && !longPressConsumed && isDragging && currentAction === 'idle') {
      if (hasExternalPrayingAnimation) {
        setAction('praying');
      } else {
        setAction('wave', 1800);
      }
      longPressConsumed = true;
    }
  }, 700);

  try {
    const pos = await window.desktopPet.getPosition();
    windowStart = { x: pos.x, y: pos.y };
  } catch (_) {
    windowStart = { x: 0, y: 0 };
  }
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.screenX - dragStart.x;
  const dy = e.screenY - dragStart.y;

  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    hasMoved = true;
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  petWindowPos.x = windowStart.x + dx;
  petWindowPos.y = windowStart.y + dy;
  petWindowPosReady = true;

  window.desktopPet.setPosition(petWindowPos.x, petWindowPos.y);
  saveWindowPosition(petWindowPos);
});

window.addEventListener('mouseup', () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  if (!isDragging) return;

  // 创意触发 3：快速甩动（拖拽距离较大）后松手 => jump
  const dragDx = petWindowPos.x - windowStart.x;
  const dragDy = petWindowPos.y - windowStart.y;
  const dragDistance = Math.hypot(dragDx, dragDy);

  isDragging = false;
  petContainer.classList.remove('dragging');

  if (dragDistance > 180 && hasExternalJumpAnimation && currentAction === 'idle') {
    setAction('jump');
  }
});

petContainer.addEventListener('click', (e) => {
  if (hasMoved || longPressConsumed) return;

  const rect = petContainer.getBoundingClientRect();
  spawnParticles(rect, 7);

  if (!vrm) {
    fallback.classList.add('active');
    restartClassAnimation(fallback, 'pat');
    return;
  }

  // 新创意触发：按点击区域决定动作
  const localY = e.clientY - rect.top;
  const h = rect.height || 1;
  const isHeadZone = localY <= h / 3;
  const isLegZone = localY >= (h * 2) / 3;

  // 头部：弹出对话框
  if (isHeadZone) {
    setChatPanelVisible(true);
    return;
  }

  // 腿部（下三分之一）：触发 walk
  if (isLegZone) {
    setAction('walk');
    return;
  }

  // 创意触发 2：快速三连击 => 在 sillyDance / hipHop 之间交替
  clickBurstCount += 1;
  if (clickBurstTimer) {
    clearTimeout(clickBurstTimer);
  }
  clickBurstTimer = window.setTimeout(() => {
    clickBurstCount = 0;
    clickBurstTimer = null;
  }, 700);

  if (clickBurstCount >= 3) {
    clickBurstCount = 0;
    if (clickBurstTimer) {
      clearTimeout(clickBurstTimer);
      clickBurstTimer = null;
    }

    const danceOrder = danceToggle % 2 === 0 ? ['sillyDance', 'hipHop'] : ['hipHop', 'sillyDance'];
    danceToggle += 1;

    const danceAction = danceOrder.find((name) => {
      if (name === 'sillyDance') return hasExternalSillyDanceAnimation;
      if (name === 'hipHop') return hasExternalHipHopAnimation;
      return false;
    });

    if (danceAction) {
      setExpression(VRMExpressionPresetName.Joy, 1);
      react = { type: 'pat', startMs: performance.now() };
      setAction(danceAction);
      return;
    }
  }

  const r = Math.random();
  if (r < 0.78) {
    setExpression(VRMExpressionPresetName.Joy, 1);
    react = { type: 'pat', startMs: performance.now() };
    // 点击更像“回应”：挥手一下
    setAction('wave', 1400);
  } else {
    setExpression(VRMExpressionPresetName.Angry, 1);
    react = { type: 'shake', startMs: performance.now() };
    // 生气：执行一次 walk.vrma
    setAction('walk');
  }
});

petContainer.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.desktopPet.showContextMenu();
});

// 键盘切动作（方便你检查权重是否正确）
window.addEventListener('keydown', (e) => {
  // Ctrl + Enter 打开/关闭聊天面板
  if (e.ctrlKey && e.key === 'Enter') {
    setChatPanelVisible(!chatPanelVisible);
    return;
  }

  // 聊天输入时不触发动作快捷键
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  const isTyping = activeTag === 'input' || activeTag === 'textarea';

  if (!isTyping) {
    if (e.key === '1') setAction('idle');
    if (e.key === '2') setAction('wave', 2000);
    if (e.key === '3') setAction('walk');
    if (e.key === '4') setAction('sit');
    if (e.key === '5') {
      if (hasExternalSillyDanceAnimation) {
        setAction('sillyDance');
      }
    }
    if (e.key === '6') {
      if (hasExternalHipHopAnimation) {
        setAction('hipHop');
      }
    }
    if (e.key === '7') {
      if (hasExternalPrayingAnimation) {
        setAction('praying');
      }
    }
    if (e.key === '8') {
      if (hasExternalJumpAnimation) {
        setAction('jump');
      }
    }
    if (e.key === '9') {
      if (hasExternalDyingAnimation) {
        setAction('dying');
      }
    }
    if (e.key.toLowerCase() === 'd') {
      debugEl.classList.toggle('show');
      updateDebug();
    }
  }

  if (chatPanelVisible && e.key === 'Escape') {
    setChatPanelVisible(false);
  }
});

// Let the user stop generation and speech without submitting another message.
document.getElementById('chat-stop')?.addEventListener('click', () => window.desktopPet?.cancelChat?.());

if (chatSendEl) {
  chatSendEl.addEventListener('click', () => {
    submitChatPrompt();
  });
}

if (chatInputEl) {
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitChatPrompt();
    }
  });
}

