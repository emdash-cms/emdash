import { JetstreamSubscription } from "@atcute/jetstream";
import { DurableObject } from "cloudflare:workers";

import { createD1DiscoveryCursorStore } from "./discovery/cursor.js";
import { DiscoveryStreamIngestor } from "./discovery/ingestor.js";
import { logEvent } from "./observability.js";

const WANTED_COLLECTIONS = [
	"com.emdashcms.experimental.package.profile",
	"com.emdashcms.experimental.package.release",
];

export interface DiscoveryStatus {
	configured: true;
	running: boolean;
	ready: boolean;
	cursor: string | null;
	consecutiveFailures: number;
	reason?: "awaiting-start" | "connecting" | "stream-unavailable";
}

export class LabelerDiscoveryDO extends DurableObject<Env> {
	#runPromise: Promise<void> | undefined;
	#ready = false;
	#consecutiveFailures = 0;
	#reason: DiscoveryStatus["reason"] = "awaiting-start";

	async status(): Promise<DiscoveryStatus> {
		const cursor = await createD1DiscoveryCursorStore(this.env.DB, "jetstream-enqueued").read();
		return {
			configured: true,
			running: this.#runPromise !== undefined,
			ready: this.#ready,
			cursor,
			consecutiveFailures: this.#consecutiveFailures,
			...(this.#reason ? { reason: this.#reason } : {}),
		};
	}

	async wake(scheduledTime: number): Promise<void> {
		if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
			throw new TypeError("discovery wake timestamp is invalid");
		}
		this.#start();
	}

	#start(): void {
		if (this.#runPromise) return;
		this.#reason = "connecting";
		const running = this.#runLoop()
			.catch((error) => {
				this.#ready = false;
				this.#reason = "stream-unavailable";
				logEvent("error", "discovery_loop_stopped", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#runPromise === running) this.#runPromise = undefined;
			});
		this.#runPromise = running;
		this.ctx.waitUntil(running);
	}

	async #runLoop(): Promise<void> {
		const cursor = createD1DiscoveryCursorStore(this.env.DB, "jetstream-enqueued");
		const ingestor = new DiscoveryStreamIngestor({
			queue: this.env.DISCOVERY_QUEUE,
			cursor,
		});
		for (;;) {
			let opened = false;
			let connectionFailureLogged = false;
			try {
				const current = await cursor.read();
				const subscription = new JetstreamSubscription({
					url: this.env.JETSTREAM_URL,
					wantedCollections: [...WANTED_COLLECTIONS],
					...(current === null ? {} : { cursor: Number(current) }),
					onConnectionOpen: () => {
						opened = true;
						connectionFailureLogged = false;
						this.#ready = true;
						this.#reason = undefined;
						this.#consecutiveFailures = 0;
					},
					onConnectionClose: (event) => {
						if (!connectionFailureLogged) {
							connectionFailureLogged = true;
							logEvent("warn", "discovery_stream_connection_closed", {
								code: event.code,
								reason: event.reason,
							});
						}
						this.#ready = false;
						this.#reason = "connecting";
					},
					onConnectionError: (event) => {
						if (!connectionFailureLogged) {
							connectionFailureLogged = true;
							logEvent("warn", "discovery_stream_connection_error", {
								message: event.message,
							});
						}
						this.#ready = false;
						this.#reason = "stream-unavailable";
					},
				});
				await ingestor.consume(subscription);
				if (!opened) this.#consecutiveFailures += 1;
			} catch (error) {
				this.#ready = false;
				this.#reason = "stream-unavailable";
				this.#consecutiveFailures += 1;
				logEvent("warn", "discovery_stream_retry", {
					consecutiveFailures: this.#consecutiveFailures,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** this.#consecutiveFailures)),
			);
		}
	}
}
