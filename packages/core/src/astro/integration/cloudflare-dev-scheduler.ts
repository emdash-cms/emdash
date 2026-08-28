import type { Server } from "node:http";

import type { AstroIntegrationLogger } from "astro";

const DEFAULT_INTERVAL_MS = 60_000;
const GENERAL_CRON = "* * * * *";

interface DevServer {
	httpServer: Pick<Server, "address" | "once"> | null;
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
			const address = httpServer.address();
			if (!address || typeof address === "string") {
				logger.warn("Cloudflare dev scheduler could not resolve the local server port.");
				return;
			}

			const url = new URL("/cdn-cgi/handler/scheduled", `http://localhost:${address.port}`);
			url.searchParams.set("cron", GENERAL_CRON);
			url.searchParams.set("format", "json");
			const response = await fetchScheduled(url);
			if (!response.ok) {
				logger.warn(
					`Cloudflare dev scheduler request failed with status ${response.status}. ` +
						"Verify that the Worker entrypoint exports its scheduled handler.",
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
