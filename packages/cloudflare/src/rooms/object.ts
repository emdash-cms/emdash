/**
 * `EmDashRoom`: one co-editing room per Durable Object, named by its room ID. Sockets hibernate,
 * and each one's connection info lives in its attachment so it survives. The room calls back
 * into its own Worker through the `EmDashRoomSite` entrypoint.
 */

import { DurableObject, exports } from "cloudflare:workers";
import {
	CLOSE_CODES,
	COMMIT,
	MAX_UPDATE_BYTES,
	parseRoomId,
	ROOM_STATE_LIFETIME_MS,
	RoomSaveError,
	VERSION,
	type ConnectionInfo,
	type OutsideValue,
	type RoomConnection,
	type TokenClaims,
} from "emdash/internal/co-editing";
import type { Room, RoomOptions } from "emdash/internal/co-editing/room";

import { DurableObjectRoomStore } from "./store.js";

/** Node.js closes larger frames with 1009 too, through `ws`'s `maxPayload`. */
const MAX_MESSAGE_BYTES = 2 * MAX_UPDATE_BYTES;
const MESSAGE_TOO_BIG = 1009;

/** What `save` resolves to over RPC, which drops error subclasses. */
export type RoomSaveReply =
	| { rev: string; hold: string }
	| "conflict"
	| null
	| { failed: { reason: string; code: string; message: string } };

interface Socket {
	connection: RoomConnection;
	/** The room's info for the socket, which it updates as messages arrive. */
	info: ConnectionInfo | null;
	attachedClientId: number | null;
	closed: boolean;
}

export class EmDashRoom extends DurableObject {
	readonly #store: DurableObjectRoomStore;
	readonly #sockets = new Map<WebSocket, Socket>();
	#room!: Room;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const name = ctx.id.name ?? "";
		this.#store = new DurableObjectRoomStore(ctx.storage, name);
		void ctx.blockConcurrencyWhile(async () => {
			const entry = parseRoomId(name);
			if (!entry) throw new Error(`[co-editing] ${name} isn't a room ID`);
			const { Room } = await import("emdash/internal/co-editing/room");
			this.#room = new Room({
				entry,
				site: roomSite(),
				store: this.#store,
				build: { version: VERSION, commit: COMMIT },
				timers: {
					now: () => Date.now(),
					set(ms, run) {
						const timer = setTimeout(run, ms);
						return () => clearTimeout(timer);
					},
				},
			});
			for (const ws of ctx.getWebSockets()) {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only this class writes attachments
				const info = ws.deserializeAttachment() as ConnectionInfo | null;
				if (!info) continue;
				const socket = this.#socket(ws, info);
				this.#room.resume(socket.connection, info);
			}
		});
	}

	issueToken(claims: TokenClaims): ReturnType<Room["issueToken"]> {
		return this.#room.issueToken(claims);
	}

	isOpen(): boolean {
		return this.#room.isOpen();
	}

	async save(actorId: string, rev?: string): Promise<RoomSaveReply> {
		try {
			return await this.#room.save(actorId, rev);
		} catch (error) {
			if (!(error instanceof RoomSaveError)) throw error;
			return { failed: { reason: error.reason, code: error.code, message: error.message } };
		}
	}

	release(hold: string, options?: { overwrite?: boolean }): Promise<void> {
		return this.#room.release(hold, options);
	}

	notify(outside: OutsideValue[]): Promise<void> {
		return this.#room.notify(outside);
	}

	forgetTokens(userId: string): Promise<void> {
		return this.#room.forgetTokens(userId);
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response(null, { status: 400 });
		}
		const token = new URL(request.url).searchParams.get("token") ?? "";
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const socket = this.#socket(server, null);
		const info = this.#room.connect(socket.connection, token);
		if (info) {
			socket.info = info;
			try {
				this.#attach(server, socket);
			} catch (error) {
				// A socket whose info can't survive hibernation would come back as a stranger.
				console.error("[co-editing] couldn't keep a socket's connection info:", error);
				socket.connection.close(CLOSE_CODES.busy, "The room couldn't take the socket");
				this.#room.disconnect(socket.connection);
			}
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const socket = this.#sockets.get(ws);
		if (!socket) return;
		if (messageBytes(message) > MAX_MESSAGE_BYTES) {
			closeSocket(ws, socket, MESSAGE_TOO_BIG, "The message is too big");
			this.#forget(ws);
			return;
		}
		if (typeof message === "string") return;
		this.#room.receive(socket.connection, new Uint8Array(message));
		if (!socket.closed && socket.info && socket.info.clientId !== socket.attachedClientId) {
			this.#attach(ws, socket);
		}
	}

	override webSocketClose(ws: WebSocket, code: number): void {
		this.#forget(ws);
		try {
			// 1005 and 1006 report a close without a code, and can't be sent.
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// Already closed.
		}
	}

	override webSocketError(ws: WebSocket): void {
		this.#forget(ws);
	}

	override async alarm(): Promise<void> {
		try {
			await this.#room.expire();
		} finally {
			// An open room, or a drop that failed, keeps its state for the next hour.
			if (this.#store.holdsState()) {
				await this.ctx.storage.setAlarm(Date.now() + ROOM_STATE_LIFETIME_MS);
			}
		}
	}

	#socket(ws: WebSocket, info: ConnectionInfo | null): Socket {
		const socket: Socket = {
			info,
			attachedClientId: info?.clientId ?? null,
			closed: false,
			connection: {
				send(message) {
					try {
						ws.send(message);
					} catch {
						// The socket closed; its close handler forgets it.
					}
				},
				close: (code, reason) => closeSocket(ws, socket, code, reason),
			},
		};
		this.#sockets.set(ws, socket);
		return socket;
	}

	#attach(ws: WebSocket, socket: Socket): void {
		if (!socket.info) return;
		ws.serializeAttachment(socket.info);
		socket.attachedClientId = socket.info.clientId;
	}

	#forget(ws: WebSocket): void {
		const socket = this.#sockets.get(ws);
		if (!socket) return;
		this.#sockets.delete(ws);
		this.#room.disconnect(socket.connection);
	}
}

/** A message's size as sent, which is UTF-8 for text. */
function messageBytes(message: string | ArrayBuffer): number {
	return typeof message === "string"
		? new TextEncoder().encode(message).byteLength
		: message.byteLength;
}

function closeSocket(ws: WebSocket, socket: Socket, code: number, reason: string): void {
	socket.closed = true;
	try {
		// So a socket still finishing its close isn't resumed as live after a wake.
		ws.serializeAttachment(null);
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
}

type RoomSite = RoomOptions["site"];

/** The site, through the Worker's own `EmDashRoomSite` entrypoint. */
function roomSite(): RoomSite {
	const site = (): RoomSite => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loopback entrypoint from untyped cloudflare:workers exports
		const entrypoint = (exports as Record<string, unknown>).EmDashRoomSite as RoomSite | undefined;
		if (!entrypoint) throw new Error("[co-editing] The Worker doesn't export EmDashRoomSite");
		return entrypoint;
	};
	return {
		load: (entry) => site().load(entry),
		save: (entry, checkpoint) => site().save(entry, checkpoint),
		saveRecovery: (entry, recovery) => site().saveRecovery(entry, recovery),
	};
}
