import * as THREE from "/vendor/three/three.module.js";
import { COLORS, flatMaterial, makeBox } from "./scene.js";
import { moverPosition } from "/shared/track.js";

const EPS = 1e-4;

function aabb(x, y, z, sx, sy, sz) {
	return {
		minX: x - sx / 2,
		maxX: x + sx / 2,
		minY: y - sy / 2,
		maxY: y + sy / 2,
		minZ: z - sz / 2,
		maxZ: z + sz / 2,
	};
}

/**
 * Builds every mesh for a track and keeps the collision volumes in sync.
 * Nothing here is loaded from disk - the whole course is generated from the seed.
 */
export class TrackView {
	constructor(scene, track) {
		this.scene = scene;
		this.track = track;
		this.group = new THREE.Group();
		scene.add(this.group);

		this.statics = [];
		this.movers = [];
		this.lobbyWalls = [];
		this.spinners = [];
		this.lobbyWallsEnabled = true;
		this.active = [];

		this.mats = {
			start: flatMaterial(COLORS.start),
			normal: flatMaterial(COLORS.normal),
			checkpoint: flatMaterial(COLORS.checkpoint),
			finish: flatMaterial(COLORS.finish, { metalness: 0.4, roughness: 0.4 }),
			mover: flatMaterial(COLORS.mover, { emissive: 0x3a1152, emissiveIntensity: 0.7 }),
			hazard: flatMaterial(COLORS.hazard, { emissive: 0x5a1109, emissiveIntensity: 0.9 }),
			beam: flatMaterial(COLORS.beam, { transparent: true, opacity: 0.5 }),
			ring: flatMaterial(0x9ccc65, {
				emissive: 0x5a8f2a,
				emissiveIntensity: 1.4,
				metalness: 0.3,
				roughness: 0.3,
			}),
			gate: flatMaterial(0xffd166, { emissive: 0x8a6a1f, emissiveIntensity: 1.2 }),
			wall: new THREE.MeshStandardMaterial({
				color: 0x3a4a5e,
				transparent: true,
				opacity: 0.16,
				roughness: 1,
			}),
		};

		this.build();
	}

	/* ------------------------------------------------------------------ build */

	addBox(x, y, z, sx, sy, sz, mat, collide = true) {
		const mesh = makeBox(sx, sy, sz, mat);
		mesh.position.set(x, y, z);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		this.group.add(mesh);
		if (collide) this.statics.push(aabb(x, y, z, sx, sy, sz));
		return mesh;
	}

	build() {
		for (const p of this.track.platforms) {
			const mat =
				p.kind === "start"
					? this.mats.start
					: p.kind === "checkpoint"
						? this.mats.checkpoint
						: p.kind === "finish"
							? this.mats.finish
							: this.mats.normal;
			this.addBox(p.x, p.y, p.z, p.sx, p.sy, p.sz, mat);
		}

		for (const b of this.track.beams) {
			this.addBox(b.x, b.y, b.z, b.sx, b.sy, b.sz, this.mats.beam, false);
		}

		for (const h of this.track.hazards) {
			this.addBox(h.x, h.y + h.sy / 2, h.z, h.sx, h.sy, h.sz, this.mats.hazard);
		}

		for (const m of this.track.movers) {
			const mesh = makeBox(m.sx, m.sy, m.sz, this.mats.mover);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			this.group.add(mesh);
			this.movers.push({
				mover: m,
				mesh,
				box: aabb(0, 0, 0, m.sx, m.sy, m.sz),
				delta: new THREE.Vector3(),
			});
		}

		this.buildCheckpoints();
		this.buildFinish();
		this.buildLobbyWalls();
		this.rebuildActive();
	}

	buildCheckpoints() {
		for (const cp of this.track.checkpoints) {
			const pillar = new THREE.Mesh(
				new THREE.CylinderGeometry(0.35, 0.35, 16, 12, 1, true),
				new THREE.MeshBasicMaterial({
					color: 0x9ccc65,
					transparent: true,
					opacity: 0.24,
					side: THREE.DoubleSide,
					depthWrite: false,
				}),
			);
			pillar.position.set(cp.x, cp.y + 8, cp.z);
			this.group.add(pillar);

			const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.28, 8, 28), this.mats.ring);
			ring.position.set(cp.x, cp.y + 2.6, cp.z);
			ring.rotation.x = Math.PI / 2;
			this.group.add(ring);
			this.spinners.push({ mesh: ring, speed: 1.6 });
		}
	}

	buildFinish() {
		const f = this.track.finish;
		for (const side of [-1, 1]) {
			const pillar = this.addBox(f.x + side * 6, f.y + 4, f.z, 1.2, 8, 1.2, this.mats.gate, false);
			pillar.castShadow = true;
		}
		const lintel = this.addBox(f.x, f.y + 8, f.z, 13.2, 1.2, 1.2, this.mats.gate, false);
		lintel.castShadow = true;

		const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.32, 8, 32), this.mats.gate);
		ring.position.set(f.x, f.y + 3.4, f.z);
		this.group.add(ring);
		this.spinners.push({ mesh: ring, speed: 0.9, axis: "y" });
	}

	/** Invisible barrier that keeps players on the start pad while in the lobby. */
	buildLobbyWalls() {
		const t = this.track.startTop;
		const half = 11;
		const h = 9;
		const spec = [
			[0, -half, 22, h, 0.6],
			[0, half, 22, h, 0.6],
			[-half, 0, 0.6, h, 22],
			[half, 0, 0.6, h, 22],
		];
		for (const [x, z, sx, sy, sz] of spec) {
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), this.mats.wall);
			mesh.position.set(x, t + sy / 2 - 1, z);
			this.group.add(mesh);
			this.lobbyWalls.push({ box: aabb(x, t + sy / 2 - 1, z, sx, sy, sz), mesh });
		}
	}

	/* ---------------------------------------------------------------- runtime */

	setLobbyWalls(enabled) {
		this.lobbyWallsEnabled = enabled;
		for (const w of this.lobbyWalls) w.mesh.visible = enabled;
		this.rebuildActive();
	}

	/** Re-place moving platforms and record their per-frame delta for rider carry. */
	update(t, dt) {
		for (const m of this.movers) {
			const p = moverPosition(m.mover, t);
			const x = p.x;
			const y = p.y - m.mover.sy / 2;
			const z = p.z;
			m.delta.set(x - m.mesh.position.x, y - m.mesh.position.y, z - m.mesh.position.z);
			m.mesh.position.set(x, y, z);
			m.box = aabb(x, y, z, m.mover.sx, m.mover.sy, m.mover.sz);
		}
		for (const s of this.spinners) {
			if (s.axis === "y") s.mesh.rotation.y += s.speed * dt;
			else s.mesh.rotation.z += s.speed * dt;
		}
		this.rebuildActive();
	}

	/** Refresh the collision list once per frame; the player reuses it every step. */
	rebuildActive() {
		const out = this.active;
		out.length = 0;
		for (const s of this.statics) out.push(s);
		for (const m of this.movers) out.push(m.box);
		if (this.lobbyWallsEnabled) for (const w of this.lobbyWalls) out.push(w.box);
	}

	/** All solid volumes the local player can stand on or bump into. */
	surfaces() {
		return this.active;
	}

	/** Volumes that reset you to the last checkpoint. */
	get hazards() {
		return this.track.hazards;
	}

	dispose() {
		this.group.traverse((obj) => {
			if (obj.geometry) obj.geometry.dispose();
		});
		this.scene.remove(this.group);
	}
}

export { EPS, aabb };
