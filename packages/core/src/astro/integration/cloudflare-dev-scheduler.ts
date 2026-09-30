import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { request as requestHttps, type ServerOptions } from "node:https";
import { Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";

import type { AstroIntegrationLogger } from "astro";

const DEFAULT_INTERVAL_MS = 60_000;
type DevHttpsOptions = Pick<ServerOptions, "cert" | "ca" | "pfx" | "passphrase">;

interface DevServer {
	httpServer: Pick<Server, "once"> | null;
	resolvedUrls: { local: string[]; network: string[] } | null;
	config?: { server: { https?: DevHttpsOptions } };
}

interface SchedulerOptions {
	intervalMs?: number;
	fetch?: typeof fetch;
}

async function postMaintenance(
	url: URL,
	https?: DevHttpsOptions,
): Promise<{ ok: boolean; status: number }> {
	if (url.protocol !== "https:") return fetch(url, { method: "POST" });
	let certificate = https?.cert ?? https?.ca;
	if (!certificate && https?.pfx) {
		const pfx =
			typeof https.pfx === "string" ? await readFile(https.pfx).catch(() => https.pfx) : https.pfx;
		// Extract only the public certificate without opening a connection or
		// forwarding the server's private key to the maintenance client.
		const socket = new TLSSocket(new Socket(), {
			secureContext: createSecureContext({ pfx, passphrase: https.passphrase }),
		});
		try {
			certificate = socket.getX509Certificate()?.toString();
		} finally {
			socket.destroy();
		}
	}
	if (!certificate) return fetch(url, { method: "POST" });

	// Vite accepts either PEM contents or a certificate file path.
	const ca =
		typeof certificate === "string"
			? await readFile(certificate).catch(() => certificate)
			: certificate;
	return new Promise((resolve, reject) => {
		// The configured server certificate may be a leaf rather than a CA.
		const request = requestHttps(
			url,
			{ method: "POST", ca, allowPartialTrustChain: true, agent: false },
			(response) => {
				const status = response.statusCode ?? 500;
				response.once("error", reject);
				response.once("end", () => resolve({ ok: status >= 200 && status < 300, status }));
				response.resume();
			},
		);
		request.once("error", reject);
		request.end();
	});
}

export function startCloudflareDevScheduler(
	server: DevServer,
	logger: Pick<AstroIntegrationLogger, "warn">,
	options: SchedulerOptions = {},
): void {
	const httpServer = server.httpServer;
	if (!httpServer) return;

	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => void run(), intervalMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	};

	const run = async () => {
		try {
			const origin = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
			if (!origin) {
				logger.warn("Cloudflare dev scheduler could not resolve the dev server origin.");
				return;
			}

			const url = new URL("/_emdash/api/dev/scheduled-tasks", origin);
			const response = options.fetch
				? await options.fetch(url, { method: "POST" })
				: await postMaintenance(url, server.config?.server.https);
			if (!response.ok) {
				logger.warn(
					`Cloudflare dev scheduler request failed with status ${response.status}. ` +
						"Verify that EmDash's dev maintenance route is available.",
				);
			}
		} catch (error) {
			logger.warn(
				`Cloudflare dev scheduler request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			schedule();
		}
	};

	httpServer.once("listening", schedule);
	httpServer.once("close", () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	});
}
