import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workspaceEntries = [
	"@emdash-cms/registry-lexicons",
	"@emdash-cms/registry-moderation",
	"@emdash-cms/registry-verification/records",
];

const dependenciesBuilt = workspaceEntries.every((entry) => {
	try {
		require.resolve(entry);
		return true;
	} catch {
		return false;
	}
});

if (!dependenciesBuilt) {
	const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	execFileSync(pnpm, ["--filter", "@emdash-cms/aggregator^...", "build"], {
		cwd: new URL("../../../", import.meta.url),
		stdio: "inherit",
	});
}
