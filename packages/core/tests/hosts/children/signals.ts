/**
 * Holds a room's claim until `SIGTERM` or `SIGINT`. With `--other-handler`, the app listens for
 * both too, and stops the process by ending its last task half a second later, as closing its
 * server would. A signal sent again in that time reaches the app's listener again.
 */

import { issue, openDatabase, startRegistry } from "./shared.js";

const [path, option] = process.argv.slice(2);
if (!path) throw new Error("Pass the database path");

const keepAlive = setInterval(() => {}, 60_000);
if (option === "--other-handler") {
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			console.log(`app handled ${signal}`);
			setTimeout(clearInterval, 500, keepAlive);
		});
	}
}

const db = await openDatabase(path);
const { registry, site } = startRegistry(db);
const issued = await issue(registry, site, "ana");
console.log(JSON.stringify({ issued, host: registry.host }));
