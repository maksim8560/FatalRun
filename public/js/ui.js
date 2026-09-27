import { PHASE } from "/shared/config.js";

const $ = (id) => document.getElementById(id);

function fmt(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

const ORDINAL = ["1-е", "2-е", "3-е", "4-е"];

/** Owns every DOM screen. Pure presentation - it never touches the network. */
export class UI {
	constructor() {
		this.el = {
			menu: $("menu"),
			lobby: $("lobby"),
			hud: $("hud"),
			results: $("results"),
			loader: $("loader"),
			nick: $("nick"),
			codeInput: $("code-input"),
			menuError: $("menu-error"),
			roomCode: $("room-code"),
			playerList: $("player-list"),
			playerCount: $("player-count"),
			btnStart: $("btn-start"),
			lobbyHint: $("lobby-hint"),
			timer: $("timer"),
			roundNum: $("round-num"),
			cpList: $("cp-list"),
			countdown: $("countdown"),
			toast: $("toast"),
			placeBanner: $("place-banner"),
			resultsList: $("results-list"),
			resultsTitle: $("results-title"),
			resultsTimer: $("results-timer"),
			controls: $("controls"),
			pause: $("pause"),
			pauseInfo: $("pause-info"),
			btnPause: $("btn-pause"),
			btnResume: $("btn-resume"),
			btnExit: $("btn-exit"),
		};
		this.toastTimer = null;
		this.bannerTimer = null;
		this.lastCountdown = null;
		this.controlsHidden = localStorage.getItem("fr.controlsHidden") === "1";
		if (this.controlsHidden) this.el.controls.classList.add("off");
	}

	bind(handlers) {
		$("btn-create").addEventListener("click", handlers.create);
		$("btn-join").addEventListener("click", handlers.join);
		$("btn-start").addEventListener("click", handlers.start);
		$("btn-leave").addEventListener("click", handlers.leave);
		$("btn-copy").addEventListener("click", handlers.copy);
		this.el.btnPause.addEventListener("click", handlers.pause);
		this.el.btnResume.addEventListener("click", handlers.resume);
		this.el.btnExit.addEventListener("click", handlers.exit);

		this.el.codeInput.addEventListener("input", () => {
			this.el.codeInput.value = this.el.codeInput.value
				.toUpperCase()
				.replace(/[^A-Z0-9]/g, "")
				.slice(0, 4);
		});
		this.el.codeInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") handlers.join();
		});
	}

	nick() {
		return this.el.nick.value.trim() || "Player";
	}

	showError(text) {
		this.el.menuError.textContent = text || "";
	}

	/* ---------------------------------------------------------------- screens */

	show(which) {
		for (const key of ["menu", "lobby", "hud", "results"]) {
			this.el[key].classList.toggle("hidden", key !== which);
		}
	}

	hideAllOverlays() {
		this.el.menu.classList.add("hidden");
		this.el.lobby.classList.add("hidden");
		this.el.results.classList.add("hidden");
	}

	/** Back to the title screen after leaving a room. */
	showMenu() {
		this.show("menu");
		this.showPause(false);
		this.setPauseButton(false);
		this.setCountdown(null);
	}

	showLoader(v) {
		this.el.loader.classList.toggle("hidden", !v);
	}

	/** Route to the screen that matches the authoritative phase. */
	renderPhase(state, myId) {
		this.el.roundNum.textContent = state.round || 1;

		if (state.phase === PHASE.LOBBY) {
			this.show("lobby");
			this.el.roomCode.textContent = state.code;
			this.renderRoster(state, myId);

			const me = state.players.find((p) => p.id === myId);
			// Only the host may start, and there must be at least one player in the room.
			this.el.btnStart.disabled = !me || !me.host || state.players.length === 0;
			this.el.lobbyHint.textContent = this.startHint(state, myId);
			return;
		}

		if (state.phase === PHASE.COUNTDOWN || state.phase === PHASE.PLAYING) {
			this.hideAllOverlays();
			this.el.hud.classList.remove("hidden");
			this.renderRoster(state, myId, true);
			return;
		}

		if (state.phase === PHASE.RESULTS) this.show("results");
	}

	startHint(state, myId) {
		const me = state.players.find((p) => p.id === myId);
		if (!me) return "";
		if (!me.host) return "Ждём, пока хост начнёт раунд";
		if (state.players.length === 1) return "Можно начать и в одиночку — но вдруг придут друзья";
		return "Нажми «Начать раунд», когда все на месте";
	}

	/* ----------------------------------------------------------------- roster */

	renderRoster(state, myId, compact = false) {
		this.el.playerCount.textContent = `${state.players.length}/${state.maxPlayers}`;

		if (compact) {
			// In-game: small checkpoint list, ordered by progress.
			const total = state.checkpointTotal ?? 0;
			this.el.cpList.innerHTML = state.players
				.slice()
				.sort((a, b) => (b.cp ?? -1) - (a.cp ?? -1) || a.slot - b.slot)
				.map((p) => {
					const cls = p.finished ? "fin" : p.cp >= 0 ? "done" : "";
					const label = p.finished
						? `финиш ${ORDINAL[(p.place || 1) - 1] ?? p.place}`
						: total
							? `чекпоинт ${Math.max(0, p.cp + 1)}/${total}`
							: "на старте";
					return `<li class="${cls}"><span class="dot" style="background:#${p.color
						.toString(16)
						.padStart(6, "0")}"></span>${escapeHtml(p.name)}${
						p.id === myId ? " <span class='you'>вы</span>" : ""
					}<span class="pts">${label}</span></li>`;
				})
				.join("");
			return;
		}

		this.el.playerList.innerHTML = state.players
			.map(
				(p) => `<li>
					<span class="dot" style="background:#${p.color.toString(16).padStart(6, "0")}"></span>
					${escapeHtml(p.name)}
					${p.id === myId ? '<span class="tag">вы</span>' : ""}
					${p.host ? '<span class="tag host">хост</span>' : ""}
				</li>`,
			)
			.join("");
	}

	/* -------------------------------------------------------------------- hud */

	updateTimer(state, myId) {
		if (state.phase === PHASE.COUNTDOWN) {
			this.setCountdown(Math.ceil((state.phaseEndsAt - state.serverNow) / 1000));
			return;
		}
		this.setCountdown(null);
		if (state.phase !== PHASE.PLAYING) return;
		const left = Math.max(0, state.phaseEndsAt - state.serverNow);
		this.el.timer.textContent = fmt(left);
		this.el.timer.classList.toggle("urgent", left < 20000);
	}

	setCountdown(value) {
		const el = this.el.countdown;
		if (value === null) {
			if (!el.classList.contains("hidden")) el.classList.add("hidden");
			this.lastCountdown = null;
			return;
		}
		const text = value <= 0 ? "СТАРТ!" : String(value);
		if (text === this.lastCountdown && !el.classList.contains("hidden")) return;
		this.lastCountdown = text;
		el.textContent = text;
		el.classList.remove("hidden");
		// Restart the pop animation.
		el.style.animation = "none";
		void el.offsetHeight;
		el.style.animation = "";
	}

	toggleControls() {
		this.controlsHidden = !this.controlsHidden;
		this.el.controls.classList.toggle("off", this.controlsHidden);
		localStorage.setItem("fr.controlsHidden", this.controlsHidden ? "1" : "0");
	}

	/** Esc menu. `info` is a short line describing what Esc will do. */
	showPause(visible, info = "") {
		this.el.pause.classList.toggle("hidden", !visible);
		this.el.pauseInfo.textContent = info;
	}

	/** The Esc button only makes sense while a round is actually running. */
	setPauseButton(visible) {
		this.el.btnPause.classList.toggle("hidden", !visible);
	}

	toast(text, ms = 1800) {
		clearTimeout(this.toastTimer);
		this.el.toast.textContent = text;
		this.el.toast.classList.remove("hidden");
		this.toastTimer = setTimeout(() => this.el.toast.classList.add("hidden"), ms);
	}

	banner(text, ms = 1600) {
		clearTimeout(this.bannerTimer);
		this.el.placeBanner.textContent = text;
		this.el.placeBanner.classList.remove("hidden");
		this.bannerTimer = setTimeout(() => this.el.placeBanner.classList.add("hidden"), ms);
	}

	/* ---------------------------------------------------------------- results */

	showResults(state, myId) {
		const list = state.results || [];
		const reason =
			state.reason === "time_up" ? "Время вышло" : state.reason === "everyone_finished" ? "Все финишировали" : "Раунд завершён";
		this.el.resultsTitle.textContent = reason;

		this.el.resultsList.innerHTML = list
			.slice()
			.sort((a, b) => a.place - b.place)
			.map((entry, i) => {
				const player = state.players.find((p) => p.id === entry.id);
				const color = player ? `#${player.color.toString(16).padStart(6, "0")}` : "#888";
				const you = entry.id === myId ? " <span class='tag'>вы</span>" : "";
				const dnf = entry.dnf ? " <span class='tag'>не добежал</span>" : "";
				return `<li class="${i === 0 ? "first" : ""}" style="animation-delay:${i * 60}ms">
					<span class="place">${entry.place}</span>
					<span class="dot" style="background:${color}"></span>
					<span class="name">${escapeHtml(entry.name)}${you}${dnf}</span>
					<span class="score">+${entry.score}</span>
				</li>`;
			})
			.join("");

		this.show("results");
	}

	updateResultsTimer(ms) {
		this.el.resultsTimer.textContent = Math.ceil(ms / 1000);
	}
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
