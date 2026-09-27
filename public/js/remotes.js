import * as THREE from "/vendor/three/three.module.js";
import { createAvatar } from "./avatar.js";
import { SNAP_DISTANCE, PLAYER } from "/shared/config.js";

const DELAY_MS = 110; // render remote players slightly in the past to hide jitter

/**
 * Snapshot interpolation for everyone except the local player.
 * Positions arrive at 15 Hz; we render ~110 ms behind and blend between the two
 * neighbouring snapshots.
 */
export class RemotePlayers {
	constructor(scene) {
		this.scene = scene;
		this.entries = new Map(); // id -> { avatar, buffer, name }
	}

	syncRoster(players, localId) {
		const alive = new Set();

		for (const p of players) {
			if (p.id === localId) continue;
			alive.add(p.id);

			const meta = { name: p.name, host: !!p.host, score: p.score ?? null };
			let entry = this.entries.get(p.id);

			if (!entry) {
				const avatar = createAvatar(p.color, p.name, meta);
				this.scene.add(avatar.group);
				entry = { avatar, buffer: [], last: null, meta };
				this.entries.set(p.id, entry);
			} else if (
				entry.meta.name !== meta.name ||
				entry.meta.host !== meta.host ||
				entry.meta.score !== meta.score
			) {
				entry.meta = meta;
				avatarSetTag(entry.avatar, meta);
			}
		}

		for (const [id, entry] of this.entries) {
			if (alive.has(id)) continue;
			this.scene.remove(entry.avatar.group);
			entry.avatar.dispose();
			this.entries.delete(id);
		}
	}

	applySnapshot(id, pos, yaw, now) {
		const entry = this.entries.get(id);
		if (!entry) return;

		const last = entry.buffer[entry.buffer.length - 1];
		if (last) {
			const dx = pos[0] - last.p[0];
			const dy = pos[1] - last.p[1];
			const dz = pos[2] - last.p[2];
			// A big jump means a respawn or a server correction - snap instead of sliding.
			if (Math.sqrt(dx * dx + dy * dy + dz * dz) > SNAP_DISTANCE * 4) {
				entry.buffer.length = 0;
			}
		}

		entry.buffer.push({ t: now, p: [pos[0], pos[1], pos[2]], ry: yaw });
		while (entry.buffer.length > 24) entry.buffer.shift();
	}

	snapTo(id, pos, yaw, now) {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.buffer.length = 0;
		entry.buffer.push({ t: now, p: [pos[0], pos[1], pos[2]], ry: yaw });
	}

	update(dt, now) {
		const renderTime = now - DELAY_MS;

		for (const entry of this.entries.values()) {
			const buf = entry.buffer;
			if (buf.length === 0) continue;

			let a = null;
			let b = null;
			for (let i = buf.length - 1; i >= 0; i--) {
				if (buf[i].t <= renderTime) {
					a = buf[i];
					b = buf[i + 1] || null;
					break;
				}
			}
			if (!a) {
				a = buf[0];
				b = buf[1] || null;
			}

			const g = entry.avatar.group;

			if (b) {
				const span = Math.max(1, b.t - a.t);
				const k = Math.min(1, Math.max(0, (renderTime - a.t) / span));
				g.position.set(
					a.p[0] + (b.p[0] - a.p[0]) * k,
					a.p[1] + (b.p[1] - a.p[1]) * k,
					a.p[2] + (b.p[2] - a.p[2]) * k,
				);
				g.rotation.y = a.ry + shortestAngle(a.ry, b.ry) * k;
			} else {
				g.position.set(a.p[0], a.p[1], a.p[2]);
				g.rotation.y = a.ry;
			}

			const prev = entry.last;
			let speed = 0;
			if (prev) {
				const dx = g.position.x - prev.x;
				const dy = g.position.y - prev.y;
				const dz = g.position.z - prev.z;
				speed = Math.min(PLAYER.sprintSpeed, Math.hypot(dx, dy, dz) / Math.max(dt, 1e-4));
			}
			entry.avatar.pose(dt, speed, true, false);
			entry.last = { x: g.position.x, y: g.position.y, z: g.position.z };
		}
	}

	setTagsVisible(v) {
		for (const entry of this.entries.values()) entry.avatar.setTagVisible(v);
	}

	dispose() {
		for (const entry of this.entries.values()) {
			this.scene.remove(entry.avatar.group);
			entry.avatar.dispose();
		}
		this.entries.clear();
	}
}

function shortestAngle(from, to) {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}

/** Repaint a nametag only when the avatar actually supports it. */
function avatarSetTag(avatar, meta) {
	if (typeof avatar.setTag === "function") avatar.setTag(meta);
}

export { THREE };
