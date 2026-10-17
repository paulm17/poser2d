import {convertBlenderPose} from './blender-retarget.js';
export function libraryPoseFor(selected,record,reference,scratch){return convertBlenderPose(record,reference,scratch);}
