// Shared tuning values. Imported by both the Node server and the browser client,
// so this file must stay free of any platform-specific API.

export const MAX_PLAYERS = 4;

export const PHASE = {
	LOBBY: "lobby",
	COUNTDOWN: "countdown",
	PLAYING: "playing",
	RESULTS: "results",
};

export const COUNTDOWN_MS = 4000;
export const ROUND_MS = 150000;
export const RESULTS_MS = 14000;

// How often the client streams its position, in Hz.
export const POS_HZ = 15;

// Anti-cheat sanity clamp: a single position packet may not move the player
// further than this many studs. Prevents teleporting and rubber-banding abuse.
export const MAX_STEP_STUDS = 24;

// Snapshot interpolation threshold.
export const SNAP_DISTANCE = 2.0;

export const PLAYER = {
	halfWidth: 0.7,
	halfHeight: 1.8,
	walkSpeed: 15,
	sprintSpeed: 22,
	accel: 110,
	airAccel: 45,
	jumpVelocity: 48,
	gravity: 180,
	maxFallSpeed: 150,
	coyoteTime: 0.12,
	jumpBuffer: 0.13,
	mouseSensitivity: 0.0026,
	dragSensitivity: 0.0034,
	keyboardLookSpeed: 2.3, // radians per second
	turnSpeed: 12, // radians per second, body facing
	// Camera boom collision: studs per second it may retract / extend. Capping these
	// in absolute units is what stops the camera snapping when a gap opens up.
	camPullSpeed: 45,
	camPushSpeed: 7,
};

export const CODE_LENGTH = 4;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1, avoids misreads

// Points awarded by finishing position.
export const SCORE_TABLE = [4, 3, 2, 1, 0];

export const KILL_PLANE_Y = -40;
