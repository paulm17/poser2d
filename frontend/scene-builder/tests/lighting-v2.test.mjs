import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { defaultLighting, normalizeLighting, isLighting, createLight, LIGHT_TYPES, applyObjectShadows, lightingJSON, parseLightingJSON, shadowBudget } from '../src/lighting/state.js';
import { lightingPreset, PRESETS } from '../src/lighting/presets.js';
import { generateLightingCode } from '../src/lighting/codeExport.js';
import { createLightingController } from '../src/lighting/controller.js';
import { fitLocalShadow, fitDirectionalShadow, stabilizeDirectionalFit } from '../src/lighting/shadows.js';
import { isProject } from '../protocol.js';
const stage = () => {
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight(); scene.add(light,new THREE.AmbientLight());
  const ground = new THREE.Mesh(new THREE.CircleGeometry(50),new THREE.MeshLambertMaterial({ transparent:true,opacity:0.8 })); ground.rotation.x=-Math.PI/2; scene.add(ground);
  return { scene,light,ground,renderer:{shadowMap:{},capabilities:{maxTextureSize:4096}} };
};
test('version 1 migrates arbitrary edits and old quality resolutions; future versions reject',()=>{
  const old={version:1,shadows:{enabled:false},lights:[{id:'main',type:'directional',enabled:true,color:'#112233',intensity:7,position:[8,2,-4],target:[1,0,0],castShadow:true,autoFit:true,quality:'balanced'},{id:'ambient',type:'ambient',enabled:false,color:'#445566',intensity:0.7}]};
  const migrated=normalizeLighting(old); assert.equal(migrated.version,2);assert.deepEqual(migrated.lights[0].position,old.lights[0].position);assert.equal(migrated.lights[0].shadow.resolution,2048);assert.equal(migrated.shadows.enabled,false);
  assert.deepEqual(normalizeLighting(migrated),migrated);assert.throws(()=>normalizeLighting({...migrated,version:3}));
});
test('six light types round trip through shared project validation and lighting-only files',()=>{
  const state=defaultLighting();state.lights=LIGHT_TYPES.map((t,i)=>createLight(t,`id-${i}`));
  assert(isLighting(state));assert(isProject({mannequins:[],lighting:state}));assert.deepEqual(parseLightingJSON(lightingJSON(state)),state);
  assert.throws(()=>parseLightingJSON('{"format":"scene-lighting","version":2}'));
  assert.throws(()=>parseLightingJSON('{"format":"scene-lighting","version":1}'));
  for(const change of [s=>s.lights[1].id=s.lights[0].id,s=>s.lights[2].position=[0,0,0],s=>s.lights[3].decay=-1,s=>s.lights[4].penumbra=2,s=>s.lights[5].width=0,s=>s.ground.opacity=Infinity]){const next=structuredClone(state);change(next);assert(!isLighting(next));}
});
test('budgets count point atlas allocation, reject excess shadows, and allow disabled lights',()=>{
  const state=defaultLighting();state.lights=[createLight('point','p')];state.lights[0].castShadow=true;
  assert.equal(shadowBudget(state).bytes,1024**2*8*8);assert(isLighting(state));
  state.lights[0].shadow.resolution=4096;assert(!isLighting(state));state.lights[0].enabled=false;assert(isLighting(state));
  state.lights=Array.from({length:5},(_,i)=>({...createLight('directional',String(i)),castShadow:true}));assert(!isLighting(state));
});
test('all presets validate, replace lights, retain ground, and can be undone via snapshots',()=>{
  const before=defaultLighting();before.ground.opacity=0.4;
  for(const name of PRESETS){const after=lightingPreset(name,before);assert(isLighting(after));assert.equal(after.ground.opacity,0.4);const history=[JSON.stringify(before),JSON.stringify(after)];assert.deepEqual(normalizeLighting(JSON.parse(history[0])),before);}
});
test('registry applies reference light properties, keeps manual frusta, and disposes removed resources',()=>{
  const s=stage(),root=new THREE.Mesh(new THREE.BoxGeometry(2,3,2));root.castShadow=true;const c=createLightingController(s,()=>[root]);
  const state=defaultLighting();state.lights=LIGHT_TYPES.map((t,i)=>createLight(t,`id${i}`));state.lights[3].distance=10;state.lights[3].autoFit=false;state.lights[3].shadow.far=40;
  state.lights[4].autoFit=false;state.lights[4].distance=12;state.lights[4].shadow.far=35;
  c.apply(state);c.flush(true);
  assert(s.ground.material.isMeshStandardMaterial);assert.equal(c.get('id2').groundColor.getHexString(),'332211');assert.equal(c.get('id5').width,3);
  c.get('id3').shadow.updateMatrices(c.get('id3'),5);assert.equal(c.get('id3').shadow.camera.far,40);
  c.get('id4').shadow.updateMatrices(c.get('id4'));assert.equal(c.get('id4').shadow.camera.far,35);
  let disposed=0;c.get('id3').shadow.map={dispose(){disposed++;}};state.lights.splice(3,1);c.apply(state);assert.equal(disposed,1);assert.equal(c.get('id3'),undefined);
  const before=c.snapshot();const bad=structuredClone(before);bad.lights[0].intensity=Infinity;assert.throws(()=>c.apply(bad));assert.deepEqual(c.snapshot(),before);
  c.dispose();assert(!s.scene.children.some(n=>n.isLight));
});
test('object overrides propagate intentionally and absence preserves original GLB flags',()=>{
  const root=new THREE.Group(),a=new THREE.Mesh(),b=new THREE.Mesh();a.castShadow=true;b.receiveShadow=true;root.add(a,b);
  for(const invalid of [true, [], 'invalid']) assert.throws(()=>applyObjectShadows(root,invalid));
  applyObjectShadows(root);assert(a.castShadow);assert(!b.castShadow);applyObjectShadows(root,{receive:false});assert(a.castShadow);assert(!b.receiveShadow);applyObjectShadows(root,{cast:true,receive:false});assert(b.castShadow);
  assert(!isProject({mannequins:[{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],shadowSettings:{cast:'yes'}}]}));
});
test('local fitting and stabilized directional camera contain distant and scaled subjects',()=>{
  const bounds=new THREE.Box3(new THREE.Vector3(-100,-10,-20),new THREE.Vector3(50,200,80));
  const local=fitLocalShadow(bounds,[0,0,0]);assert(local.far>200&&local.near>0);assert.equal(fitLocalShadow(bounds,[0,0,0],10).far,10);
  const fit=stabilizeDirectionalFit(fitDirectionalShadow(bounds,[0,15,8],[0,0,0]),1024);
  const camera=new THREE.OrthographicCamera(fit.left,fit.right,fit.top,fit.bottom,fit.near,fit.far);camera.position.copy(fit.eye);camera.lookAt(fit.target);camera.updateMatrixWorld(true);
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){const p=new THREE.Vector3(x,y,z).project(camera);assert(Math.abs(p.x)<=1&&Math.abs(p.y)<=1&&Math.abs(p.z)<=1);}
});
test('generated code is deterministic, escapes names, installs all enabled lights and restores targets',async()=>{
  const state=defaultLighting();state.lights=LIGHT_TYPES.map((t,i)=>createLight(t,`id${i}`));state.lights[1].name='"</script> ${danger}\\\n';state.lights[0].enabled=false;
  const code=generateLightingCode(state,'vanilla',true);assert.equal(generateLightingCode(state,'vanilla',true),code);assert(!code.includes('</script>'));
  // Execute standalone code against actual r163 constructors, without the editor/controller.
  const body=code.replace(/^import .*;$/gm,'').replace('export function','function');
  const {RectAreaLightUniformsLib}=await import('three/examples/jsm/lights/RectAreaLightUniformsLib.js');const {RectAreaLightHelper}=await import('three/examples/jsm/helpers/RectAreaLightHelper.js');
  const install=Function('THREE','RectAreaLightUniformsLib','RectAreaLightHelper',`${body}; return installLighting;`)(THREE,RectAreaLightUniformsLib,RectAreaLightHelper);
  const scene=new THREE.Scene(),result=install(scene,{shadowMap:{}});assert.equal(result.lights.length,5);assert.equal(result.lights[0].name,state.lights[1].name);assert.equal(result.lights[0].target.parent,scene);result.dispose();assert.equal(scene.children.length,0);
  const jsx=generateLightingCode(state,'r3f');assert(jsx.includes('target={target0}'));assert(jsx.includes('shadow-camera-near'));assert(jsx.includes('name={'));  // escaped string appears literally, never an interpolation
});

