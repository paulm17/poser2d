// Adapted unchanged solver algorithms from VNCCS Pose Studio; see vendor/LICENSE.
export function clampTwoBoneReachDistance(targetDistance, totalLength) {
    const target = Math.max(0, Number(targetDistance) || 0);
    const total = Math.max(0, Number(totalLength) || 0);
    return Math.min(target, total);
}

export class AnalyticIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
    }

    // Solve 2-bone chain analytically (100% accurate)
    solve2Bone(rootBone, midBone, effectorBone, targetPos, poleTarget, THREE) {
        // Get bone lengths from actual bone positions
        const rootPos = new THREE.Vector3();
        const midPos = new THREE.Vector3();
        const effPos = new THREE.Vector3();

        rootBone.getWorldPosition(rootPos);
        midBone.getWorldPosition(midPos);
        effectorBone.getWorldPosition(effPos);

        const upperLen = rootPos.distanceTo(midPos);
        const lowerLen = midPos.distanceTo(effPos);

        // Distance from root to target
        const targetDist = rootPos.distanceTo(targetPos);

        // Clamp to reachable range
        const totalLen = upperLen + lowerLen;
        const reachDist = clampTwoBoneReachDistance(targetDist, totalLen);

        // Law of cosines to find the bend angle at the middle joint
        // cos(A) = (a² + b² - c²) / (2ab)
        let bendAngle = 0;
        if (reachDist > 0.001 && upperLen > 0.001 && lowerLen > 0.001) {
            const cosAngle = (upperLen * upperLen + lowerLen * lowerLen - reachDist * reachDist) / (2 * upperLen * lowerLen);
            bendAngle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
        }

        // Direction from root to target
        const dirToTarget = new THREE.Vector3().subVectors(targetPos, rootPos).normalize();

        // Calculate bend direction (perpendicular to dirToTarget, towards pole)
        // Use the parent's world orientation (usually Hips) to derive a stable "local-forward" fallback.
        // This prevents the knee from snapping to world-front when the character is rotated.
        const refBone = rootBone.parent || rootBone;
        const refQuat = new THREE.Quaternion();
        refBone.getWorldQuaternion(refQuat);
        let bendDir = new THREE.Vector3(0, 0, 1).applyQuaternion(refQuat);

        if (poleTarget) {
            // Project pole position onto plane perpendicular to dirToTarget
            const toPole = new THREE.Vector3().subVectors(poleTarget, rootPos);
            const poleProj = toPole.clone().sub(dirToTarget.clone().multiplyScalar(toPole.dot(dirToTarget)));
            if (poleProj.lengthSq() > 0.001) {
                bendDir = poleProj.normalize();
            }
        } else {
            // Default: bend forward (for knees) or backward (for elbows)
            // Use a hint based on the current mid bone position
            const toMid = new THREE.Vector3().subVectors(midPos, rootPos);
            const midProj = toMid.clone().sub(dirToTarget.clone().multiplyScalar(toMid.dot(dirToTarget)));
            if (midProj.lengthSq() > 0.001) {
                bendDir = midProj.normalize();
            }
        }

        // Calculate the angle at root joint
        // Distance from root to the middle point
        const reachRatio = reachDist / totalLen;
        const midDist = upperLen;

        // Angle at root: angle between dirToTarget and the upper bone direction
        // Using law of cosines again
        let rootAngle = 0;
        if (reachDist > 0.001) {
            const cosRoot = (upperLen * upperLen + reachDist * reachDist - lowerLen * lowerLen) / (2 * upperLen * reachDist);
            rootAngle = Math.acos(Math.max(-1, Math.min(1, cosRoot)));
        }

        // Calculate upper bone direction
        // The rotation axis should be perpendicular to both dirToTarget and the bend plane (bendDir)
        let axis = new THREE.Vector3().crossVectors(dirToTarget, bendDir);

        let upperDir;
        if (axis.lengthSq() < 0.0001) {
            // Singularity fallback: if target is perfectly aligned with bendDir, pick any arbitrary perpendicular axis
            axis = new THREE.Vector3(1, 0, 0);
            if (Math.abs(dirToTarget.x) > 0.9) axis.set(0, 1, 0);
            axis.cross(dirToTarget).normalize();
        } else {
            axis.normalize();
        }

        // Rotate target direction towards the bend direction
        const rotQuat = new THREE.Quaternion().setFromAxisAngle(axis, rootAngle);
        upperDir = dirToTarget.clone().applyQuaternion(rotQuat);

        // Calculate target mid position
        const targetMidPos = rootPos.clone().add(upperDir.clone().multiplyScalar(upperLen));

        // Now we need to rotate rootBone so its child (midBone) is at targetMidPos
        // And rotate midBone so its child (effectorBone) is at targetPos

        // === Rotate root bone ===
        this.rotateBoneToPoint(rootBone, midPos, targetMidPos, THREE);

        // Update matrices after root rotation
        rootBone.updateMatrixWorld(true);

        // Get new mid position after root rotation
        midBone.getWorldPosition(midPos);

        // === Rotate mid bone ===
        // IMPORTANT: Must refresh effector world position because it moved with its parent!
        effectorBone.getWorldPosition(effPos);
        this.rotateBoneToPoint(midBone, effPos, targetPos, THREE);

        // Update matrices
        midBone.updateMatrixWorld(true);

        return true;
    }

    rotateBoneToPoint(bone, currentChildPos, targetChildPos, THREE) {
        // Get bone world position
        const bonePos = new THREE.Vector3();
        bone.getWorldPosition(bonePos);

        // Direction from bone to current child position
        const currentDir = new THREE.Vector3().subVectors(currentChildPos, bonePos).normalize();

        // Direction from bone to target child position
        const targetDir = new THREE.Vector3().subVectors(targetChildPos, bonePos).normalize();

        // Calculate rotation
        const dot = currentDir.dot(targetDir);
        if (dot > 1 - 1e-12) return; // Already aligned to sub-pixel precision

        const axis = new THREE.Vector3().crossVectors(currentDir, targetDir);
        let angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (axis.lengthSq() < 1e-12) {
            // Singularity: 180 degree rotation. Pick any perpendicular axis.
            if (dot < 0) {
                const perp = new THREE.Vector3(1, 0, 0);
                if (Math.abs(currentDir.x) > 0.9) perp.set(0, 1, 0);
                axis.crossVectors(currentDir, perp).normalize();
            } else {
                return; // Already aligned (0 degrees)
            }
        } else {
            axis.normalize();
        }

        // Create rotation quaternion in world space
        const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, angle);

        // Get current world quaternion
        const currentWorldQuat = new THREE.Quaternion();
        bone.getWorldQuaternion(currentWorldQuat);

        // Apply rotation in world space
        const newWorldQuat = worldRotQuat.multiply(currentWorldQuat);

        // Convert to local quaternion
        if (bone.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            bone.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        bone.quaternion.copy(newWorldQuat);
    }
}

