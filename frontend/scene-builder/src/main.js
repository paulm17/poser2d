import { initFrameControl } from './poses/frame-control.js';
import { initBlenderGallery } from './poses/gallery2.js';
import { captureExactPose, applyExactPose, jointNodes } from './poses/exact-state.js';
import * as THREE from 'three';
import { Male, createStage, getStage } from 'mannequin-js/src/mannequin.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { initExportSystem } from './exportSystem.js';
import { initEditorBridge } from './bridge.js';
import { isProject } from '../protocol.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const BUILTIN_POSES = {
  Default: { posture: null, joints: {} }
};
const GROUND_Y = 0.25;
const IK_LIMBS = ['Head', 'Left_Arm', 'Right_Arm', 'Left_Leg', 'Right_Leg'];
const IK_CHAINS = {
  Head: ['torso', 'neck', 'head'],
  Left_Arm: ['l_arm', 'l_elbow', 'l_wrist'],
  Right_Arm: ['r_arm', 'r_elbow', 'r_wrist'],
  Left_Leg: ['l_leg', 'l_knee', 'l_ankle'],
  Right_Leg: ['r_leg', 'r_knee', 'r_ankle'],
};
const HANDLE_COLORS = {
  Head: 0xaa66ff, Left_Arm: 0x4499ff, Right_Arm: 0x44ccff,
  Left_Leg: 0xff8844, Right_Leg: 0xffcc44,
};

const poseConfig = {
  Root: { target: 'self', props: { bend:[-90,90], tilt:[-90,90], turn:[-180,180] } },
  Torso: { target: 'torso', props: { bend:[-90,90], tilt:[-45,45], turn:[-90,90] } },
  Neck: { target: 'neck', props: { nod:[-90,90], tilt:[-45,45], turn:[-90,90] } },
  Head: { target: 'head', props: { nod:[-90,90], tilt:[-45,45], turn:[-90,90] } },
  Left_Arm: { target: 'l_arm', props: { raise:[-180,180], straddle:[-180,180], turn:[-90,90] } },
  Left_Elbow: { target: 'l_elbow', props: { bend:[0,150] } },
  Left_Wrist: { target: 'l_wrist', props: { bend:[-90,90], turn:[-90,90], straddle:[-45,45] } },
  Left_Leg: { target: 'l_leg', props: { raise:[-90,135], straddle:[-90,90], turn:[-90,90] } },
  Left_Knee: { target: 'l_knee', props: { bend:[-100,150] } },
  Left_Ankle: { target: 'l_ankle', props: { bend:[-45,45], turn:[-45,45] } },
  Right_Arm: { target: 'r_arm', props: { raise:[-180,180], straddle:[-180,180], turn:[-90,90] } },
  Right_Elbow: { target: 'r_elbow', props: { bend:[0,150] } },
  Right_Wrist: { target: 'r_wrist', props: { bend:[-90,90], turn:[-90,90], straddle:[-45,45] } },
  Right_Leg: { target: 'r_leg', props: { raise:[-90,135], straddle:[-90,90], turn:[-90,90] } },
  Right_Knee: { target: 'r_knee', props: { bend:[-100,150] } },
  Right_Ankle: { target: 'r_ankle', props: { bend:[-45,45], turn:[-45,45] } },
};

// defaultPosture is built dynamically per-mannequin — see createFullMannequin()

// ─── State ────────────────────────────────────────────────────────────────────
let stage, activeMannequin = null, selectedPartGroup = null;
const mannequins = [];
const importedModels = []; // GLB imports (tracked separately)
let transformControl, transformProxy, connectionLine;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const ikEnabled = { Head:false, Left_Arm:false, Right_Arm:false, Left_Leg:false, Right_Leg:false };
const ikHandles = {};
let activeIKHandle = null, isDraggingIK = false;
const ikDragPlane = new THREE.Plane();
const ikDragPlaneNormal = new THREE.Vector3();
let selectedBodyPart = 'Root';
let frameController = null, exportController = null, editorBridge = null;
const pendingEdits = new Set();
async function runEditorTask(action) {
  const task = Promise.resolve().then(action); pendingEdits.add(task);
  document.body.inert = true; editorBridge?.busy(true);
  document.getElementById("editor-error").hidden = true;
  try { return await task; }
  catch (error) { const message = document.getElementById("editor-error"); message.textContent = error.message; message.hidden = false; throw error; }
  finally { pendingEdits.delete(task); if (!pendingEdits.size) { document.body.inert = !!window.sceneSuspended; editorBridge?.busy(false); } }
}
async function whenIdle() { await Promise.allSettled([...pendingEdits]); }
const historyStack = [];
let historyIndex = -1;

function updateStageControlsEnabled() {
  if (!stage || !stage.controls) return;
  const isTransformDragging = !!(transformControl && transformControl.dragging);
  stage.controls.enabled = !isDraggingIK && !isTransformDragging;
}

// ─── History ──────────────────────────────────────────────────────────────────
function serializeObjects() {
  return {
    mannequins: mannequins.map(m => {
      const joints = {};
      for (const [key, cfg] of Object.entries(poseConfig)) {
        if (cfg.target !== 'self' && m[cfg.target]) {
          joints[cfg.target] = {
            position: m[cfg.target].position.toArray(),
            rotation: m[cfg.target].rotation.toArray(),
            scale: m[cfg.target].scale.toArray()
          };
        }
      }
      return {
        name: m.name,
        position: m.position.toArray(),
        rotation: m.rotation.toArray(),
        scale: m.scale.toArray(),
        posture: m.posture,
        exactPose: captureExactPose(m),
        poseFrame: m.userData.poseFrame || null,
        joints: joints
      };
    }),
    importedModels: importedModels.map(m => ({
      position: m.position.toArray(),
      rotation: m.rotation.toArray(),
      scale: m.scale.toArray(),
      name: m.userData._glbFileName || m.name,
      glbBase64: m.userData._glbBase64 || null,
    })),
    activeIndex: mannequins.indexOf(activeMannequin),
    activeImportIndex: importedModels.indexOf(activeMannequin),
    selectedBodyPart,
  };
}

function captureState() {
  const state = serializeObjects();
  if (historyIndex < historyStack.length - 1) historyStack.splice(historyIndex + 1);
  historyStack.push(JSON.stringify(state));
  if (historyStack.length > 30) historyStack.shift();
  else historyIndex++;
  updateHistoryButtons();
}

