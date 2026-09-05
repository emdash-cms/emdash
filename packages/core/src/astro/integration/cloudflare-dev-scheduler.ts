import type { Server } from "node:http";

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

export function startCloudflareDevScheduler(
	server: DevServer,
	logger: Pick<AstroIntegrationLogger, "warn">,
	options: SchedulerOptions = {},
): void {
	const httpServer = server.httpServer;
	if (!httpServer) return;

	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const fetchScheduled = options.fetch ?? fetch;
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
			const response = await fetchScheduled(url, { method: "POST" });
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
