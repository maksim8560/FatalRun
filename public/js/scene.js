import * as THREE from "/vendor/three/three.module.js";

export const COLORS = {
	sky: 0x0b1220,
	fog: 0x0e1726,
	start: 0x2f6f7d,
	normal: 0x46566b,
	checkpoint: 0x3d7a4e,
	finish: 0x8a6a1f,
	mover: 0x7a3f8f,
	hazard: 0xb0342c,
	beam: 0x1d2a3a,
};

/** Renderer, camera, lights and fog. One instance for the whole session. */
export class World {
	constructor(container) {
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(COLORS.sky);
		this.scene.fog = new THREE.Fog(COLORS.fog, 70, 260);

		this.camera = new THREE.PerspectiveCamera(72, 1, 0.3, 900);
		this.camera.position.set(0, 14, 26);

		this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		container.appendChild(this.renderer.domElement);

		const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x1a2230, 1.15);
		this.scene.add(hemi);

		// The sun follows the player so a small shadow frustum stays sharp.
		this.sun = new THREE.DirectionalLight(0xfff3d6, 1.5);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(2048, 2048);
		this.sun.shadow.camera.near = 1;
		this.sun.shadow.camera.far = 160;
		this.sun.shadow.bias = -0.0012;
		const cam = this.sun.shadow.camera;
		cam.left = -45;
		cam.right = 45;
		cam.top = 45;
		cam.bottom = -45;
		cam.updateProjectionMatrix();
		this.scene.add(this.sun, this.sun.target);

		this.resize();
		addEventListener("resize", () => this.resize());
	}

	resize() {
		const w = innerWidth;
		const h = innerHeight;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h, false);
	}

	/** Keep the shadow volume centred on the action. */
	followSun(target) {
		this.sun.target.position.copy(target);
		this.sun.position.set(target.x + 42, target.y + 68, target.z - 34);
		this.sun.target.updateMatrixWorld();
	}

	render() {
		this.renderer.render(this.scene, this.camera);
	}
}

/** Cheap flat material factory - the whole game is boxes, so one per colour is plenty. */
export function flatMaterial(color, opts = {}) {
	return new THREE.MeshStandardMaterial({
		color,
		roughness: opts.roughness ?? 0.85,
		metalness: opts.metalness ?? 0.05,
		emissive: opts.emissive ?? 0x000000,
		emissiveIntensity: opts.emissiveIntensity ?? 1,
		transparent: opts.transparent ?? false,
		opacity: opts.opacity ?? 1,
	});
}

export function makeBox(sx, sy, sz, material) {
	return new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
}