async function applyState(json) {
  if (!json) return;
  const state = JSON.parse(json);
  const nextModels = [];
  const nextMannequins = [];
  try {
    // Prepare all GLBs before changing the visible scene, and preserve their order.
    for (const data of state.importedModels ?? []) nextModels.push(await restoreImportedModel(data));
    for (const d of state.mannequins) {
      const m = createFullMannequin(); stage.scene.remove(m); nextMannequins.push(m);
      m.name = d.name || 'Mannequin';
      m.position.fromArray(d.position); m.rotation.fromArray(d.rotation); m.scale.fromArray(d.scale);
      if (d.posture) m.posture = d.posture;
      for (const [part, data] of Object.entries(d.joints ?? {})) {
        if (m[part]) {
          if (data.position) m[part].position.fromArray(data.position);
          if (data.rotation) m[part].rotation.fromArray(data.rotation);
          if (data.scale) m[part].scale.fromArray(data.scale);
        }
      }
      applyExactPose(m, d.exactPose); m.userData.poseFrame = d.poseFrame || null;
    }
  } catch (error) {
    [...nextModels, ...nextMannequins].forEach(disposeObject); throw error;
  }
  detachGizmo(); clearHighlight(); activeMannequin = null;
  mannequins.forEach(disposeObject); importedModels.forEach(disposeObject);
  mannequins.splice(0, mannequins.length, ...nextMannequins);
  importedModels.splice(0, importedModels.length, ...nextModels);
  [...mannequins, ...importedModels].forEach(model => stage.scene.add(model));

  if (state.activeIndex !== -1 && mannequins[state.activeIndex]) {
    activeMannequin = mannequins[state.activeIndex];
    attachGizmo(activeMannequin);
  } else if (state.activeImportIndex !== -1 && importedModels[state.activeImportIndex]) {
    activeMannequin = importedModels[state.activeImportIndex];
    attachGizmo(activeMannequin);
  }
  
  if (state.selectedBodyPart) {
    selectedBodyPart = state.selectedBodyPart;
    const selectEl = document.getElementById('body-part-select');
    if (selectEl) selectEl.value = selectedBodyPart;
    const cfg = poseConfig[selectedBodyPart];
    if (cfg && cfg.target !== 'self' && activeMannequin && activeMannequin[cfg.target]) {
      setHighlight(activeMannequin[cfg.target]);
    } else {
      clearHighlight();
    }
  }
  updatePropertiesPanel();
  updateLayerWindow();
}

async function moveHistory(offset) {
  const next = historyIndex + offset;
  if (next < 0 || next >= historyStack.length || pendingEdits.size) return;
  await runEditorTask(async () => { await applyState(historyStack[next]); historyIndex = next; updateHistoryButtons(); }).catch(() => {});
}
function undo() { return moveHistory(-1); }
function redo() { return moveHistory(1); }
function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = historyIndex <= 0;
  document.getElementById('btn-redo').disabled = historyIndex >= historyStack.length - 1;
}

// ─── Mannequin Factory ────────────────────────────────────────────────────────
function createFullMannequin() {
  const m = new Male();
  // Tag each joint with its poseConfig key
  Object.keys(poseConfig).forEach(key => {
    const target = poseConfig[key].target;
    const jointNode = target === 'self' ? m : m[target];
    if (jointNode) jointNode.userData._jointKey = key;
  });
  // Snapshot the anatomical defaults BEFORE any user edits
  Object.keys(poseConfig).forEach(key => {
    const cfg = poseConfig[key];
    const tgt = cfg.target === 'self' ? m : m[cfg.target];
    if (!tgt) return;
    // Position baseline
    tgt.userData.anatomicPos = tgt.position.clone();
    // Rotation baseline (the actual mannequin-js default pose values)
    const rotDefaults = {};
    for (const prop of Object.keys(cfg.props)) {
      rotDefaults[prop] = typeof tgt[prop] === 'number' ? tgt[prop] : 0;
    }
    tgt.userData.anatomicRot = rotDefaults;
  });
  // Propagate posePartKey down to every Mesh for click-selection
  m.traverse(obj => {
    if (!obj.isMesh) return;
    let tmp = obj;
    while (tmp) {
      if (tmp.userData._jointKey) {
        obj.userData.posePartKey = tmp.userData._jointKey;
        obj.userData.posePartNode = tmp;
        break;
      }
      tmp = tmp.parent;
    }
  });
  return m;
}

// ─── IK System ────────────────────────────────────────────────────────────────
function initIKHandles() {
  const geom = new THREE.SphereGeometry(0.22, 14, 14);
  IK_LIMBS.forEach(key => {
    const mat = new THREE.MeshPhongMaterial({
      color: HANDLE_COLORS[key], emissive: HANDLE_COLORS[key], emissiveIntensity: 0.3,
      transparent: true, opacity: 0.88,
    });
    const h = new THREE.Mesh(geom, mat.clone());
    h.userData.ikLimbKey = key;
    h.visible = false;
    stage.scene.add(h);
    ikHandles[key] = h;
  });
}

function getChainEnd(mannequin, limbKey) {
  const chain = IK_CHAINS[limbKey];
  const end = mannequin[chain[chain.length - 1]];
  const pos = new THREE.Vector3();
  if (end) end.getWorldPosition(pos);
  return pos;
}

function solveIKChain(mannequin, limbKey, target) {
  const chain = IK_CHAINS[limbKey].map(k => mannequin[k]).filter(Boolean);
  if (chain.length < 2) return;
  const end = chain[chain.length - 1];
  const _jp = new THREE.Vector3(), _ep = new THREE.Vector3();
  const _toE = new THREE.Vector3(), _toT = new THREE.Vector3();
  const _rq = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
  for (let iter = 0; iter < 20; iter++) {
    for (let i = chain.length - 2; i >= 0; i--) {
      const joint = chain[i];
      joint.updateWorldMatrix(true, true);
      joint.getWorldPosition(_jp);
      end.getWorldPosition(_ep);
      _toE.subVectors(_ep, _jp).normalize();
      _toT.subVectors(target, _jp).normalize();
      if (_toE.dot(_toT) >= 0.9999) continue;
      _rq.setFromUnitVectors(_toE, _toT);
      joint.getWorldQuaternion(_wq);
      _wq.premultiply(_rq);
      if (joint.parent) {
        joint.parent.getWorldQuaternion(_pq);
        _wq.premultiply(_pq.invert());
      }
      joint.quaternion.copy(_wq);
      joint.updateMatrixWorld(true);
    }
    end.getWorldPosition(_ep);
    if (_ep.distanceTo(target) < 0.04) break;
  }
}

function tickIKHandles() {
  if (!activeMannequin) {
    IK_LIMBS.forEach(k => ikHandles[k] && (ikHandles[k].visible = false));
    return;
  }
  IK_LIMBS.forEach(key => {
    const h = ikHandles[key];
    h.visible = ikEnabled[key];
    if (ikEnabled[key] && activeIKHandle !== h) h.position.copy(getChainEnd(activeMannequin, key));
  });
}

