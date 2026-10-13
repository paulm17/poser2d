import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { defaultLighting, defaultLightingEditor, isLightingEditor } from './state.js';
export function createLightingUI(stage, controller, { enter, leave, commit, dragChanged }) {
  let settings = defaultLightingEditor(), dragStart;
  const gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
  gizmo.setMode('translate');
  const helper = new THREE.DirectionalLightHelper(controller.main, 0.8);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xffcc44, depthTest: false }));
  marker.renderOrder = 1000;
  for (const overlay of [gizmo, helper, marker]) {
    overlay.traverse(node => { node.userData.exportAlwaysHide = true; }); stage.scene.add(overlay);
  }
  const panel = document.createElement('section');
  panel.id = 'lighting-panel'; panel.className = 'glass-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Lighting');
  panel.innerHTML = `<header><strong>Lighting</strong><button class="btn" id="lighting-close" aria-label="Close lighting">×</button></header>
    <label>Light <select id="lighting-select"><option value="main">Main light</option><option value="ambient">Ambient fill</option></select></label>
    <label><input id="lighting-enabled" type="checkbox"> Enabled</label>
    <label>Color <input id="lighting-color" type="color"></label>
    <div id="lighting-intensity"></div><div id="lighting-spatial"></div>
    <p id="lighting-hint">The aim target controls illumination direction. Moving a directional light farther away does not dim it.</p>
    <div id="lighting-moves"><button class="btn" id="lighting-move">Move light</button><button class="btn" id="lighting-target">Move target</button></div>
    <label><input id="lighting-helper" type="checkbox"> Show light helper</label>
    <label><input id="lighting-shadows" type="checkbox"> Global shadows</label>
    <label id="lighting-cast-row"><input id="lighting-cast" type="checkbox"> Main light casts shadows</label>
    <label id="lighting-quality-row">Shadow quality <select id="lighting-quality"><option value="low">Low (1024)</option><option value="balanced">Balanced (2048)</option><option value="high">High (4096)</option></select></label>
    <p id="lighting-error" role="alert"></p><button class="btn" id="lighting-reset">Reset lighting</button>`;
  document.getElementById('app').append(panel);
  const button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Lighting';
  document.querySelector('#ui-overlay .toolbar').append(button);
  button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
  const el = id => panel.querySelector(`#lighting-${id}`);
  function current() { return controller.snapshot().lights.find(l => l.id === (settings.selected ?? 'main')); }
  function edit(update, record = false) {
    const before = controller.snapshot(), next = structuredClone(before);
    update(next, next.lights.find(l => l.id === settings.selected));
    try { controller.apply(next); el('error').textContent = ''; sync(); if (record && JSON.stringify(before) !== JSON.stringify(next)) commit(); }
    catch (error) { controller.apply(before); el('error').textContent = error.message; sync(); }
  }
  const numeric = [], finishEdits = [];
  function numberRow(container, label, key, axis, min, max, step) {
    const row = document.createElement('label'); row.className = 'lighting-number';
    const text = document.createElement('span'); text.textContent = label;
    const range = document.createElement('input'); range.type = 'range'; range.min = min; range.max = max; range.step = step; range.setAttribute('aria-label', label);
    const number = document.createElement('input'); number.type = 'number'; number.step = step; number.setAttribute('aria-label', `${label} numeric`);
    if (key === 'intensity') number.min = 0;
    row.append(text, range, number); container.append(row);
    const apply = input => edit((state, data) => { if (input.value === '') throw Error('Enter a finite number.'); const value = Number(input.value); if (axis === undefined) data[key] = value; else data[key][axis] = value; });
    for (const input of [range, number]) {
      let start = null;
      function finish() {
        if (start !== null && start !== JSON.stringify(controller.snapshot())) commit();
        start = null; sync();
      }
      finishEdits.push(finish);
      input.addEventListener('input', () => {
        start ??= JSON.stringify(controller.snapshot());
        try { apply(input); } catch (error) { el('error').textContent = error.message; }
      });
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { input.blur(); } });
    }
    numeric.push({ key, axis, range, number });
  }
  numberRow(el('intensity'), 'Intensity', 'intensity', undefined, 0, 10, 0.05);
  for (const key of ['position', 'target']) for (let axis = 0; axis < 3; axis++) numberRow(el('spatial'), `${key === 'target' ? 'Aim' : 'Position'} ${'XYZ'[axis]}`, key, axis, -30, 30, 0.1);
  function sync() {
    const data = current();
    el('select').value = data.id; el('enabled').checked = data.enabled; el('color').value = data.color;
    for (const field of numeric) {
      if (field.key !== 'intensity' && data.type !== 'directional') continue;
      const value = field.axis === undefined ? data[field.key] : data[field.key][field.axis];
      field.range.value = value;
      if (document.activeElement !== field.number) field.number.value = Number(value.toFixed(4));
    }
    for (const id of ['spatial', 'hint', 'moves', 'cast-row', 'quality-row']) el(id).hidden = data.type !== 'directional';
    const state = controller.snapshot(), main = state.lights.find(l => l.id === 'main');
    el('shadows').checked = state.shadows.enabled; el('cast').checked = main.castShadow; el('quality').value = main.quality;
    el('helper').checked = settings.helper;
    marker.position.copy(controller.main.target.position); controller.main.updateWorldMatrix(true, false); controller.main.target.updateWorldMatrix(true, false); helper.update();
    helper.visible = settings.helper; marker.visible = settings.helper && settings.selected === 'main';
  }
  function attach() {
    gizmo.detach();
    if (settings.selected === 'main') gizmo.attach(settings.mode === 'target' ? controller.main.target : controller.main);
    sync(); dragChanged();
  }
  function select(id) { settings.selected = id; enter(); attach(); }
  function exit(restore = true) { settings.selected = null; gizmo.detach(); panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (restore) leave(); sync(); dragChanged(); }
  button.addEventListener('click', () => { if (!panel.hidden) exit(); else { panel.hidden = false; button.setAttribute('aria-expanded', 'true'); select(settings.selected ?? 'main'); } });
  el('close').addEventListener('click', () => exit());
  el('select').addEventListener('change', () => select(el('select').value));
  el('move').addEventListener('click', () => { settings.mode = 'light'; attach(); });
  el('target').addEventListener('click', () => { settings.mode = 'target'; attach(); });
  el('helper').addEventListener('change', () => { settings.helper = el('helper').checked; sync(); });
  for (const key of ['enabled', 'color']) el(key).addEventListener('change', () => edit((state, data) => { data[key] = key === 'enabled' ? el(key).checked : el(key).value; }, true));
  el('shadows').addEventListener('change', () => edit(state => { state.shadows.enabled = el('shadows').checked; }, true));
  for (const [id, key] of [['cast', 'castShadow'], ['quality', 'quality']]) el(id).addEventListener('change', () => edit(state => { state.lights.find(l => l.id === 'main')[key] = id === 'cast' ? el(id).checked : el(id).value; }, true));
  el('reset').addEventListener('click', () => { controller.apply(defaultLighting()); sync(); commit(); });
  gizmo.addEventListener('dragging-changed', event => {
    if (event.value) dragStart = JSON.stringify(controller.snapshot());
    else if (dragStart && dragStart !== JSON.stringify(controller.snapshot())) { commit(); dragStart = null; }
    dragChanged();
  });
  gizmo.addEventListener('objectChange', () => edit((state, data) => {
    data.position = controller.main.position.toArray(); data.target = controller.main.target.position.toArray();
  }));
  function commitPending() { finishEdits.forEach(finish => finish()); if (gizmo.dragging) gizmo.pointerUp(null); }
  window.addEventListener('scene-suspend', commitPending);
  sync();
  return { gizmo, get active() { return settings.selected !== null; }, exit, sync, commitPending, snapshot: () => structuredClone(settings),
    restore(value) {
      settings = isLightingEditor(value) ? structuredClone(value) : defaultLightingEditor();
      if (settings.selected) { panel.hidden = false; button.setAttribute('aria-expanded', 'true'); enter(); } else { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); }
      attach();
    }
  };
}
