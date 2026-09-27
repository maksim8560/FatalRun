import * as THREE from "/vendor/three/three.module.js";

import { PHASE, POS_HZ, PLAYER, MAX_PLAYERS } from "/shared/config.js";
import { buildTrack } from "/shared/track.js";
import { World } from "./scene.js";
import { TrackView } from "./trackView.js";
import { LocalPlayer } from "./player.js";
import { RemotePlayers } from "./remotes.js";
import { createAvatar } from "./avatar.js";
import { Net } from "./net.js";
import { UI } from "./ui.js";

const net = new Net();
const ui = new UI();
const world = new World(document.getElementById("viewport"));

let track = null;
let view = null;
let player = null;
let localAvatar = null;
let remotes = null;
let state = null;
let myId = null;
let lastPhase = null;
let previewSeed = 0;
let needSync = false;
let netAccum = 0;
let inRoom = false;
let paused = false;
let wasLocked = false;
let namesVisible = localStorage.getItem("fr.namesHidden") !== "1";

/** Nametags stay on by default, in the lobby and mid-run alike. */
function applyNameVisibility() {
	if (remotes) remotes.setTagsVisible(namesVisible);
	if (localAvatar) localAvatar.setTagVisible(namesVisible);
}

function toggleNames() {
	namesVisible = !namesVisible;
	localStorage.setItem("fr.namesHidden", namesVisible ? "0" : "1");
	applyNameVisibility();
	ui.toast(namesVisible ? "Ники включены" : "Ники скрыты", 1200);
}

const centre = new THREE.Vector3();
const camTarget = new THREE.Vector3();

/* ------------------------------------------------------------------- world */

function ensureWorld(seed, preview) {
	if (view && previewSeed === seed) return;

	if (view) view.dispose();
	previewSeed = seed;
	track = buildTrack(seed);
	view = new TrackView(world.scene, track);

	if (remotes) remotes.dispose();
	remotes = new RemotePlayers(world.scene);

	if (localAvatar) {
		world.scene.remove(localAvatar.group);
		localAvatar.dispose();
		localAvatar = null;
	}
	player = null;
	view.setLobbyWalls(true);
}

function slotOf(id) {
	const me = state?.players.find((p) => p.id === id);
	return me ? me.slot : 0;
}

function spawnLocalPlayer() {
	const slot = Math.min(slotOf(myId), MAX_PLAYERS - 1);
	const spawn = track.spawns[slot];
	const me = state?.players.find((p) => p.id === myId);

	player = new LocalPlayer({ x: spawn.x, y: spawn.y + 1, z: spawn.z });
	player.bindInput(world.renderer.domElement);

	localAvatar = createAvatar(0xf0f4f8, me?.name || "Вы", {
		host: !!me?.host,
		score: me?.score ?? null,
	});
	localTagMeta = {
		name: me?.name || "Вы",
		host: !!me?.host,
		score: me?.score ?? null,
	};
	localAvatar.setTagVisible(namesVisible);
	world.scene.add(localAvatar.group);
	player.frozen = state?.phase === PHASE.LOBBY || state?.phase === PHASE.COUNTDOWN;
	needSync = true;
}

/* ----------------------------------------------------------------- network */

net.on("joined", (msg) => {
	const rejoining = inRoom;
	myId = msg.id;
	ui.showLoader(!rejoining);
	if (!rejoining) ensureWorld(msg.seed, false);
	// applyState flips inRoom itself; setting it here would skip player creation.
	applyState(msg);
	ui.showLoader(false);
	if (rejoining) ui.toast("Переподключились", 1800);
});

net.on("state", (msg) => {
	if (!inRoom) return;
	applyState(msg);
});

net.on("progress", (msg) => {
	if (!inRoom || !state) return;
	state.players = msg.players;
	if (state.phase === PHASE.PLAYING || state.phase === PHASE.COUNTDOWN) {
		ui.renderRoster({ ...state, checkpointTotal: track?.checkpoints.length ?? 0 }, myId, true);
	}
});