// ─── Gizmo Proxy ──────────────────────────────────────────────────────────────
const GIZMO_OFFSET = new THREE.Vector3(0, 0, -1); // 1 unit behind mannequin

function attachGizmo(mannequin) {
    const isImported = importedModels.includes(mannequin);
    transformProxy.position.copy(mannequin.position);
    if (!isImported) {
      // Mannequin: offset gizmo 1 unit behind
      transformProxy.position.add(GIZMO_OFFSET);
    }
    transformProxy.rotation.copy(mannequin.rotation);
    transformProxy.scale.copy(mannequin.scale);
    transformControl.attach(transformProxy);
    connectionLine.visible = true;
    updateLayerWindow();
  }

  function detachGizmo() { transformControl.detach(); connectionLine.visible = false; updateLayerWindow(); }

function syncProxy() {
  if (!activeMannequin || !connectionLine.visible) return;
  const pts = [transformProxy.position.clone(), activeMannequin.position.clone()];
  connectionLine.geometry.setFromPoints(pts);
  connectionLine.computeLineDistances();
}

function setHighlight(node) {
  clearHighlight();
  selectedPartGroup = node;
  const targetToHighlight = node.image ? node.image : node;
  targetToHighlight.traverse(nc => {
    if (nc.isMesh && nc.material) {
      if (Array.isArray(nc.material)) {
        if (!nc.userData.origEmissive) nc.userData.origEmissive = nc.material.map(m => m.emissive.clone());
        nc.material.forEach(m => m.emissive.setHex(0xbc4e4e));
      } else {
        if (!nc.userData.origEmissive) nc.userData.origEmissive = nc.material.emissive.clone();
        nc.material.emissive.setHex(0xbc4e4e);
      }
    }
  });
}

function clearHighlight() {
  if (selectedPartGroup) {
    const targetToClear = selectedPartGroup.image ? selectedPartGroup.image : selectedPartGroup;
    targetToClear.traverse(nc => {
      if (nc.isMesh && nc.userData.origEmissive) {
        if (Array.isArray(nc.material)) nc.material.forEach((m, i) => m.emissive.copy(nc.userData.origEmissive[i]));
        else nc.material.emissive.copy(nc.userData.origEmissive);
      }
    });
  }
  selectedPartGroup = null;
}

