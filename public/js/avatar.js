import * as THREE from "/vendor/three/three.module.js";
import { flatMaterial, makeBox } from "./scene.js";

const SKIN = 0xf0c9a0;
const TAG_W = 512;
const TAG_H = 128;

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

/** Mix a colour toward black by `amount` (0..1). */
function shade(color, amount) {
	const c = new THREE.Color(color);
	c.lerp(new THREE.Color(0x000000), amount);
	return `#${c.getHexString()}`;
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** Trim a long name so the pill keeps a sane width. */
function fit(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Nametag drawn onto a canvas sprite. `update()` repaints the same texture, so the
 * host crown and the score badge can change without rebuilding the sprite.
 */
function makeTag(name, color, opts = {}) {
	const canvas = document.createElement("canvas");
	canvas.width = TAG_W;
	canvas.height = TAG_H;
	const ctx = canvas.getContext("2d");
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 8;
	tex.minFilter = THREE.LinearFilter;
	tex.generateMipmaps = false;

	const sprite = new THREE.Sprite(
		new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
	);
	sprite.scale.set(3.1, 0.78, 1);
	sprite.renderOrder = 20;

	let current = null;

	function draw() {
		const { host = false, score = null } = current || {};
		const label = fit(String(current?.name || "Player"), 18);
		const suffix = score === null ? "" : `  ${score}`;
		const font = "700 46px 'Segoe UI', system-ui, sans-serif";

		ctx.clearRect(0, 0, TAG_W, TAG_H);
		ctx.font = font;
		const textW = ctx.measureText(label + suffix).width;

		const crownW = host ? 52 : 0;
		const padX = 30;
		const boxW = Math.min(TAG_W - 8, textW + padX * 2 + crownW);
		const boxH = 74;
		const boxX = (TAG_W - boxW) / 2;
		const boxY = (TAG_H - boxH) / 2;

		ctx.fillStyle = "rgba(8, 12, 18, 0.72)";
		roundRect(ctx, boxX, boxY, boxW, boxH, boxH / 2);
		ctx.fill();

		ctx.lineWidth = 5;
		ctx.strokeStyle = hex(color);
		ctx.stroke();

		// Soft drop shadow so the tag lifts off a busy background.
		ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
		ctx.shadowBlur = 14;
		ctx.shadowOffsetY = 4;
		ctx.fillStyle = "rgba(8, 12, 18, 0.72)";
		roundRect(ctx, boxX, boxY, boxW, boxH, boxH / 2);
		ctx.fill();
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
		ctx.shadowOffsetY = 0;

		ctx.textAlign = "center";
		ctx.textBaseline = "middle";

		const centerX = TAG_W / 2 + crownW / 2;
		const centerY = TAG_H / 2 + 2;

		if (host) {
			const cx = boxX + 30;
			const cy = centerY - 2;
			const s = 15;
			ctx.fillStyle = "#ffd166";
			ctx.beginPath();
			ctx.moveTo(cx - s, cy + s * 0.7);
			ctx.lineTo(cx - s, cy - s * 0.5);
			ctx.lineTo(cx - s * 0.4, cy + s * 0.15);
			ctx.lineTo(cx, cy - s);
			ctx.lineTo(cx + s * 0.4, cy + s * 0.15);
			ctx.lineTo(cx + s, cy - s * 0.5);
			ctx.lineTo(cx + s, cy + s * 0.7);
			ctx.closePath();
			ctx.fill();
			ctx.fillStyle = shade(color, 0.25);
			ctx.fillRect(cx - s, cy + s * 0.7, s * 2, s * 0.45);
		}

		ctx.font = font;
		ctx.lineJoin = "round";
		ctx.lineWidth = 7;
		ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
		ctx.strokeText(label, centerX, centerY);
		ctx.fillStyle = "#ffffff";
		ctx.fillText(label, centerX, centerY);

		if (score !== null) {
			const tail = `${score}`;
			ctx.font = "700 40px 'Segoe UI', system-ui, sans-serif";
			const w = ctx.measureText(tail).width;
			const bx = centerX + textW / 2 + 16;
			ctx.fillStyle = shade(color, 0.1);
			roundRect(ctx, bx - 6, centerY - 25, w + 30, 50, 25);
			ctx.fill();
			ctx.lineWidth = 6;
			ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
			ctx.strokeText(tail, bx + w / 2 + 9, centerY);
			ctx.fillStyle = "#ffffff";
			ctx.fillText(tail, bx + w / 2 + 9, centerY);
		}

		tex.needsUpdate = true;
	}

	return {
		sprite,
		update(next) {
			current = { ...current, ...next };
			draw();
		},
	};
}

/**
 * Blocky avatar built from six boxes - the whole character is original geometry,
 * no rig and no imported mesh.
 */
export function createAvatar(color, name, tagOpts = {}) {
	const group = new THREE.Group();
	const body = flatMaterial(color, { roughness: 0.7 });
	const limb = flatMaterial(new THREE.Color(color).multiplyScalar(0.72).getHex(), { roughness: 0.8 });
	const skin = flatMaterial(SKIN);

	const mk = (sx, sy, sz, mat) => {
		const m = makeBox(sx, sy, sz, mat);
		m.castShadow = true;
		return m;
	};

	const legL = mk(0.55, 1.4, 0.55, limb);
	const legR = mk(0.55, 1.4, 0.55, limb);
	legL.position.set(-0.36, 0.7, 0);
	legR.position.set(0.36, 0.7, 0);

	const torso = mk(1.4, 1.4, 0.7, body);
	torso.position.set(0, 2.1, 0);

	const armL = mk(0.45, 1.3, 0.45, skin);
	const armR = mk(0.45, 1.3, 0.45, skin);
	armL.position.set(-0.93, 2.05, 0);
	armR.position.set(0.93, 2.05, 0);

	const head = mk(0.85, 0.85, 0.85, skin);
	head.position.set(0, 3.22, 0);

	group.add(legL, legR, torso, armL, armR, head);

	let tag = null;
	if (name) {
		tag = makeTag(name, color, tagOpts);
		tag.update({ name, ...tagOpts });
		tag.sprite.position.set(0, 4.6, 0);
		group.add(tag.sprite);
	}

	const parts = { legL, legR, armL, armR, torso, head, tag };
	let phase = 0;

	return {
		group,
		parts,

		/** Repaint the nametag, e.g. when the host changes or a score is earned. */
		setTag(next) {
			if (tag) tag.update(next);
		},

		setTagVisible(v) {
			if (tag) tag.sprite.visible = v;
		},

		/**
		 * @param speed  horizontal speed in studs/s
		 * @param grounded  whether the feet are on a surface
		 * @param airborne  jump/fall pose
		 */
		pose(dt, speed, grounded, airborne) {
			if (airborne) {
				armL.rotation.x = -1.9;
				armR.rotation.x = -1.9;
				legL.rotation.x = 0.5;
				legR.rotation.x = -0.3;
				return;
			}
			phase += dt * (2.2 + speed * 0.42);
			const swing = Math.min(0.85, speed * 0.055) * (grounded ? 1 : 0);
			legL.rotation.x = Math.sin(phase) * swing;
			legR.rotation.x = -Math.sin(phase) * swing;
			armL.rotation.x = -Math.sin(phase) * swing * 0.85;
			armR.rotation.x = Math.sin(phase) * swing * 0.85;
			if (!grounded) {
				legL.rotation.x = 0.5;
				legR.rotation.x = -0.3;
				armL.rotation.x = -1.9;
				armR.rotation.x = -1.9;
			}
		},

		dispose() {
			group.traverse((o) => {
				if (o.geometry) o.geometry.dispose();
				if (o.material) {
					if (o.material.map) o.material.map.dispose();
					o.material.dispose();
				}
			});
		},
	};
}
