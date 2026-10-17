import * as THREE from 'three';
export function subjectBounds(roots) {
    const bounds = new THREE.Box3();
    for (const root of roots) {
        root.updateWorldMatrix(true, true);
        root.traverseVisible(node => {
            if (!node.isMesh || !node.castShadow)
                return;
            if (node.isSkinnedMesh)
                node.computeBoundingBox();
            const box = new THREE.Box3().setFromObject(node, true);
            if ([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
                bounds.union(box);
        });
    }
    return bounds;
}
export function fitDirectionalShadow(bounds, position, target, groundY = 0, receiveGround = true, groundExtent = Infinity) {
    const box = bounds.clone();
    if (![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
        box.makeEmpty();
    const direction = new THREE.Vector3().fromArray(target).sub(new THREE.Vector3().fromArray(position)).normalize();
    if (!direction.toArray().every(Number.isFinite) || direction.lengthSq() < 0.5)
        throw Error('Invalid light direction.');
    if (box.isEmpty())
        box.set(new THREE.Vector3(-1, groundY, -1), new THREE.Vector3(1, groundY + 2, 1));
    const subjects = box.clone();
    // Receive shadows below and around the subjects without including the huge stage plane.
    const size = box.getSize(new THREE.Vector3());
    const margin = Math.max(1, Math.max(size.x, size.z) * 0.25);
    const addReceiver = point => {
        const half = groundExtent / 2;
        point.x = THREE.MathUtils.clamp(point.x, -half, half);
        point.z = THREE.MathUtils.clamp(point.z, -half, half);
        box.expandByPoint(point);
    };
    if (receiveGround) {
        addReceiver(new THREE.Vector3(subjects.min.x - margin, groundY, subjects.min.z - margin));
        addReceiver(new THREE.Vector3(subjects.max.x + margin, groundY, subjects.max.z + margin));
    }
    // Include the ground intersections of downward shadow rays. A nearly horizontal
    // light has no bounded floor footprint, so retain the local receiver region there.
    if (receiveGround && direction.y < -1e-4) {
        const source = subjects;
        for (const x of [source.min.x, source.max.x])
            for (const y of [source.min.y, source.max.y])
                for (const z of [source.min.z, source.max.z]) {
                    const distance = (groundY - y) / direction.y;
                    if (distance >= 0)
                        addReceiver(new THREE.Vector3(x, y, z).addScaledVector(direction, distance));
                }
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    // Directional illumination is independent of distance. Move only its shadow viewpoint.
    const eye = center.clone().addScaledVector(direction, -(radius + 2));
    const camera = new THREE.OrthographicCamera();
    camera.position.copy(eye);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const viewBox = new THREE.Box3();
    for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z])
                viewBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const padding = Math.max(0.2, radius * 0.05);
    return { eye, target: center, left: viewBox.min.x - padding, right: viewBox.max.x + padding,
        bottom: viewBox.min.y - padding, top: viewBox.max.y + padding,
        near: Math.max(0.01, -viewBox.max.z - padding), far: -viewBox.min.z + padding };
}
// Quantized padded extents and texel-aligned light-space center reduce shimmer.
export function stabilizeDirectionalFit(fit, resolution) {
    const width = 2 ** Math.ceil(Math.log2(Math.max(1, fit.right - fit.left))), height = 2 ** Math.ceil(Math.log2(Math.max(1, fit.top - fit.bottom)));
    const camera = new THREE.OrthographicCamera();
    camera.position.copy(fit.eye);
    camera.lookAt(fit.target);
    camera.updateMatrixWorld(true);
    const center = fit.target.clone().applyMatrix4(camera.matrixWorldInverse);
    const worldOrigin = new THREE.Vector3().applyMatrix4(camera.matrixWorldInverse);
    const dx = Math.round(worldOrigin.x / (width / resolution)) * width / resolution - worldOrigin.x;
    const dy = Math.round(worldOrigin.y / (height / resolution)) * height / resolution - worldOrigin.y;
    // One texel padding protects corners at exact power-of-two boundaries.
    return { ...fit, left: center.x - width / 2 + dx - width / resolution, right: center.x + width / 2 + dx + width / resolution,
        bottom: center.y - height / 2 + dy - height / resolution, top: center.y + height / 2 + dy + height / resolution };
}
export function fitLocalShadow(bounds, position, distance = 0) {
    const eye = new THREE.Vector3().fromArray(position);
    const box = bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 2, 1)) : bounds;
    let far = 1;
    for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z])
                far = Math.max(far, eye.distanceTo(new THREE.Vector3(x, y, z)));
    far = Math.min(1e6, far * 1.15 + 1);
    if (distance > 0)
        far = Math.min(far, distance);
    return { near: Math.max(0.001, Math.min(0.05, far / 1000)), far: Math.max(0.002, far) };
}