// ─── Layer Window ──────────────────────────────────────────────────────────────
function updateLayerWindow() {
  const container = document.getElementById('layer-content');
  if (!container) return;
  
  let html = '';
  
  const allObjects = [...mannequins, ...importedModels];
  if (allObjects.length === 0) {
    container.innerHTML = '<p class="placeholder-text" style="color:var(--text-secondary);">No objects in scene.</p>';
    return;
  }
  
  allObjects.forEach((obj, idx) => {
    const isImported = importedModels.includes(obj);
    const typeLabel = isImported ? 'Imported GLB' : 'Mannequin';
    const isActive = (obj === activeMannequin);
    const displayName = (obj.name || `${typeLabel} ${idx + 1}`).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    
    html += `<div style="display:flex;align-items:center;gap:6px;padding:6px;background:${isActive ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.3)'};border:1px solid ${isActive ? 'var(--accent)' : 'var(--glass-border)'};border-radius:4px;cursor:pointer;" class="layer-item" data-idx="${idx}" data-imported="${isImported}">
      <span style="font-size:14px;color:var(--text-secondary);">${isImported ? '📦' : '🧍'}</span>
      <div style="flex:1;display:flex;flex-direction:column;">
        <input type="text" class="layer-name-input" data-idx="${idx}" data-imported="${isImported}" value="${displayName}" style="background:transparent;border:none;color:white;font-size:12px;font-weight:${isActive ? 'bold' : 'normal'};outline:none;width:100%;font-family:inherit;padding:0;">
      </div>
      <div style="display:flex;gap:2px;">
        <button class="btn-save-layer" data-idx="${idx}" data-imported="${isImported}" style="background:none;border:none;color:#66ccff;cursor:pointer;font-size:12px;padding:2px 4px;" title="Save Object">💾</button>
        <button class="btn-delete-layer" data-idx="${idx}" data-imported="${isImported}" style="background:none;border:none;color:#ff6666;cursor:pointer;font-size:12px;padding:2px 4px;" title="Delete">🗑</button>
      </div>
    </div>`;
  });
  
  container.innerHTML = html;
  
  // Bind events
  container.querySelectorAll('.layer-name-input').forEach(input => {
    input.addEventListener('click', e => {
      e.stopPropagation(); // Allow clicking into input without triggering item selection if already selected
    });
    input.addEventListener('change', e => {
      const isImported = e.target.dataset.imported === 'true';
      const idx = parseInt(e.target.dataset.idx);
      const obj = isImported ? importedModels[idx] : mannequins[idx];
      if (obj) {
        obj.name = e.target.value;
        if (isImported) obj.userData._glbFileName = e.target.value; // Sync to save data
        captureState();
      }
    });
  });

  container.querySelectorAll('.layer-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.btn-delete-layer') || e.target.tagName === 'INPUT') return; // Ignore delete and input clicks
      
      const isImported = item.dataset.imported === 'true';
      const idx = parseInt(item.dataset.idx);
      
      const obj = isImported ? importedModels[idx] : mannequins[idx];
      if (obj) {
        activeMannequin = obj;
        attachGizmo(activeMannequin);
        selectedBodyPart = 'Root';
        updatePropertiesPanel();
        updateLayerWindow();
      }
    });
  });
  
  container.querySelectorAll('.btn-save-layer').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isImported = btn.dataset.imported === 'true';
      const idx = parseInt(btn.dataset.idx);
      const obj = isImported ? importedModels[idx] : mannequins[idx];
      if (obj) {
        let exportData;
        if (isImported) {
          exportData = {
            type: 'importedModel',
            position: obj.position.toArray(),
            rotation: obj.rotation.toArray(),
            scale: obj.scale.toArray(),
            name: obj.userData._glbFileName || obj.name,
            glbBase64: obj.userData._glbBase64 || null,
          };
        } else {
          const joints = {};
          for (const [key, cfg] of Object.entries(poseConfig)) {
            if (cfg.target !== 'self' && obj[cfg.target]) {
              joints[cfg.target] = {
                position: obj[cfg.target].position.toArray(),
                rotation: obj[cfg.target].rotation.toArray(),
                scale: obj[cfg.target].scale.toArray()
              };
            }
          }
          exportData = {
            type: 'mannequin',
            position: obj.position.toArray(),
            rotation: obj.rotation.toArray(),
            scale: obj.scale.toArray(),
            posture: obj.posture,
            exactPose: captureExactPose(obj),
            poseFrame: obj.userData.poseFrame || null,
            joints: joints,
            name: obj.name || 'Mannequin'
          };
        }
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const defaultName = (obj.name || (isImported ? 'imported-model' : 'mannequin')).replace(/\s+/g, '-').toLowerCase();
        a.download = `pose-object-${defaultName}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    });
  });

  container.querySelectorAll('.btn-delete-layer').forEach(btn => {
    btn.addEventListener('click', e => {
      const isImported = btn.dataset.imported === 'true';
      const idx = parseInt(btn.dataset.idx);
      const obj = isImported ? importedModels[idx] : mannequins[idx];
      
      if (obj) {
        if (obj === activeMannequin) {
          activeMannequin = null;
          detachGizmo();
          clearHighlight();
        }
        
        stage.scene.remove(obj);
        if (isImported) importedModels.splice(idx, 1);
        else mannequins.splice(idx, 1);
        
        updatePropertiesPanel();
        updateLayerWindow();
        captureState();
      }
    });
  });
}
function deleteSelected() {
  if (!activeMannequin) return;
  const importIndex = importedModels.indexOf(activeMannequin);
  if (importIndex !== -1) {
    stage.scene.remove(activeMannequin);
    importedModels.splice(importIndex, 1);
    detachGizmo();
    activeMannequin = null;
    clearHighlight();
    updatePropertiesPanel();
    console.log('Deleted imported model');
    return;
  }
  const mannequinIndex = mannequins.indexOf(activeMannequin);
  if (mannequinIndex !== -1) {
    if (mannequins.length <= 1) { console.log('Cannot delete the last mannequin'); return; }
    stage.scene.remove(activeMannequin);
    mannequins.splice(mannequinIndex, 1);
    detachGizmo();
    activeMannequin = null;
    clearHighlight();
    updatePropertiesPanel();
    captureState();
    console.log('Deleted mannequin');
  }
}

// ─── GLB Import ───────────────────────────────────────────────────────────────
function disposeObject(object) {
  stage.scene.remove(object);
  object.traverse(node => {
    node.geometry?.dispose();
    for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}
async function restoreImportedModel(data) {
  if (!data.glbBase64) throw Error('Saved model is missing its GLB data.');
  const { scene: model } = await new GLTFLoader().parseAsync(base64ToArrayBuffer(data.glbBase64), '');
  model.name = data.name || 'restored-glb';
  model.position.fromArray(data.position); model.rotation.fromArray(data.rotation); model.scale.fromArray(data.scale);
  model.userData._glbBase64 = data.glbBase64; model.userData._glbFileName = data.name;
  return model;
}
function importGLB(file) {
  return runEditorTask(async () => {
    const arrayBuffer = await file.arrayBuffer();
    const { scene: model } = await new GLTFLoader().parseAsync(arrayBuffer, '');
    model.name = file.name || 'imported.glb';
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    const scale = 2 / Math.max(size.x, size.y, size.z, 0.001);
    model.scale.setScalar(scale); model.position.set(0, size.y * scale / 2 + GROUND_Y, 0);
    model.userData._glbBase64 = arrayBufferToBase64(arrayBuffer); model.userData._glbFileName = model.name;
    stage.scene.add(model); importedModels.push(model); activeMannequin = model; attachGizmo(model);
    captureState(); updatePropertiesPanel(); updateLayerWindow();
  }).catch(() => {});
}

// Helper: ArrayBuffer → base64 string
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Helper: base64 string → ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function addMannequinFromData(data) {
  const m = createFullMannequin();
  m.position.fromArray(data.position || [0, GROUND_Y, 0]);
  m.rotation.fromArray(data.rotation || [0, 0, 0, 'XYZ']);
  m.scale.fromArray(data.scale || [1, 1, 1]);
  m.name = data.name || 'Mannequin';
  try {
    if (data.posture) m.posture = data.posture;
    if (data.joints) {
      for (const [part, jdata] of Object.entries(data.joints)) {
        if (m[part]) {
          if (jdata.position) m[part].position.fromArray(jdata.position);
          if (jdata.rotation) m[part].rotation.fromArray(jdata.rotation);
          if (jdata.scale) m[part].scale.fromArray(jdata.scale);
        }
      }
    }
    applyExactPose(m, data.exactPose); m.userData.poseFrame = data.poseFrame || null;
  } catch(err) {}
  mannequins.push(m);
  stage.scene.add(m);
  activeMannequin = m;
  attachGizmo(m);
  captureState();
  updatePropertiesPanel();
  updateLayerWindow();
}

function addMannequinFromPickedFile() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
  document.body.append(input);
  input.onchange = () => {
    const file = input.files[0]; input.remove();
    if (file) loadProject(file, true);
  };
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.click();
}


// ─── Save/Load Project ────────────────────────────────────────────────────────
function serializeProject() {
  return {
    ...serializeObjects(),
    camera: {
      position: stage.camera.position.toArray(), rotation: stage.camera.rotation.toArray(),
      target: stage.controls.target.toArray(), zoom: stage.camera.zoom,
    },
    export: exportController.snapshot(),
    ik: { enabled: { ...ikEnabled }, active: !!window.ikToggleActive },
  };
}
async function restoreProject(data) {
  document.getElementById("editor-error").hidden = true;
  if (!isProject(data)) throw Error('Choose a valid pose project JSON file.');
  await applyState(JSON.stringify(data));
  if (data.camera) {
    stage.camera.position.fromArray(data.camera.position);
    stage.camera.rotation.fromArray([...data.camera.rotation.slice(0, 3), data.camera.rotation[3] ?? 'XYZ']);
    // Old toolkit projects omitted the orbit target: derive it from their camera.
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(stage.camera.quaternion);
    stage.controls.target.fromArray(data.camera.target ?? stage.camera.position.clone().addScaledVector(direction, 7).toArray());
    stage.camera.zoom = data.camera.zoom ?? 1; stage.camera.updateProjectionMatrix();
    stage.controls.update();
  }
  Object.keys(ikEnabled).forEach(key => { ikEnabled[key] = data.ik?.enabled?.[key] ?? false; }); window.ikToggleActive = data.ik?.active ?? false;
  isDraggingIK = false; activeIKHandle = null;
  exportController.restore(data.export);
  updatePropertiesPanel(); updateLayerWindow();
}
function saveProject() {
  const blob = new Blob([JSON.stringify(serializeProject(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'pose-project.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function loadProject(file, objectOnly = false) {
  return runEditorTask(async () => {
    const data = JSON.parse(await file.text());
    if (objectOnly && !['mannequin', 'importedModel'].includes(data.type)) throw Error('Pick a saved mannequin or imported-object JSON file.');
    if (data.type === 'mannequin') { addMannequinFromData(data); return; }
    if (data.type === 'importedModel') {
      const model = await restoreImportedModel(data); stage.scene.add(model); importedModels.push(model);
      activeMannequin = model; attachGizmo(model); captureState(); updatePropertiesPanel(); updateLayerWindow(); return;
    }
    await restoreProject(data); historyStack.length = 0; historyIndex = -1; captureState();
  }).catch(() => {});
}

// ─── HUD Updates ──────────────────────────────────────────────────────────────
function updateHUDValues() {
  document.getElementById('cam-pos-x').value = stage.camera.position.x;
  document.getElementById('cam-pos-y').value = stage.camera.position.y;
  document.getElementById('cam-pos-z').value = stage.camera.position.z;
  document.getElementById('val-cam-pos-x').textContent = stage.camera.position.x.toFixed(1);
  document.getElementById('val-cam-pos-y').textContent = stage.camera.position.y.toFixed(1);
  document.getElementById('val-cam-pos-z').textContent = stage.camera.position.z.toFixed(1);
  document.getElementById('cam-rot-x').value = THREE.MathUtils.radToDeg(stage.camera.rotation.x);
  document.getElementById('cam-rot-y').value = THREE.MathUtils.radToDeg(stage.camera.rotation.y);
  document.getElementById('cam-rot-z').value = THREE.MathUtils.radToDeg(stage.camera.rotation.z);
  document.getElementById('val-cam-rot-x').textContent = THREE.MathUtils.radToDeg(stage.camera.rotation.x).toFixed(1) + '°';
  document.getElementById('val-cam-rot-y').textContent = THREE.MathUtils.radToDeg(stage.camera.rotation.y).toFixed(1) + '°';
  document.getElementById('val-cam-rot-z').textContent = THREE.MathUtils.radToDeg(stage.camera.rotation.z).toFixed(1) + '°';
}

function updateMannequinHUD() {
  const el = document.getElementById('mannequin-pos-values');
  if (!activeMannequin) { el.textContent = 'Select a mannequin...'; return; }
  const p = activeMannequin.position;
  el.textContent = `X: ${p.x.toFixed(2)}  Y: ${p.y.toFixed(2)}  Z: ${p.z.toFixed(2)}`;
}

// ─── Properties Panel ─────────────────────────────────────────────────────────
function sliderRow(id, label, min, max, step, value, def) {
  return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
    <span style="width:70px;font-size:11px;color:var(--text-secondary);">${label}</span>
    <input type="range" id="rng-${id}" min="${min}" max="${max}" step="${step}" value="${value}" style="flex:1;">
    <input type="number" id="num-${id}" class="slider-num" value="${value.toFixed(2)}">
    <button class="btn-reset-slider" data-id="${id}" data-def="${def}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:12px;padding:0 4px;" title="Reset to default">↺</button>
  </div>`;
}

