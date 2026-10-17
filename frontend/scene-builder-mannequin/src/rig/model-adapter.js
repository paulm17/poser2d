// Exact method copied from upstream/web/vnccs_pose_studio.js
export const adapter = {
    modelDataFromMorphMessage(message) {
        const staticData = message?.staticData;
        const bonePositions = message?.bonePositions;
        if (!staticData || !bonePositions || !message?.vertices) {
            throw new Error("Pose Studio MakeHuman worker returned incomplete model data.");
        }
        const bones = (staticData.bones || []).map((bone, index) => {
            const offset = index * 6;
            const headPos = Array.from(bonePositions.subarray(offset, offset + 3));
            const tailPos = Array.from(bonePositions.subarray(offset + 3, offset + 6));
            const dx = tailPos[0] - headPos[0];
            const dy = tailPos[1] - headPos[1];
            const dz = tailPos[2] - headPos[2];
            return {
                name: bone.name,
                parent: bone.parent || null,
                headPos,
                tailPos,
                length: Math.hypot(dx, dy, dz),
            };
        });
        return {
            status: "success",
            vertices: message.vertices,
            uvs: staticData.uvs,
            indices: staticData.indices,
            bones,
            skinIndices: staticData.skinIndices,
            skinWeights: staticData.skinWeights,
            landmarks: message.landmarks || {},
            landmark_indices: message.landmarkIndices || {},
        };
    }

};
