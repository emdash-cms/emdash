import type { DiscoveryCursorStore } from "./cursor.js";
import type { DiscoveryStreamItem } from "./events.js";

const WANTED_COLLECTIONS = new Set([
	"com.emdashcms.experimental.package.profile",
	"com.emdashcms.experimental.package.release",
]);

export interface DiscoveryQueueProducer {
	send(item: DiscoveryStreamItem): Promise<unknown>;
}

export interface DiscoveryStreamIngestorOptions {
	queue: DiscoveryQueueProducer;
	cursor: DiscoveryCursorStore;
	now?: () => Date;
}

export class DiscoveryStreamIngestor {
	readonly #queue: DiscoveryQueueProducer;
	readonly #cursor: DiscoveryCursorStore;
	readonly #now: () => Date;

	constructor(options: DiscoveryStreamIngestorOptions) {
		this.#queue = options.queue;
		this.#cursor = options.cursor;
		this.#now = options.now ?? (() => new Date());
	}

	async consume(events: AsyncIterable<unknown>): Promise<string | null> {
		let cursor = await this.#cursor.read();
		for await (const event of events) {
			const next = eventCursor(event);
			if (cursor !== null && BigInt(next) < BigInt(cursor)) continue;
			if (isRelevantCommit(event)) {
				const id = await eventId(event);
				await this.#queue.send({
					cursor: next,
					eventId: id,
					orderKey: eventOrderKey(event, id),
					event,
				});
			}
			const observedAt = this.#now().toISOString();
			if (!(await this.#cursor.advance(cursor, next, observedAt))) {
				throw new Error("Jetstream discovery cursor changed concurrently");
			}
			cursor = next;
		}
		return cursor;
	}
}

function eventOrderKey(value: unknown, fallback: string): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"commit" in value &&
		typeof value.commit === "object" &&
		value.commit !== null &&
		"rev" in value.commit &&
		typeof value.commit.rev === "string" &&
		value.commit.rev.length > 0
	) {
		return `${value.commit.rev}:${fallback}`;
	}
	return fallback;
}

async function eventId(value: unknown): Promise<string> {
	if (typeof value !== "object" || value === null)
		throw new TypeError("Jetstream event is invalid");
	const material = JSON.stringify({
		time_us: "time_us" in value ? value.time_us : undefined,
		kind: "kind" in value ? value.kind : undefined,
		did: "did" in value ? value.did : undefined,
		commit:
			"commit" in value && typeof value.commit === "object" && value.commit !== null
				? {
						operation: "operation" in value.commit ? value.commit.operation : undefined,
						collection: "collection" in value.commit ? value.commit.collection : undefined,
						rkey: "rkey" in value.commit ? value.commit.rkey : undefined,
						cid: "cid" in value.commit ? value.commit.cid : undefined,
					}
				: undefined,
	});
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
	);
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function eventCursor(value: unknown): string {
	if (
		typeof value !== "object" ||
		value === null ||
		!("time_us" in value) ||
		typeof value.time_us !== "number" ||
		!Number.isSafeInteger(value.time_us) ||
		value.time_us < 0
	) {
		throw new TypeError("Jetstream event cursor is invalid");
	}
	return String(value.time_us);
}

function isRelevantCommit(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "commit" &&
		"commit" in value &&
		typeof value.commit === "object" &&
		value.commit !== null &&
		"collection" in value.commit &&
		typeof value.commit.collection === "string" &&
		WANTED_COLLECTIONS.has(value.commit.collection)
	);
}
