// Versioned exact joint transforms supplement mannequin-js's rounded posture format.
export function jointNodes(m) {
 const nodes={};
 for(const name of ['body','pelvis','torso','neck','head','l_arm','l_elbow','l_wrist','r_arm','r_elbow','r_wrist','l_leg','l_knee','l_ankle','r_leg','r_knee','r_ankle'])nodes[name]=m[name];
 for(const side of ['l','r'])for(let i=0;i<5;i++){
  const name=`${side}_finger_${i}`;nodes[name]=m[name];nodes[`${name}.mid`]=m[name].mid;nodes[`${name}.tip`]=m[name].tip;
 }
 return nodes;
}
export function captureExactPose(m) {
 return {version:1,joints:Object.fromEntries(Object.entries(jointNodes(m)).map(([name,node])=>[name,{quaternion:node.quaternion.toArray(),position:node.position.toArray(),scale:node.scale.toArray()}]))};
}
export function applyExactPose(m,state) {
 if(!state)return;
 if(state.version!==1)throw Error('Unsupported exact pose version.');
 const nodes=jointNodes(m);
 for(const [name,value] of Object.entries(state.joints)){
  if(!nodes[name])throw Error(`Unknown pose joint: ${name}`);
  for(const [key,length] of [['quaternion',4],['position',3],['scale',3]])if(!Array.isArray(value[key])||value[key].length!==length||!value[key].every(Number.isFinite))throw Error(`Invalid ${key} for ${name}`);
 }
 for(const [name,value] of Object.entries(state.joints)){nodes[name].quaternion.fromArray(value.quaternion);nodes[name].position.fromArray(value.position);nodes[name].scale.fromArray(value.scale);}
 m.updateWorldMatrix(true,true);
}
