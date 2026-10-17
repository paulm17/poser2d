import {RIG,BONE_NAMES} from '../rig/model.js';
import {applyExactPose,captureExactPose} from './exact-state.js';
export function convertBlenderPose(record,reference,scratch){
 if(record.version!==1||record.rig!==RIG||Object.keys(record.bones||{}).length!==BONE_NAMES.length)throw Error('Choose a fitted MakeHuman UAL65 animation.');
 applyExactPose(scratch,{version:1,rig:RIG,joints:record.bones});return captureExactPose(scratch);
}
