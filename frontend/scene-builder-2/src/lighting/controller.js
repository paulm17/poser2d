import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { normalizeLighting, shadowResolution } from './state.js';
import { subjectBounds, fitDirectionalShadow, fitLocalShadow, stabilizeDirectionalFit } from './shadows.js';
const filters = { basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, pcfSoft: THREE.PCFSoftShadowMap, vsm: THREE.VSMShadowMap };
const constructors = { ambient: THREE.AmbientLight, directional: THREE.DirectionalLight, hemisphere: THREE.HemisphereLight, point: THREE.PointLight, spot: THREE.SpotLight, area: THREE.RectAreaLight };
export function createLightingController(stage, getSubjects) {
    const main = stage.light, ambient = stage.scene.children.find(child => child.isAmbientLight);
    if (!main || !ambient)
        throw Error('Stage lighting is unavailable.');
    RectAreaLightUniformsLib.init();
    const registry = new Map(), meshStates = new WeakMap();
    let state, dirty = true, previousCount = -1, lastFit = -Infinity;
    function release(light) {
        if (!light)
            return;
        light.shadow?.dispose();
        light.removeFromParent();
        light.target?.removeFromParent();
    }
    function adopt(light, data) {
        if (light.shadow) {
            light.shadow.autoUpdate = false;
            const original = light.shadow.updateMatrices;
            const view = new THREE.Object3D();
            view.target = new THREE.Object3D();
            light.userData.shadowView = view;
            // r163 spot/point updateMatrices overwrites manual far with light.distance.
            // A proxy preserves illumination range while allowing independent shadow frusta.
            light.shadow.updateMatrices = function (source, face) {
                const proxy = data.type === 'directional' && light.userData.autoFit ? view : Object.create(light);
                if (proxy !== view)
                    proxy.distance = 0;
                original.call(this, proxy, face);
            };
        }
        stage.scene.add(light);
        if (light.target)
            stage.scene.add(light.target);
        registry.set(data.id, { light, type: data.type });
        return light;
    }
    function apply(value) {
        const next = normalizeLighting(value);
        // Validate first. Prepare new lights before disposing any current scene resources.
        const prepared = new Map();
        try {
            for (const data of next.lights)
                if (registry.get(data.id)?.type !== data.type)
                    prepared.set(data.id, new constructors[data.type]());
        }
        catch (error) {
            prepared.forEach(release);
            throw error;
        }
        const filterChanged = stage.renderer.shadowMap.type !== filters[next.shadows.filter];
        for (const [id, entry] of registry)
            if (!next.lights.some(l => l.id === id && l.type === entry.type)) {
                release(entry.light);
                registry.delete(id);
            }
        for (const data of next.lights) {
            let light = registry.get(data.id)?.light;
            if (!light) {
                const initial = !state && data.id === 'main' && data.type === 'directional' ? main : !state && data.id === 'ambient' && data.type === 'ambient' ? ambient : prepared.get(data.id);
                if (initial !== prepared.get(data.id))
                    release(prepared.get(data.id));
                light = adopt(initial, data);
            }
            // Parameter application follows threejs-lighting-generator/main.js's six apply*FromParams functions.
            light.name = data.name;
            light.visible = data.enabled;
            light.intensity = data.intensity;
            light.color.set(data.color);
            if (data.position)
                light.position.fromArray(data.position);
            if (data.target)
                light.target.position.fromArray(data.target);
            if (data.groundColor)
                light.groundColor.set(data.groundColor);
            for (const key of ['distance', 'decay', 'angle', 'penumbra', 'width', 'height'])
                if (data[key] !== undefined)
                    light[key] = data[key];
            if (data.rotation)
                light.rotation.set(...data.rotation);
            if (light.shadow) {
                light.castShadow = data.castShadow;
                light.userData.autoFit = data.autoFit;
                const atlasWidth = data.type === 'point' ? 4 : 1;
                const size = Math.min(shadowResolution(data, next), 2 ** Math.floor(Math.log2(stage.renderer.capabilities.maxTextureSize / atlasWidth)));
                if (filterChanged || light.shadow.mapSize.x !== size || !data.enabled || !data.castShadow || !next.shadows.enabled) {
                    light.shadow.dispose();
                    light.shadow.map = null;
                    light.shadow.mapPass = null;
                    light.shadow.mapSize.set(size, size);
                }
                for (const key of ['bias', 'normalBias', 'radius', 'blurSamples'])
                    light.shadow[key] = data.shadow[key];
                for (const key of data.type === 'directional' ? ['near', 'far', 'left', 'right', 'bottom', 'top'] : ['near', 'far'])
                    light.shadow.camera[key] = data.shadow[key];
                light.shadow.camera.updateProjectionMatrix();
            }
        }
        if (!state) {
            if (![...registry.values()].some(e => e.light === main))
                release(main);
            if (![...registry.values()].some(e => e.light === ambient))
                release(ambient);
        }
        stage.renderer.shadowMap.enabled = next.shadows.enabled;
        stage.renderer.shadowMap.type = filters[next.shadows.filter];
        if (stage.ground) {
            if (!stage.ground.material.isMeshStandardMaterial) {
                const old = stage.ground.material;
                stage.ground.material = new THREE.MeshStandardMaterial({ color: old.color, map: old.map, transparent: old.transparent, opacity: old.opacity, side: old.side, depthWrite: old.depthWrite, roughness: 0.92, metalness: 0.05 });
                old.dispose();
            }
            stage.ground.visible = next.ground.visible;
            stage.ground.receiveShadow = next.ground.receiveShadow;
            stage.ground.material.color.set(next.ground.color);
            stage.ground.material.transparent = true;
            stage.ground.material.opacity = next.ground.opacity;
            stage.ground.geometry.computeBoundingSphere();
            stage.ground.scale.setScalar(next.ground.extent / (stage.ground.geometry.boundingSphere.radius * 2));
        }
        if (filterChanged)
            stage.scene.traverse(node => { for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [])
                material.needsUpdate = true; });
        state = next;
        dirty = true;
    }
    function flush(force = false) {
        const roots = getSubjects();
        let count = 0;
        for (const root of roots) {
            root.updateWorldMatrix(true, true);
            root.traverse(node => {
                count++;
                const values = [...node.matrixWorld.elements, node.visible, node.castShadow, node.receiveShadow, ...(node.morphTargetInfluences ?? [])];
                const previous = meshStates.get(node);
                if (!previous || values.length !== previous.length || values.some((v, i) => v !== previous[i])) {
                    meshStates.set(node, values);
                    dirty = true;
                }
            });
        }
        if (count !== previousCount) {
            previousCount = count;
            dirty = true;
        }
        const now = performance.now();
        if (!dirty || (!force && now - lastFit < 100))
            return;
        const bounds = subjectBounds(roots);
        for (const data of state.lights) {
            const light = registry.get(data.id).light;
            if (!light.shadow)
                continue;
            if (data.autoFit && data.type === 'directional') {
                const fit = stabilizeDirectionalFit(fitDirectionalShadow(bounds, data.position, data.target, stage.ground?.position.y ?? 0, !!stage.ground && state.ground.visible && state.ground.receiveShadow && state.ground.opacity > 0, state.ground.extent), light.shadow.mapSize.x);
                const view = light.userData.shadowView;
                view.position.copy(fit.eye);
                view.target.position.copy(fit.target);
                view.updateMatrixWorld();
                view.target.updateMatrixWorld();
                for (const key of ['left', 'right', 'top', 'bottom', 'near', 'far'])
                    light.shadow.camera[key] = fit[key];
            }
            else if (data.autoFit) {
                Object.assign(light.shadow.camera, fitLocalShadow(bounds, data.position, data.distance));
            }
            light.updateWorldMatrix(true, false);
            light.target?.updateWorldMatrix(true, false);
            light.shadow.camera.updateProjectionMatrix();
            light.shadow.updateMatrices(light);
            light.shadow.needsUpdate = true;
        }
        stage.renderer.shadowMap.needsUpdate = true;
        dirty = false;
        lastFit = now;
    }
    apply();
    return { main, ambient, get: id => registry.get(id)?.light, apply, snapshot: () => structuredClone(state), flush,
        invalidate: () => { dirty = true; lastFit = -Infinity; }, dispose: () => { registry.forEach(e => release(e.light)); registry.clear(); } };
}
