import { renderSceneCapture } from '../src/exportSystem.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { defaultLighting, normalizeLighting, isLighting } from '../src/lighting/state.js';
import { fitDirectionalShadow, subjectBounds } from '../src/lighting/shadows.js';
import { createLightingController } from '../src/lighting/controller.js';
import { isProject, isSnapshot } from '../protocol.js';

test('legacy lighting resets to independent original defaults and round trips', () => {
  const original = defaultLighting();
  assert.deepEqual(normalizeLighting(), original);
  const edited = defaultLighting(); edited.lights[0].position = [-4, 2, 8]; edited.lights[1].intensity = 1.5;
  assert.deepEqual(normalizeLighting(JSON.parse(JSON.stringify(edited))), edited);
  edited.lights[0].target[0] = 10;
  assert.deepEqual(normalizeLighting(), original);
  assert.equal(original.lights[0].intensity, 2.75);
  assert.equal(original.lights[1].intensity, 0.5);
});

test('shared validation rejects invalid lighting before project/session restoration', () => {
  for (const mutate of [s => s.version++, s => s.lights.pop(), s => s.lights[1].id = 'main',
    s => s.lights[0].type = 'spot', s => s.lights[0].position[1] = Infinity,
    s => s.lights[0].target = [...s.lights[0].position], s => s.lights[1].intensity = -1,
    s => s.lights[0].color = 'red', s => s.lights[0].quality = 'ultra', s => s.lights[0].autoFit = false]) {
    const lighting = defaultLighting(); mutate(lighting);
    assert(!isLighting(lighting)); assert.throws(() => normalizeLighting(lighting));
    assert(!isProject({ mannequins: [], lighting }));
    assert(!isSnapshot({ project: { mannequins: [], importedModels: [], lighting }, history: [], historyIndex: -1 }));
  }
  assert(isProject({ mannequins: [] }));
  assert(isSnapshot({ project: { mannequins: [], importedModels: [], lighting: defaultLighting() }, history: [], historyIndex: -1 }));
});

function checkFit(bounds, position, target) {
  const fit = fitDirectionalShadow(bounds, position, target);
  assert(Object.values(fit).filter(v => typeof v === 'number').every(Number.isFinite));
  assert(fit.near > 0 && fit.far > fit.near && fit.right > fit.left && fit.top > fit.bottom);
  const camera = new THREE.OrthographicCamera(fit.left, fit.right, fit.top, fit.bottom, fit.near, fit.far);
  camera.position.copy(fit.eye); camera.lookAt(fit.target); camera.updateMatrixWorld(true);
  if (!bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const point = new THREE.Vector3(x, y, z).project(camera);
    assert(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1, `clipped ${point.toArray()}`);
  }
}
test('directional fitting contains empty, distant, scaled, and separated subjects at arbitrary light positions', () => {
  for (const bounds of [new THREE.Box3(), new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)),
    new THREE.Box3(new THREE.Vector3(-80, -3, -30), new THREE.Vector3(120, 60, 90))])
    for (const [position, target] of [[[0, 15, 8], [0,0,0]], [[0, -5, 0], [0, 10, 0]], [[1, 0, 0], [0,0,0]]]) checkFit(bounds, position, target);
});

test('subject bounds exclude helpers and receivers and update nested pose transforms', () => {
  const root = new THREE.Group(), joint = new THREE.Group(); root.add(joint);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)); mesh.castShadow = true; joint.add(mesh);
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(1000, 1, 1000)); root.add(receiver);
  root.add(new THREE.AxesHelper(100));
  assert.equal(subjectBounds([root]).getSize(new THREE.Vector3()).x, 1);
  joint.position.x = 30; root.scale.setScalar(2);
  const bounds = subjectBounds([root]); assert.equal(bounds.getCenter(new THREE.Vector3()).x, 60);
  assert.equal(bounds.getSize(new THREE.Vector3()).y, 4);
});