net.on("pos", (msg) => {
	if (!inRoom || !remotes) return;
	remotes.applySnapshot(msg.id, msg.p, msg.ry, performance.now());
});

net.on("snap", (msg) => {
	// The server rejected our packet; take its version as truth.
	if (!inRoom || !player) return;
	player.teleport({ x: msg.p[0], y: msg.p[1] - PLAYER.halfHeight, z: msg.p[2] });
	needSync = true;
});

net.on("finished", (msg) => {
	if (!inRoom) return;
	const who = state?.players.find((p) => p.id === msg.id);
	const ordinal = ["1-е", "2-е", "3-е", "4-е"][msg.place - 1] ?? `${msg.place}-е`;
	ui.banner(`${who ? who.name : "Игрок"} финишивает ${ordinal}!`, 1500);
});

net.on("roundEnd", (msg) => {
	if (!inRoom) return;
	state = { ...(state || {}), results: msg.results, players: msg.players, reason: msg.reason };
	ui.showResults(state, myId);
});

net.on("err", (msg) => {
	ui.showError(msg.message);
	if (!inRoom) ui.show("menu");
});

net.on("__reconnecting", () => {
	if (inRoom) ui.toast("Соединение потеряно, переподключаемся…", 2500);
});

net.on("__closed", (info) => {
	// Before ever joining a room there is nothing to restore - just report it.
	if (!info.joined) {
		ui.showError("Нет связи с сервером");
		return;
	}
	// We were in a room: keep the client state and wait for the automatic reconnect.
	if (inRoom) ui.showError("");
});

/* ------------------------------------------------------------------- state */

function applyState(msg) {
	const first = !inRoom;
	inRoom = true;
	state = msg;

	const me = msg.players.find((p) => p.id === net.myId);
	if (me) myId = me.id;

	if (first) spawnLocalPlayer();
	if (remotes) remotes.syncRoster(msg.players, myId);
	refreshOwnTag(msg.players);

	// Walls come down when the round starts and go back up in the lobby.
	const inRace = msg.phase === PHASE.COUNTDOWN || msg.phase === PHASE.PLAYING;
	view.setLobbyWalls(!inRace);
	applyNameVisibility();

	ui.setPauseButton(inRace);
	if (!inRace && paused) setPaused(false);

	if (msg.phase !== lastPhase) onPhaseChange(msg.phase, msg);
	lastPhase = msg.phase;

	ui.renderPhase(msg, myId);
}

function onPhaseChange(phase, msg) {
	if (phase === PHASE.COUNTDOWN) {
		const slot = Math.min(slotOf(myId), MAX_PLAYERS - 1);
		const spawn = track.spawns[slot];
		player.teleport({ x: spawn.x, y: spawn.y + 1, z: spawn.z });
		player.finished = false;
		player.checkpointIndex = -1;
		player.lastCheckpoint.set(spawn.x, spawn.y + 1, spawn.z);
		player.frozen = true;
		needSync = true;
		ui.toast("Приготовьтесь!");
	}

	if (phase === PHASE.PLAYING) {
		player.frozen = false;
	}

	if (phase === PHASE.LOBBY) {
		player.finished = false;
		player.checkpointIndex = -1;
		player.frozen = false;
		ui.setCountdown(null);
	}
}

/* ------------------------------------------------------------- game events */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Push our position immediately. Used before any claim the server has to validate. */
function sendPosition() {
	const ok = net.send({
		t: "pos",
		p: [player.pos.x, player.pos.y + PLAYER.halfHeight, player.pos.z],
		ry: player.yaw,
		sync: needSync,
	});
	if (ok) needSync = false;
}

