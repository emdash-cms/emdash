import { DurableObject } from "cloudflare:workers";

import { storedRowToIssuedLabel, type StoredLabelRow } from "./labels/rows.js";
import { createRuntimeListingLabelSigner } from "./runtime-signer.js";
import {
	encodeLabelEvent,
	encodeSubscriptionError,
	type LabelSubscriptionEvent,
} from "./subscriptions/protocol.js";

const REPLAY_PAGE_SIZE = 100;
const MAX_CONNECTION_BYTES = 1_000_000;
const MAX_HIGH_PRIORITY_QUEUE = 100;
const MAX_LOW_PRIORITY_QUEUE = 100;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;

interface SubscriptionState {
	lastSent: number;
	targetSequence: number;
	replaying: boolean;
}

interface QueueItem {
	run(): Promise<void>;
}

export class LabelSubscriptionDO extends DurableObject<Env> {
	private readonly highPriority: QueueItem[] = [];
	private readonly lowPriority: QueueItem[] = [];
	private draining = false;
	private deliveryScheduled = false;
	private deliveryCursor = 0;

	async status(): Promise<{ ready: true }> {
		return { ready: true };
	}

	async notify(sequence: number): Promise<void> {
		if (!Number.isSafeInteger(sequence) || sequence < 1) {
			throw new TypeError("sequence must be a positive integer");
		}
		if (this.highPriority.length >= MAX_HIGH_PRIORITY_QUEUE) {
			throw new Error("label publication queue is full");
		}
		await this.enqueue("high", () => this.handleNotification(sequence));
	}

	override fetch(request: Request): Promise<Response> {
		if (this.lowPriority.length >= MAX_LOW_PRIORITY_QUEUE) {
			return Promise.resolve(new Response("label subscriptions are busy", { status: 503 }));
		}
		return this.enqueue("low", () => this.handleSubscription(request));
	}

	override webSocketClose(): void {}

