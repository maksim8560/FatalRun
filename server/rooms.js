// Room + round state machine. The server owns everything that matters: lobby membership,
// the phase clock, checkpoint progress and finishing order. Clients only send intent
// ("I moved here", "I touched checkpoint N") and the server validates it against the
// deterministically generated track.

import {
	MAX_PLAYERS,
	PHASE,
	COUNTDOWN_MS,
	ROUND_MS,
	RESULTS_MS,
	MAX_STEP_STUDS,
	SCORE_TABLE,
} from "../shared/config.js";
import { buildTrack, seedFromCode, randomCode } from "../shared/track.js";

const TICK_MS = 50;
const PLAYER_COLORS = [0x4fc3f7, 0xff7043, 0x9ccc65, 0xba68c8];

let nextPlayerId = 1;

class Room {
	constructor(code) {
		this.code = code;
		this.seed = seedFromCode(code);
		this.track = buildTrack(this.seed);
		this.players = new Map();
		this.hostId = null;
		this.phase = PHASE.LOBBY;
		this.phaseEndsAt = 0;
		this.round = 0;
		this.winners = [];
		this.timer = null;
	}

	/* ---------------------------------------------------------------- players */

	add(socket, name) {
		if (this.players.size >= MAX_PLAYERS) return { error: "room_full" };

		const taken = new Set([...this.players.values()].map((p) => p.slot));
		let slot = 0;
		while (taken.has(slot)) slot++;

		const player = {
			id: nextPlayerId++,
			slot,
			name,
			socket,
			color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
			score: 0,
			cp: -1,
			pos: { ...this.track.spawns[slot], y: this.track.startTop + 4 },
			yaw: 0,
			finished: false,
			place: 0,
		};

		this.players.set(player.id, player);
		if (this.hostId === null) this.hostId = player.id;
		return { player };
	}

	remove(playerId) {
		const player = this.players.get(playerId);
		if (!player) return;

		this.players.delete(playerId);
		if (this.hostId === playerId) this.hostId = this.firstId();

		if (this.phase === PHASE.PLAYING && this.allFinished()) this.endRound("everyone_finished");
		if (this.players.size === 0) this.stopTimer();
	}

	firstId() {
		for (const id of this.players.keys()) return id;
		return null;
	}

	isHost(playerId) {
		return this.hostId === playerId;
	}

	/* ------------------------------------------------------------- messaging */

	send(player, msg) {
		if (player.socket.readyState === 1) player.socket.send(JSON.stringify(msg));
	}

	broadcast(msg, exceptId = null) {
		const payload = JSON.stringify(msg);
		for (const p of this.players.values()) {
			if (p.id === exceptId) continue;
			if (p.socket.readyState === 1) p.socket.send(payload);
		}
	}

	publicPlayer(p) {
		return {
			id: p.id,
			slot: p.slot,
			name: p.name,
			color: p.color,
			score: p.score,
			host: p.id === this.hostId,
			cp: p.cp,
			finished: p.finished,
			place: p.place,
		};
	}

	snapshot() {
		return {
			t: "state",
			code: this.code,
			seed: this.seed,
			phase: this.phase,
			phaseEndsAt: this.phaseEndsAt,
			hostId: this.hostId,
			round: this.round,
			now: Date.now(),
			maxPlayers: MAX_PLAYERS,
			players: [...this.players.values()].map((p) => this.publicPlayer(p)),
			results: this.winners,
		};
	}

	pushState() {
		this.broadcast(this.snapshot());
	}

	/* ----------------------------------------------------------------- phases */

	startCountdown() {
		if (this.players.size === 0 || this.phase === PHASE.COUNTDOWN) return;

		this.round += 1;
		this.phase = PHASE.COUNTDOWN;
		this.phaseEndsAt = Date.now() + COUNTDOWN_MS;
		this.resetRoundState();
		this.pushState();
		this.ensureTimer();
	}

	beginPlaying() {
		this.phase = PHASE.PLAYING;
		this.phaseEndsAt = Date.now() + ROUND_MS;
		this.pushState();
	}