function checkProgress() {
	if (!player || paused || state?.phase !== PHASE.PLAYING || player.finished) return;

	if (player.touchesHazard(view.hazards)) {
		player.respawn();
		needSync = true;
		sendPosition();
		return;
	}

	const here = player.centre();

	for (let i = player.checkpointIndex + 1; i < track.checkpoints.length; i++) {
		const cp = track.checkpoints[i];
		if (dist(here, cp) < cp.r) {
			player.reachedCheckpoint(i, cp);
			// The server checks the claim against its last known position, so make that
			// position current before asking.
			sendPosition();
			net.send({ t: "cp", i });
			ui.toast(`Чекпоинт ${i + 1} / ${track.checkpoints.length}`);
			break;
		}
	}

	const f = track.finish;
	if (dist(here, f) < f.r) {
		player.finished = true;
		player.frozen = true;
		sendPosition();
		net.send({ t: "finish" });
	}
}

let localTagMeta = null;

/** Keep our own nametag in sync: host crown and score both change between rounds. */
function refreshOwnTag(players) {
	if (!localAvatar || !localAvatar.setTag) return;
	const me = players.find((p) => p.id === myId);
	if (!me) return;
	const meta = { name: me.name, host: !!me.host, score: me.score ?? null };
	if (
		localTagMeta &&
		localTagMeta.host === meta.host &&
		localTagMeta.score === meta.score &&
		localTagMeta.name === meta.name
	) {
		return;
	}
	localTagMeta = meta;
	localAvatar.setTag(meta);
}

/* ------------------------------------------------------------------ pause */

const PAUSABLE_PHASES = new Set([PHASE.COUNTDOWN, PHASE.PLAYING]);

function canPause() {
	return inRoom && !!state && PAUSABLE_PHASES.has(state.phase);
}

function pauseInfo() {
	if (!state) return "";
	const left = Math.max(0, state.phaseEndsAt - net.serverNow());
	const m = Math.floor(left / 60000);
	const s = Math.floor((left % 60000) / 1000);
	return `До конца раунда ${m}:${String(s).padStart(2, "0")} · Esc — продолжить`;
}

function setPaused(value) {
	if (paused === value) return;
	paused = value;
	ui.showPause(paused, pauseInfo());

	if (player) {
		player.paused = paused;
		// Drop any held keys so resuming does not launch you sideways.
		if (paused) {
			player.keys.clear();
			player.wantJump = false;
			player.wantSprint = false;
			player.dragging = false;
			player.releaseLook();
		} else {
			player.requestLook();
		}
	}
}

/* ------------------------------------------------------------------ leave */

/** Leave the room and drop back to the menu without reloading the page. */
function resetToMenu() {
	setPaused(false);
	inRoom = false;
	state = null;
	myId = null;
	lastPhase = null;
	needSync = false;
	netAccum = 0;

	if (view) view.dispose();
	if (remotes) remotes.dispose();
	if (localAvatar) {
		world.scene.remove(localAvatar.group);
		localAvatar.dispose();
		localAvatar = null;
	}
	view = null;
	remotes = null;
	player = null;
	track = null;
	previewSeed = 0;

	ui.setPauseButton(false);
	ui.showMenu();
	ensureWorld((Math.random() * 0xffffffff) >>> 0, true);
}

/* -------------------------------------------------------------------- loop */

let last = performance.now();