test('controller adopts lights, replaces shadow resources, follows pose edits, and resets sessions', () => {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight(), ambient = new THREE.AmbientLight(); scene.add(light, ambient);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)); mesh.castShadow = true; scene.add(mesh);
  const stage = { scene, light, renderer: { shadowMap: {}, capabilities: { maxTextureSize: 2048 } } };
  const controller = createLightingController(stage, () => [mesh]); controller.flush();
  const before = light.shadow.camera.position.clone(); mesh.position.x = 100; controller.flush();
  assert(light.shadow.camera.position.x > before.x + 90);
  let disposed = 0; light.shadow.map = { dispose() { disposed++; } };
  const edited = defaultLighting(); edited.lights[0].quality = 'low'; edited.lights[0].position = [0, -5, 0];
  controller.apply(edited); controller.flush(); assert.equal(disposed, 1); assert.equal(light.shadow.map, null);
  light.shadow.updateMatrices(light);
  assert(light.shadow.camera.position.distanceTo(light.position) > 1, 'renderer uses fitted shadow viewpoint');
  controller.apply(); assert.deepEqual(controller.snapshot(), defaultLighting()); assert.equal(light.shadow.mapSize.x, 2048);
  assert.equal(light.target.parent, scene);
});


test('low-angle shadows contain the receiving ground footprint', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1));
  const fit = fitDirectionalShadow(bounds, [10, 1, 0], [0, 0, 0]);
  const camera = new THREE.OrthographicCamera(fit.left, fit.right, fit.top, fit.bottom, fit.near, fit.far);
  camera.position.copy(fit.eye); camera.lookAt(fit.target); camera.updateMatrixWorld(true);
  const projectedShadow = new THREE.Vector3(-31, 0, 1).project(camera);
  assert(Math.abs(projectedShadow.x) <= 1 && Math.abs(projectedShadow.y) <= 1 && Math.abs(projectedShadow.z) <= 1);
});

test('capture hides lighting overlays even with gizmos included and restores after readback failure', () => {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight(); scene.add(light);
  const helper = new THREE.Object3D(), hiddenMarker = new THREE.Object3D();
  helper.userData.exportAlwaysHide = hiddenMarker.userData.exportAlwaysHide = true;
  hiddenMarker.visible = false; scene.add(helper, hiddenMarker);
  const background = new THREE.Color('blue'); scene.background = background;
  let alpha = 0.7, renders = 0;
  const stage = { scene, camera: {}, renderer: {
    getClearAlpha: () => alpha, setClearAlpha: value => { alpha = value; },
    render() { renders++; if (renders === 1) { assert(!helper.visible); assert(!hiddenMarker.visible); assert(light.visible); assert.equal(alpha, 0); } }
  } };
  assert.throws(() => renderSceneCapture(stage, THREE, { includeGizmo: true, includeCoords: true, includeBg: false }, () => { throw Error('Readback failed'); }), /Readback failed/);
  assert(helper.visible); assert(!hiddenMarker.visible); assert(light.visible);
  assert.equal(scene.background, background); assert.equal(alpha, 0.7); assert.equal(renders, 2);
});

test('shadow fitting skips unchanged scenes and refreshes for nested bone/pose changes', () => {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight(); scene.add(light, new THREE.AmbientLight());
  const root = new THREE.Group(), bone = new THREE.Bone(), mesh = new THREE.Mesh(new THREE.BoxGeometry()); mesh.castShadow = true; root.add(mesh, bone);
  const controller = createLightingController({ scene, light, renderer: { shadowMap: {}, capabilities: { maxTextureSize: 4096 } } }, () => [root]);
  controller.flush(); light.shadow.needsUpdate = false;
  controller.flush(); assert(!light.shadow.needsUpdate);
  bone.rotation.x = 0.1; controller.flush(); assert(light.shadow.needsUpdate);
});
