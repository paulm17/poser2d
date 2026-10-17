import { normalizeLighting, shadowResolution } from './state.js';
const classes = { ambient: 'AmbientLight', directional: 'DirectionalLight', hemisphere: 'HemisphereLight', point: 'PointLight', spot: 'SpotLight', area: 'RectAreaLight' };
const tags = { ambient: 'ambientLight', directional: 'directionalLight', hemisphere: 'hemisphereLight', point: 'pointLight', spot: 'spotLight', area: 'rectAreaLight' };
const filters = { basic: 'BasicShadowMap', pcf: 'PCFShadowMap', pcfSoft: 'PCFSoftShadowMap', vsm: 'VSMShadowMap' };
// Adapted from the reference generator's q/colorToHexString and enabled-light code blocks.
const q = n => Number(n.toFixed(6));
const json = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const vec = v => v.map(q).join(', ');
// Keep standalone source literal: Function.toString would capture minified dependency names in production.
const fittingCode = () => `function subjectBounds(roots) {
  const bounds = new THREE.Box3();
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible(node => {
      if (!node.isMesh || !node.castShadow) return;
      if (node.isSkinnedMesh) node.computeBoundingBox();
      const box = new THREE.Box3().setFromObject(node, true);
      if ([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) bounds.union(box);
    });
  }
  return bounds;
}
function fitDirectionalShadow(bounds, position, target, groundY = 0, receiveGround = true) {
  const box = bounds.clone();
  if (![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) box.makeEmpty();
  const direction = new THREE.Vector3().fromArray(target).sub(new THREE.Vector3().fromArray(position)).normalize();
  if (!direction.toArray().every(Number.isFinite) || direction.lengthSq() < 0.5) throw Error('Invalid light direction.');
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, groundY, -1), new THREE.Vector3(1, groundY + 2, 1));
  const subjects = box.clone();
  // Receive shadows below and around the subjects without including the huge stage plane.
  const size = box.getSize(new THREE.Vector3());
  const margin = Math.max(1, Math.max(size.x, size.z) * 0.25);
  if (receiveGround) box.expandByPoint(new THREE.Vector3(box.min.x - margin, groundY, box.min.z - margin));
  if (receiveGround) box.expandByPoint(new THREE.Vector3(box.max.x + margin, groundY, box.max.z + margin));
  // Include the ground intersections of downward shadow rays. A nearly horizontal
  // light has no bounded floor footprint, so retain the local receiver region there.
  if (receiveGround && direction.y < -1e-4) {
    const source = subjects;
    for (const x of [source.min.x, source.max.x]) for (const y of [source.min.y, source.max.y]) for (const z of [source.min.z, source.max.z]) {
      const distance = (groundY - y) / direction.y;
      if (distance >= 0) box.expandByPoint(new THREE.Vector3(x, y, z).addScaledVector(direction, distance));
    }
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // Directional illumination is independent of distance. Move only its shadow viewpoint.
  const eye = center.clone().addScaledVector(direction, -(radius + 2));
  const camera = new THREE.OrthographicCamera();
  camera.position.copy(eye); camera.lookAt(center); camera.updateMatrixWorld(true);
  const viewBox = new THREE.Box3();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
    viewBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
  const padding = Math.max(0.2, radius * 0.05);
  return { eye, target: center, left: viewBox.min.x - padding, right: viewBox.max.x + padding,
    bottom: viewBox.min.y - padding, top: viewBox.max.y + padding,
    near: Math.max(0.01, -viewBox.max.z - padding), far: -viewBox.min.z + padding };
}

// Quantized padded extents and texel-aligned light-space center reduce shimmer.
function stabilizeDirectionalFit(fit, resolution) {
  const width = 2 ** Math.ceil(Math.log2(Math.max(1, fit.right - fit.left))), height = 2 ** Math.ceil(Math.log2(Math.max(1, fit.top - fit.bottom)));
  const camera = new THREE.OrthographicCamera(); camera.position.copy(fit.eye); camera.lookAt(fit.target); camera.updateMatrixWorld(true);
  const center = fit.target.clone().applyMatrix4(camera.matrixWorldInverse);
  const worldOrigin = new THREE.Vector3().applyMatrix4(camera.matrixWorldInverse);
  const dx = Math.round(worldOrigin.x / (width / resolution)) * width / resolution - worldOrigin.x;
  const dy = Math.round(worldOrigin.y / (height / resolution)) * height / resolution - worldOrigin.y;
  // One texel padding protects corners at exact power-of-two boundaries.
  return { ...fit, left: center.x - width / 2 + dx - width / resolution, right: center.x + width / 2 + dx + width / resolution,
    bottom: center.y - height / 2 + dy - height / resolution, top: center.y + height / 2 + dy + height / resolution };
}
function fitLocalShadow(bounds, position, distance = 0) {
  const eye = new THREE.Vector3().fromArray(position);
  const box = bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 2, 1)) : bounds;
  let far = 1;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) far = Math.max(far, eye.distanceTo(new THREE.Vector3(x,y,z)));
  far = Math.min(1e6, far * 1.15 + 1);
  if (distance > 0) far = Math.min(far, distance);
  return { near: Math.max(0.001, Math.min(0.05, far / 1000)), far: Math.max(0.002, far) };
}

function exportedShadowFit(light, data, scene) {
  if (!data.shadow) return;
  const update = light.shadow.updateMatrices;
  const view = new THREE.Object3D(); view.target = new THREE.Object3D();
  light.shadow.updateMatrices = function (source, face) {
    const proxy = data.type === 'directional' && data.autoFit ? view : Object.create(light);
    if (proxy !== view) proxy.distance = 0;
    update.call(this, proxy, face);
  };
  return () => {
    scene.updateMatrixWorld(true);
    if (data.autoFit) {
      const bounds = subjectBounds(scene.children.filter(root => root !== light));
      if (data.type === 'directional') {
        const fit = stabilizeDirectionalFit(fitDirectionalShadow(bounds, data.position, data.target, 0), light.shadow.mapSize.x);
        view.position.copy(fit.eye); view.target.position.copy(fit.target); view.updateMatrixWorld(); view.target.updateMatrixWorld();
        for (const key of ['left', 'right', 'top', 'bottom', 'near', 'far']) light.shadow.camera[key] = fit[key];
      } else Object.assign(light.shadow.camera, fitLocalShadow(bounds, data.position, data.distance));
    }
    light.shadow.camera.updateProjectionMatrix(); light.shadow.needsUpdate = true;
  };
}
`;
export function generateLightingCode(value, format = 'vanilla', helpers = false) {
    const state = normalizeLighting(value), lights = state.lights.filter(l => l.enabled);
    const notes = '// Three.js 0.163.0; R3F must use a compatible Three.js version.\n// Meshes need castShadow/receiveShadow. Area lights require Standard/Physical materials and have no shadow maps.\n// Automatic fitting is included. Three.js exposes updateShadows(); R3F fits on mount. Assumes receiving ground at Y=0.\n';
    if (format === 'r3f') {
        const lines = [notes, "import * as THREE from 'three';", "import { useMemo, useLayoutEffect, useRef } from 'react';", "import { useThree } from '@react-three/fiber';", "import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';", 'RectAreaLightUniformsLib.init();', '// Use <Canvas shadows> and configure gl.shadowMap.type as shown below.', `// gl.shadowMap.enabled = ${state.shadows.enabled}; gl.shadowMap.type = THREE.${filters[state.shadows.filter]};`, fittingCode(), 'export function Lighting() {', '  const { scene, gl } = useThree(); const lights = useRef([]);'];
        for (let i = 0; i < lights.length; i++)
            if (lights[i].target)
                lines.push(`  const target${i} = useMemo(() => { const target = new THREE.Object3D(); target.position.set(${vec(lights[i].target)}); return target; }, []);`);
        lines.push('  useLayoutEffect(() => { const updates = [];', `    gl.shadowMap.enabled = ${state.shadows.enabled}; gl.shadowMap.type = THREE.${filters[state.shadows.filter]};`);
        lights.forEach((l, i) => { if (l.shadow)
            lines.push(`    const update${i} = exportedShadowFit(lights.current[${i}], ${json(l)}, scene); updates.push(update${i});`); });
        lines.push('    updates.forEach(update => update());', '    return () => { lights.current.forEach(light => light?.shadow?.dispose()); };', '  }, [scene, gl]);', '  return <>');
        lights.forEach((l, i) => {
            if (l.target)
                lines.push(`    <primitive object={target${i}} />`);
            const props = [`ref={light => { lights.current[${i}] = light; }}`, `name={${json(l.name)}}`, `color={${json(l.color)}}`, `intensity={${q(l.intensity)}}`];
            if (l.position)
                props.push(`position={[${vec(l.position)}]}`);
            if (l.rotation)
                props.push(`rotation={[${vec(l.rotation)}]}`);
            if (l.target)
                props.push(`target={target${i}}`);
            if (l.groundColor)
                props.push(`groundColor={${json(l.groundColor)}}`);
            for (const k of ['distance', 'decay', 'angle', 'penumbra', 'width', 'height'])
                if (l[k] !== undefined)
                    props.push(`${k}={${q(l[k])}}`);
            if (l.shadow) {
                props.push(`castShadow={${l.castShadow}}`, `shadow-mapSize={[${shadowResolution(l, state)}, ${shadowResolution(l, state)}]}`);
                for (const k of ['bias', 'normalBias', 'radius', 'blurSamples'])
                    props.push(`shadow-${k}={${q(l.shadow[k])}}`);
                for (const k of l.type === 'directional' ? ['near', 'far', 'left', 'right', 'top', 'bottom'] : ['near', 'far'])
                    props.push(`shadow-camera-${k}={${q(l.shadow[k])}}`);
            }
            lines.push(`    <${tags[l.type]} ${props.join(' ')} />`);
        });
        lines.push('  </>;', '}');
        return lines.join('\n');
    }
    const lines = [notes, "import * as THREE from 'three';"];
    if (lights.some(l => l.type === 'area'))
        lines.push("import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';", ...(helpers ? ["import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';"] : []));
    lines.push('export function installLighting(scene, renderer) {', `  renderer.shadowMap.enabled = ${state.shadows.enabled};`, `  renderer.shadowMap.type = THREE.${filters[state.shadows.filter]};`, '  const lights = [], overlays = [], shadowUpdates = [];');
    lines.splice(lines.indexOf('export function installLighting(scene, renderer) {'), 0, fittingCode());
    if (lights.some(l => l.type === 'area'))
        lines.push('  RectAreaLightUniformsLib.init();');
    lights.forEach((l, i) => {
        const n = `light${i}`, args = l.type === 'hemisphere' ? `${json(l.color)}, ${json(l.groundColor)}, ${q(l.intensity)}` : `${json(l.color)}, ${q(l.intensity)}`;
        lines.push(`  const ${n} = new THREE.${classes[l.type]}(${args});`, `  ${n}.name = ${json(l.name)};`);
        if (l.position)
            lines.push(`  ${n}.position.set(${vec(l.position)});`);
        if (l.rotation)
            lines.push(`  ${n}.rotation.set(${vec(l.rotation)});`);
        if (l.target)
            lines.push(`  ${n}.target.position.set(${vec(l.target)});`, `  scene.add(${n}.target);`);
        for (const k of ['distance', 'decay', 'angle', 'penumbra', 'width', 'height'])
            if (l[k] !== undefined)
                lines.push(`  ${n}.${k} = ${q(l[k])};`);
        if (l.shadow) {
            lines.push(`  ${n}.castShadow = ${l.castShadow};`, `  ${n}.shadow.mapSize.set(${shadowResolution(l, state)}, ${shadowResolution(l, state)});`);
            for (const k of ['bias', 'normalBias', 'radius', 'blurSamples'])
                lines.push(`  ${n}.shadow.${k} = ${q(l.shadow[k])};`);
            for (const k of l.type === 'directional' ? ['near', 'far', 'left', 'right', 'top', 'bottom'] : ['near', 'far'])
                lines.push(`  ${n}.shadow.camera.${k} = ${q(l.shadow[k])};`);
            lines.push(`  ${n}.shadow.camera.updateProjectionMatrix();`);
        }
        lines.push(`  scene.add(${n}); lights.push(${n});`);
        if (l.shadow)
            lines.push(`  shadowUpdates.push(exportedShadowFit(${n}, ${json(l)}, scene));`);
        if (helpers && l.type !== 'ambient') {
            const ctor = l.type === 'area' ? 'RectAreaLightHelper' : `THREE.${classes[l.type]}Helper`;
            lines.push(`  const helper${i} = new ${ctor}(${n}${['directional', 'hemisphere', 'point'].includes(l.type) ? ', 0.8' : ''});`, `  scene.add(helper${i}); overlays.push(helper${i});`);
        }
    });
    lines.push('  shadowUpdates.forEach(update => update());');
    lines.push('  return { lights, updateShadows() { shadowUpdates.forEach(update => update()); }, updateHelpers() { overlays.forEach(h => h.update?.()); }, dispose() { overlays.forEach(h => { h.removeFromParent(); h.dispose(); }); lights.forEach(l => { l.shadow?.dispose(); l.target?.removeFromParent(); l.removeFromParent(); }); } };', '}');
    return lines.join('\n');
}
