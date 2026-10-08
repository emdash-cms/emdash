import type { Server } from "node:http";
import { request as requestHttps } from "node:https";

import type { AstroIntegrationLogger } from "astro";

const DEFAULT_INTERVAL_MS = 60_000;

interface DevServer {
	httpServer: Pick<Server, "once"> | null;
	resolvedUrls: { local: string[]; network: string[] } | null;
}

interface SchedulerOptions {
	intervalMs?: number;
	fetch?: typeof fetch;
}

function postMaintenance(url: URL): Promise<{ ok: boolean; status: number }> {
	if (url.protocol !== "https:") return fetch(url, { method: "POST" });
	// Empty POST to the dev server's own origin. Only the status is read, so
	// certificate checks add no protection and can stop maintenance when the
	// certificate name does not match the resolved host.
	return new Promise((resolve, reject) => {
		const request = requestHttps(
			url,
			{ method: "POST", rejectUnauthorized: false, agent: false },
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

			const base = origin.endsWith("/") ? origin : `${origin}/`;
			const url = new URL("_emdash/api/dev/scheduled-tasks", base);
			const response = options.fetch
				? await options.fetch(url, { method: "POST" })
				: await postMaintenance(url);
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
