// Thin WebSocket wrapper: typed message dispatch plus a clock offset so the HUD can
// countdown against server time instead of the local clock.
//
// The socket is auto-reconnected with a capped backoff, because a server restart or a
// dropped Wi-Fi link would otherwise silently kill a player who is mid-round.

const RECONNECT_STEPS_MS = [400, 900, 1800, 3500, 6000];
const RECONNECT_MAX_MS = 8000;

export class Net {
	constructor() {
		this.socket = null;
		this.handlers = new Map();
		this.offset = 0; // serverNow = Date.now() + offset
		this.myId = null;
		this.connected = false;
		this.hasJoined = false; // once true, a close means "lost the room"
		this.attempt = 0;
		this.reconnectTimer = null;
		this.intentionalClose = false;
	}

	connect() {
		this.intentionalClose = false;
		return new Promise((resolve, reject) => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const socket = new WebSocket(`${proto}://${location.host}/ws`);
			this.socket = socket;

			socket.addEventListener("open", () => {
				this.connected = true;
				this.attempt = 0;
				// A reconnect only helps if we put ourselves back into the room.
				if (this.hasJoined) this.rejoin();
				resolve();
			});

			socket.addEventListener("error", () => {
				if (!this.connected) reject(new Error("Нет связи с сервером"));
			});

			socket.addEventListener("close", () => {
				this.connected = false;
				this.scheduleReconnect();
				this.emit("__closed", { joined: this.hasJoined });
			});

			socket.addEventListener("message", (event) => {
				let msg;
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}
				if (typeof msg.now === "number") this.offset = msg.now - Date.now();
				if (msg.t === "joined") {
					this.myId = msg.id;
					this.hasJoined = true;
				}
				this.emit(msg.t, msg);
			});
		});
	}

	/** Re-open the socket after a short, capped backoff. */
	scheduleReconnect() {
		if (this.intentionalClose || this.reconnectTimer) return;
		if (!this.hasJoined) return; // never in a room, nothing worth restoring
		const delay =
			RECONNECT_STEPS_MS[Math.min(this.attempt, RECONNECT_STEPS_MS.length - 1)];
		this.attempt++;
		this.emit("__reconnecting", { delay });
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch(() => this.scheduleReconnect());
		}, Math.min(delay, RECONNECT_MAX_MS));
	}

	/** Re-enter the room we were in. Call this after the socket reports open again. */
	rejoin() {
		if (!this.lastJoin) return;
		if (this.lastJoin.type === "create") this.send({ t: "create", name: this.lastJoin.name });
		else this.send({ t: "join", code: this.lastJoin.code, name: this.lastJoin.name });
	}

	/** Remember how this session entered a room so it can be restored. */
	rememberJoin(entry) {
		this.lastJoin = entry;
	}

	/** Drop the saved room: after a deliberate exit we must not come back. */
	forgetJoin() {
		this.lastJoin = null;
		this.hasJoined = false;
	}

	on(type, fn) {
		if (!this.handlers.has(type)) this.handlers.set(type, []);
		this.handlers.get(type).push(fn);
		return this;
	}

	emit(type, payload) {
		const list = this.handlers.get(type);
		if (!list) return;
		for (const fn of list) fn(payload);
	}

	send(obj) {
		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(obj));
			return true;
		}
		return false;
	}

	serverNow() {
		return Date.now() + this.offset;
	}

	/** Milliseconds until a server timestamp, floored at zero. */
	msUntil(ts) {
		return Math.max(0, ts - this.serverNow());
	}
}
