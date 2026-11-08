import type { EmDashRuntime } from "../emdash-runtime.js";
import { createInitLock, type InitLock } from "../utils/init-lock.js";

// SSR chunks and the dev-server plugin must share the same runtime and init lock.
const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
const store = globalThis as Record<symbol, unknown>;

interface RuntimeHolder {
	instance: EmDashRuntime | null;
	lock: InitLock;
	closed: boolean;
	shutdown?: Promise<void>;
}

export function getRuntimeHolder(): RuntimeHolder {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let holder = store[RUNTIME_HOLDER_KEY] as RuntimeHolder | undefined;
	if (!holder) {
		holder = { instance: null, lock: createInitLock(), closed: false };
		store[RUNTIME_HOLDER_KEY] = holder;
	}
	return holder;
}

export async function shutdownRuntime(): Promise<void> {
	delete store[Symbol.for("emdash:plugins")];
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	const holder = store[RUNTIME_HOLDER_KEY] as RuntimeHolder | undefined;
	if (!holder) return;

	if (holder.shutdown) return holder.shutdown;

	// Keep the closed holder installed until teardown finishes. Requests must
	// not initialize replacement plugins while the old runtime clears them.
	holder.closed = true;
	const runtime = holder.instance;
	holder.instance = null;
	holder.shutdown = Promise.resolve().then(async () => {
		try {
			await runtime?.shutdown();
		} catch (error) {
			console.error("[emdash] runtime shutdown failed:", error);
			throw error;
		} finally {
			if (store[RUNTIME_HOLDER_KEY] === holder) delete store[RUNTIME_HOLDER_KEY];
		}
	});
	return holder.shutdown;
}