// === CCD IK Solver ===
export class CCDIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
        this.analyticSolver = new AnalyticIKSolver(THREE);
    }

    solve(chainDef, bones, target, poleTarget = null) {
        const THREE = this.THREE;

        const chainBones = chainDef.bones.map(name => bones[name]).filter(b => b);
        const effectorBone = bones[chainDef.effector];
        const poleBone = chainDef.poleBone ? bones[chainDef.poleBone] : null;

        if (!effectorBone || chainBones.length === 0) {
            return false;
        }

        // Use analytic solver for 2-bone chains (much more accurate)
        if (chainBones.length === 2) {
            return this.analyticSolver.solve2Bone(
                chainBones[0],
                chainBones[1],
                effectorBone,
                target,
                poleTarget,
                THREE
            );
        }

        // For 3-bone chains (arms with clavicle), use analytic solver for last 2 bones
        // This gives accurate pole target behavior like legs
        if (chainBones.length === 3) {
            // chainBones[0] = clavicle (skip for IK)
            // chainBones[1] = upperarm
            // chainBones[2] = lowerarm
            return this.analyticSolver.solve2Bone(
                chainBones[1], // upperarm
                chainBones[2], // lowerarm
                effectorBone,  // hand
                target,
                poleTarget,
                THREE
            );
        }

        // Fall back to CCD for longer chains
        const effectorWorldPos = new THREE.Vector3();
        effectorBone.getWorldPosition(effectorWorldPos);

        const initialDist = effectorWorldPos.distanceTo(target);
        if (initialDist < chainDef.threshold) {
            return true;
        }

        for (let iter = 0; iter < chainDef.iterations; iter++) {
            for (let i = chainBones.length - 1; i >= 0; i--) {
                const bone = chainBones[i];

                effectorBone.getWorldPosition(effectorWorldPos);

                const dist = effectorWorldPos.distanceTo(target);
                if (dist < chainDef.threshold) {
                    return true;
                }

                const boneWorldPos = new THREE.Vector3();
                bone.getWorldPosition(boneWorldPos);

                const toEffector = effectorWorldPos.clone().sub(boneWorldPos).normalize();
                const toTarget = target.clone().sub(boneWorldPos).normalize();

                const dot = toEffector.dot(toTarget);

                if (dot > 0.9999) continue;

                const clampedDot = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(clampedDot);

                if (angle < 0.0001) continue;

                const axis = new THREE.Vector3().crossVectors(toEffector, toTarget).normalize();

                if (axis.lengthSq() < 0.0001) continue;

                const maxAngle = Math.PI / 4;
                const limitedAngle = Math.min(angle, maxAngle);

                const boneWorldQuat = new THREE.Quaternion();
                bone.getWorldQuaternion(boneWorldQuat);

                const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, limitedAngle);
                const newWorldQuat = worldRotQuat.multiply(boneWorldQuat);

                if (bone.parent) {
                    const parentWorldQuat = new THREE.Quaternion();
                    bone.parent.getWorldQuaternion(parentWorldQuat);
                    const invParentQuat = parentWorldQuat.clone().invert();
                    newWorldQuat.premultiply(invParentQuat);
                }

                bone.quaternion.copy(newWorldQuat);
                bone.updateMatrixWorld(true);
            }
        }

        // Apply pole target constraint ONCE at the end (not every iteration to avoid accumulation)
        if (poleTarget && poleBone && chainBones.length >= 2) {
            this.applyPoleConstraint(chainBones, poleBone, target, poleTarget, THREE);
        }

        effectorBone.getWorldPosition(effectorWorldPos);
        return effectorWorldPos.distanceTo(target) < chainDef.threshold;
    }

    applyPoleConstraint(chainBones, poleBone, effectorTarget, poleTarget, THREE) {
        // For 2-bone chains (legs): chainBones[0]=thigh, chainBones[1]=calf
        // For 3-bone chains (arms): chainBones[0]=clavicle, chainBones[1]=upperarm, chainBones[2]=lowerarm

        // Use poleBone for elbow/knee position (passed as parameter)
        if (!poleBone) return;

        // For 3-bone chains, we need to rotate upperarm (index 1), not clavicle (index 0)
        // For 2-bone chains, we rotate the first bone (thigh)
        const boneToRotate = chainBones.length >= 3 ? chainBones[1] : chainBones[0];
        if (!boneToRotate) return;

        // Get positions - use boneToRotate position as root for calculations
        const rootPos = new THREE.Vector3();
        const polePos = new THREE.Vector3();

        boneToRotate.getWorldPosition(rootPos); // Position of upperarm/thigh
        poleBone.getWorldPosition(polePos); // Position of elbow/knee

        // Calculate the bend plane
        const rootToTarget = effectorTarget.clone().sub(rootPos).normalize();
        const rootToPole = poleTarget.clone().sub(rootPos).normalize();

        // Calculate the desired bend direction (perpendicular to root->target, towards pole)
        const bendAxis = new THREE.Vector3().crossVectors(rootToTarget, rootToPole).normalize();

        if (bendAxis.lengthSq() < 0.0001) return;

        // Get current bend direction from boneToRotate to poleBone (elbow/knee)
        const currentBend = polePos.clone().sub(rootPos).normalize();

        // Project current bend onto plane perpendicular to root->target
        const projectedCurrent = currentBend.clone().sub(
            rootToTarget.clone().multiplyScalar(currentBend.dot(rootToTarget))
        ).normalize();

        // Project desired bend (towards pole) onto same plane
        const projectedDesired = rootToPole.clone().sub(
            rootToTarget.clone().multiplyScalar(rootToPole.dot(rootToTarget))
        ).normalize();

        // Calculate rotation angle to align with pole
        const dot = projectedCurrent.dot(projectedDesired);
        if (Math.abs(dot) > 0.9999) return;

        const clampedDot = Math.max(-1, Math.min(1, dot));
        let rotationAngle = Math.acos(clampedDot);

        // Check rotation direction
        const cross = new THREE.Vector3().crossVectors(projectedCurrent, projectedDesired);
        if (cross.dot(rootToTarget) < 0) {
            rotationAngle = -rotationAngle;
        }

        // Apply rotation to the correct bone (upperarm for arms, thigh for legs)
        const boneWorldQuat = new THREE.Quaternion();
        boneToRotate.getWorldQuaternion(boneWorldQuat);

        // Create rotation around the target direction axis
        const poleRotationQuat = new THREE.Quaternion().setFromAxisAngle(rootToTarget, rotationAngle * 0.5);
        const newWorldQuat = poleRotationQuat.multiply(boneWorldQuat);

        if (boneToRotate.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            boneToRotate.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        boneToRotate.quaternion.copy(newWorldQuat);
        boneToRotate.updateMatrixWorld(true);
    }
}

// === IK Controller ===