function frame(now) {
	const dt = Math.min(0.05, (now - last) / 1000);
	last = now;
	const elapsed = now / 1000;

	if (view) view.update(elapsed, dt);

	if (player) {
		const fell = player.update(dt, view.surfaces());
		player.carry(view);
		if (fell) needSync = true;

		if (localAvatar) {
			localAvatar.group.position.copy(player.pos);
			localAvatar.group.rotation.y = player.yaw;
			localAvatar.pose(dt, player.speed, player.grounded, !player.grounded);
		}

		centre.set(player.pos.x, player.pos.y + PLAYER.halfHeight * 1.15, player.pos.z);
		const camDist = player.updateCameraDistance(dt, view.surfaces(), 11);
		world.camera.position.set(
			centre.x - player.camDir.x * camDist,
			centre.y - player.camDir.y * camDist,
			centre.z - player.camDir.z * camDist,
		);
		world.camera.lookAt(centre);
		world.followSun(player.pos);

		checkProgress();
	} else {		// Menu preview: slow orbit over the start pad.
		const r = 26;
		world.camera.position.set(Math.cos(elapsed * 0.13) * r, 13, Math.sin(elapsed * 0.13) * r);
		world.camera.lookAt(0, 3, 0);
		world.followSun(camTarget.set(0, 0, 0));
	}

	if (remotes) remotes.update(dt, now);
	world.render();

	// Stream our position to the room.
	if (player && state && (state.phase === PHASE.PLAYING || state.phase === PHASE.COUNTDOWN)) {
		netAccum += dt;
		if (netAccum >= 1 / POS_HZ) {
			netAccum = 0;
			sendPosition();
		}
	}

	if (state) {
		const enriched = {
			...state,
			serverNow: net.serverNow(),
			checkpointTotal: track?.checkpoints.length ?? 0,
		};
		ui.updateTimer(enriched, myId);
		if (state.phase === PHASE.RESULTS) ui.updateResultsTimer(state.phaseEndsAt - net.serverNow());
	}

	requestAnimationFrame(frame);
}

/* -------------------------------------------------------------------- boot */

ui.bind({
	create: () => {
		ui.showError("");
		net.rememberJoin({ type: "create", name: ui.nick() });
		net.send({ t: "create", name: ui.nick() });
	},
	join: () => {
		ui.showError("");
		const code = ui.el.codeInput.value.trim().toUpperCase();
		if (code.length !== 4) {
			ui.showError("Код состоит из 4 символов");
			return;
		}
		net.rememberJoin({ type: "join", code, name: ui.nick() });
		net.send({ t: "join", code, name: ui.nick() });
	},
	start: () => net.send({ t: "start" }),
	leave: () => {
		if (!inRoom) return;
		net.forgetJoin();
		net.send({ t: "leave" });
		resetToMenu();
	},
	pause: () => {
		if (canPause()) setPaused(!paused);
	},
	resume: () => setPaused(false),
	exit: () => {
		if (!inRoom) return;
		net.forgetJoin();
		net.send({ t: "leave" });
		ui.showError("Вы вышли из комнаты");
		resetToMenu();
	},
	copy: async () => {
		const code = ui.el.roomCode.textContent.trim();
		try {
			await navigator.clipboard.writeText(code);
			ui.toast(`Код ${code} скопирован`);
		} catch {
			ui.toast(`Код: ${code}`);
		}
	},
});

// H toggles the control hints, N the nametags, Esc the pause menu.
addEventListener("keydown", (e) => {
	if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName ?? "")) return;
	if (e.code === "KeyH") {
		ui.toggleControls();
		return;
	}
	if (e.code === "KeyN") {
		toggleNames();
		return;
	}
	if (e.code === "Escape") {
		if (!canPause()) return;
		e.preventDefault();
		setPaused(!paused);
	}
});

// Some browsers swallow the Escape keydown when they release pointer lock, so treat a
// real lock release as an Esc press as well.
document.addEventListener("pointerlockchange", () => {
	const locked = !!document.pointerLockElement;
	if (wasLocked && !locked && !paused && canPause()) setPaused(true);
	wasLocked = locked;
});

// Preview world behind the menu, from a random seed.
ensureWorld((Math.random() * 0xffffffff) >>> 0, true);
ui.show("menu");
requestAnimationFrame(frame);

// Debug handle: inspect the live scene from the console.
window.__fr = {
	get world() {
		return world;
	},
	get track() {
		return track;
	},
	get view() {
		return view;
	},
	get player() {
		return player;
	},
	get remotes() {
		return remotes;
	},
	get state() {
		return state;
	},
	get myId() {
		return myId;
	},
	net,
	ui,
};

net
	.connect()
	.catch((err) => ui.showError(err.message));
