import { installSelectionHighlight } from './selection-highlight.js';
import * as THREE from 'three';

export const RIG = 'makehuman-ual65-v2';
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const BONE_NAMES = ["root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "index_01_l", "index_02_l", "index_03_l", "index_04_leaf_l", "middle_01_l", "middle_02_l", "middle_03_l", "middle_04_leaf_l", "pinky_01_l", "pinky_02_l", "pinky_03_l", "pinky_04_leaf_l", "ring_01_l", "ring_02_l", "ring_03_l", "ring_04_leaf_l", "thumb_01_l", "thumb_02_l", "thumb_03_l", "thumb_04_leaf_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "index_01_r", "index_02_r", "index_03_r", "index_04_leaf_r", "middle_01_r", "middle_02_r", "middle_03_r", "middle_04_leaf_r", "pinky_01_r", "pinky_02_r", "pinky_03_r", "pinky_04_leaf_r", "ring_01_r", "ring_02_r", "ring_03_r", "ring_04_leaf_r", "thumb_01_r", "thumb_02_r", "thumb_03_r", "thumb_04_leaf_r", "thigh_l", "calf_l", "foot_l", "ball_l", "ball_leaf_l", "thigh_r", "calf_r", "foot_r", "ball_r", "ball_leaf_r"];
export function poseConfiguration() {
  const config = { Root: { target: 'self', group: 'Figure', label: 'Root' } };
  const labels = { root:'Animation root', Root:'Skeleton root', pelvis:'Pelvis', spine_01:'Lower spine', spine_02:'Middle spine', spine_03:'Torso', neck_01:'Neck', head:'Head', clavicle:'Clavicle',upperarm:'Arm',lowerarm:'Elbow',hand:'Wrist',thigh:'Leg',calf:'Knee',foot:'Ankle',ball:'Forefoot' };
  for (const name of BONE_NAMES) {
    const side = name.endsWith('_l') ? 'Left' : name.endsWith('_r') ? 'Right' : '';
    const finger = FINGERS.find(f => name.startsWith(f+'_'));
    const key = 'Joint_'+name;
    if(name.includes('leaf'))continue;
    config[key] = { target:name, group:finger ? `${side} hand` : 'Body', label:finger ? `${side} ${finger} · segment ${Number(name.split('_')[1])}` : `${side} ${labels[name] || labels[name.replace(/_[lr]$/,'')] || name}`.trim() };
  }
  for (const cfg of Object.values(config)) {
    const n=cfg.target;
    cfg.props={bend:[-90,90],tilt:[-45,45],turn:[-90,90]};
    if(n==='self')cfg.props={bend:[-90,90],tilt:[-90,90],turn:[-180,180]};
    if(/^(neck_01|Head)$/.test(n))cfg.props={nod:[-90,90],tilt:[-45,45],turn:[-90,90]};
    if(/^upperarm_/.test(n))cfg.props={raise:[-180,180],straddle:[-180,180],turn:[-90,90]};
    if(/^lowerarm_/.test(n))cfg.props={bend:[0,150]};
    if(/^hand_/.test(n))cfg.props={bend:[-90,90],turn:[-90,90],straddle:[-45,45]};
    if(/^thigh_/.test(n))cfg.props={raise:[-90,135],straddle:[-90,90],turn:[-90,90]};
    if(/^calf_/.test(n))cfg.props={bend:[-100,150]};
    if(/^foot_/.test(n))cfg.props={bend:[-45,45],turn:[-45,45]};
    if(/^ball_/.test(n))cfg.props={bend:[-45,45]};
    if(FINGERS.some(f=>n.startsWith(f+'_')))cfg.props=n.includes('_01_')?{bend:[-10,120],straddle:[-30,30],turn:[-45,45]}:{bend:[0,120]};
  }
  const familiar=['Root','Joint_spine_03','Joint_neck_01','Joint_Head',...['l','r'].flatMap(side=>['upperarm','lowerarm','hand','thigh','calf','foot'].map(part=>'Joint_'+part+'_'+side))];
  return Object.fromEntries([...familiar.map(key=>[key,config[key]]),...Object.entries(config).filter(([key])=>!familiar.includes(key))]);
}
export function exposeDegreeRotations(node) {
  for (const axis of ['x','y','z']) Object.defineProperty(node,'rotation'+axis.toUpperCase(), {
    get() { return THREE.MathUtils.radToDeg(this.rotation[axis]); },
    set(value) { this.rotation[axis] = THREE.MathUtils.degToRad(value); }, configurable:true,
  });
  // Keep the original scene-builder's simple property vocabulary on this rig.
  const side=node.name?.endsWith('_r')?-1:1;
  const mapping={bend:['x',1],nod:['x',1],tilt:['z',1],turn:['y',1],raise:['x',-1],straddle:['z',side]};
  if(/^upperarm_/.test(node.name)){mapping.raise=['z',side];mapping.straddle=['x',side];mapping.turn=['y',side];}
  if(/^(lowerarm|calf|hand|foot|ball|thumb|index|middle|ring|pinky)_/.test(node.name))mapping.bend=['x',-1];
  for(const [prop,[axis,sign]]of Object.entries(mapping))Object.defineProperty(node,prop,{
    get(){return THREE.MathUtils.radToDeg(this.rotation[axis])*sign;},
    set(value){this.rotation[axis]=THREE.MathUtils.degToRad(value)*sign;},configurable:true,
  });
}
let modelData, skin;
export async function initializeRig() {
  const response=await fetch(new URL('../../assets/ual-fit/model.json',import.meta.url));
  if(!response.ok)throw Error('Unable to load the fitted UAL mannequin.');
  modelData=await response.json();
  if(modelData.rig!==RIG||modelData.bones.length!==65)throw Error('Invalid fitted UAL skeleton.');
  skin=await new THREE.TextureLoader().loadAsync(new URL('./vendor/textures/skin_dummy.png',import.meta.url).href);
  // Blender and glTF UV origins match. The original MakeHuman texture remains unchanged.
}
export function createRig(options={}) {return createRigFromData(modelData,{...options,texture:skin});}
export function createRigFromData(data,{mesh:includeMesh=true,texture=null}={}) {
  if(!data)throw Error('Mannequin assets are not ready.');
  const group=new THREE.Group();group.name='MakeHuman · UAL skeleton';group.userData.rig=RIG;
  const bones=Object.fromEntries(data.bones.map(d=>{
    const b=new THREE.Bone();b.name=d.name;b.position.fromArray(d.position);b.quaternion.fromArray(d.quaternion);b.scale.fromArray(d.scale);
    b.userData={headPos:d.headPos,tailPos:d.tailPos,parentName:d.parent,restPosition:[...d.position],restQuaternion:[...d.quaternion],restScale:[...d.scale]};
    exposeDegreeRotations(b);return [d.name,b];
  }));
  for(const d of data.bones)(bones[d.parent]||group).add(bones[d.name]);
  if(includeMesh){
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(data.vertices,3));
    geometry.setIndex(new THREE.Uint32BufferAttribute(data.indices,1));geometry.computeVertexNormals();
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(data.skinIndices,4));
    geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(data.skinWeights,4));
    const material=new THREE.MeshPhongMaterial({map:texture?.clone()||null,color:0xffffff,specular:0x111111,shininess:5,side:THREE.DoubleSide});
    material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat rim = 1.0 - abs(vNormal.z);\ngl_FragColor.rgb *= (1.0 - pow(rim, 3.0) * 0.4);');};
    const mesh=new THREE.SkinnedMesh(geometry,material);installSelectionHighlight(mesh);group.add(mesh);
    group.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(data.bones.map(d=>bones[d.name])));
    mesh.castShadow=mesh.receiveShadow=true;mesh.frustumCulled=false;group.mesh=mesh;
  }
  group.bones=bones;Object.assign(group,bones);group.head=bones.Head;group.body=bones.pelvis;group.torso=bones.spine_03;
  exposeDegreeRotations(group);group.updateMatrixWorld(true);group.mesh?.skeleton.update();
  group.userData.restWorld=Object.fromEntries(Object.entries(bones).map(([n,b])=>[n,{position:b.getWorldPosition(new THREE.Vector3()).toArray(),quaternion:b.getWorldQuaternion(new THREE.Quaternion()).toArray()}]));
  return group;
}
export function importGeneratorPose() {
  throw Error('Generator poses use the previous skeleton. Load a MakeHuman UAL65 object or project instead.');
}
