import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import { handleMessage, getRoomCount, destroyAll, getRoom, dropRoom } from "./rooms.js";
import { MAX_PLAYERS, ROUND_MS } from "../shared/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

// Static client.
app.use(express.static(path.join(root, "public")));

// Shared gameplay code, imported directly by the browser as an ES module.
app.use("/shared", express.static(path.join(root, "shared")));

// three.js straight from node_modules - no CDN, so the game runs offline.
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three", "build")));

app.get("/api/health", (_req, res) => {
	res.json({ ok: true, rooms: getRoomCount(), maxPlayers: MAX_PLAYERS, roundMs: ROUND_MS });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
	socket.isAlive = true;
	socket.on("pong", () => {
		socket.isAlive = true;
	});

	socket.on("message", (raw) => handleMessage(socket, raw.toString()));

	socket.on("close", () => {
		const code = socket.fr && socket.fr.code;
		if (!code) return;
		// The room owns the player objects; it also cleans itself up when empty.
		const room = getRoom(code);
		if (room && socket.fr.id !== undefined) {
			room.remove(socket.fr.id);
			room.pushState();
			dropRoom(code);
		}
	});

	socket.on("error", () => {});
});

// Drop dead sockets so abandoned rooms do not linger.
const heartbeat = setInterval(() => {
	for (const socket of wss.clients) {
		if (socket.isAlive === false) {
			socket.terminate();
			continue;
		}
		socket.isAlive = false;
		socket.ping();
	}
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
	console.log(`FatalRun  ->  http://localhost:${PORT}`);
	console.log(`rooms: ${getRoomCount()}  max players: ${MAX_PLAYERS}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		destroyAll();
		clearInterval(heartbeat);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 1000).unref();
	});
}