function renderSliders() {
  if (!activeMannequin) return '';
  const cfg = poseConfig[selectedBodyPart];
  const tgt = cfg.target === 'self' ? activeMannequin : activeMannequin[cfg.target];
  if (!tgt) return '<p style="color:var(--text-secondary);">Joint not found.</p>';
  const aPos = tgt.userData.anatomicPos || new THREE.Vector3();
  const aRot = tgt.userData.anatomicRot || {};
  let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
  html += `<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">
    <button id="btn-reset-bodypart" class="btn" style="font-size:11px;padding:4px 8px;opacity:0.85;" title="Reset this body part to default">↺ Reset Part</button>
  </div>`;
  html += '<div style="font-size:9px;letter-spacing:.05em;color:var(--text-secondary);margin-top:2px;">OFFSET POSITION</div>';
  ['x', 'y', 'z'].forEach(ax => {
    const v = tgt.position[ax];
    const def = aPos[ax];
    html += sliderRow(`pos-${ax}`, `Pos ${ax.toUpperCase()}`, -20, 20, 0.05, v, def);
  });
  html += '<div style="font-size:9px;letter-spacing:.05em;color:var(--text-secondary);margin-top:4px;">JOINT ROTATION</div>';
  for (const [prop, range] of Object.entries(cfg.props)) {
    const v = typeof tgt[prop] === 'number' ? tgt[prop] : 0;
    const def = typeof aRot[prop] === 'number' ? aRot[prop] : 0;
    html += sliderRow(`rot-${prop}`, prop, range[0], range[1], 0.5, v, def);
  }
  html += `<div style="margin-top:10px;border-top:1px solid var(--glass-border);padding-top:10px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <div style="font-size:9px;letter-spacing:.05em;color:var(--text-secondary);">IK CONTROLS</div>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
        <input type="checkbox" id="ik-master-toggle" ${window.ikToggleActive ? 'checked' : ''}>
        <span>Enable IK</span>
      </label>
    </div>
    <select id="ik-limb-select" style="width:100%;padding:4px;background:rgba(0,0,0,0.5);color:white;border:1px solid var(--glass-border);border-radius:4px;margin-bottom:6px;" ${!window.ikToggleActive ? 'disabled' : ''}>
      <option value="">-- Select IK Joint --</option>
      ${IK_LIMBS.map(k => `<option value="${k}" ${ikEnabled[k] ? 'selected' : ''}>${k.replace('_', ' ')}</option>`).join('')}
    </select>
  </div>`;
  html += `<div style="margin-top:10px;border-top:1px solid var(--glass-border);padding-top:10px;">
    <div style="font-size:9px;letter-spacing:.05em;color:var(--text-secondary);margin-bottom:6px;">CAMERA ANGLE PRESETS (Relative to Torso)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
      <button class="btn mannequin-cam-preset" data-preset="front">Front</button>
      <button class="btn mannequin-cam-preset" data-preset="back">Back</button>
      <button class="btn mannequin-cam-preset" data-preset="left">Left</button>
      <button class="btn mannequin-cam-preset" data-preset="right">Right</button>
      <button class="btn mannequin-cam-preset" data-preset="top">Top</button>
      <button class="btn mannequin-cam-preset" data-preset="bottom">Bottom</button>
    </div>
  </div>`;
  
  return html + '</div>';
}

