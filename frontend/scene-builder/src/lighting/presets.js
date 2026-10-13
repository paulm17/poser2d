import * as THREE from 'three';
import { createLight, defaultLighting, normalizeLighting } from './state.js';
export const PRESETS = ['Default', 'Three-point studio', 'Soft portrait approximation', 'Dramatic side lighting', 'Rim lighting', 'Outdoor daylight'];
export function lightingPreset(name, previous = defaultLighting()) {
    if (!PRESETS.includes(name))
        throw Error('Unknown lighting preset.');
    const state = defaultLighting();
    state.ground = structuredClone(previous.ground);
    if (name === 'Default')
        return state;
    const light = (type, title, position, intensity, color = '#ffffff', shadows = false) => {
        const data = createLight(type);
        data.name = title;
        data.intensity = intensity;
        data.color = color;
        if (position)
            data.position = position;
        if (data.target)
            data.target = [0, 0.7, 0];
        if (data.castShadow !== undefined)
            data.castShadow = shadows;
        if (type === 'area') {
            const aim = new THREE.Object3D();
            aim.position.fromArray(position);
            aim.lookAt(0, 0.7, 0);
            aim.rotateY(Math.PI);
            data.rotation = aim.rotation.toArray().slice(0, 3);
        }
        return data;
    };
    state.lights = [light('ambient', 'Fill', null, 0.15)];
    if (name === 'Three-point studio' || name === 'Soft portrait approximation') {
        state.lights.push(light('spot', 'Key', [-3, 4, 4], 90, '#fff1df', true), light('area', 'Fill panel', [3, 2, 3], 3, '#dceaff'), light('spot', 'Rim', [1, 3, -3], 70));
        state.lights[1].angle = Math.PI / 4;
        state.lights[1].penumbra = 0.7;
        if (name === 'Soft portrait approximation') {
            state.lights[1].intensity = 60;
            state.lights[2].width = 5;
            state.lights[2].height = 4;
        }
    }
    else if (name === 'Dramatic side lighting') {
        state.lights[0].intensity = 0.05;
        state.lights.push(light('directional', 'Side key', [-4, 2, 1], 3, '#fff1df', true));
    }
    else if (name === 'Rim lighting') {
        state.lights.push(light('spot', 'Back rim', [0, 3, -3], 100, '#dceaff', true));
    }
    else {
        state.lights = [light('hemisphere', 'Sky', [0, 10, 0], 1, '#88c8ff'), light('directional', 'Sun', [-5, 10, 4], 2.75, '#fff1df', true)];
    }
    return normalizeLighting(state);
}
