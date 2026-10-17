import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
let stage;
export function getStage(){
 if(stage)return stage;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30,innerWidth/innerHeight,0.01,2000);
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setSize(innerWidth,innerHeight);
 document.body.append(renderer.domElement);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshPhongMaterial({color:0xc8bda9}));ground.position.y=-0.7;ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
 const light=new THREE.DirectionalLight();scene.add(light,new THREE.AmbientLight());
 const controls=new OrbitControls(camera,renderer.domElement);
 stage={scene,camera,renderer,ground,light,controls,animationLoop:null};return stage;
}
export function createStage(loop){getStage().animationLoop=loop;}
