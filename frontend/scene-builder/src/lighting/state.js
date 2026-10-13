const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
const base = l => l && typeof l.enabled === 'boolean' && /^#[0-9a-f]{6}$/i.test(l.color) && Number.isFinite(l.intensity) && l.intensity >= 0 && l.intensity <= 1000;
export function defaultLighting() {
  return { version: 1, shadows: { enabled: true }, lights: [
    { id: 'main', type: 'directional', enabled: true, color: '#ffffff', intensity: 2.75,
      position: [0, 30 / Math.sqrt(5), 15 / Math.sqrt(5)], target: [0, 0, 0], castShadow: true, quality: 'high', autoFit: true },
    { id: 'ambient', type: 'ambient', enabled: true, color: '#ffffff', intensity: 0.5 }
  ] };
}
export function isLighting(value) {
  if (!value || value.version !== 1 || typeof value.shadows?.enabled !== 'boolean' || !Array.isArray(value.lights) || value.lights.length !== 2) return false;
  const main = value.lights.find(l => l?.id === 'main'), ambient = value.lights.find(l => l?.id === 'ambient');
  return !!(base(main) && base(ambient) && main.type === 'directional' && ambient.type === 'ambient' &&
    vector(main.position) && vector(main.target) && Math.hypot(...main.position.map((v, i) => v - main.target[i])) > 1e-6 &&
    typeof main.castShadow === 'boolean' && main.autoFit === true && ['low', 'balanced', 'high'].includes(main.quality));
}
export function normalizeLighting(value) {
  if (value === undefined) return defaultLighting();
  if (!isLighting(value)) throw Error('Invalid lighting settings.');
  return structuredClone(value);
}
export function isLightingEditor(value) {
  return !!value && ['main', 'ambient', null].includes(value.selected) && ['light', 'target'].includes(value.mode) && typeof value.helper === 'boolean';
}
export const defaultLightingEditor = () => ({ selected: null, mode: 'light', helper: false });
