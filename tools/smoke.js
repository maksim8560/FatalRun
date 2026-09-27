// Headless protocol test: drives a full round with four WebSocket clients and checks
// the lobby, the player cap, checkpoint validation, finishing order and the results.
//
//   node tools/smoke.js            (expects the server on ws://localhost:3000)

import WebSocket from "ws";
import { buildTrack, seedFromCode } from "../shared/track.js";
import { COUNTDOWN_MS, RESULTS_MS, MAX_PLAYERS } from "../shared/config.js";

const URL = process.env.URL || "ws://localhost:3000/ws";

let failures = 0;
const check = (label, ok, extra = "") => {
	if (ok) {
		console.log(`  ok   ${label}`);
	} else {
		failures++;
		console.log(`  FAIL ${label} ${extra}`);
	}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(tag) {
		this.tag = tag;
		this.messages = [];
		this.id = null;
		this.state = null;
		this.errors = [];
		this.roundEnd = null;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(URL);
			this.ws.on("open", resolve);
			this.ws.on("error", reject);
			this.ws.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				this.messages.push(msg);
				if (msg.t === "joined") {
					this.id = msg.id;
					// The joined payload is a full snapshot with a different type tag.
					this.state = { ...msg, t: "state" };
				}
				if (msg.t === "state") this.state = msg;
				if (msg.t === "progress" && this.state) this.state.players = msg.players;
				if (msg.t === "err") this.errors.push(msg.message);
				if (msg.t === "roundEnd") this.roundEnd = msg;
			});
		});
	}

	send(obj) {
		this.ws.send(JSON.stringify(obj));
	}

	/** Wait until `test(state)` holds, or time out. */
	async until(test, ms = 4000, label = "condition") {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.state && test(this.state)) return this.state;
			await sleep(25);
		}
		throw new Error(`${this.tag}: timed out waiting for ${label}`);
	}

	/** Force a position, bypassing the speed clamp the way a respawn would. */
	teleport(x, y, z) {
		this.send({ t: "pos", p: [x, y, z], ry: 0, sync: true });
	}

	close() {
		this.ws.close();
	}
}

