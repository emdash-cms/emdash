import { createServer } from "node:http";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { measureRoutes } from "../../../../infra/perf-monitor/probe/src/measure.js";

it("measures the HTML response on both cold and warm page requests", async () => {
	let htmlRequests = 0;
	const server = createServer((request, response) => {
		const acceptsHtml = request.headers.accept?.split(",", 1)[0]?.trim().startsWith("text/html");
		if (acceptsHtml) htmlRequests++;
		response.writeHead(200, {
			"Content-Type": acceptsHtml ? "text/html" : "application/json",
			"Server-Timing": `render;dur=${acceptsHtml ? 12 : 1}`,
		});
		response.end(acceptsHtml ? "<p>Rendered page</p>" : "{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test server address");
		const [result] = await measureRoutes({
			targetUrl: `http://127.0.0.1:${address.port}`,
			routes: [{ path: "/", label: "Home" }],
			warmRequests: 2,
		});
		expect(htmlRequests).toBe(3);
		expect(result?.coldServerTimings?.render?.dur).toBe(12);
		expect(result?.warmServerTimings?.render?.dur).toBe(12);
	} finally {
		server.closeAllConnections();
		await promisify(server.close.bind(server))();
	}
});
