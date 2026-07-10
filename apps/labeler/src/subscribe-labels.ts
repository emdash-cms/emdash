import { encode, toBytes } from "@atcute/cbor";
import { DurableObject } from "cloudflare:workers";

import type { IssuedLabel } from "./service.js";

export const LABEL_SUBSCRIPTION_DO_NAME = "main";

const REPLAY_PAGE_SIZE = 100;
const MAX_CONNECTION_BYTES = 1_000_000;
const MAX_HIGH_PRIORITY_QUEUE = 100;
const MAX_LOW_PRIORITY_QUEUE = 100;

interface StoredLabelRow {
	sequence: number;
	ver: number;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	exp: string | null;
	sig: ArrayBuffer;
}

interface SubscriptionEvent {
	sequence: number;
	label: IssuedLabel["label"];
}

interface SubscriptionState {
	lastSent: number;
	targetSequence: number;
	replaying: boolean;
}

interface QueueItem {
	run(): Promise<void>;
}

export interface LabelPublisher {
	publish(issued: IssuedLabel): Promise<void>;
}

export function createLabelPublisher(env: Env): LabelPublisher {
	const subscription = env.LABEL_SUBSCRIPTION.getByName(LABEL_SUBSCRIPTION_DO_NAME);
	return {
		async publish(issued) {
			const response = await subscription.fetch("https://labeler.internal/notify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sequence: issued.sequence }),
			});
			if (!response.ok) throw new Error(`label notification failed with ${response.status}`);
		},
	};
}

/** Singleton public label subscription. D1 remains the retained source of truth. */
export class LabelSubscriptionDO extends DurableObject {
	private readonly highPriority: QueueItem[] = [];
	private readonly lowPriority: QueueItem[] = [];
	private draining = false;
	private deliveryScheduled = false;
	private deliveryCursor = 0;

	override webSocketClose(): void {}

