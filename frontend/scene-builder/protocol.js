// Shared runtime validation for the React host and the plain JavaScript editor.
export const CHANNEL = 'qwen-stage-v1';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const vector = (value, length = 3) => Array.isArray(value) && value.length >= length && value.slice(0, length).every(Number.isFinite);
const transform = value => record(value) && vector(value.position) && vector(value.rotation) && vector(value.scale);
export function isProject(value) {
  return record(value) && Array.isArray(value.mannequins) && value.mannequins.every(transform) &&
    (value.importedModels === undefined || (Array.isArray(value.importedModels) && value.importedModels.every(item => transform(item) && typeof item.glbBase64 === 'string'))) &&
    (value.camera === undefined || (record(value.camera) && vector(value.camera.position) && vector(value.camera.rotation) && (value.camera.target === undefined || vector(value.camera.target))));
}
export function isSnapshot(value) {
  return record(value) && isProject(value.project) &&
    Array.isArray(value.project.importedModels) && Array.isArray(value.history) &&
    value.history.every(item => typeof item === 'string') && Number.isInteger(value.historyIndex) &&
    value.historyIndex >= -1 && value.historyIndex < value.history.length;
}
export function isMessage(value, token) {
  if (!record(value) || value.channel !== CHANNEL || value.token !== token) return false;
  switch (value.type) {
    case 'connect': case 'ready': return true;
    case 'startup-error': return typeof value.error === 'string';
    case 'busy': return typeof value.busy === 'boolean';
    case 'snapshot': return id(value.requestId) && id(value.sessionId);
    case 'restore': return id(value.requestId) && id(value.sessionId) && (value.snapshot === null || isSnapshot(value.snapshot));
    case 'suspend': return id(value.requestId) && id(value.sessionId) && typeof value.suspended === 'boolean';
    case 'ack': return id(value.requestId) && id(value.sessionId) && (value.snapshot === undefined || isSnapshot(value.snapshot));
    case 'error': return id(value.requestId) && id(value.sessionId) && typeof value.error === 'string';
    case 'capture': return id(value.requestId) && id(value.sessionId) && value.blob instanceof Blob && value.blob.type === 'image/png' && value.blob.size > 0;
    case 'capture-result': return id(value.requestId) && id(value.sessionId) && (value.error === undefined || typeof value.error === 'string');
    default: return false;
  }
}
export function targetOrigin(origin) { return origin === 'null' ? '*' : origin; }