	private async handleSubscription(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return new Response(null, { status: 405, headers: { allow: "GET" } });
		}
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		const rawCursor = new URL(request.url).searchParams.get("cursor");
		const cursor = parseCursor(rawCursor);
		if (rawCursor !== null && cursor === null) {
			return Response.json(
				{ error: "InvalidRequest", message: "cursor must be a non-negative integer" },
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}

		const replayUntil = await this.currentSequence();
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		this.setState(server, {
			lastSent: cursor ?? replayUntil,
			targetSequence: replayUntil,
			replaying: cursor !== null,
		});
		if (cursor !== null && cursor > replayUntil) {
			this.sendError(server, "FutureCursor", "cursor is ahead of the stream");
		} else if (cursor !== null && cursor < replayUntil) {
			this.scheduleDelivery();
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	private async handleNotification(sequence: number): Promise<void> {
		if (!(await this.labelAt(sequence))) {
			throw new Error(`issued label sequence ${sequence} does not exist`);
		}
		for (const socket of this.ctx.getWebSockets()) {
			const state = this.state(socket);
			if (sequence > state.targetSequence) {
				this.setState(socket, { ...state, targetSequence: sequence });
			}
		}
		await this.deliverThrough(sequence);
		await this.env.DB.prepare(
			`UPDATE issued_labels SET publication_pending = 0
			 WHERE sequence <= ? AND publication_pending = 1`,
		)
			.bind(sequence)
			.run();
		if (this.pendingSockets().length > 0) this.scheduleDelivery();
	}

	private async currentSequence(): Promise<number> {
		const row = await this.env.DB.prepare(
			"SELECT COALESCE(MAX(sequence), 0) AS sequence FROM issued_labels",
		).first<{ sequence: number }>();
		return row?.sequence ?? 0;
	}

	private async deliverThrough(through: number): Promise<void> {
		for (;;) {
			const sockets = this.ctx.getWebSockets().filter((socket) => {
				if (socket.readyState !== WebSocket.OPEN) return false;
				const state = this.state(socket);
				return state.lastSent < Math.min(state.targetSequence, through);
			});
			if (sockets.length === 0) return;
			for (const socket of sockets) {
				try {
					const state = this.state(socket);
					const target = Math.min(state.targetSequence, through);
					const labels = await this.labelsAfter(state.lastSent, target);
					if (labels.length === 0) {
						socket.close(1011, "failed to deliver label events");
						continue;
					}
					for (const event of labels) {
						if (!this.send(socket, event)) break;
					}
					this.finishReplayIfCurrent(socket);
				} catch {
					socket.close(1011, "failed to deliver label events");
				}
			}
		}
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
			const labels = await this.labelsAfter(state.lastSent, state.targetSequence);
			if (labels.length === 0) {
				socket.close(1011, "failed to replay label events");
			} else {
				for (const event of labels) {
					if (!this.send(socket, event)) break;
				}
				this.finishReplayIfCurrent(socket);
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

	private async labelsAfter(cursor: number, through: number): Promise<LabelSubscriptionEvent[]> {
		const result = await this.env.DB.prepare(
			`SELECT id, idempotency_key, assessment_id, assessment_policy_version,
			 assessment_outcome, operator_action_id, actor_did,
			 actor_role, reason, sequence, ver, src, uri, cid, val, neg, cts, exp, sig,
			 signing_key_id, publication_pending, NULL AS operator_action,
			 NULL AS operator_idempotency_key
			 FROM issued_labels
			 WHERE sequence > ? AND sequence <= ?
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
			.bind(cursor, through, REPLAY_PAGE_SIZE)
			.all<StoredLabelRow>();
		const signer = await createRuntimeListingLabelSigner(this.env);
		return Promise.all(
			(result.results ?? []).map(async (row) => {
				const issued = storedRowToIssuedLabel(row);
				if (issued.label.src !== signer.issuerDid) {
					return { sequence: issued.sequence, label: issued.label };
				}
				const { src: _src, sig: _sig, ...unsigned } = issued.label;
				return { sequence: issued.sequence, label: await signer.sign(unsigned) };
			}),
		);
	}

	private async labelAt(sequence: number): Promise<LabelSubscriptionEvent | null> {
		const row = await this.env.DB.prepare(
			`SELECT id, idempotency_key, assessment_id, assessment_policy_version,
			 assessment_outcome, operator_action_id, actor_did,
			 actor_role, reason, sequence, ver, src, uri, cid, val, neg, cts, exp, sig,
			 signing_key_id, publication_pending, NULL AS operator_action,
			 NULL AS operator_idempotency_key
			 FROM issued_labels WHERE sequence = ?`,
		)
			.bind(sequence)
			.first<StoredLabelRow>();
		if (!row) return null;
		const issued = storedRowToIssuedLabel(row);
		const signer = await createRuntimeListingLabelSigner(this.env);
		if (issued.label.src !== signer.issuerDid) {
			return { sequence: issued.sequence, label: issued.label };
		}
		const { src: _src, sig: _sig, ...unsigned } = issued.label;
		return { sequence: issued.sequence, label: await signer.sign(unsigned) };
	}

	private send(socket: WebSocket, event: LabelSubscriptionEvent): boolean {
		const state = this.state(socket);
		if (event.sequence <= state.lastSent) return true;
		const frame = encodeLabelEvent(event);
		if (
			socket.readyState !== WebSocket.OPEN ||
			bufferedBytes(socket) + frame.byteLength > MAX_CONNECTION_BYTES
		) {
			socket.close(1013, "subscriber must reconnect with a cursor");
			return false;
		}
		try {
			socket.send(frame);
			this.setState(socket, { ...state, lastSent: event.sequence });
			return true;
		} catch {
			socket.close(1011, "failed to send label event");
			return false;
		}
	}

	private finishReplayIfCurrent(socket: WebSocket): void {
		const state = this.state(socket);
		if (state.replaying && state.lastSent >= state.targetSequence) {
			this.setState(socket, { ...state, replaying: false });
		}
	}

	private sendError(socket: WebSocket, error: string, message: string): void {
		socket.send(encodeSubscriptionError(error, message));
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

function parseCursor(value: string | null): number | null {
	if (value === null) return null;
	if (!NON_NEGATIVE_INTEGER.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function isSubscriptionState(value: unknown): value is SubscriptionState {
	if (!value || typeof value !== "object") return false;
	return (
		typeof Object.getOwnPropertyDescriptor(value, "lastSent")?.value === "number" &&
		typeof Object.getOwnPropertyDescriptor(value, "targetSequence")?.value === "number" &&
		typeof Object.getOwnPropertyDescriptor(value, "replaying")?.value === "boolean"
	);
}

function bufferedBytes(socket: WebSocket): number {
	return "bufferedAmount" in socket && typeof socket.bufferedAmount === "number"
		? socket.bufferedAmount
		: 0;
}
