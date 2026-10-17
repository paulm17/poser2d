import * as THREE from 'three';

export function configureLockedOrbit(controls) {
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = controls.maxPolarAngle = Math.PI / 2;
}

// Projection offsets fit the subject without changing world height or tilt.
export function fitLockedCamera(camera, controls, subject, frame = null, groundY = null) {
  subject.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(subject, true);
  if (box.isEmpty() || !Number.isFinite(box.min.x + box.min.y + box.min.z + box.max.x + box.max.y + box.max.z)) return;
  // Keep the floor under elevated poses inside the fitted view.
  if (Number.isFinite(groundY)) box.min.y = Math.min(box.min.y, groundY);
  const angle = controls.getAzimuthalAngle();
  const center = box.getCenter(new THREE.Vector3());
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const dx = x - center.x, dz = z - center.z;
    corners.push({ x: cos * dx - sin * dz, y: y - 0.7, z: sin * dx + cos * dz });
  }
  const crop = frame ?? { x: 0, y: 0, width: 1, height: 1 };
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  function projected(distance) {
    const xs = corners.map(p => p.x / ((distance - p.z) * tan * camera.aspect));
    const ys = corners.map(p => p.y / ((distance - p.z) * tan));
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  }
  let low = Math.max(0.01, ...corners.map(p => p.z + camera.near * 2));
  let high = low + Math.max(1, box.getSize(new THREE.Vector3()).length());
  const fits = d => {
    const b = projected(d);
    return b.right - b.left <= crop.width * 1.8 && b.top - b.bottom <= crop.height * 1.8;
  };
  while (!fits(high)) high *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (fits(mid)) high = mid; else low = mid;
  }
  const bounds = projected(high);
  controls.target.set(center.x, 0.7, center.z);
  camera.position.set(center.x + sin * high, 0.7, center.z + cos * high);
  camera.up.set(0, 1, 0);
  camera.lookAt(controls.target);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[8] = (bounds.left + bounds.right) / 2 - (2 * crop.x + crop.width - 1);
  camera.projectionMatrix.elements[9] = bounds.bottom - (1 - 2 * (crop.y + crop.height) + crop.height * 0.1);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld(true);
}