function setupSliderListeners() {
  const cfg = poseConfig[selectedBodyPart];
  const tgt = cfg.target === 'self' ? activeMannequin : activeMannequin[cfg.target];
  function bind(id, read, write) {
    const rng = document.getElementById(`rng-${id}`);
    const num = document.getElementById(`num-${id}`);
    if (!rng || !num) return;
    rng.addEventListener('input', () => {
      const v = parseFloat(rng.value);
      write(v);
      num.value = v.toFixed(2);
    });
    num.addEventListener('input', () => {
      const v = parseFloat(num.value);
      if (isNaN(v)) return;
      write(v);
      rng.value = Math.max(parseFloat(rng.min), Math.min(parseFloat(rng.max), v));
    });
    rng.addEventListener('change', captureState);
    num.addEventListener('change', captureState);
  }
  ['x', 'y', 'z'].forEach(ax => bind(`pos-${ax}`, () => tgt.position[ax], v => tgt.position[ax] = v));
  for (const prop of Object.keys(cfg.props)) bind(`rot-${prop}`, () => tgt[prop] || 0, v => tgt[prop] = v);

  // Per-slider reset buttons
  document.querySelectorAll('.btn-reset-slider').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const def = parseFloat(btn.dataset.def);
      if (id.startsWith('pos-')) {
        const ax = id.replace('pos-', '');
        tgt.position[ax] = def;
      } else if (id.startsWith('rot-')) {
        const prop = id.replace('rot-', '');
        tgt[prop] = def;
      }
      updatePropertiesPanel();
      if (activeMannequin) attachGizmo(activeMannequin);
      captureState();
    });
  });

  // Reset Part button
  const resetPartBtn = document.getElementById('btn-reset-bodypart');
  if (resetPartBtn) {
    resetPartBtn.addEventListener('click', () => {
      const aPos = tgt.userData.anatomicPos || new THREE.Vector3();
      const aRot = tgt.userData.anatomicRot || {};
      ['x', 'y', 'z'].forEach(ax => {
        tgt.position[ax] = aPos[ax];
      });
      for (const prop of Object.keys(cfg.props)) {
        const defVal = typeof aRot[prop] === 'number' ? aRot[prop] : 0;
        tgt[prop] = defVal;
      }
      updatePropertiesPanel();
      if (activeMannequin) attachGizmo(activeMannequin);
      updateMannequinHUD();
      captureState();
    });
  }

  const masterToggle = document.getElementById('ik-master-toggle');
  const limbSelect = document.getElementById('ik-limb-select');
  if (masterToggle) {
    masterToggle.addEventListener('change', e => {
      window.ikToggleActive = e.target.checked;
      if (limbSelect) limbSelect.disabled = !window.ikToggleActive;
      // Disable/enable individual IK limbs based on toggle
      IK_LIMBS.forEach(k => {
        ikEnabled[k] = window.ikToggleActive && limbSelect.value === k;
      });
      if (!window.ikToggleActive) {
        isDraggingIK = false;
        activeIKHandle = null;
      }
      updateStageControlsEnabled();
      updatePropertiesPanel();
    });
  }

  if (limbSelect) {
    limbSelect.addEventListener('change', e => {
      IK_LIMBS.forEach(k => {
        ikEnabled[k] = (e.target.value === k);
      });
      updatePropertiesPanel();
    });
  }

  document.querySelectorAll('.mannequin-cam-preset').forEach(btn => {
    btn.addEventListener('click', e => {
      if (!activeMannequin || !activeMannequin.torso) return;
      const preset = e.target.dataset.preset;
      const torso = activeMannequin.torso;
      
      const distance = 5; // distance from torso
      const offsets = {
        front: new THREE.Vector3(distance, 0, 0),
        back: new THREE.Vector3(-distance, 0, 0),
        left: new THREE.Vector3(0, 0, -distance),
        right: new THREE.Vector3(0, 0, distance),
        top: new THREE.Vector3(0, distance, 0),
        bottom: new THREE.Vector3(0, -distance, 0)
      };

      const offset = offsets[preset].clone();
      
      // Apply torso's world rotation to the offset
      const torsoWorldQuat = new THREE.Quaternion();
      torso.getWorldQuaternion(torsoWorldQuat);
      offset.applyQuaternion(torsoWorldQuat);

      // Get torso's world position
      const torsoWorldPos = new THREE.Vector3();
      torso.getWorldPosition(torsoWorldPos);

      // Set camera position and target
      stage.camera.position.copy(torsoWorldPos).add(offset);
      stage.controls.target.copy(torsoWorldPos);
      
      stage.camera.lookAt(torsoWorldPos);
      stage.controls.update();
      updateHUDValues();
    });
  });
}

function updatePropertiesPanel() {
  frameController?.update();
  const content = document.getElementById('properties-content');
  if (!activeMannequin) {
    content.innerHTML = '<p class="placeholder-text" style="color:var(--text-secondary);">Select a mannequin to edit its pose.</p>';
    return;
  }
  content.innerHTML = `<div style="margin-bottom:10px;">
    <select id="body-part-select" style="width:100%;padding:6px;background:rgba(0,0,0,0.5);color:white;border:1px solid var(--glass-border);border-radius:4px;">
      ${Object.keys(poseConfig).map(k => `<option value="${k}" ${k === selectedBodyPart ? 'selected' : ''}>${k.replace('_', ' ')}</option>`).join('')}
    </select>
  </div>` + renderSliders();
  document.getElementById('body-part-select').addEventListener('change', e => {
    selectedBodyPart = e.target.value;
    const cfg = poseConfig[selectedBodyPart];
    if (cfg && cfg.target !== 'self' && activeMannequin[cfg.target]) {
      setHighlight(activeMannequin[cfg.target]);
    } else {
      clearHighlight();
    }
    updatePropertiesPanel();
  });
  setupSliderListeners();
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      e.preventDefault();
      deleteSelected();
    }
  });
}

// ─── Camera HUD Listeners ─────────────────────────────────────────────────────
function setupHUDListeners() {
  ['x', 'y', 'z'].forEach(a => {
    const rng = document.getElementById(`cam-pos-${a}`);
    const num = document.getElementById(`val-cam-pos-${a}`);
    const inc = document.getElementById(`btn-cam-pos-${a}-inc`);
    const dec = document.getElementById(`btn-cam-pos-${a}-dec`);
    rng.addEventListener('input', () => { stage.camera.position[a] = +rng.value; num.textContent = rng.value; });
    inc.addEventListener('click', () => { stage.camera.position[a] += 1; updateHUDValues(); });
    dec.addEventListener('click', () => { stage.camera.position[a] -= 1; updateHUDValues(); });
  });
  ['x', 'y', 'z'].forEach(a => {
    const rng = document.getElementById(`cam-rot-${a}`);
    const num = document.getElementById(`val-cam-rot-${a}`);
    const inc = document.getElementById(`btn-cam-rot-${a}-inc`);
    const dec = document.getElementById(`btn-cam-rot-${a}-dec`);
    rng.addEventListener('input', () => {
      stage.camera.rotation[a] = THREE.MathUtils.degToRad(+rng.value);
      num.textContent = rng.value + '°';
    });
    inc.addEventListener('click', () => {
      stage.camera.rotation[a] = THREE.MathUtils.degToRad(THREE.MathUtils.radToDeg(stage.camera.rotation[a]) + 0.5);
      updateHUDValues();
    });
    dec.addEventListener('click', () => {
      stage.camera.rotation[a] = THREE.MathUtils.degToRad(THREE.MathUtils.radToDeg(stage.camera.rotation[a]) - 0.5);
      updateHUDValues();
    });
  });
  document.querySelectorAll('.cam-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = { front: [0, 0.7, 7], back: [0, 0.7, -7], left: [-7, 0.7, 0], right: [7, 0.7, 0], top: [0, 10, 0.01] }[btn.dataset.preset];
      if (pos) { stage.camera.position.set(...pos); updateHUDValues(); }
    });
  });
}

