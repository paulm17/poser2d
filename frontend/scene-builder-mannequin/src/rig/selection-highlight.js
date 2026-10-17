import * as THREE from 'three';

// Editor-only skin tint: the weight attribute follows the same skinned vertices
// as the body, without adding an overlay mesh or changing the saved material.
export function installSelectionHighlight(mesh) {
  const weights=new THREE.BufferAttribute(new Float32Array(mesh.geometry.attributes.position.count),1);
  mesh.geometry.setAttribute('selectionWeight',weights);
  const state={enabled:{value:0},colour:{value:new THREE.Color(0xbc4e4e)},bone:null};
  mesh.selectionHighlight=state;
  const previous=mesh.material.onBeforeCompile;
  mesh.material.onBeforeCompile=shader=>{
    previous.call(mesh.material,shader);
    shader.uniforms.selectionEnabled=state.enabled;
    shader.uniforms.selectionColour=state.colour;
    shader.vertexShader='attribute float selectionWeight;\nvarying float vSelectionWeight;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvSelectionWeight = selectionWeight;');
    shader.fragmentShader='uniform float selectionEnabled;\nuniform vec3 selectionColour;\nvarying float vSelectionWeight;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance += selectionColour * smoothstep(0.0, 1.0, vSelectionWeight) * selectionEnabled;');
  };
  mesh.material.customProgramCacheKey=()=> 'makehuman-selection-v1';
}

export function setSkinHighlight(model,bone) {
  const mesh=model?.mesh,state=mesh?.selectionHighlight;
  if(!state)return;
  const index=mesh.skeleton.bones.indexOf(bone);
  state.enabled.value=index<0?0:1;state.bone=index<0?null:bone.name;
  if(index<0)return;
  const {skinIndex,skinWeight,selectionWeight}=mesh.geometry.attributes;
  for(let i=0;i<selectionWeight.count;i++){
    let weight=0;
    for(let k=0;k<4;k++)if(skinIndex.array[i*4+k]===index)weight+=skinWeight.array[i*4+k];
    selectionWeight.array[i]=weight;
  }
  selectionWeight.needsUpdate=true;
}