test('R3F output parses as JSX with unusual names and all six light types', async () => {
  const { transform } = await import('esbuild');
  const state = defaultLighting(); state.lights = LIGHT_TYPES.map((t,i) => createLight(t,`jsx${i}`));
  state.lights[0].name = 'Quotes " and <tag> and \u2028';
  const result = await transform(generateLightingCode(state,'r3f'), { loader: 'jsx', jsx: 'automatic' });
  assert.equal(result.warnings.length,0); assert(result.code.includes('Lighting'));
});

test('small receiving ground bounds do not waste the frustum on distant low-angle shadow rays', () => {
  const bounds=new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,3,1));
  const unlimited=fitDirectionalShadow(bounds,[10,1,0],[0,0,0]);
  const limited=fitDirectionalShadow(bounds,[10,1,0],[0,0,0],0,true,4);
  assert(limited.far<unlimited.far);assert(limited.near>0);
});

test('disabled shadows release maps so dormant lights cannot exceed the live allocation budget', () => {
  const s=stage(),c=createLightingController(s,()=>[]);let disposed=0;
  const light=c.get('main');light.shadow.map={dispose(){disposed++;}};
  const state=c.snapshot();state.lights[0].enabled=false;c.apply(state);
  assert.equal(disposed,1);assert.equal(light.shadow.map,null);
  state.lights[0].enabled=true;c.apply(state);light.shadow.map={dispose(){disposed++;}};
  state.shadows.enabled=false;c.apply(state);assert.equal(disposed,2);assert.equal(light.shadow.map,null);
});
