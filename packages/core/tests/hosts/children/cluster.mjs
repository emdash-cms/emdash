/**
 * Loads the built Node.js host in a `node:cluster` primary and in a worker it forks. Each reports
 * whether it got a host and whether it watches for servers; the primary prints both.
 */

import cluster from "node:cluster";
import dc from "node:diagnostics_channel";

const { createRoomHost } = await import(process.argv[2]);

async function report() {
	const host = createRoomHost({ db: null });
	await host?.shutdown();
	return { host: host !== null, watching: dc.hasSubscribers("http.server.response.finish") };
}

if (cluster.isPrimary) {
	const worker = cluster.fork();
	worker.once("message", async (fromWorker) => {
		console.log(JSON.stringify({ primary: await report(), worker: fromWorker }));
	});
} else {
	process.send(await report(), () => process.disconnect());
}
