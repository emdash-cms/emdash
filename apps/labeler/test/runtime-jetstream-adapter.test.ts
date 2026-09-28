import { JetstreamSubscription } from "@atcute/jetstream";
import { describe, expect, it } from "vitest";

const EVENT = {
	did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
	time_us: 1_787_778_000_000_000,
	kind: "commit",
	commit: {
		rev: "3m4vyn4rjyc2f",
		collection: "com.emdashcms.experimental.package.profile",
		rkey: "self",
		operation: "create",
		cid: "bafyreidc6gthvydj3wplg4tq7w3d4oqrogtcrfkm4rh55tyqowxzb5vtse",
		record: {},
	},
} as const;

describe("Jetstream Workerd compatibility", () => {
	it("accepts message events whose source is an outbound Workerd WebSocket", async () => {
		const subscription = new JetstreamSubscription({
			url: "wss://jetstream.example",
			wantedCollections: [EVENT.commit.collection],
			ws: {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test double implements the WebSocket surface Partysocket uses
				WebSocket: FakeWorkerdWebSocket as unknown as typeof WebSocket,
			},
		});
		const iterator = subscription[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ done: false, value: EVENT });
		await iterator.return?.();
	});
});

class FakeWorkerdWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readonly protocol = "";
	readonly extensions = "";
	readonly bufferedAmount = 0;
	binaryType: "blob" | "arraybuffer" = "blob";
	readyState = FakeWorkerdWebSocket.CONNECTING;
	#sentEvent = false;

	constructor(url: string | URL) {
		super();
		this.url = String(url);
		queueMicrotask(() => {
			this.readyState = FakeWorkerdWebSocket.OPEN;
			this.dispatchEvent(new Event("open"));
		});
	}

	send(): void {
		if (this.#sentEvent) return;
		this.#sentEvent = true;
		queueMicrotask(() => {
			const event = new MessageEvent("message", { data: JSON.stringify(EVENT) });
			Object.defineProperty(event, "source", { value: this });
			this.dispatchEvent(event);
		});
	}

	close(): void {
		this.readyState = FakeWorkerdWebSocket.CLOSED;
	}
}