// ─── Mouse Interaction ────────────────────────────────────────────────────────
function onMouseDown(event) {
  if (event.target.closest('.glass-panel') || transformControl.dragging || transformControl.axis !== null) return;
  if (event.button !== 0) return;
  const rect = stage.renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, stage.camera);
  
  // Check IK handles first
  const ikHits = raycaster.intersectObjects(Object.values(ikHandles).filter(h => h.visible));
  if (ikHits.length > 0) {
    activeIKHandle = ikHits[0].object;
    isDraggingIK = true;
    updateStageControlsEnabled();
    const limbKey = activeIKHandle.userData.ikLimbKey;
    const chain = IK_CHAINS[limbKey];
    const endJoint = activeMannequin[chain[chain.length - 1]];
    if (endJoint) {
      const endPos = new THREE.Vector3();
      endJoint.getWorldPosition(endPos);
      stage.camera.getWorldDirection(ikDragPlaneNormal);
      ikDragPlane.setFromNormalAndCoplanarPoint(ikDragPlaneNormal, endPos);
    }
    return;
  }
  
  // Check mannequins and imported models
  const allObjects = [...mannequins, ...importedModels];
  const hits = raycaster.intersectObjects(allObjects, true);
  if (hits.length > 0) {
    let hitNode = hits[0].object;
    
    // First, find the root mannequin or imported model
    const root = mannequins.find(m => {
      let n = hitNode;
      while(n) { if (n === m) return true; n = n.parent; }
      return false;
    });
    
    const importedRoot = importedModels.find(m => {
      let n = hitNode;
      while(n) { if (n === m) return true; n = n.parent; }
      return false;
    });

    const targetRoot = root || importedRoot;
    
    if (targetRoot) {
      activeMannequin = targetRoot;
      attachGizmo(activeMannequin);

      let posePartKey = null;
      // Traverse up to find a node that has a posePartKey, or until we hit the root
      let curr = hitNode;
      while (curr) {
        // We found a specific body part mapping
        for (const [key, cfg] of Object.entries(poseConfig)) {
          if (cfg.target !== 'self' && activeMannequin[cfg.target] === curr) {
            posePartKey = key;
            break;
          }
        }
        if (posePartKey) break;
        curr = curr.parent;
      }
      
      if (posePartKey) {
        selectedBodyPart = posePartKey;
        const cfg = poseConfig[selectedBodyPart];
        if (cfg && cfg.target !== 'self' && activeMannequin[cfg.target]) {
          setHighlight(activeMannequin[cfg.target]);
        } else {
          clearHighlight();
        }
      } else {
        selectedBodyPart = 'Root';
        clearHighlight();
      }
      updatePropertiesPanel();
      
      // Ensure the properties panel is visible
      const panel = document.getElementById('properties-panel');
      if (panel) panel.classList.remove('hidden');
    }
  }
}

function onMouseMove(event) {
  if (isDraggingIK && activeIKHandle && activeMannequin) {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, stage.camera);
    const pt = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(ikDragPlane, pt);
    if (hit) {
      activeIKHandle.position.copy(pt);
      solveIKChain(activeMannequin, activeIKHandle.userData.ikLimbKey, pt);
    }
  }
}