	resetRoundState() {
		this.winners = [];
		for (const p of this.players.values()) {
			p.cp = -1;
			p.finished = false;
			p.place = 0;
			p.pos = { ...this.track.spawns[p.slot], y: this.track.startTop + 4 };
			p.yaw = 0;
		}
	}

	allFinished() {
		for (const p of this.players.values()) if (!p.finished) return false;
		return true;
	}

	endRound(reason) {
		if (this.phase !== PHASE.PLAYING) return;

		// Everyone still running is ranked by checkpoint progress, best first.
		const rest = [...this.players.values()].filter((p) => !p.finished).sort((a, b) => b.cp - a.cp);

		let place = this.winners.length + 1;
		for (const p of rest) {
			p.finished = true;
			p.place = place;
			this.winners.push({ id: p.id, name: p.name, place, score: 0, cp: p.cp, dnf: true });
			place++;
		}

		for (const entry of this.winners) {
			const p = this.players.get(entry.id);
			if (!p) continue;
			entry.score = SCORE_TABLE[entry.place - 1] ?? 0;
			entry.dnf = entry.score === 0;
			p.score += entry.score;
		}

		this.phase = PHASE.RESULTS;
		this.phaseEndsAt = Date.now() + RESULTS_MS;
		this.broadcast({
			t: "roundEnd",
			reason,
			results: this.winners,
			players: [...this.players.values()].map((p) => this.publicPlayer(p)),
		});
		this.pushState();
		this.ensureTimer();
	}

	backToLobby() {
		this.phase = PHASE.LOBBY;
		this.phaseEndsAt = 0;
		this.winners = [];
		this.resetRoundState();
		this.pushState();
		this.stopTimer();
	}

	ensureTimer() {
		if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
	}

	stopTimer() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	destroy() {
		this.stopTimer();
		this.players.clear();
	}

	tick() {
		const now = Date.now();

		if (this.phase === PHASE.COUNTDOWN && now >= this.phaseEndsAt) {
			this.beginPlaying();
			return;
		}
		if (this.phase === PHASE.PLAYING) {
			if (this.allFinished()) this.endRound("everyone_finished");
			else if (now >= this.phaseEndsAt) this.endRound("time_up");
			return;
		}
		if (this.phase === PHASE.RESULTS && now >= this.phaseEndsAt) {
			this.backToLobby();
			return;
		}
		if (this.phase === PHASE.LOBBY) this.stopTimer();
	}
}

/* ------------------------------------------------------------------ registry */

const rooms = new Map();

export function createRoom() {
	for (let attempt = 0; attempt < 50; attempt++) {
		const code = randomCode();
		if (!rooms.has(code)) {
			const room = new Room(code);
			rooms.set(code, room);
			return room;
		}
	}
	return null;
}

export function getRoom(code) {
	return rooms.get(String(code || "").toUpperCase().trim()) || null;
}

export function getRoomCount() {
	return rooms.size;
}

export function dropRoom(code) {
	const room = getRoom(code);
	if (room && room.players.size === 0) {
		room.destroy();
		rooms.delete(room.code);
	}
}

export function destroyAll() {
	for (const room of rooms.values()) room.destroy();
	rooms.clear();
}

/* ------------------------------------------------------------ client messages */

// Every socket carries its own binding, so the client never has to prove which room or
// which player it is acting as.
function bindingOf(socket) {
	const code = socket.fr && socket.fr.code;
	if (!code) return { room: null, player: null };
	const room = getRoom(code);
	return { room, player: room ? room.players.get(socket.fr.id) : null };
}

