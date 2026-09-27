import * as THREE from "/vendor/three/three.module.js";
import { PLAYER, KILL_PLANE_Y } from "/shared/config.js";

const UP = new THREE.Vector3(0, 1, 0);
const EPS = 0.001;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Move `current` towards `target` by at most `step`. */
function approach(current, target, step) {
	if (current < target) return Math.min(current + step, target);
	if (current > target) return Math.max(current - step, target);
	return target;
}

/** Player box vs volume test. `pos` is the player's feet. */
function overlaps(pos, box, hw, hh) {
	return (
		pos.x + hw > box.minX + EPS &&
		pos.x - hw < box.maxX - EPS &&
		pos.y + hh * 2 > box.minY + EPS &&
		pos.y < box.maxY - EPS &&
		pos.z + hw > box.minZ + EPS &&
		pos.z - hw < box.maxZ - EPS
	);
}

/**
 * Local player: input, camera rig and an axis-by-axis AABB solver.
 * The player is simulated on the client and only the resulting position is streamed;
 * the server validates it and owns scoring.
 */
export class LocalPlayer {
	constructor(spawn) {
		this.pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
		this.spawnPoint = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
		this.vel = new THREE.Vector3();
		this.yaw = 0; // body facing
		this.camYaw = 0; // camera orbit
		this.camPitch = -0.2;

		this.grounded = false;
		this.groundBox = null;
		this.coyote = 0;
		this.jumpBuffer = 0;
		this.airTime = 0;
		this.lastCheckpoint = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
		this.checkpointIndex = -1;
		this.finished = false;
		this.frozen = true;

		this.keys = new Set();
		this.wantJump = false;
		this.wantSprint = false;
		this.dragging = false;
		this.paused = false;
		this.camDist = null;

		this.camDir = new THREE.Vector3(0, 0, -1);
		this.flatForward = new THREE.Vector3(0, 0, -1);
		this.right = new THREE.Vector3(1, 0, 0);
		this.moveDir = new THREE.Vector3();
		this.speed = 0;
	}

	/* ------------------------------------------------------------------ input */

	bindInput(canvas) {
		this.canvas = canvas;
		const isTypingTarget = (el) =>
			el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

	// Keys that drive UI only - never treated as held movement input.
	// Keys that drive UI only - never treated as held movement input.
	const UI_KEYS = new Set(["Escape", "KeyH", "KeyN", "Tab", "ControlLeft", "ControlRight"]);

		addEventListener("keydown", (e) => {
			if (isTypingTarget(e.target) || UI_KEYS.has(e.code)) return;
			const code = e.code;
			if (code === "Space" || code.startsWith("Arrow")) e.preventDefault();
			if (this.keys.has(code)) return;
			this.keys.add(code);
			if (code === "Space") this.wantJump = true;
			if (code === "ShiftLeft" || code === "ShiftRight") this.wantSprint = true;
		});

		addEventListener("keyup", (e) => {
			this.keys.delete(e.code);
			if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.wantSprint = false;
		});

		addEventListener("blur", () => {
			this.keys.clear();
			this.wantSprint = false;
			this.dragging = false;
		});

		// Look with the mouse. Pointer lock is the good path; if the browser refuses it
		// (iframes, untrusted gestures, embedded views) drag-to-look keeps working.
		addEventListener("mousemove", (e) => {
			if (document.pointerLockElement === canvas) {
				this.look(e.movementX, e.movementY, PLAYER.mouseSensitivity);
				return;
			}
			if (this.dragging) this.look(e.movementX, e.movementY, PLAYER.dragSensitivity);
		});

		addEventListener("mousedown", (e) => {
			if (isTypingTarget(e.target)) return;
			if (e.button !== 0 && e.button !== 2) return;
			if (document.pointerLockElement === canvas) return;
			this.dragging = true;
			this.requestLook();
		});

		addEventListener("mouseup", () => {
			this.dragging = false;
		});

		addEventListener("contextmenu", (e) => {
			if (!isTypingTarget(e.target)) e.preventDefault();
		});

		document.addEventListener("pointerlockchange", () => {
			if (document.pointerLockElement !== canvas) this.dragging = false;
		});
	}

	/** Shared look math. Positive dx (mouse right) turns the view to the right. */
	look(dx, dy, sensitivity) {
		this.camYaw -= dx * sensitivity;
		this.camPitch = clamp(this.camPitch - dy * sensitivity, -1.2, 0.8);
	}

