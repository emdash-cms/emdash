/**
 * Re-runs dev-bypass after a dev-reset so the server info file has a valid PAT
 * and the fixture database is back in "setup complete" state.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");

export async function refreshServerPatAfterDevBypass(baseUrl: string): Promise<void> {
	const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass?token=1`);
	if (!res.ok) {
		throw new Error(`dev-bypass failed (${res.status}): ${await res.text()}`);
	}
	const json: { data: { token?: string } } = await res.json();
	const token = json.data.token;
	if (!token) throw new Error("dev-bypass did not return a PAT token");

	// Update the server info so subsequent tests use the fresh token
	const info = JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));
	info.token = token;
	writeFileSync(SERVER_INFO_PATH, JSON.stringify(info, null, 2));
}
