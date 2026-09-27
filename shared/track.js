// Deterministic obby track generator.
//
// The server and every client call buildTrack(seed) and therefore get a byte-identical
// layout from the same integer seed. Nothing about the track is ever sent over the
// network - only the seed is.
//
// Geometry is authored from primitives only (boxes). No imported meshes or art, so the
// track carries no third-party licensing.

import { MAX_PLAYERS, CODE_ALPHABET, CODE_LENGTH } from "./config.js";

/** Small LCG. Deterministic across Node and every browser. */
export function makeRng(seed) {
	let s = (seed >>> 0) || 0x9e3779b9;
	return function next() {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** FNV-1a over a room code, so a code always maps to the same track. */
export function seedFromCode(code) {
	let h = 2166136261 >>> 0;
	for (const ch of String(code)) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

const START_TOP = 2;
const SLOTS = 40;
const CHECKPOINT_SLOTS = new Set([9, 19, 29]);
const MOVER_SLOTS = new Set([12, 13, 14, 26]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Current centre of a moving platform at time `t` (seconds). */
export function moverPosition(mover, t) {
	const k = (Math.sin((t / mover.period + mover.phase) * Math.PI * 2) + 1) / 2;
	return {
		x: mover.a.x + (mover.b.x - mover.a.x) * k,
		y: mover.a.y + (mover.b.y - mover.a.y) * k,
		z: mover.a.z + (mover.b.z - mover.a.z) * k,
	};
}

export function buildTrack(seed) {
	const rng = makeRng(seed);

	const platforms = [];
	const movers = [];
	const hazards = [];
	const checkpoints = [];
	const beams = [];

	platforms.push({
		x: 0,
		y: START_TOP - 1,
		z: 0,
		sx: 22,
		sy: 2,
		sz: 22,
		kind: "start",
	});

	// `edge` is the forward-most edge of the last placed surface, `top` its height.
	let edge = 11;
	let top = START_TOP;

	for (let i = 1; i <= SLOTS; i++) {
		const isCheckpoint = CHECKPOINT_SLOTS.has(i);
		const isMover = MOVER_SLOTS.has(i);
		const gap = 3.1 + rng() * 2.7;

		const rise = isCheckpoint
			? 0.4
			: i % 3 === 0
				? 1.1 + rng() * 2.1
				: rng() * 1.4 - 0.7;
		top = clamp(top + rise, START_TOP - 1, START_TOP + 44);

		if (isCheckpoint) {
			const half = 5.5;
			const cz = edge + gap + half;
			platforms.push({
				x: 0,
				y: top - 1,
				z: cz,
				sx: 11,
				sy: 2,
				sz: half * 2,
				kind: "checkpoint",
			});
			checkpoints.push({ x: 0, y: top, z: cz, r: 7.5 });
			edge = cz + half;
			continue;
		}

		if (isMover) {
			const size = 5;
			const cz = edge + gap + size / 2;
			movers.push({
				a: { x: 0, y: top, z: cz },
				b: {
					x: (rng() - 0.5) * 7,
					y: top + (rng() > 0.5 ? 1.7 : -1.7),
					z: cz + 7 + rng() * 2,
				},
				period: 3.4 + rng() * 1.6,
				phase: rng(),
				sx: size,
				sy: 0.6,
				sz: size,
			});
			edge = cz + size;
			continue;
		}

		const half = 1.7 + rng() * 1.4;
		const sx = 3.2 + rng() * 2.6;
		const cz = edge + gap + half;
		platforms.push({
			x: (rng() - 0.5) * 2.5,
			y: top - 1,
			z: cz,
			sx,
			sy: 2,
			sz: half * 2,
			kind: "normal",
		});

		// A low spike bar to vault. Every fourth regular platform.
		if (i % 4 === 2) {
			hazards.push({
				x: 0,
				y: top,
				z: cz,
				sx: sx * 0.68,
				sy: 1.5,
				sz: 0.7,
			});
		}
		edge = cz + half;
	}

	// Finish pad.
	const finishZ = edge + 6;
	top = top + 0.5;
	platforms.push({
		x: 0,
		y: top - 1,
		z: finishZ,
		sx: 20,
		sy: 2,
		sz: 20,
		kind: "finish",
	});

	const finish = { x: 0, y: top, z: finishZ, r: 8 };

	// Four spawn pads arranged around the start platform.
	const spawns = [];
	for (let p = 0; p < MAX_PLAYERS; p++) {
		const a = (p / MAX_PLAYERS) * Math.PI * 2 - Math.PI / 2;
		spawns.push({
			x: Math.cos(a) * 5.5,
			y: START_TOP,
			z: Math.sin(a) * 5.5 - 3,
		});
	}

	// Set dressing along the run: thin guide bars that visually tie the route together.
	for (let i = 0; i < platforms.length - 1; i += 3) {
		const a = platforms[i];
		const b = platforms[i + 1];
		if (b.z - a.z > 14) continue;
		beams.push({
			x: (a.x + b.x) / 2,
			y: (a.y + b.y) / 2 - 1.6,
			z: (a.z + b.z) / 2,
			sx: 0.25,
			sy: 0.25,
			sz: Math.abs(b.z - a.z),
		});
	}

	return {
		seed,
		platforms,
		movers,
		hazards,
		checkpoints,
		beams,
		finish,
		spawns,
		startTop: START_TOP,
		maxY: top + 30,
		endZ: finishZ + 60,
	};
}

export function randomCode() {
	let out = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
	}
	return out;
}