	/** Best-effort mouse capture; silently degrades to drag-to-look. */
	requestLook() {
		const canvas = this.canvas;
		if (!canvas || document.pointerLockElement === canvas) return;
		const request = canvas.requestPointerLock?.();
		if (request && typeof request.catch === "function") request.catch(() => {});
	}

	releaseLook() {
		if (document.pointerLockElement) document.exitPointerLock?.();
	}

	/* ------------------------------------------------------------------ state */

	teleport(point) {
		this.pos.set(point.x, point.y, point.z);
		this.vel.set(0, 0, 0);
		this.grounded = false;
		this.groundBox = null;
		this.airTime = 0;
	}

	respawn() {
		this.teleport(this.lastCheckpoint);
		this.checkpointIndex = -1;
	}

	reachedCheckpoint(index, point) {
		this.checkpointIndex = index;
		this.lastCheckpoint.set(point.x, point.y + 1, point.z);
	}

	/* ------------------------------------------------------------------- step */

	updateCameraBasis(dt) {
		// Keyboard look. camDir.x is -sin(camYaw), so a bigger yaw means looking left.
		// The camera is purely manual - it never chases the player on its own.
		const kb = PLAYER.keyboardLookSpeed * dt;
		if (this.keys.has("ArrowRight") || this.keys.has("KeyE")) this.camYaw -= kb;
		if (this.keys.has("ArrowLeft") || this.keys.has("KeyQ")) this.camYaw += kb;

		const q = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(this.camPitch, this.camYaw, 0, "YXZ"),
		);
		this.camDir.set(0, 0, -1).applyQuaternion(q);
		this.flatForward.set(this.camDir.x, 0, this.camDir.z);
		if (this.flatForward.lengthSq() < 1e-6) this.flatForward.set(0, 0, -1);
		this.flatForward.normalize();
		this.right.crossVectors(this.flatForward, UP).normalize();
	}

	/** @returns true when the player is standing on a moving platform this frame */
	update(dt, surfaces) {
		// Paused by the Esc menu: hold the last state so the body does not drift or fall.
		if (this.paused) {
			this.updateCameraBasis(dt);
			return false;
		}

		// --- desired horizontal direction
		// `right` is already the world-space strafing axis, so D must add to it.
		let fwd = 0;
		let strafe = 0;
		if (!this.frozen) {
			if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fwd += 1;
			if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fwd -= 1;
			if (this.keys.has("KeyD")) strafe += 1;
			if (this.keys.has("KeyA")) strafe -= 1;
		}

		this.updateCameraBasis(dt);

		const hw = PLAYER.halfWidth;
		const hh = PLAYER.halfHeight;

		this.moveDir
			.copy(this.flatForward)
			.multiplyScalar(fwd)
			.addScaledVector(this.right, strafe);
		if (this.moveDir.lengthSq() > 1) this.moveDir.normalize();

		const maxSpeed = this.wantSprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
		const targetX = this.moveDir.x * maxSpeed;
		const targetZ = this.moveDir.z * maxSpeed;
		const accel = (this.grounded ? PLAYER.accel : PLAYER.airAccel) * dt;
		this.vel.x = approach(this.vel.x, targetX, accel);
		this.vel.z = approach(this.vel.z, targetZ, accel);

		// --- jump
		this.coyote -= dt;
		this.airTime += dt;
		if (this.wantJump) {
			this.jumpBuffer = PLAYER.jumpBuffer;
			this.wantJump = false;
		} else {
			this.jumpBuffer -= dt;
		}
		if (this.jumpBuffer > 0 && this.coyote > 0 && !this.frozen) {
			this.vel.y = PLAYER.jumpVelocity;
			this.grounded = false;
			this.coyote = 0;
			this.jumpBuffer = 0;
		}

		// --- gravity
		this.vel.y = Math.max(-PLAYER.maxFallSpeed, this.vel.y - PLAYER.gravity * dt);

		// --- Y axis
		this.pos.y += this.vel.y * dt;
		const wasGrounded = this.grounded;
		this.grounded = false;
		this.groundBox = null;
		for (const box of surfaces) {
			if (!overlaps(this.pos, box, hw, hh)) continue;
			if (this.vel.y <= 0) {
				this.pos.y = box.maxY;
				this.groundBox = box;
			} else {
				this.pos.y = box.minY - hh * 2 - EPS;
			}
			this.vel.y = 0;
		}
		if (this.groundBox) {
			this.grounded = true;
			this.coyote = PLAYER.coyoteTime;
			this.airTime = 0;
		} else if (wasGrounded) {
			this.coyote = PLAYER.coyoteTime;
		}

		// --- X axis
		this.pos.x += this.vel.x * dt;
		for (const box of surfaces) {
			if (!overlaps(this.pos, box, hw, hh)) continue;
			this.pos.x = this.vel.x > 0 ? box.minX - hw - EPS : box.maxX + hw + EPS;
			this.vel.x = 0;
		}

		// --- Z axis
		this.pos.z += this.vel.z * dt;
		for (const box of surfaces) {
			if (!overlaps(this.pos, box, hw, hh)) continue;
			this.pos.z = this.vel.z > 0 ? box.minZ - hw - EPS : box.maxZ + hw + EPS;
			this.vel.z = 0;
		}

		this.speed = Math.hypot(this.vel.x, this.vel.z);
		// Turn the body towards travel at a bounded rate; snapping it instantly makes
		// the avatar twitch whenever the velocity direction changes.
		if (this.speed > 0.4) {
			const target = Math.atan2(this.vel.x, this.vel.z);
			let diff = (target - this.yaw) % (Math.PI * 2);
			if (diff > Math.PI) diff -= Math.PI * 2;
			if (diff < -Math.PI) diff += Math.PI * 2;
			this.yaw += clamp(diff, -PLAYER.turnSpeed * dt, PLAYER.turnSpeed * dt);
		}

		// Fell off the world.
		if (this.pos.y < KILL_PLANE_Y) {
			this.respawn();
			return true;
		}
		return false;
	}

	/** Ride whatever we are standing on. Call after TrackView.update. */
	carry(trackView) {
		if (!this.groundBox) return;
		for (const m of trackView.movers) {
			if (m.box === this.groundBox) {
				this.pos.add(m.delta);
				return;
			}
		}
	}

	/** Does the player's body intersect this hazard box? */
	touchesHazard(hazards) {
		const hw = PLAYER.halfWidth;
		const hh = PLAYER.halfHeight;
		for (const h of hazards) {
			const box = {
				minX: h.x - h.sx / 2,
				maxX: h.x + h.sx / 2,
				minY: h.y,
				maxY: h.y + h.sy,
				minZ: h.z - h.sz / 2,
				maxZ: h.z + h.sz / 2,
			};
			if (overlaps(this.pos, box, hw, hh)) return true;
		}
		return false;
	}

	/** Distance from the body centre to a target, used for checkpoint pickup. */
	centre() {
		return { x: this.pos.x, y: this.pos.y + PLAYER.halfHeight, z: this.pos.z };
	}

	/** Raw probe: how far back the camera can sit before it enters geometry. */
	cameraDistance(surfaces, maxDist = 11) {
		const eye = {
			x: this.pos.x,
			y: this.pos.y + PLAYER.halfHeight * 1.15,
			z: this.pos.z,
		};
		for (let d = maxDist; d > 1.2; d -= 0.35) {
			const p = {
				x: eye.x - this.camDir.x * d,
				y: eye.y - this.camDir.y * d,
				z: eye.z - this.camDir.z * d,
			};
			let blocked = false;
			for (const box of surfaces) {
				if (
					p.x > box.minX &&
					p.x < box.maxX &&
					p.y > box.minY - 0.3 &&
					p.y < box.maxY &&
					p.z > box.minZ &&
					p.z < box.maxZ
				) {
					blocked = true;
					break;
				}
			}
			if (!blocked) return d;
		}
		return 1.2;
	}

	/**
	 * Smoothed camera boom. The raw probe is a step function of the view direction, so
	 * using it directly makes the camera pop in and out around geometry. The change per
	 * frame is capped in absolute studs: a percentage-based lerp still produced a
	 * multi-stud yank whenever the gap was large.
	 */
	updateCameraDistance(dt, surfaces, maxDist = 11) {
		const desired = this.cameraDistance(surfaces, maxDist);
		if (this.camDist === null) {
			this.camDist = desired;
			return this.camDist;
		}
		const speed = desired < this.camDist ? PLAYER.camPullSpeed : PLAYER.camPushSpeed;
		const maxDelta = speed * dt;
		this.camDist += clamp(desired - this.camDist, -maxDelta, maxDelta);
		return this.camDist;
	}
}

export { overlaps };