export function handleMessage(socket, raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	if (!msg || typeof msg.t !== "string") return;

	const sendErr = (text) => {
		if (socket.readyState === 1) socket.send(JSON.stringify({ t: "err", message: text }));
	};
	const cleanName = (v) => String(v || "Player").replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 16) || "Player";

	switch (msg.t) {
		case "create": {
			const room = createRoom();
			if (!room) return sendErr("Сервер перегружен, попробуйте снова");
			const { player } = room.add(socket, cleanName(msg.name));
			socket.fr = { code: room.code, id: player.id };
			room.ensureTimer();
			// `t` must win over the snapshot's own type field.
			socket.send(JSON.stringify({ ...room.snapshot(), t: "joined", id: player.id }));
			room.broadcast(room.snapshot(), player.id);
			return;
		}

		case "join": {
			const room = getRoom(msg.code);
			if (!room) return sendErr("Комната не найдена");
			const { player, error } = room.add(socket, cleanName(msg.name));
			if (error) return sendErr("Комната заполнена — максимум 4 игрока");
			socket.fr = { code: room.code, id: player.id };
			room.ensureTimer();
			socket.send(JSON.stringify({ ...room.snapshot(), t: "joined", id: player.id }));
			room.broadcast(room.snapshot(), player.id);
			return;
		}

		case "start": {
			const { room, player } = bindingOf(socket);
			if (!room || !player) return sendErr("Вы не в комнате");
			if (!room.isHost(player.id)) return sendErr("Начать раунд может только хост");
			room.startCountdown();
			return;
		}

		case "pos": {
			const { room, player } = bindingOf(socket);
			if (!room || !player || room.phase !== PHASE.PLAYING) return;

			const raw3 = msg.p;
			if (!Array.isArray(raw3) || raw3.length !== 3) return;
			const next = { x: +raw3[0], y: +raw3[1], z: +raw3[2] };
			if (![next.x, next.y, next.z].every(Number.isFinite)) return;
			if (next.y < -200 || next.y > 500) return;

			if (!msg.sync) {
				const dx = next.x - player.pos.x;
				const dy = next.y - player.pos.y;
				const dz = next.z - player.pos.z;
				if (Math.sqrt(dx * dx + dy * dy + dz * dz) > MAX_STEP_STUDS) {
					// Reject the outlier and tell the client to snap back to our version.
					room.send(player, { t: "snap", p: [player.pos.x, player.pos.y, player.pos.z] });
					return;
				}
			}

			player.pos = next;
			player.yaw = +msg.ry || 0;
			room.broadcast(
				{ t: "pos", id: player.id, p: [next.x, next.y, next.z], ry: player.yaw },
				player.id,
			);
			return;
		}

		case "cp": {
			const { room, player } = bindingOf(socket);
			if (!room || !player || room.phase !== PHASE.PLAYING || player.finished) return;

			const i = msg.i;
			const cp = room.track.checkpoints[i];
			if (!cp || i <= player.cp) return;

			// The player must physically be at the checkpoint, not just claim it.
			const dx = player.pos.x - cp.x;
			const dy = player.pos.y - cp.y;
			const dz = player.pos.z - cp.z;
			if (Math.sqrt(dx * dx + dy * dy + dz * dz) > cp.r + 2) return;

			player.cp = i;
			room.broadcast({ t: "cp", id: player.id, i, total: room.track.checkpoints.length });
			room.broadcast({ t: "progress", players: room.snapshot().players });
			return;
		}

		case "finish": {
			const { room, player } = bindingOf(socket);
			if (!room || !player || room.phase !== PHASE.PLAYING || player.finished) return;

			const f = room.track.finish;
			const dx = player.pos.x - f.x;
			const dy = player.pos.y - f.y;
			const dz = player.pos.z - f.z;
			if (Math.sqrt(dx * dx + dy * dy + dz * dz) > f.r) return;

			player.finished = true;
			player.place = room.winners.length + 1;

			room.winners.push({
				id: player.id,
				name: player.name,
				place: player.place,
				cp: player.cp,
				score: SCORE_TABLE[player.place - 1] ?? 0,
				dnf: false,
			});
			room.broadcast({ t: "finished", id: player.id, place: player.place, total: room.players.size });
			room.broadcast({ t: "progress", players: room.snapshot().players });

			if (room.allFinished()) room.endRound("everyone_finished");
			return;
		}

		case "leave": {
			const { room, player } = bindingOf(socket);
			if (room && player) {
				room.remove(player.id);
				socket.fr = null;
				room.pushState();
				dropRoom(room.code);
			}
			return;
		}

		default:
			return;
	}
}

export { Room };
