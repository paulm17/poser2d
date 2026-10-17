import { setSkinHighlight } from '../../scene-builder-mannequin/src/rig/selection-highlight.js';
import { initFrameControl } from '../../scene-builder-mannequin/src/poses/frame-control.js';
import { initBlenderGallery } from '../../scene-builder-mannequin/src/poses/gallery2.js';
import { captureExactPose, applyExactPose, jointNodes } from '../../scene-builder-mannequin/src/poses/exact-state.js';
import * as THREE from 'three';
import { createStage, getStage } from './stage.js';
import { initializeRig, createRig, poseConfiguration, RIG, importGeneratorPose, exposeDegreeRotations } from '../../scene-builder-mannequin/src/rig/model.js';
import { controlTarget, initializeControlCompatibility } from '../../scene-builder-mannequin/src/rig/control-compatibility.js';
import { CCDIKSolver } from '../../scene-builder-mannequin/src/rig/ik-solvers.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createLightingController } from '../../scene-builder-mannequin/src/lighting/controller.js';
import { createLightingUI } from '../../scene-builder-mannequin/src/lighting/ui.js';
import { normalizeLighting, isLightingEditor, applyObjectShadows, isObjectShadows } from '../../scene-builder-mannequin/src/lighting/state.js';
import { initExportSystem } from '../../scene-builder-mannequin/src/exportSystem.js';
import { initEditorBridge } from '../../scene-builder-mannequin/src/bridge.js';
import { isProject } from '../../scene-builder-mannequin/protocol.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const BUILTIN_POSES = {
  Default: { posture: null, joints: {} }
};
const GROUND_Y = -0.7;
const DEFAULT_FIGURE_HEIGHT = 1.7948851161100043; // scene-builder-2 neutral figure height
const IK_CHAINS = {
  Spine: ['spine_01','spine_02','spine_03','neck_01','Head'],
  Left_Arm: ['clavicle_l','upperarm_l','lowerarm_l','hand_l'], Right_Arm: ['clavicle_r','upperarm_r','lowerarm_r','hand_r'],
  Left_Leg: ['thigh_l','calf_l','foot_l'], Right_Leg: ['thigh_r','calf_r','foot_r'],
  Left_Shoulder: ['clavicle_l','upperarm_l'], Right_Shoulder: ['clavicle_r','upperarm_r'], Pelvis:['pelvis'],
};
const IK_LIMBS = Object.keys(IK_CHAINS);
const HANDLE_COLORS = Object.fromEntries(IK_LIMBS.map((key,i)=>[key,[0xaa66ff,0x4499ff,0x44ccff,0xff8844,0xffcc44,0x66dd88,0x88dd66,0xdd88ff][i]]));
const poseConfig = poseConfiguration();
const ikSolver = new CCDIKSolver(THREE);
let polePosition = null;
// Joint controls use the actual MakeHuman skeleton, including every finger segment.

// ─── State ────────────────────────────────────────────────────────────────────
let lightingController, lightingUI;
let stage, activeMannequin = null, selectedPartGroup = null;
const mannequins = [];
const importedModels = []; // GLB imports (tracked separately)
let transformControl, transformProxy, connectionLine;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const ikEnabled = Object.fromEntries(IK_LIMBS.map(key=>[key,false]));
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
  stage.controls.enabled = !isDraggingIK && !isTransformDragging && !lightingUI?.gizmo.dragging;
}