	override fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const priority = request.method === "POST" && url.pathname === "/notify" ? "high" : "low";
		const queue = priority === "high" ? this.highPriority : this.lowPriority;
		const maxQueueSize = priority === "high" ? MAX_HIGH_PRIORITY_QUEUE : MAX_LOW_PRIORITY_QUEUE;
		if (queue.length >= maxQueueSize)
			return Promise.resolve(new Response("label subscriptions are busy", { status: 503 }));
		return this.enqueue(priority, () => this.handleFetch(request));
	}

	private async handleFetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/notify") {
			const sequence = notificationSequence(await request.json<unknown>());
			if (sequence === null) return new Response(null, { status: 400 });
			if (!(await this.labelAt(sequence))) return new Response(null, { status: 404 });
			this.broadcastThrough(sequence);
			return new Response(null, { status: 204 });
		}

		const suppliedCursor = url.searchParams.get("cursor");
		const cursor = suppliedCursor === null ? null : Number(suppliedCursor);
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		if (!client || !server) throw new Error("failed to create WebSocket pair");

		const replayUntil = await this.currentSequence();
		this.ctx.acceptWebSocket(server);
		this.setState(server, {
			lastSent: cursor ?? replayUntil,
			targetSequence: replayUntil,
			replaying: cursor !== null,
		});
		if (cursor !== null && cursor > replayUntil) {
			this.sendError(server, "FutureCursor", "cursor is ahead of the stream");
			return new Response(null, { status: 101, webSocket: client });
		}
		if (cursor !== null) this.scheduleDelivery();
		return new Response(null, { status: 101, webSocket: client });
	}

	private async currentSequence(): Promise<number> {
		const row = await this.env.DB.prepare(
			"SELECT MAX(sequence) AS sequence FROM issued_labels",
		).first<{
			sequence: number | null;
		}>();
		return row?.sequence ?? 0;
	}

	private broadcastThrough(sequence: number): void {
		for (const socket of this.ctx.getWebSockets()) {
			const state = this.state(socket);
			if (sequence <= state.targetSequence) continue;
			state.targetSequence = sequence;
			this.setState(socket, state);
		}
		this.scheduleDelivery();
	}

	private scheduleDelivery(): void {
		if (this.deliveryScheduled) return;
		this.deliveryScheduled = true;
		this.ctx.waitUntil(this.enqueue("low", () => this.deliverNextPage()));
	}

	private async deliverNextPage(): Promise<void> {
		this.deliveryScheduled = false;
		const pending = this.pendingSockets();
		const socket = pending[this.deliveryCursor % pending.length];
		if (!socket) return;
		this.deliveryCursor++;
		try {
			const state = this.state(socket);
			if (state.lastSent >= state.targetSequence) {
				if (state.replaying) {
					state.replaying = false;
					this.setState(socket, state);
				}
				return;
			}
			const labels = await this.labelsAfter(state.lastSent, state.targetSequence);
			for (const event of labels) {
				if (!this.send(socket, event)) break;
			}
			const updated = this.state(socket);
			if (updated.lastSent >= updated.targetSequence && updated.replaying) {
				updated.replaying = false;
				this.setState(socket, updated);
			}
		} catch {
			socket.close(1011, "failed to replay label events");
		}
		if (this.pendingSockets().length > 0) this.scheduleDelivery();
	}

	private pendingSockets(): WebSocket[] {
		return this.ctx.getWebSockets().filter((socket) => {
			if (socket.readyState !== WebSocket.OPEN) return false;
			const state = this.state(socket);
			return state.lastSent < state.targetSequence;
		});
	}

	private async labelsAfter(cursor: number, through: number): Promise<SubscriptionEvent[]> {
		const rows = await this.env.DB.prepare(
			`SELECT sequence, ver, src, uri, cid, val, neg, cts, exp, sig
			 FROM issued_labels
			 WHERE sequence > ? AND sequence <= ?
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
			.bind(cursor, through, REPLAY_PAGE_SIZE)
			.all<StoredLabelRow>();
		return (rows.results ?? []).map((row) => ({
			sequence: row.sequence,
			label: rowToLabel(row),
		}));
	}

	private async labelAt(sequence: number): Promise<SubscriptionEvent | null> {
		const row = await this.env.DB.prepare(
			`SELECT sequence, ver, src, uri, cid, val, neg, cts, exp, sig
			 FROM issued_labels WHERE sequence = ?`,
		)
			.bind(sequence)
			.first<StoredLabelRow>();
		return row ? { sequence: row.sequence, label: rowToLabel(row) } : null;
	}

	private send(socket: WebSocket, event: SubscriptionEvent): boolean {
		const state = this.state(socket);
		if (event.sequence <= state.lastSent) return true;
		const frame = encodeLabelEvent(event.sequence, event.label);
		if (
			socket.readyState !== WebSocket.OPEN ||
			bufferedBytes(socket) + frame.byteLength > MAX_CONNECTION_BYTES
		) {
			socket.close(1013, "subscriber must reconnect with a cursor");
			return false;
		}
		try {
			socket.send(frame);
			this.setState(socket, {
				lastSent: event.sequence,
				targetSequence: state.targetSequence,
				replaying: state.replaying,
			});
			return true;
		} catch {
			socket.close(1011, "failed to send label event");
			return false;
		}
	}

	private sendError(socket: WebSocket, error: string, message: string): void {
		socket.send(encodeEvent({ op: -1 }, { error, message }));
		socket.close(1000, message);
	}

	private state(socket: WebSocket): SubscriptionState {
		const state = socket.deserializeAttachment();
		if (!isSubscriptionState(state)) throw new Error("subscription is missing state");
		return state;
	}

	private setState(socket: WebSocket, state: SubscriptionState): void {
		socket.serializeAttachment(state);
	}

	private enqueue<T>(priority: "high" | "low", task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const item: QueueItem = {
				async run() {
					try {
						resolve(await task());
					} catch (error) {
						reject(error);
					}
				},
			};
			(priority === "high" ? this.highPriority : this.lowPriority).push(item);
			if (!this.draining) void this.drainQueue();
		});
	}

	private async drainQueue(): Promise<void> {
		this.draining = true;
		while (this.highPriority.length > 0 || this.lowPriority.length > 0) {
			const item = this.highPriority.shift() ?? this.lowPriority.shift();
			await item?.run();
		}
		this.draining = false;
	}
}

function rowToLabel(row: StoredLabelRow): IssuedLabel["label"] {
	return {
		ver: 1,
		src: row.src,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts: row.cts,
		...(row.exp === null ? {} : { exp: row.exp }),
		sig: new Uint8Array(row.sig),
	};
}

function encodeLabelEvent(sequence: number, label: IssuedLabel["label"]): Uint8Array {
	return encodeEvent(
		{ op: 1, t: "#labels" },
		{
			seq: sequence,
			labels: [{ ...label, sig: toBytes(label.sig) }],
		},
	);
}

function encodeEvent(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
): Uint8Array {
	const encodedHeader = encode(header);
	const encodedPayload = encode(payload);
	const frame = new Uint8Array(encodedHeader.length + encodedPayload.length);
	frame.set(encodedHeader);
	frame.set(encodedPayload, encodedHeader.length);
	return frame;
}

function notificationSequence(value: unknown): number | null {
	return isRecord(value) &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence > 0
		? value.sequence
		: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isSubscriptionState(value: unknown): value is SubscriptionState {
	return (
		isRecord(value) &&
		typeof value.lastSent === "number" &&
		typeof value.targetSequence === "number" &&
		typeof value.replaying === "boolean"
	);
}

function bufferedBytes(socket: WebSocket): number {
	return "bufferedAmount" in socket && typeof socket.bufferedAmount === "number"
		? socket.bufferedAmount
		: 0;
}
