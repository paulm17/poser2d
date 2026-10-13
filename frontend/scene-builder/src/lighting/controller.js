import * as THREE from 'three';
import { normalizeLighting } from './state.js';
import { subjectBounds, fitDirectionalShadow } from './shadows.js';
export function createLightingController(stage, getSubjects) {
  const main = stage.light, ambient = stage.scene.children.find(child => child.isAmbientLight);
  if (!main || !ambient) throw Error('Stage lighting is unavailable.');
  stage.scene.add(main.target);
  let state, dirty = true, previousCount = -1;
  const meshStates = new WeakMap();
  main.shadow.autoUpdate = false;
  const shadowView = new THREE.Object3D(); shadowView.target = new THREE.Object3D();
  const originalUpdate = main.shadow.updateMatrices;
  main.shadow.updateMatrices = function () { originalUpdate.call(this, shadowView); };
  function apply(value) {
    state = normalizeLighting(value);
    for (const data of state.lights) {
      const light = data.id === 'main' ? main : ambient;
      light.visible = data.enabled; light.color.set(data.color); light.intensity = data.intensity;
    }
    const data = state.lights.find(l => l.id === 'main');
    main.position.fromArray(data.position); main.target.position.fromArray(data.target);
    main.castShadow = data.castShadow;
    stage.renderer.shadowMap.enabled = state.shadows.enabled;
    const size = Math.min({ low: 1024, balanced: 2048, high: 4096 }[data.quality], stage.renderer.capabilities.maxTextureSize);
    if (main.shadow.mapSize.x !== size) {
      main.shadow.dispose(); main.shadow.map = null; main.shadow.mapPass = null; main.shadow.mapSize.set(size, size);
    }
    main.shadow.bias = -0.0001; main.shadow.normalBias = 0.005;
    dirty = true;
  }
  function flush() {
    const roots = getSubjects();
    let count = 0;
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      root.traverse(node => {
        count++;
        const values = [...node.matrixWorld.elements, node.visible, node.castShadow, ...(node.morphTargetInfluences ?? [])];
        const previous = meshStates.get(node);
        if (!previous || values.some((value, i) => value !== previous[i])) {
          meshStates.set(node, values); dirty = true;
        }
      });
    }
    if (count !== previousCount) { previousCount = count; dirty = true; }
    if (!dirty) return;
    const data = state.lights.find(l => l.id === 'main');
    const fit = fitDirectionalShadow(subjectBounds(roots), data.position, data.target, stage.ground?.position.y ?? 0);
    shadowView.position.copy(fit.eye); shadowView.target.position.copy(fit.target);
    shadowView.updateMatrixWorld(); shadowView.target.updateMatrixWorld();
    const camera = main.shadow.camera;
    for (const key of ['left', 'right', 'top', 'bottom', 'near', 'far']) camera[key] = fit[key];
    camera.updateProjectionMatrix(); main.shadow.updateMatrices(main);
    main.shadow.needsUpdate = true; stage.renderer.shadowMap.needsUpdate = true; dirty = false;
  }
  apply();
  return { main, ambient, apply, snapshot: () => structuredClone(state), flush, invalidate: () => { dirty = true; } };
}
