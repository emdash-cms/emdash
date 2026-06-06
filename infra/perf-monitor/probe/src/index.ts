/**
 * Perf probe Worker -- deployed per-region with placement hints.
 * Receives measurement requests via service binding fetch(),
 * runs the measurements from its placed location, returns results.
 */

import { measureRoutes } from "./measure.js";
import type { MeasureRequest, MeasureResponse } from "./measure.js";

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		try {
			const body = await request.json<MeasureRequest & { region?: string }>();
			const results = await measureRoutes(body);

			const response: MeasureResponse = {
				results,
				probeRegion: body.region ?? "unknown",
			};

			return Response.json(response);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			return Response.json({ error: message }, { status: 500 });
		}
	},
} satisfies ExportedHandler;
