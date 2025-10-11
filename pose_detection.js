import * as THREE from 'three';

/**
 * Auto-detects pose from the 3D viewer and places markers automatically
 */

// MediaPipe Pose landmark indices mapping to our marker definitions
const POSE_LANDMARK_MAP = {
    'head': 0, // Nose (approximate head top)
    'neck': 0, // Will calculate between shoulders
    'left_shoulder': 11,
    'right_shoulder': 12,
    'left_elbow': 13,
    'right_elbow': 14,
    'left_wrist': 15,
    'right_wrist': 16,
    'left_hip': 23,
    'right_hip': 24,
    'left_knee': 25,
    'right_knee': 26,
    'left_ankle': 27,
    'right_ankle': 28,
    'hips': null, // Will calculate between left and right hip
    'spine': null, // Will calculate between neck and hips
    'left_clavicle': null, // Will calculate between neck and left shoulder
    'right_clavicle': null, // Will calculate between neck and right shoulder
};

let poseInstance = null;

async function initializePose() {
    if (poseInstance) return poseInstance;

    const pose = new Pose({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
        }
    });

    pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    poseInstance = pose;
    return pose;
}

export async function detectPoseAndPlaceMarkers(viewer, onProgress) {
    onProgress(0.1, "Capturing scene...");

    // Render the scene to get a clean snapshot
    viewer.renderer.render(viewer.scene, viewer.camera);
    const imageData = viewer.canvas.toDataURL('image/png');

    onProgress(0.3, "Initializing pose detection...");
    const pose = await initializePose();

    // Convert data URL to image
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageData;
    });

    onProgress(0.5, "Detecting pose...");

    // Run pose detection
    const results = await new Promise((resolve) => {
        pose.onResults(resolve);
        pose.send({ image: img });
    });

    if (!results.poseLandmarks || results.poseLandmarks.length === 0) {
        throw new Error("No pose detected. Please ensure the character is visible in T-pose or A-pose.");
    }

    onProgress(0.7, "Mapping landmarks to 3D...");

    const landmarks = results.poseLandmarks;
    const markers = new Map();

    // Get canvas dimensions for coordinate conversion
    const canvasWidth = viewer.canvas.width;
    const canvasHeight = viewer.canvas.height;

    // Helper to convert 2D screen coords to 3D world position via raycasting
    const screenTo3D = (x, y, z) => {
        // MediaPipe gives normalized coords (0-1), convert to NDC (-1 to 1)
        const ndcX = (x * 2) - 1;
        const ndcY = -(y * 2) + 1; // Flip Y axis

        viewer.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), viewer.camera);
        const intersects = viewer.raycaster.intersectObject(viewer.model, true);

        if (intersects.length > 0) {
            return intersects[0].point.clone();
        }

        // Improved fallback: use MediaPipe's z-depth to estimate position
        // z is normalized depth (0 = close, higher = far)
        const depthScale = 2.0; // Scale factor for depth
        const baseDepth = 1.0; // Base distance from camera
        const estimatedDepth = baseDepth + (z * depthScale);
        
        // Create a ray from the camera through the screen point
        const vector = new THREE.Vector3(ndcX, ndcY, 0.5);
        vector.unproject(viewer.camera);
        const dir = vector.sub(viewer.camera.position).normalize();
        
        // Project to estimated depth
        return viewer.camera.position.clone().add(dir.multiplyScalar(estimatedDepth));
    };

    // Direct mappings
    for (const [markerId, landmarkIdx] of Object.entries(POSE_LANDMARK_MAP)) {
        if (landmarkIdx !== null && landmarks[landmarkIdx]) {
            const lm = landmarks[landmarkIdx];
            const pos3D = screenTo3D(lm.x, lm.y, lm.z);
            markers.set(markerId, pos3D);
        }
    }

    // Calculate derived positions
    // Head (use nose but offset upward)
    if (landmarks[0]) {
        const nose = landmarks[0];
        const pos3D = screenTo3D(nose.x, nose.y - 0.1, nose.z); // Offset up
        markers.set('head', pos3D);
    }

    // Neck (midpoint between shoulders)
    if (landmarks[11] && landmarks[12]) {
        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const midX = (leftShoulder.x + rightShoulder.x) / 2;
        const midY = (leftShoulder.y + rightShoulder.y) / 2;
        const midZ = (leftShoulder.z + rightShoulder.z) / 2;
        markers.set('neck', screenTo3D(midX, midY, midZ));
    }

    // Hips (midpoint between left and right hip)
    if (landmarks[23] && landmarks[24]) {
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];
        const midX = (leftHip.x + rightHip.x) / 2;
        const midY = (leftHip.y + rightHip.y) / 2;
        const midZ = (leftHip.z + rightHip.z) / 2;
        markers.set('hips', screenTo3D(midX, midY, midZ));
    }

    // Spine (between neck and hips)
    if (markers.has('neck') && markers.has('hips')) {
        const neck = markers.get('neck');
        const hips = markers.get('hips');
        const spine = new THREE.Vector3().lerpVectors(hips, neck, 0.5);
        markers.set('spine', spine);
    }

    // Left clavicle (between neck and left shoulder)
    if (markers.has('neck') && markers.has('left_shoulder')) {
        const neck = markers.get('neck');
        const shoulder = markers.get('left_shoulder');
        const clavicle = new THREE.Vector3().lerpVectors(neck, shoulder, 0.3);
        markers.set('left_clavicle', clavicle);
    }

    // Right clavicle (between neck and right shoulder)
    if (markers.has('neck') && markers.has('right_shoulder')) {
        const neck = markers.get('neck');
        const shoulder = markers.get('right_shoulder');
        const clavicle = new THREE.Vector3().lerpVectors(neck, shoulder, 0.3);
        markers.set('right_clavicle', clavicle);
    }

    onProgress(0.9, "Placing markers...");

    return markers;
}