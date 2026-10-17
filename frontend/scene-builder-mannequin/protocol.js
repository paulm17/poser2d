import { isExactPose } from './src/poses/exact-state.js';
import { RIG, poseConfiguration } from './src/rig/model.js';
import { isLighting, isLightingEditor, isObjectShadows } from './src/lighting/state.js';
// Shared runtime validation for the React host and the plain JavaScript editor.
export const CHANNEL = 'qwen-stage-v1';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const vector = (value, length = 3) => Array.isArray(value) && value.length >= length && value.slice(0, length).every(Number.isFinite);
const validFrame = value => value === null || value === undefined || (record(value) && id(value.id) && Number.isInteger(value.frame));
const parts=new Set(Object.keys(poseConfiguration()));
const validIK=value=>value===undefined||(record(value)&&record(value.enabled)&&Object.values(value.enabled).every(v=>typeof v==='boolean')&&typeof value.active==='boolean'&&(value.polePosition===undefined||value.polePosition===null||vector(value.polePosition)));
const transform = value => isObjectShadows(value?.shadowSettings) && record(value) && vector(value.position) && vector(value.rotation) && vector(value.scale)&&value.scale.every(v=>v>0)&&(['XYZ','YZX','ZXY','XZY','YXZ','ZYX'].includes(value.rotation[3]??'XYZ'));
export function isProject(value) {
  return record(value) && value.format === 'scene-builder-mannequin' && value.version === 1 && value.rig === RIG && (value.selectedBodyPart===undefined||parts.has(value.selectedBodyPart)) && validIK(value.ik) && (value.lighting === undefined || isLighting(value.lighting)) &&
    (value.lightingEditor === undefined || isLightingEditor(value.lightingEditor)) && Array.isArray(value.mannequins) && value.mannequins.every(item => transform(item) && item.rig === RIG && isExactPose(item.exactPose) && validFrame(item.poseFrame)) &&
    (value.importedModels === undefined || (Array.isArray(value.importedModels) && value.importedModels.every(item => transform(item) && typeof item.glbBase64 === 'string'))) &&
    (value.camera === undefined || (record(value.camera) && vector(value.camera.position) && vector(value.camera.rotation) && (value.camera.target === undefined || vector(value.camera.target))));
}
export function isSnapshot(value) {
  return record(value) && isProject(value.project) &&
    Array.isArray(value.project.importedModels) && Array.isArray(value.history) &&
    value.history.every(item => {try{return typeof item === 'string' && isProject(JSON.parse(item));}catch{return false;}}) && Number.isInteger(value.historyIndex) &&
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
