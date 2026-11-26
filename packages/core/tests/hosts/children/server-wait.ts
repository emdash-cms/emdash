/**
 * Joins on an injected clock in a process where no server has been found yet, then after a
 * response for an EmDash request attaches the listener. Prints what each join got.
 */

import { createServer } from "node:http";

import { SERVER_WAIT_MS } from "../../../src/rooms/limits.js";
import { nodeTimers } from "../../../src/rooms/node/registry.js";
import { serverAttached, watchServers } from "../../../src/rooms/node/upgrades.js";
import { issue, openDatabase, startRegistry } from "./shared.js";

watchServers();
let now = Date.now();
const db = await openDatabase(":memory:");
const { registry, site } = startRegistry(db, { now: () => now, set: nodeTimers.set });

const results = [await issue(registry, site, "ana")];
now += SERVER_WAIT_MS - 1;
results.push(await issue(registry, site, "ben"));
now += 1;
results.push(await issue(registry, site, "cy"));

const server = createServer((_request, response) => response.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
await fetch(`http://127.0.0.1:${port}/_emdash/api/manifest`).then((response) => response.text());
for (let tries = 0; !serverAttached() && tries < 100; tries++) {
	await new Promise((resolve) => setImmediate(resolve));
}
results.push(await issue(registry, site, "dee"));

console.log(JSON.stringify(results));
server.closeAllConnections();
server.close();
await registry.shutdown();
