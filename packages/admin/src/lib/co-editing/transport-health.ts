/**
 * What a browser session has learned about co-editing transport: whether WebSockets reach the
 * server, and when an outdated admin last reloaded.
 */

/**
 * A session cookie, so the rule lasts as long as the browser session, in every tab. Its value is
 * `failed=<n>&opened=1&single=1`, each part present only when set.
 */
export const TRANSPORT_COOKIE = "emdash-co-editing";

const RELOAD_KEY = "emdash-co-editing-reload";
const FAILED_OPENS_TO_PIN = 3;
const RELOAD_GUARD_MS = 60_000;

export interface TransportHealth {
	/** The browser session joins in single-editor mode. */
	pinned(): boolean;
	recordOpened(): void;
	/**
	 * Records a socket that closed without opening. Returns true once the session is pinned: its
	 * third such socket, while none has ever opened.
	 */
	recordFailedOpen(): boolean;
	recordOutdatedReload(now: number): void;
	/** An outdated admin reloaded less than a minute ago, so a reload now could loop. */
	reloadedRecently(now: number): boolean;
}

interface CookieState {
	failed: number;
	opened: boolean;
	single: boolean;
}

export function createTransportHealth(): TransportHealth {
	return {
		pinned: () => readCookie().single,
		recordOpened() {
			const state = readCookie();
			if (!state.opened) writeCookie({ ...state, opened: true });
		},
		recordFailedOpen() {
			const state = readCookie();
			if (state.opened || state.single) return state.single;
			const failed = state.failed + 1;
			const single = failed >= FAILED_OPENS_TO_PIN;
			writeCookie({ ...state, failed, single });
			return single;
		},
		recordOutdatedReload(now) {
			try {
				sessionStorage.setItem(RELOAD_KEY, String(now));
			} catch {
				// Storage can be unavailable; the guard then never trips.
			}
		},
		reloadedRecently(now) {
			let last: number;
			try {
				last = Number(sessionStorage.getItem(RELOAD_KEY));
			} catch {
				return false;
			}
			return last > 0 && now - last < RELOAD_GUARD_MS;
		},
	};
}

function readCookie(): CookieState {
	const prefix = `${TRANSPORT_COOKIE}=`;
	const raw = document.cookie
		.split("; ")
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
	const params = new URLSearchParams(raw ?? "");
	const failed = Number(params.get("failed"));
	return {
		failed: Number.isInteger(failed) && failed > 0 ? failed : 0,
		opened: params.get("opened") === "1",
		single: params.get("single") === "1",
	};
}

function writeCookie(state: CookieState): void {
	const params = new URLSearchParams();
	if (state.failed > 0) params.set("failed", String(state.failed));
	if (state.opened) params.set("opened", "1");
	if (state.single) params.set("single", "1");
	const secure = location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `${TRANSPORT_COOKIE}=${params.toString()}; Path=${adminBase()}; SameSite=Lax${secure}`;
}

/** `/_emdash` under whatever base path the site serves the admin from. */
function adminBase(): string {
	const index = location.pathname.indexOf("/_emdash/");
	// A cookie is readable only on pages under its path.
	return index >= 0 ? `${location.pathname.slice(0, index)}/_emdash` : "/";
}
