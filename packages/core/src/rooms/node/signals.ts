/**
 * `SIGTERM` and `SIGINT` while rooms hold claims: the rooms hand off, then the process stops as it
 * would have.
 */

import { SHUTDOWN_WAIT_MS } from "../limits.js";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** What signal handling needs from a registry. */
export interface SignalRegistry {
	readonly holdsClaims: boolean;
	shutdown(): Promise<void>;
}

interface SignalState {
	/** Registries that haven't started shutting down. */
	registries: Set<SignalRegistry>;
	/** The one listener for both signals while it is installed. */
	listener: ((signal: NodeJS.Signals) => void) | null;
}

// A development restart runs this module again, so its registries and listener must be shared.
const STATE_KEY = Symbol.for("emdash:rooms:signals");
const store = globalThis as Record<symbol, unknown>;

function state(): SignalState {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let current = store[STATE_KEY] as SignalState | undefined;
	if (!current) {
		current = { registries: new Set(), listener: null };
		store[STATE_KEY] = current;
	}
	return current;
}

/** Counts a registry as live until it starts shutting down. */
export function trackRegistry(registry: SignalRegistry): void {
	state().registries.add(registry);
}

/** Stops counting a registry. Call it before the registry's first `await` in `shutdown`. */
export function untrackRegistry(registry: SignalRegistry): void {
	state().registries.delete(registry);
	updateSignalListeners();
}

/** Listens, ahead of any other listener, exactly while a live registry's room holds a claim. */
export function updateSignalListeners(): void {
	const current = state();
	const needed = [...current.registries].some((registry) => registry.holdsClaims);
	if (needed && !current.listener) {
		current.listener = onSignal;
		for (const signal of SIGNALS) process.prependListener(signal, onSignal);
	} else if (!needed && current.listener) {
		stopListening(current);
	}
}

function stopListening(current: SignalState): void {
	const { listener } = current;
	if (!listener) return;
	current.listener = null;
	for (const signal of SIGNALS) process.removeListener(signal, listener);
}

function onSignal(signal: NodeJS.Signals): void {
	const current = state();
	stopListening(current);
	// Each registry leaves the set as its shutdown starts, so none reinstalls the listener.
	void shutDown([...current.registries], signal);
}

async function shutDown(registries: SignalRegistry[], signal: NodeJS.Signals): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(registries.map((registry) => registry.shutdown())),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
				if (typeof timer === "object" && "unref" in timer) timer.unref();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	// Another listener decides when the process stops; with none, it stops as it would have.
	if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
