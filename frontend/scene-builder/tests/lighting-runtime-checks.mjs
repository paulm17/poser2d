// Development-only integration/visual harness. Runs against the actual host iframe and bridge.
// Serve with Vite and call runLightingRuntimeChecks() from the host page's developer console.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createLight, defaultLighting, LIGHT_TYPES } from '../src/lighting/state.js';
import { lightingPreset } from '../src/lighting/presets.js';
import { renderSceneCapture } from '../src/exportSystem.js';
export async function runLightingRuntimeChecks() {
  const iframe = document.querySelector('iframe'), w = iframe.contentWindow;
  const sessionId = document.querySelector('select[aria-label="Session"]').value;
  const token = new URL(iframe.src).searchParams.get('bridge');
  async function send(type, extra = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(Error(`Timeout: ${type}`)); }, 10000);
      function receive(event) {
        const data = event.data;
        if (event.source !== w || data.token !== token || data.requestId !== requestId) return;
        if (!['ack','error'].includes(data.type)) return;
        clearTimeout(timer); window.removeEventListener('message', receive);
        data.type === 'error' ? reject(Error(data.error)) : resolve(data);
      }
      window.addEventListener('message', receive);
      w.postMessage({ channel:'qwen-stage-v1', token, type, requestId, sessionId, ...extra }, location.origin);
    });
  }
  const original = (await send('snapshot')).snapshot;
  const moduleURL = w.performance.getEntriesByType('resource').find(e => e.name.includes('mannequin-js_src_mannequin')).name;
  const { getStage } = await w.eval(`import(${JSON.stringify(moduleURL)})`);
  const stage = getStage(), cases = [], failures = [], images = [], timings = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  function snap(lighting, extra = {}) {
    return { project: { ...structuredClone(original.project), lighting, lightingEditor: {selected:null,mode:'light',helper:false,frustum:false}, ...extra }, history:[],historyIndex:-1 };
  }
  async function run(name, snapshot, capture = true) {
    await send('restore',{snapshot}); await send('suspend',{suspended:false}); await frame();
    const before=performance.now();for(let i=0;i<20;i++)stage.renderer.render(stage.scene,stage.camera);
    const renderMs=(performance.now()-before)/20;
    const shadowLights=stage.scene.children.filter(l=>l.isLight&&l.visible&&l.castShadow);
    let actualBytes=0;
    for(const light of shadowLights){ const map=light.shadow.map; if(map)actualBytes+=map.width*map.height*8; const pass=light.shadow.mapPass;if(pass)actualBytes+=pass.width*pass.height*8; }
    const samples=[];let last=w.performance.now();for(let i=0;i<12;i++){await frame();const now=w.performance.now();samples.push(now-last);last=now;}
    timings.push({name,frameMs:Number((samples.reduce((a,b)=>a+b,0)/samples.length).toFixed(2)),renderCpuMs:Number(renderMs.toFixed(3)),drawCalls:stage.renderer.info.render.calls,triangles:stage.renderer.info.render.triangles,actualShadowMiB:actualBytes/1048576});
    check(actualBytes<=128*1048576,`${name}: actual shadow budget exceeded`);
    if(capture){let png;renderSceneCapture(stage,THREE,{includeGizmo:false,includeCoords:false,includeBg:true,background:'#404040'},()=>{png=stage.renderer.domElement.toDataURL('image/png');});
      images.push({name,png});}
    cases.push(name);
  }
  try {
    for(const type of LIGHT_TYPES){const state=defaultLighting();const light=createLight(type,'test-light');if(light.shadow)light.castShadow=true;state.lights=[light];await run(`type-${type}`,snap(state));}
    for(const quality of ['low','balanced','high']){const state=lightingPreset('Three-point studio');state.shadows.quality=quality;await run(`studio-${quality}`,snap(state));}
    for(const filter of ['basic','pcf','pcfSoft','vsm']){const state=lightingPreset('Outdoor daylight');state.shadows.filter=filter;await run(`filter-${filter}`,snap(state));}
    const manual=defaultLighting();manual.lights[0].autoFit=false;manual.lights[0].shadow.resolution=1024;await run('manual-fit',snap(manual));
    const off=defaultLighting();off.shadows.enabled=false;await run('shadows-off',snap(off));
    const ground=lightingPreset('Three-point studio');ground.ground.receiveShadow=false;ground.ground.opacity=0.35;await run('ground-no-receive',snap(ground));
    const dense=defaultLighting();let shadows=0;dense.lights=Array.from({length:16},(_,i)=>{const l=createLight(LIGHT_TYPES[i%6],`limit-${i}`);l.intensity=l.type==='ambient'?0.1:1;if(l.shadow){l.shadow.resolution=512;l.castShadow=shadows++<4;}return l;});await run('limit-16-lights',snap(dense));
    const subjects=structuredClone(original.project.mannequins);if(subjects.length){const other=structuredClone(subjects[0]);other.position[0]+=3;subjects.push(other);await run('separated-subjects',snap(lightingPreset('Outdoor daylight'),{mannequins:subjects}));const bent=structuredClone(original.project.mannequins);bent[0].exactPose.joints.torso.quaternion=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),0.4).toArray();await run('pose-bent',snap(lightingPreset('Three-point studio'),{mannequins:bent}));const noCast=structuredClone(original.project.mannequins);noCast[0].shadowSettings={cast:false,receive:false};await run('object-shadows-off',snap(lightingPreset('Outdoor daylight'),{mannequins:noCast}));}
    const box=new THREE.Mesh(new THREE.SphereGeometry(0.5,128,128),new THREE.MeshStandardMaterial({color:0x6699cc}));
    const glb=await new GLTFExporter().parseAsync(box,{binary:true});const bytes=new Uint8Array(glb);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
    const imported={name:'Lighting test GLB',position:[1,0.5,0],rotation:[0,0,0,'XYZ'],scale:[1,1,1],glbBase64:btoa(binary),shadowSettings:{cast:true,receive:true}};
    const glbSnapshot=snap(lightingPreset('Three-point studio'),{importedModels:[imported]});await run('imported-standard-material',glbSnapshot);
    const committed=(await send('snapshot')).snapshot;
    try { await send('restore',{snapshot:snap(defaultLighting(),{importedModels:[{...imported,glbBase64:'AAAA'}]})}); failures.push('Invalid GLB was accepted'); } catch {}
    const recovered=(await send('snapshot')).snapshot.project;
    function equivalent(a,b){if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<1e-6;if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>equivalent(a[k],b[k]));}
    // Mannequin posture getters reorder Euler angles, introducing sub-ulp quaternion drift on snapshots.
    const changed=Object.keys(committed.project).filter(k=>!equivalent(recovered[k],committed.project[k]));
    check(changed.length===0,`Failed GLB restore changed: ${changed.join(', ')} ${changed.includes('camera')?JSON.stringify([committed.project.camera,recovered.camera]):''}`);
    await send('suspend',{suspended:true});check(w.sceneSuspended,'Suspension failed');await send('suspend',{suspended:false});check(!w.sceneSuspended,'Resume failed');
    let transparency;renderSceneCapture(stage,THREE,{includeGizmo:false,includeCoords:false,includeBg:false},()=>{transparency=stage.renderer.domElement.toDataURL('image/png');});images.push({name:'transparent-capture',png:transparency});
    for(let i=0;i<8;i++){const state=defaultLighting();state.lights=[createLight('point','repeat')];state.lights[0].castShadow=true;await run(`resource-cycle-${i}`,snap(state),false);await run(`empty-cycle-${i}`,snap({...state,lights:[]}),false);}
  } finally { await send('restore',{snapshot:original});await send('suspend',{suspended:false}); }
  return {cases,failures,timings,images,renderer:stage.renderer.getContext().getParameter(stage.renderer.getContext().VERSION)};
}