function onMouseUp() {
  if (isDraggingIK) {
    isDraggingIK = false;
    activeIKHandle = null;
    updateStageControlsEnabled();
    captureState();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  stage = getStage();
  stage.scene.background = new THREE.Color(0x1a1a1a);
  const cc = document.getElementById('canvas-container');
  if (cc && stage.renderer.domElement.parentNode === document.body) {
    document.body.removeChild(stage.renderer.domElement);
    cc.appendChild(stage.renderer.domElement);
    Object.assign(stage.renderer.domElement.style, { position:'absolute', top:'0', left:'0', width:'100%', height:'100%' });
  }
  createStage(() => { updateHUDValues(); updateMannequinHUD(); tickIKHandles(); syncProxy(); });
  if (stage.ground && stage.ground.material) { stage.ground.material.transparent = true; stage.ground.material.opacity = 0.8; }
  stage.camera.position.set(0, 0.7, 7);
  stage.camera.rotation.set(THREE.MathUtils.degToRad(-4), 0, 0);
  stage.controls.target.set(0, 0.7, 0);
  stage.controls.update();

  const oldRenderer = stage.renderer;
  oldRenderer.setAnimationLoop(null);
  stage.controls.dispose();
  stage.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  stage.renderer.setSize(window.innerWidth, window.innerHeight);
  stage.renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.renderer.shadowMap.enabled = true; stage.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  oldRenderer.domElement.replaceWith(stage.renderer.domElement); oldRenderer.dispose();
  stage.controls = new OrbitControls(stage.camera, stage.renderer.domElement);
  stage.controls.enableDamping = true; stage.controls.target.set(0, 0.7, 0); stage.controls.update();
  window.addEventListener('resize', () => {
    stage.camera.aspect = window.innerWidth / window.innerHeight; stage.camera.updateProjectionMatrix();
    stage.renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const grid = new THREE.GridHelper(100, 100, 0x000000, 0x000000);
  grid.material.transparent = true;
  grid.material.opacity = 0.2;
  stage.scene.add(grid);
  stage.scene.add(new THREE.AxesHelper(10));

  transformProxy = new THREE.Object3D();
  stage.scene.add(transformProxy);
  const lineMat = new THREE.LineDashedMaterial({ color: 0x888888, dashSize: 0.2, gapSize: 0.1 });
  connectionLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat);
  connectionLine.userData.exportHideWhenGizmoDisabled = true;
  connectionLine.visible = false;
  stage.scene.add(connectionLine);

  transformControl = new TransformControls(stage.camera, stage.renderer.domElement);
  transformControl.userData.exportHideWhenGizmoDisabled = true;
  transformControl.traverse(obj => {
    obj.userData.exportHideWhenGizmoDisabled = true;
  });
  transformControl.addEventListener('dragging-changed', e => {
    updateStageControlsEnabled();
    if (!e.value) captureState();
  });
  transformControl.addEventListener('objectChange', () => {
    if (activeMannequin) {
      const isImported = importedModels.includes(activeMannequin);
      if (isImported) {
        activeMannequin.position.copy(transformProxy.position);
      } else {
        // Apply the proxy's translation correctly
        const newPos = transformProxy.position.clone();
        // GIZMO_OFFSET is subtracted so we get back the actual mannequin position
        newPos.sub(GIZMO_OFFSET);
        activeMannequin.position.copy(newPos);
      }
      activeMannequin.rotation.copy(transformProxy.rotation);
      activeMannequin.scale.copy(transformProxy.scale);
    }
  });
  stage.scene.add(transformControl);

  initIKHandles();
  exportController = initExportSystem(stage, THREE, capture => editorBridge.sendCapture(capture));
  setupHUDListeners();
  setupKeyboardShortcuts();

  document.getElementById('btn-focus-center').addEventListener('click', () => {
    stage.camera.position.set(0, 0.7, 7);
    stage.controls.target.set(0, 0.7, 0);
    updateHUDValues();
  });

  const btnTranslate = document.getElementById('btn-gizmo-translate');
  const btnRotate = document.getElementById('btn-gizmo-rotate');
  
  if (btnTranslate && btnRotate) {
    btnTranslate.addEventListener('click', () => {
      transformControl.setMode('translate');
      btnTranslate.style.background = 'rgba(255,255,255,0.15)';
      btnRotate.style.background = 'transparent';
    });
    btnRotate.addEventListener('click', () => {
      transformControl.setMode('rotate');
      btnRotate.style.background = 'rgba(255,255,255,0.15)';
      btnTranslate.style.background = 'transparent';
    });
  }

  const addMannequinBtn = document.getElementById('btn-add-mannequin');
  const addMannequinMenu = document.getElementById('add-mannequin-menu');
  const addMannequinPathBtn = document.getElementById('btn-add-mannequin-path');
  if (addMannequinBtn && addMannequinMenu) {
    addMannequinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addMannequinMenu.classList.toggle('hidden');
    });
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addMannequinMenu.classList.add('hidden');
        addMannequin(btn.dataset.preset);
      });
    });
    if (addMannequinPathBtn) {
      addMannequinPathBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addMannequinMenu.classList.add('hidden');
        addMannequinFromPickedFile();
      });
    }
    window.addEventListener('click', () => {
      addMannequinMenu.classList.add('hidden');
    });
  }

  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-load').addEventListener('change', e => {
    if (e.target.files[0]) loadProject(e.target.files[0]);
    e.target.value = '';
  });

  // GLB Import button
  const importBtn = document.getElementById('btn-import');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.glb,.gltf';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) importGLB(file);
      };
      input.hidden = true; document.body.append(input);
      input.addEventListener('change', () => input.remove(), { once: true });
      input.addEventListener('cancel', () => input.remove(), { once: true });
      input.click();
    });
  }

  // Mouse events
  stage.renderer.domElement.addEventListener('pointerdown', onMouseDown);
  window.addEventListener('pointermove', onMouseMove);
  window.addEventListener('pointerup', onMouseUp);

  // Panel hamburger toggle
  const hamb = document.getElementById('btn-hamburguer');
  const panel = document.getElementById('properties-panel');
  if (hamb && panel) {
    hamb.addEventListener('click', () => panel.classList.toggle('collapsed'));
  }
  
  const layerHamb = document.getElementById('btn-layer-hamburguer');
  const layerPanel = document.getElementById('layer-panel');
  if (layerHamb && layerPanel) {
    layerHamb.addEventListener('click', () => layerPanel.classList.toggle('collapsed'));
  }

  // Create initial mannequin
  addMannequin();
}

function addMannequin(poseName = 'Default') {
    const m = createFullMannequin();
    m.position.set(0, GROUND_Y, 0);
    
    if (poseName && BUILTIN_POSES[poseName]) {
      const p = BUILTIN_POSES[poseName];
      if (p.posture) m.posture = p.posture;
      if (p.joints) {
        for (const [part, data] of Object.entries(p.joints)) {
          if (m[part] && data.rotation) m[part].rotation.fromArray(data.rotation);
        }
      }
    }
    
    mannequins.push(m);
    activeMannequin = m;
    m.updateMatrixWorld(true);
    attachGizmo(m);
    updatePropertiesPanel();
    updateLayerWindow();
    captureState();
  }

init();

function createPoseScratch(selected) {
  const m = new Male(); stage.scene.remove(m);
  if (selected) { const source = jointNodes(selected); for (const [name, node] of Object.entries(jointNodes(m))) { node.position.copy(source[name].position); node.scale.copy(source[name].scale); } }
  return m;
}
function refreshAppliedPose() { activeMannequin.updateMatrixWorld(true); tickIKHandles(); attachGizmo(activeMannequin); updatePropertiesPanel(); }
frameController = initFrameControl({
 getSelected: () => mannequins.includes(activeMannequin) ? activeMannequin : null,
 createScratch: createPoseScratch, onPreview: refreshAppliedPose, onCommit: captureState
});
initBlenderGallery({
  getSelected: () => mannequins.includes(activeMannequin) ? activeMannequin : null,
  createScratch: createPoseScratch,
  preparePose: entry => frameController.prepare(entry),
  onApplied: entry => { activeMannequin.userData.poseFrame = { id: entry.id, frame: entry.frame }; refreshAppliedPose(); captureState(); }
});

const defaultProject = serializeProject();
function animate() {
  stage.controls.update(); stage.animationLoop?.(); stage.renderer.render(stage.scene, stage.camera);
}
editorBridge = initEditorBridge({
  whenIdle,
  snapshot() { frameController.commit(); return { project: serializeProject(), history: [...historyStack], historyIndex }; },
  async restore(snapshot) {
    frameController.commit();
    await restoreProject(snapshot?.project ?? structuredClone(defaultProject));
    historyStack.splice(0, historyStack.length, ...(snapshot?.history ?? []));
    historyIndex = snapshot?.historyIndex ?? -1;
    if (!historyStack.length) captureState(); else updateHistoryButtons();
  },
  suspend(suspended) {
    window.sceneSuspended = suspended;
    stage.renderer.setAnimationLoop(suspended ? null : animate);
    if (suspended) {
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      window.dispatchEvent(new Event('scene-suspend'));
      document.querySelectorAll('video').forEach(video => video.pause());
    } else { window.dispatchEvent(new Event('resize')); animate(); }
  },
});