// ─── History ──────────────────────────────────────────────────────────────────
function serializeObjects() {
  return {
    format: 'scene-builder-mannequin', version: 1, rig: RIG,
    mannequins: mannequins.map(m => {
      return {
        name: m.name,
        shadowSettings: m.userData.shadowSettings,
        position: m.position.toArray(),
        rotation: m.rotation.toArray(),
        scale: m.scale.toArray(),
        rig: RIG,
        exactPose: captureExactPose(m),
        poseFrame: m.userData.poseFrame || null,
      };
    }),
    importedModels: importedModels.map(m => ({
      position: m.position.toArray(),
      rotation: m.rotation.toArray(),
      scale: m.scale.toArray(),
      name: m.userData._glbFileName || m.name,
      glbBase64: m.userData._glbBase64 || null,
      shadowSettings: m.userData.shadowSettings,
    })),
    activeIndex: mannequins.indexOf(activeMannequin),
    activeImportIndex: importedModels.indexOf(activeMannequin),
    selectedBodyPart,
    lighting: lightingController.snapshot(),
    lightingEditor: lightingUI.snapshot(),
    ik: { enabled:{...ikEnabled}, active:!!window.ikToggleActive, polePosition:polePosition?.toArray()??null },
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
  if (!isProject(state)) throw Error('Invalid MakeHuman project. Legacy scene-builder projects are not supported.');
  const nextLighting = normalizeLighting(state.lighting);
  if (state.lightingEditor !== undefined && !isLightingEditor(state.lightingEditor)) throw Error('Invalid lighting editor settings.');
  if (![...(state.mannequins ?? []), ...(state.importedModels ?? [])].every(d => isObjectShadows(d.shadowSettings))) throw Error('Invalid object shadow settings.');
  const nextModels = [];
  const nextMannequins = [];
  try {
    // Prepare all GLBs before changing the visible scene, and preserve their order.
    for (const data of state.importedModels ?? []) nextModels.push(await restoreImportedModel(data));
    for (const d of state.mannequins) {
      const m = createFullMannequin(); stage.scene.remove(m); nextMannequins.push(m);
      m.name = d.name || 'Mannequin';
      m.position.fromArray(d.position); m.rotation.fromArray(d.rotation); m.scale.fromArray(d.scale);
  
      applyExactPose(m, d.exactPose); m.userData.poseFrame = d.poseFrame || null;
      applyObjectShadows(m, d.shadowSettings);
    }
  } catch (error) {
    [...nextModels, ...nextMannequins].forEach(disposeObject); throw error;
  }
  lightingUI.exit(false);
  selectedPartGroup=null;
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
  Object.keys(ikEnabled).forEach(k=>{ikEnabled[k]=state.ik?.enabled?.[k]??false;});window.ikToggleActive=state.ik?.active??false;polePosition=state.ik?.polePosition?new THREE.Vector3().fromArray(state.ik.polePosition):null;
  if(activeMannequin)attachGizmo(activeMannequin);
  lightingController.apply(nextLighting); lightingUI.restore(state.lightingEditor);
  lightingController.flush(true);
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
  const m = createRig(); stage.scene.add(m);
  for (const [key,cfg] of Object.entries(poseConfig)) {
    const node=cfg.target==='self'?m:m[cfg.target];
    node.userData._jointKey=key;node.userData.anatomicPos=node.position.clone();
    node.userData.anatomicRot=Object.fromEntries(Object.keys(cfg.props).map(prop=>[prop,node[prop]]));
  }
  return m;
}
// ─── IK System ────────────────────────────────────────────────────────────────
function initIKHandles() {
  const geom = new THREE.SphereGeometry(0.025, 14, 14);
  IK_LIMBS.forEach(key => {
    const mat = new THREE.MeshPhongMaterial({
      color: HANDLE_COLORS[key], emissive: HANDLE_COLORS[key], emissiveIntensity: 0.3,
      transparent: true, opacity: 0.88,
    });
    const h = new THREE.Mesh(geom, mat.clone());
    h.userData.ikLimbKey = key; h.userData.exportAlwaysHide = true;
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
  const names=IK_CHAINS[limbKey],bones=mannequin.bones;
  if(!bones)return;
  mannequin.updateWorldMatrix(true,true);
  if(limbKey==='Pelvis'){
    const feet=['foot_l','foot_r'].map(name=>bones[name].getWorldPosition(new THREE.Vector3()));
    bones.pelvis.position.copy(bones.pelvis.parent.worldToLocal(target.clone()));mannequin.updateWorldMatrix(true,true);
    solveIKChain(mannequin,'Left_Leg',feet[0]);solveIKChain(mannequin,'Right_Leg',feet[1]);return;
  }
  const definition={bones:names.slice(0,-1),effector:names.at(-1),iterations:30,threshold:0.001};
  let pole=null;
  if(/_(Arm|Leg)$/.test(limbKey)){
    const middle=bones[names.at(-2)];pole=polePosition?.clone()||middle.getWorldPosition(new THREE.Vector3());
    // Straight limbs need a stable direction instead of a collinear pole.
    const root=bones[names.at(-3)].getWorldPosition(new THREE.Vector3()),end=bones[names.at(-1)].getWorldPosition(new THREE.Vector3());
    if(new THREE.Vector3().subVectors(pole,root).cross(end.sub(root)).lengthSq()<1e-8)pole.add(new THREE.Vector3(0,0,0.3).applyQuaternion(mannequin.quaternion));
  }
  ikSolver.solve(definition,bones,target,pole);mannequin.updateWorldMatrix(true,true);
}
function tickIKHandles() {
  if (!mannequins.includes(activeMannequin) || lightingUI?.active) {
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
    lightingUI?.exit(false);
    const isImported = importedModels.includes(mannequin);
    transformProxy.position.copy(mannequin.position);
    if (!isImported) {
      // Put the arrows at the pelvis, rather than the rig's foot-level origin.
      mannequin.updateWorldMatrix(true, true);
      mannequin.pelvis.getWorldPosition(transformProxy.position);
      transformProxy.position.add(GIZMO_OFFSET);
    }
    transformProxy.userData.figureOffset = transformProxy.position.clone().sub(mannequin.position);
    transformProxy.rotation.copy(mannequin.rotation);
    transformProxy.scale.copy(mannequin.scale);
    // Move the complete figure; joint rotation remains in Properties.
    transformControl.enabled = transformControl.mode === 'translate';
    if (transformControl.enabled) transformControl.attach(transformProxy);
    else transformControl.detach();
    connectionLine.visible = transformControl.enabled;
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
  clearHighlight();selectedPartGroup=node;
  setSkinHighlight(activeMannequin,node);
  if(activeMannequin)attachGizmo(activeMannequin);
}
function clearHighlight() {
  mannequins.forEach(model=>setSkinHighlight(model,null));
  selectedPartGroup=null;
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
            shadowSettings: obj.userData.shadowSettings,
          };
        } else {
          exportData = {
            type: 'mannequin',
            shadowSettings: obj.userData.shadowSettings,
            position: obj.position.toArray(),
            rotation: obj.rotation.toArray(),
            scale: obj.scale.toArray(),
            rig: RIG, format:'scene-builder-mannequin-object', version:1,
            exactPose: captureExactPose(obj),
            poseFrame: obj.userData.poseFrame || null,
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
        
        disposeObject(obj);
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
  if (lightingUI?.active) { lightingUI.deleteSelected(); return; }
  if (!activeMannequin) return;
  const importIndex = importedModels.indexOf(activeMannequin);
  if (importIndex !== -1) {
    disposeObject(activeMannequin);
    importedModels.splice(importIndex, 1);
    detachGizmo();
    activeMannequin = null;
    clearHighlight();
    updatePropertiesPanel();
    captureState(); lightingController.invalidate();
    console.log('Deleted imported model');
    return;
  }
  const mannequinIndex = mannequins.indexOf(activeMannequin);
  if (mannequinIndex !== -1) {
    if (mannequins.length <= 1) { console.log('Cannot delete the last mannequin'); return; }
    disposeObject(activeMannequin);
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
    node.skeleton?.dispose();node.geometry?.dispose();
    for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}
async function restoreImportedModel(data) {
  if (!isObjectShadows(data.shadowSettings)) throw Error('Invalid object shadow settings.');
  if (!data.glbBase64) throw Error('Saved model is missing its GLB data.');
  const { scene: model } = await new GLTFLoader().parseAsync(base64ToArrayBuffer(data.glbBase64), '');
  exposeDegreeRotations(model);
  model.name = data.name || 'restored-glb';
  model.position.fromArray(data.position); model.rotation.fromArray(data.rotation); model.scale.fromArray(data.scale);
  model.userData._glbBase64 = data.glbBase64; model.userData._glbFileName = data.name;
  applyObjectShadows(model, data.shadowSettings);
  return model;
}
function importGLB(file) {
  return runEditorTask(async () => {
    const arrayBuffer = await file.arrayBuffer();
    const { scene: model } = await new GLTFLoader().parseAsync(arrayBuffer, '');
    exposeDegreeRotations(model);
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
  if(data.format!=='scene-builder-mannequin-object'||data.version!==1||data.rig!==RIG)throw Error('Choose a MakeHuman UAL65 object. Previous skeletons are incompatible.');
  const candidate={format:'scene-builder-mannequin',version:1,rig:RIG,mannequins:[data],importedModels:[]};
  if(!isProject(candidate))throw Error('Invalid mannequin object.');
  const m=createFullMannequin();
  m.position.fromArray(data.position);m.rotation.fromArray(data.rotation);m.scale.fromArray(data.scale);m.name=data.name||'MakeHuman mannequin';
  applyExactPose(m,data.exactPose);m.userData.poseFrame=data.poseFrame||null;applyObjectShadows(m,data.shadowSettings);
  mannequins.push(m);activeMannequin=m;selectedBodyPart='Root';attachGizmo(m);updatePropertiesPanel();updateLayerWindow();captureState();
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
    ik: { enabled: { ...ikEnabled }, active: !!window.ikToggleActive, polePosition:polePosition?.toArray()??null },
  };
}
async function restoreProject(data) {
  document.getElementById("editor-error").hidden = true;
  if (!isProject(data)) throw Error('Choose a MakeHuman UAL65 project. Previous skeletons are incompatible.');
  await applyState(JSON.stringify(data));
  if (data.camera) {
    stage.camera.position.fromArray(data.camera.position);
    stage.camera.rotation.fromArray([...data.camera.rotation.slice(0, 3), data.camera.rotation[3] ?? 'XYZ']);
    // Old toolkit projects omitted the orbit target: derive it from their camera.
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(stage.camera.quaternion);
    stage.controls.target.fromArray(data.camera.target ?? stage.camera.position.clone().addScaledVector(direction, 7).toArray());
    stage.camera.zoom = data.camera.zoom ?? 1; stage.camera.updateProjectionMatrix();
    stage.camera.updateMatrixWorld(true);
  }
  Object.keys(ikEnabled).forEach(key => { ikEnabled[key] = data.ik?.enabled?.[key] ?? false; }); window.ikToggleActive = data.ik?.active ?? false;
  isDraggingIK = false; activeIKHandle = null;polePosition=data.ik?.polePosition?new THREE.Vector3().fromArray(data.ik.polePosition):null;
  exportController.restore(data.export);
  updateHUDValues();
  updatePropertiesPanel(); updateLayerWindow();
}
function saveProject() {
  const blob = new Blob([JSON.stringify(serializeProject(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'makehuman-scene-project.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function loadProject(file, objectOnly = false) {
  return runEditorTask(async () => {
    const data = JSON.parse(await file.text());
    if (data.bones && !data.format) {
      if(!mannequins.includes(activeMannequin))throw Error('Select a mannequin to import a generator pose.');
      importGeneratorPose(activeMannequin,data);captureState();updatePropertiesPanel();return;
    }
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
  if (!stage?.controls) return;
  for (const axis of ['x', 'y', 'z']) {
    const position = stage.camera.position[axis];
    const rotation = THREE.MathUtils.radToDeg(stage.camera.rotation[axis]);
    document.getElementById(`cam-pos-${axis}`).value = position;
    document.getElementById(`val-cam-pos-${axis}`).textContent = position.toFixed(1);
    document.getElementById(`cam-rot-${axis}`).value = rotation;
    document.getElementById(`val-cam-rot-${axis}`).textContent = rotation.toFixed(1) + '°';
  }
}

// Keep the orbit pivot on the edited viewing direction without changing Euler roll.
function syncCameraTarget() {
  const distance = Math.max(0.01, stage.camera.position.distanceTo(stage.controls.target));
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(stage.camera.quaternion);
  stage.controls.target.copy(stage.camera.position).addScaledVector(direction, distance);
  stage.camera.updateMatrixWorld(true);
  updateHUDValues();
}

function resetCamera() {
  stage.camera.position.set(0, 0.7, 7);
  stage.controls.target.set(0, 0.7, 0);
  stage.camera.lookAt(stage.controls.target);
  updateHUDValues();
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
    <input type="range" aria-label="${label}" id="rng-${id}" min="${min}" max="${max}" step="${step}" value="${value}" style="flex:1;">
    <input type="number" aria-label="${label} degrees or offset" id="num-${id}" class="slider-num" value="${value.toFixed(2)}">
    <button class="btn-reset-slider" data-id="${id}" data-def="${def}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:12px;padding:0 4px;" title="Reset to default">↺</button>
  </div>`;
}

function renderSliders() {
  if (!activeMannequin) return '';
  const cfg = poseConfig[selectedBodyPart];
  const tgt = controlTarget(activeMannequin,cfg);
  if (!tgt) return '<p style="color:var(--text-secondary);">Joint not found.</p>';
  const aRot = tgt.userData.anatomicRot || {};
  let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
  html += `<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">
    <button id="btn-reset-bodypart" class="btn" style="font-size:11px;padding:4px 8px;opacity:0.85;" title="Reset this body part to default">↺ Reset Part</button>
  </div>`;
  html += '<div style="font-size:9px;letter-spacing:.05em;color:var(--text-secondary);margin-top:4px;">JOINT ROTATION</div>';
  for (const [prop, range] of Object.entries(cfg.props)) {
    const v = typeof tgt[prop] === 'number' ? tgt[prop] : 0;
    const def = typeof aRot[prop] === 'number' ? aRot[prop] : 0;
    html += sliderRow(`rot-${prop}`, prop, range[0], range[1], 0.5, v, def);
  }
  if(importedModels.includes(activeMannequin))return html+'</div>';
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
  const tgt = controlTarget(activeMannequin,cfg);
  function bind(id, read, write) {
    const rng = document.getElementById(`rng-${id}`);
    const num = document.getElementById(`num-${id}`);
    if (!rng || !num) return;
    rng.addEventListener('input', () => {
      const v = parseFloat(rng.value);
      if(!Number.isFinite(v))return; write(v); 
      num.value = v.toFixed(2);
    });
    num.addEventListener('input', () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      write(v); 
      rng.value = Math.max(parseFloat(rng.min), Math.min(parseFloat(rng.max), v));
    });
    rng.addEventListener('change', captureState);
    num.addEventListener('change', captureState);
  }
  for (const prop of Object.keys(cfg.props)) bind(`rot-${prop}`, () => tgt[prop] || 0, v => tgt[prop] = v);

  if(cfg.target==='self')for(const ax of ['x','y','z'])bind('scale-'+ax,()=>tgt.scale[ax],v=>{if(v>0)tgt.scale[ax]=v;});
  for(const ax of ['x','y','z'])bind('pole-'+ax,()=>polePosition?.[ax]??0,v=>{const limb=IK_LIMBS.find(k=>ikEnabled[k]);if(!limb)return;polePosition??=new THREE.Vector3();polePosition[ax]=v;solveIKChain(activeMannequin,limb,getChainEnd(activeMannequin,limb));});

  // Per-slider reset buttons
  document.querySelectorAll('.btn-reset-slider').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const def = parseFloat(btn.dataset.def);
      if (id.startsWith('pos-')) {
        const ax = id.replace('pos-', '');
        tgt.position[ax] = def;
      } else if(id.startsWith('scale-')) {tgt.scale[id.slice(-1)]=def;
      } else if(id.startsWith('pole-')) { polePosition??=new THREE.Vector3();polePosition[id.slice(-1)]=def;const limb=IK_LIMBS.find(k=>ikEnabled[k]);if(limb)solveIKChain(activeMannequin,limb,getChainEnd(activeMannequin,limb));
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
      if (tgt.resetPart) {
        tgt.resetPart();
      } else {
        const aPos = tgt.userData.anatomicPos || new THREE.Vector3();
        const aRot = tgt.userData.anatomicRot || {};
        ['x', 'y', 'z'].forEach(ax => { tgt.position[ax] = aPos[ax]; });
        for (const prop of Object.keys(cfg.props)) {
          tgt[prop] = typeof aRot[prop] === 'number' ? aRot[prop] : 0;
        }
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
      if (lightingUI?.active) { e.target.checked = !!window.ikToggleActive; return; }
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
      if (lightingUI?.active) { updatePropertiesPanel(); return; }
      polePosition=null;
      const chain=IK_CHAINS[e.target.value];
      if(chain&&/_(Arm|Leg)$/.test(e.target.value))polePosition=activeMannequin[chain.at(-2)].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0,0,0.3));
      IK_LIMBS.forEach(k => {
        ikEnabled[k] = window.ikToggleActive && (e.target.value === k);
      });
      updatePropertiesPanel();
    });
  }

  document.querySelectorAll('.mannequin-cam-preset').forEach(btn => {
    btn.addEventListener('click', e => {
      if (!activeMannequin || !activeMannequin.torso) return;
      const preset = e.target.dataset.preset;
      const torso = activeMannequin.torso;
      
      const offsets = {
        front: [0, 0, 5], back: [0, 0, -5],
        left: [-5, 0, 0], right: [5, 0, 0],
        top: [0, 5, 0], bottom: [0, -5, 0],
      };
      torso.updateWorldMatrix(true, false);
      const rotation = torso.getWorldQuaternion(new THREE.Quaternion());
      const offset = new THREE.Vector3(...offsets[preset]).applyQuaternion(rotation);
      torso.getWorldPosition(stage.controls.target);
      stage.camera.position.copy(stage.controls.target).add(offset);
      stage.camera.lookAt(stage.controls.target);
      updateHUDValues();
    });
  });
}

function updatePropertiesPanel() {
  if(selectedBodyPart==='Root')clearHighlight();
  frameController?.update();
  const content = document.getElementById('properties-content');
  if (!activeMannequin) {
    content.innerHTML = '<p class="placeholder-text" style="color:var(--text-secondary);">Select a mannequin to edit its pose.</p>';
    return;
  }
  if(importedModels.includes(activeMannequin)){selectedBodyPart='Root';}
  content.innerHTML = `<div style="margin-bottom:10px;">
    <select id="body-part-select" style="width:100%;padding:6px;background:rgba(0,0,0,0.5);color:white;border:1px solid var(--glass-border);border-radius:4px;">
      ${[...new Set(Object.values(poseConfig).map(c=>c.group))].map(group=>`<optgroup label="${group}">${Object.entries(poseConfig).filter(([k,c])=>c.group===group&&(!importedModels.includes(activeMannequin)||k==='Root')).map(([k,c])=>`<option value="${k}" ${k===selectedBodyPart?'selected':''}>${c.label}</option>`).join('')}</optgroup>`).join('')}
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
  const shadowControls = document.createElement('fieldset');
  const legend = document.createElement('legend'); legend.textContent = 'Object shadows'; shadowControls.append(legend);
  for (const [key, label] of [['cast', 'Cast shadows'], ['receive', 'Receive shadows']]) {
    const row = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
    const meshes = []; activeMannequin.traverse(node => { if (node.isMesh) meshes.push(node); });
    const prop = key === 'cast' ? 'castShadow' : 'receiveShadow';
    input.checked = meshes.length > 0 && meshes.every(node => node[prop]);
    input.indeterminate = meshes.some(node => node[prop]) && !input.checked;
    row.append(input, document.createTextNode(label)); shadowControls.append(row);
    input.addEventListener('change', () => {
      applyObjectShadows(activeMannequin, { ...activeMannequin.userData.shadowSettings, [key]: input.checked });
      lightingController.invalidate(); captureState(); updatePropertiesPanel();
    });
  }
  content.append(shadowControls);
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
    }
  });
}

// ─── Camera HUD Listeners ─────────────────────────────────────────────────────
function setupHUDListeners() {
  for (const kind of ['pos', 'rot']) for (const axis of ['x', 'y', 'z']) {
    const slider = document.getElementById(`cam-${kind}-${axis}`);
    const read = () => kind === 'pos' ? stage.camera.position[axis] : THREE.MathUtils.radToDeg(stage.camera.rotation[axis]);
    const write = value => {
      if (kind === 'pos') {
        const delta = value - stage.camera.position[axis];
        stage.camera.position[axis] = value;
        stage.controls.target[axis] += delta;
        stage.camera.updateMatrixWorld(true);
        updateHUDValues();
      } else {
        stage.camera.rotation[axis] = THREE.MathUtils.degToRad(value);
        syncCameraTarget();
      }
    };
    slider.addEventListener('input', () => write(Number(slider.value)));
    for (const [name, sign] of [['inc', 1], ['dec', -1]]) {
      document.getElementById(`btn-cam-${kind}-${axis}-${name}`).addEventListener('click', () => write(read() + sign * (kind === 'pos' ? 1 : 0.5)));
    }
  }
  stage.controls.addEventListener('change', updateHUDValues);
  updateHUDValues();
}

// ─── Mouse Interaction ────────────────────────────────────────────────────────
function onMouseDown(event) {
  if (event.target.closest('.glass-panel') || transformControl.dragging || transformControl.axis !== null || lightingUI.gizmo.dragging || lightingUI.gizmo.axis !== null) return;
  if (event.button !== 0) return;
  const rect = stage.renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, stage.camera);
  
  // Check IK handles first
  const ikHits = lightingUI.active ? [] : raycaster.intersectObjects(Object.values(ikHandles).filter(h => h.visible));
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
  
  for(const mannequin of mannequins){mannequin.updateMatrixWorld(true);mannequin.mesh.computeBoundingSphere();}
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
      if(root&&hits[0].object.isSkinnedMesh&&hits[0].face){
        const mesh=hits[0].object,attrs=mesh.geometry.attributes;let weight=-1,index=0;
        for(const vi of [hits[0].face.a,hits[0].face.b,hits[0].face.c])for(let k=0;k<4;k++){const w=attrs.skinWeight.array[vi*4+k];if(w>weight){weight=w;index=attrs.skinIndex.array[vi*4+k];}}
        posePartKey='Joint_'+mesh.skeleton.bones[index].name;
      }
      // Traverse up to find a node that has a posePartKey, or until we hit the root
      let curr = hitNode;
      while (curr && !posePartKey) {
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

  stage.renderer.outputColorSpace=THREE.SRGBColorSpace;
  stage.renderer.shadowMap.enabled=true;stage.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  stage.controls.enableDamping = false;stage.controls.target.set(0,0.7,0);stage.controls.update();
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
  transformControl.setMode('translate');
  transformControl.userData.exportHideWhenGizmoDisabled = true;
  transformControl.traverse(obj => {
    obj.userData.exportHideWhenGizmoDisabled = true;
  });
  transformControl.addEventListener('dragging-changed', e => {
    updateStageControlsEnabled();
    if (!e.value) {captureState();updatePropertiesPanel();}
  });
  transformControl.addEventListener('objectChange', () => {
    if (!activeMannequin || transformControl.mode !== 'translate') return;
    activeMannequin.position.copy(transformProxy.position);
    activeMannequin.position.sub(transformProxy.userData.figureOffset);
    activeMannequin.updateMatrixWorld(true);
    updateMannequinHUD();
    tickIKHandles();
  });
  stage.scene.add(transformControl);

  lightingController = createLightingController(stage, () => [...mannequins, ...importedModels]);
  lightingUI = createLightingUI(stage, lightingController, {
    enter() { detachGizmo(); clearHighlight(); isDraggingIK = false; activeIKHandle = null; tickIKHandles(); },
    leave() { if (activeMannequin) attachGizmo(activeMannequin); tickIKHandles(); },
    commit: captureState, dragChanged: updateStageControlsEnabled,
    getSelection: () => activeMannequin, getSubjects: () => [...mannequins, ...importedModels],
  });
  initIKHandles();
  exportController = initExportSystem(stage, THREE, capture => editorBridge.sendCapture(capture), () => { lightingController.flush(true); });
  setupHUDListeners();
  setupKeyboardShortcuts();

  document.getElementById('btn-focus-center').addEventListener('click', () => {
    resetCamera();
  });

  const btnTranslate = document.getElementById('btn-gizmo-translate');
  const btnRotate = document.getElementById('btn-gizmo-rotate');
  
  if (btnTranslate && btnRotate) {
    btnTranslate.addEventListener('click', () => {
      transformControl.setMode('translate');if(activeMannequin)attachGizmo(activeMannequin);
      btnTranslate.style.background = 'rgba(255,255,255,0.15)';
      btnRotate.style.background = 'transparent';
    });
    btnRotate.addEventListener('click', () => {
      transformControl.setMode('rotate');if(activeMannequin)attachGizmo(activeMannequin);
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
    // Match the reference editor's initial stature and floor placement once.
    const bounds = new THREE.Box3().setFromObject(m, true);
    m.scale.setScalar(DEFAULT_FIGURE_HEIGHT / (bounds.max.y - bounds.min.y));
    m.position.set(0, GROUND_Y - bounds.min.y * m.scale.y, 0);
    selectedBodyPart='Root';
    
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

async function start(){
await Promise.all([initializeRig(),initializeControlCompatibility()]);
init();

function createPoseScratch(selected) {
  const m = createRig({mesh:false});
  if (selected) { const source = jointNodes(selected); for (const [name, node] of Object.entries(jointNodes(m))) { node.position.copy(source[name].position); node.scale.copy(source[name].scale); } }
  return m;
}
function refreshAppliedPose() { window.ikToggleActive=false;for(const key of IK_LIMBS)ikEnabled[key]=false; activeMannequin.updateMatrixWorld(true); tickIKHandles(); attachGizmo(activeMannequin); updatePropertiesPanel(); }
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
  for(const m of mannequins){m.updateMatrixWorld(true);m.mesh.skeleton.update();} stage.animationLoop?.(); lightingController.flush(); lightingUI.updateOverlays(); stage.renderer.render(stage.scene, stage.camera);
}
editorBridge = initEditorBridge({
  whenIdle,
  snapshot() { frameController.commit(); lightingUI.commitPending(); return { project: serializeProject(), history: [...historyStack], historyIndex }; },
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

// Developer inspection and acceptance-test access to the live editor.
window.mannequinEditor = { three:THREE, renderFrame:animate, get stage(){return stage;}, get mannequins(){return mannequins;}, get selected(){return activeMannequin;}, get selectedPart(){return selectedBodyPart;},  snapshot:()=>({project:serializeProject(),history:[...historyStack],historyIndex}), restore:restoreProject, capture:()=>exportController.capture(), solveIK:solveIKChain, createScratch:createPoseScratch };
window.mannequinReady=true;

}
start().catch(error=>{const el=document.getElementById("editor-error");el.textContent=error.message;el.hidden=false;const token=new URLSearchParams(location.search).get("bridge");if(token)parent.postMessage({channel:"qwen-stage-v1",token,type:"startup-error",error:error.message},location.origin);console.error(error);});
