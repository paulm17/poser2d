import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { configureLockedOrbit, fitLockedCamera } from '../src/camera.js';

test('orbit prevents vertical movement, pan and zoom', () => {
  const controls = {};
  configureLockedOrbit(controls);
  assert.equal(controls.enablePan, false);
  assert.equal(controls.enableZoom, false);
  assert.equal(controls.minPolarAngle, Math.PI / 2);
  assert.equal(controls.maxPolarAngle, Math.PI / 2);
});
for (const aspect of [16 / 9, 9 / 16, 1]) for (const angle of [0, Math.PI / 2, Math.PI, -1]) {
  test(`fixed height and full-body fit: aspect ${aspect}, angle ${angle}`, () => {
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
    const controls = { target: new THREE.Vector3(), getAzimuthalAngle: () => angle };
    const subject = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 0.5));
    subject.position.set(3, 1, -2);
    for (const frame of [null, { x: 0.1, y: 0.15, width: 0.6, height: 0.7 }]) for (const scale of [1, 0.4]) {
      subject.scale.y = scale;
      fitLockedCamera(camera, controls, subject, frame);
      const crop = frame ?? { x: 0, y: 0, width: 1, height: 1 };
      assert.equal(camera.position.y, 0.7);
      assert.equal(controls.target.y, 0.7);
      assert(Math.abs(camera.getWorldDirection(new THREE.Vector3()).y) < 1e-10);
      const box = new THREE.Box3().setFromObject(subject), bottoms = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(camera);
        const px = (p.x + 1) / 2, py = (1 - p.y) / 2;
        assert(px >= crop.x - 1e-6 && px <= crop.x + crop.width + 1e-6);
        assert(py >= crop.y - 1e-6 && py <= crop.y + crop.height + 1e-6);
        bottoms.push(py);
      }
      assert(Math.abs(Math.max(...bottoms) - (crop.y + crop.height * 0.95)) < 1e-6);
    }
  });
}