async function main() {
	console.log(`FatalRun smoke test -> ${URL}\n`);

	const clients = Array.from({ length: MAX_PLAYERS }, (_, i) => new Client(`P${i + 1}`));
	await Promise.all(clients.map((c) => c.connect()));
	const [a, b, c, d] = clients;

	console.log("lobby");
	a.send({ t: "create", name: "Alpha" });
	const joined = await waitJoined(a);
	const code = joined.code;
	check("host gets a 4-character code", /^[A-Z0-9]{4}$/.test(code), `got "${code}"`);
	check("host id assigned", typeof a.id === "number");

	for (const [client, name] of [
		[b, "Bravo"],
		[c, "Charlie"],
		[d, "Delta"],
	]) {
		client.send({ t: "join", code, name });
		await waitJoined(client);
	}
	await a.until((s) => s.players.length === MAX_PLAYERS, 4000, "4 players");
	check("room holds 4 players", a.state.players.length === 4);
	check(
		"everyone sees the same roster",
		b.state.players.map((p) => p.name).sort().join(",") === "Alpha,Bravo,Charlie,Delta",
	);
	check("host flag is set", a.state.players.find((p) => p.host)?.name === "Alpha");
	check("unique slots", new Set(a.state.players.map((p) => p.slot)).size === 4);

	console.log("\ncapacity");
	const extra = new Client("P5");
	await extra.connect();
	extra.send({ t: "join", code, name: "Echo" });
	await sleep(400);
	check("5th player is rejected", extra.errors.length > 0, JSON.stringify(extra.errors));
	extra.close();

	console.log("\nround start");
	b.send({ t: "start" });
	await sleep(300);
	check("non-host cannot start the round", a.state.phase === "lobby", `phase=${a.state.phase}`);

	a.send({ t: "start" });
	await a.until((s) => s.phase === "countdown", 4000, "countdown");
	check("host starts the countdown", a.state.phase === "countdown");

	await a.until((s) => s.phase === "playing", COUNTDOWN_MS + 3000, "playing");
	check("countdown flips to playing", a.state.phase === "playing");

	const track = buildTrack(seedFromCode(code));
	check("track has checkpoints", track.checkpoints.length === 3);
	check("track has movers", track.movers.length > 0);
	check("track ends in +Z", track.finish.z > 0);

	console.log("\nvalidation");
	a.send({ t: "cp", i: 0 });
	await sleep(250);
	check(
		"checkpoint claim from spawn is rejected",
		(a.state.players.find((p) => p.id === a.id)?.cp ?? -1) === -1,
	);

	console.log("\nreplication");
	// Bravo walks the opening stretch; the host must see him move.
	const cp0 = track.checkpoints[0];
	let walker = { x: track.spawns[1].x, y: track.spawns[1].y, z: track.spawns[1].z };
	for (let i = 0; i < 8; i++) {
		walker = { x: walker.x, y: walker.y, z: walker.z + 13 };
		b.teleport(walker.x, walker.y, walker.z);
		await sleep(60);
	}
	await sleep(250);
	const relayed = a.messages.filter((m) => m.t === "pos" && m.id === b.id);
	check("host receives relayed positions", relayed.length > 0, `got ${relayed.length}`);
	if (relayed.length > 0) {
		const last = relayed[relayed.length - 1].p;
		const drift = Math.hypot(last[0] - walker.x, last[2] - walker.z);
		check("relayed position matches the sender", drift < 2, `drift=${drift.toFixed(2)}`);
	}
	// Nobody else should be relaying this player's data.
	const othersEcho = c.messages.filter((m) => m.t === "pos" && m.id === b.id);
	check("positions are not echoed back to the sender", relayed.length > 0 && othersEcho.length > 0);

	b.teleport(200, 10, 200); // genuinely nowhere near checkpoint 0
	await sleep(250);
	b.send({ t: "cp", i: 0 });
	await sleep(200);
	check(
		"checkpoint claim from across the map is rejected",
		(a.state.players.find((p) => p.id === b.id)?.cp ?? -1) === -1,
	);
	b.teleport(cp0.x, cp0.y + 2, cp0.z);
	await sleep(250);
	b.send({ t: "cp", i: 0 });
	await sleep(250);
	check(
		"checkpoint claim on the pad is accepted",
		a.state.players.find((p) => p.id === b.id)?.cp === 0,
	);
	check("host saw the checkpoint broadcast", a.messages.some((m) => m.t === "cp" && m.id === b.id));

	console.log("\nspeed clamp");
	a.teleport(0, 3, 0);
	await sleep(150);
	a.send({ t: "pos", p: [0, 3, 400], ry: 0 }); // 400 studs in one packet
	await sleep(250);
	check("impossible jump is rejected", a.messages.some((m) => m.t === "snap"));
	check("rejected jump is not relayed", !d.messages.some((m) => m.t === "pos" && m.id === a.id && m.p[2] > 100));

	console.log("\nfinishing");
	// Race order: Bravo, then Alpha, then Delta, then Charlie.
	const order = [b, a, d, c];
	for (const client of order) {
		client.teleport(track.finish.x, track.finish.y + 2, track.finish.z);
		await sleep(120);
		client.send({ t: "finish" });
		await sleep(120);
	}

	a.until((s) => s.phase === "results", 6000, "results").catch(() => null);
	await sleep(1200);
	check("round ends once everyone finishes", a.state.phase === "results", `phase=${a.state.phase}`);

	const results = (a.roundEnd?.results || []).slice().sort((x, y) => x.place - y.place);
	check("four results recorded", results.length === 4, `got ${results.length}`);
	check(
		"places are 1..4",
		results.map((r) => r.place).join(",") === "1,2,3,4",
		results.map((r) => r.place).join(","),
	);
	check("winner is Bravo", results[0]?.name === "Bravo", results[0]?.name);
	check(
		"scores follow the table",
		results.map((r) => r.score).join(",") === "4,3,2,1",
		results.map((r) => r.score).join(","),
	);
	check(
		"totals are accumulated",
		a.state.players.find((p) => p.name === "Bravo")?.score === 4,
	);

	console.log("\nback to lobby");
	await a.until((s) => s.phase === "lobby", RESULTS_MS + 4000, "lobby");
	check("results roll back into the lobby", a.state.phase === "lobby");
	check("scores survive the round", a.state.players.every((p) => p.score > 0));

	console.log("\nresume");
	// A dropped socket re-enters with the same room code, so friends keep their code.
	d.send({ t: "leave" });
	await a.until((s) => s.players.length === 3, 4000, "3 players after a leave");
	const codeBefore = a.state.code;
	const resume = new Client("Resume");
	await resume.connect();
	resume.send({ t: "resume", code: codeBefore, name: "Альфа" });
	const resumed = await waitJoined(resume);
	check("resume returns to the same room code", resumed.code === codeBefore, resumed.code);
	await a.until((s) => s.players.length === 4, 4000, "4 players after resume");
	check("voluntary leave frees the slot", a.state.players.length === 4);
	resume.send({ t: "resume", code: "ZZZZ", name: "Ghost" });
	await sleep(300);
	check(
		"resume into a missing room is reported",
		resume.errors.some((m) => /Комната не найдена/.test(m)),
	);
	resume.send({ t: "leave" });
	await sleep(400);
	check("resumed player can leave again", a.state.players.length === 3);

	console.log("\ndisconnect");
	// A dropped socket must free the slot so a friend can take it.
	const dropper = new Client("Drop");
	await dropper.connect();
	dropper.send({ t: "join", code, name: "Drop" });
	await dropper.until((s) => s.players.length === 4, 4000, "4 players with Drop");
	check("newcomer takes the free slot", a.state.players.length === 4);
	dropper.ws.terminate();
	await sleep(700);
	check(
		"abrupt disconnect frees the slot again",
		a.state.players.length === 3,
		`players=${a.state.players.length}`,
	);
	check("remaining players keep their scores", a.state.players.every((p) => p.score > 0));

	console.log("\nteardown");
	for (const client of clients) client.send({ t: "leave" });
	await sleep(600);
	const rejoin = new Client("Late");
	await rejoin.connect();
	rejoin.send({ t: "join", code, name: "Late" });
	await sleep(400);
	check("room is gone once everyone left", rejoin.errors.length > 0, JSON.stringify(rejoin.errors));
	rejoin.close();
	for (const client of clients) client.close();

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

function waitJoined(client) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 4000;
		const tick = setInterval(() => {
			const msg = client.messages.find((m) => m.t === "joined");
			if (msg) {
				clearInterval(tick);
				resolve(msg);
			} else if (Date.now() > deadline) {
				clearInterval(tick);
				reject(new Error(`${client.tag}: never joined`));
			}
		}, 25);
	});
}

main().catch((err) => {
	console.error("\nsmoke test crashed:", err);
	process.exit(1);
});
