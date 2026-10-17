export const LIGHT_TYPES = ['ambient', 'directional', 'hemisphere', 'point', 'spot', 'area'];
export const QUALITY_SIZES = { low: 512, balanced: 1024, high: 2048 };
export const LIMITS = { lights: 16, shadowLights: 4, shadowBytes: 128 * 1024 * 1024 };
const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => finite(n, -1e6, 1e6));
const color = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const id = s => typeof s === 'string' && s.length > 0 && s.length <= 200;
const base = l => l && typeof l.enabled === 'boolean' && color(l.color) && finite(l.intensity, 0, 1000);
export const supportsShadow = type => ['directional', 'point', 'spot'].includes(type);
export const supportsTarget = type => ['directional', 'spot'].includes(type);
export function createLight(type, lightId = globalThis.crypto.randomUUID()) {
    if (!LIGHT_TYPES.includes(type))
        throw Error('Unsupported light type.');
    const light = { id: lightId, name: `${type[0].toUpperCase()}${type.slice(1)} light`, type, enabled: true, color: '#ffffff', intensity: type === 'ambient' ? 0.5 : 2.75 };
    if (type !== 'ambient')
        light.position = [0, 3, 3];
    if (supportsTarget(type))
        light.target = [0, 0, 0];
    if (type === 'hemisphere')
        light.groundColor = '#332211';
    if (['point', 'spot'].includes(type))
        Object.assign(light, { distance: 0, decay: 2, intensity: 30 });
    if (type === 'spot')
        Object.assign(light, { angle: Math.PI / 6, penumbra: 0.35 });
    if (type === 'area')
        Object.assign(light, { width: 3, height: 1.2, rotation: [-Math.PI / 4, 0, 0], intensity: 4 });
    if (supportsShadow(type))
        Object.assign(light, { castShadow: false, autoFit: true, quality: 'balanced', shadow: {
                resolution: 0, bias: -0.0001, normalBias: 0.005, near: 0.05, far: 100, left: -5, right: 5, bottom: -5, top: 5, radius: 1, blurSamples: 8
            } });
    return light;
}
export function defaultLighting() {
    const main = createLight('directional', 'main');
    Object.assign(main, { name: 'Main light', position: [0, 30 / Math.sqrt(5), 15 / Math.sqrt(5)], quality: 'high', castShadow: true });
    main.shadow.resolution = 4096;
    const ambient = createLight('ambient', 'ambient');
    ambient.name = 'Ambient fill';
    return { version: 2, shadows: { enabled: true, quality: 'balanced', filter: 'pcfSoft' },
        ground: { visible: true, receiveShadow: true, color: '#faebd7', opacity: 0.8, extent: 100 }, lights: [main, ambient] };
}
function isV1(value) {
    if (!value || value.version !== 1 || typeof value.shadows?.enabled !== 'boolean' || !Array.isArray(value.lights) || value.lights.length !== 2)
        return false;
    const main = value.lights.find(l => l?.id === 'main'), ambient = value.lights.find(l => l?.id === 'ambient');
    return !!(base(main) && base(ambient) && main.type === 'directional' && ambient.type === 'ambient' && vector(main.position) && vector(main.target) &&
        Math.hypot(...main.position.map((v, i) => v - main.target[i])) > 1e-6 && typeof main.castShadow === 'boolean' && main.autoFit === true && ['low', 'balanced', 'high'].includes(main.quality));
}
export function shadowResolution(light, state) { return light.shadow.resolution || QUALITY_SIZES[state.shadows.quality]; }
export function shadowBudget(state) {
    const lights = state.lights.filter(l => l.enabled && l.castShadow && supportsShadow(l.type));
    // r163 point maps allocate a 4x2 atlas, including two unused faces. Include color+depth and VSM ping-pong buffers.
    const bytes = lights.reduce((sum, l) => sum + shadowResolution(l, state) ** 2 * (l.type === 'point' ? 8 : 1) * (state.shadows.filter === 'vsm' && l.type !== 'point' ? 16 : 8), 0);
    return { count: lights.length, bytes };
}
export function isLighting(value) {
    if (value?.version === 1)
        return isV1(value);
    if (!value || value.version !== 2 || typeof value.shadows?.enabled !== 'boolean' || !Object.hasOwn(QUALITY_SIZES, value.shadows.quality) || !['basic', 'pcf', 'pcfSoft', 'vsm'].includes(value.shadows.filter) ||
        !Array.isArray(value.lights) || value.lights.length > LIMITS.lights)
        return false;
    const g = value.ground;
    if (!g || typeof g.visible !== 'boolean' || typeof g.receiveShadow !== 'boolean' || !color(g.color) || !finite(g.opacity, 0, 1) || !finite(g.extent, 0.1, 1e6))
        return false;
    const ids = new Set();
    for (const l of value.lights) {
        if (!base(l) || !id(l.id) || ids.has(l.id) || !id(l.name) || !LIGHT_TYPES.includes(l.type))
            return false;
        ids.add(l.id);
        if (l.type !== 'ambient' && !vector(l.position))
            return false;
        if (l.type === 'hemisphere' && (!color(l.groundColor) || Math.hypot(...l.position) < 1e-6))
            return false;
        if (supportsTarget(l.type) && (!vector(l.target) || Math.hypot(...l.position.map((v, i) => v - l.target[i])) <= 1e-6))
            return false;
        if (['point', 'spot'].includes(l.type) && (!finite(l.distance, 0, 1e6) || !finite(l.decay, 0, 10)))
            return false;
        if (l.type === 'spot' && (!finite(l.angle, 0.001, Math.PI / 2 - 0.001) || !finite(l.penumbra, 0, 1)))
            return false;
        if (l.type === 'area' && (!vector(l.rotation) || !finite(l.width, 0.001, 1e6) || !finite(l.height, 0.001, 1e6)))
            return false;
        if (supportsShadow(l.type)) {
            const s = l.shadow;
            if (typeof l.castShadow !== 'boolean' || typeof l.autoFit !== 'boolean' || !Object.hasOwn(QUALITY_SIZES, l.quality) || !s ||
                ![0, 256, 512, 1024, 2048, 4096].includes(s.resolution) || !finite(s.bias, -1, 1) || !finite(s.normalBias, 0, 100) ||
                !finite(s.near, 0.001, 1e6) || !finite(s.far, s.near + 0.001, 1e6) || !finite(s.radius, 0, 20) || !Number.isInteger(s.blurSamples) || !finite(s.blurSamples, 1, 32) ||
                !['left', 'right', 'bottom', 'top'].every(k => finite(s[k], -1e6, 1e6)) || s.right <= s.left || s.top <= s.bottom ||
                (!l.autoFit && l.distance > 0 && l.distance <= s.near))
                return false;
        }
        else if (l.castShadow === true)
            return false;
    }
    const budget = shadowBudget(value);
    return budget.count <= LIMITS.shadowLights && budget.bytes <= LIMITS.shadowBytes;
}
export function normalizeLighting(value) {
    if (value === undefined)
        return defaultLighting();
    if (!isLighting(value))
        throw Error('Invalid lighting settings, unsupported version, or lighting budget exceeded (16 lights, 4 shadow lights, 128 MiB).');
    if (value.version === 2)
        return structuredClone(value);
    const state = defaultLighting();
    state.shadows.enabled = value.shadows.enabled;
    state.lights = value.lights.map(l => {
        const light = { ...createLight(l.type, l.id), ...structuredClone(l), name: l.id === 'main' ? 'Main light' : 'Ambient fill' };
        if (supportsShadow(l.type))
            light.shadow.resolution = { low: 1024, balanced: 2048, high: 4096 }[l.quality];
        return light;
    });
    return state;
}
export function isLightingEditor(value) {
    return !!value && (value.selected === null || id(value.selected)) && ['light', 'target', 'rotate'].includes(value.mode) && typeof value.helper === 'boolean' && (value.frustum === undefined || typeof value.frustum === 'boolean');
}
export const defaultLightingEditor = () => ({ selected: null, mode: 'light', helper: false, frustum: false });
export function isObjectShadows(value) { return value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) && ['cast', 'receive'].every(k => value[k] === undefined || typeof value[k] === 'boolean')); }
export function applyObjectShadows(root, flags) {
    if (!isObjectShadows(flags))
        throw Error('Invalid object shadow settings.');
    root.userData.shadowSettings = flags ? structuredClone(flags) : undefined;
    root.traverse(node => { if (node.isMesh) {
        if (flags?.cast !== undefined)
            node.castShadow = flags.cast;
        if (flags?.receive !== undefined)
            node.receiveShadow = flags.receive;
    } });
}
export function lightingJSON(state) { return JSON.stringify({ format: 'scene-lighting', version: 1, lighting: normalizeLighting(state) }, null, 2); }
export function parseLightingJSON(text) {
    const data = JSON.parse(text);
    if (data?.format !== 'scene-lighting' || data.version !== 1)
        throw Error('Unsupported lighting setup format or version.');
    return normalizeLighting(data.lighting ?? null);
}
