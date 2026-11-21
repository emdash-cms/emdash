/** Clients for host tests: plain requests, raw upgrade requests and WebSockets. */

import { request as httpRequest, createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { resolve as resolvePath } from "node:path";
import type { Duplex } from "node:stream";

import { WebSocket, type ClientOptions } from "ws";

/** Where the global setup bundles the child-process scripts. */
export const CHILDREN_DIR = resolvePath(import.meta.dirname, ".children");

/** A server that answers every request with 200, as a site's app would. */
export function serve(): Server {
	return createServer((_request, response) => response.end("ok"));
}

/** Upgraded sockets leave the server's own connection tracking, so `stop` keeps its own. */
const connections = new WeakMap<Server, Set<Duplex>>();

export async function listen(server: Server): Promise<number> {
	const accepted = new Set<Duplex>();
	connections.set(server, accepted);
	server.on("connection", (socket) => {
		accepted.add(socket);
		socket.on("close", () => accepted.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address
	return (server.address() as AddressInfo).port;
}

export function stop(server: Server): Promise<void> {
	for (const socket of connections.get(server) ?? []) socket.destroy();
	return new Promise((resolve) => server.close(() => resolve()));
}

/** A `GET`, resolving to its status once the body is read. Over HTTPS, trusts `ca`. */
export function get(url: string, ca?: string): Promise<number> {
	const send = url.startsWith("https:") ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const request = send(url, { ca }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		request.on("error", reject);
		request.end();
	});
}

const UPGRADE_HEADERS = {
	websocket:
		"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n",
	h2c: "Upgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n",
};

/** Sends an upgrade request on its own connection and resolves to the response's status line. */
export function rawUpgrade(
	port: number,
	path: string,
	kind: keyof typeof UPGRADE_HEADERS,
): Promise<string> {
	const socket = connect(port, "127.0.0.1");
	let received = "";
	const statusLine = new Promise<string>((resolveLine) => {
		const timer = setTimeout(resolveLine, 2000, "no response");
		const settle = (line: string) => {
			clearTimeout(timer);
			resolveLine(line);
		};
		socket.on("connect", () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${UPGRADE_HEADERS[kind]}\r\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("latin1");
			const end = received.indexOf("\r\n");
			if (end !== -1) settle(received.slice(0, end));
		});
		socket.on("error", () => settle("error"));
		socket.on("close", () => settle(received.split("\r\n")[0] || "closed"));
	});
	return statusLine.finally(() => socket.destroy());
}

export interface OpenedSocket {
	ws: WebSocket;
	/** The handshake response's status. */
	status: number;
	/** Resolves to the next binary message. */
	next(): Promise<Uint8Array>;
	closed: Promise<{ code: number; reason: string }>;
}

/** Opens a WebSocket, resolving once the handshake answered, whether or not it upgraded. */
export function openSocket(
	url: string,
	options: ClientOptions = {},
	protocol?: string,
): Promise<OpenedSocket> {
	const ws = new WebSocket(url, protocol, options);
	const messages: Uint8Array[] = [];
	const waiting: Array<(message: Uint8Array) => void> = [];
	ws.on("message", (data: Buffer) => {
		const message = new Uint8Array(data);
		const waiter = waiting.shift();
		if (waiter) waiter(message);
		else messages.push(message);
	});
	ws.on("error", () => {});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
	});
	const next = () =>
		new Promise<Uint8Array>((resolve) => {
			const queued = messages.shift();
			if (queued) resolve(queued);
			else waiting.push(resolve);
		});
	return new Promise((resolve, reject) => {
		ws.on("upgrade", () => resolve({ ws, status: 101, next, closed }));
		ws.on("unexpected-response", (_request, response) => {
			response.resume();
			resolve({ ws, status: response.statusCode ?? 0, next, closed });
		});
		ws.on("error", reject);
	});
}

/** A room socket's path under a base path. */
export function roomPath(base: string, collection: string, id: string, token: string): string {
	return `${base}/_emdash/api/content/${collection}/${id}/room?token=${encodeURIComponent(token)}`;
}
