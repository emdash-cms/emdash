import { execFileSync } from "node:child_process";

const mode = process.argv[2];

const run = (args) => execFileSync("pnpm", args, { stdio: "inherit" });

// changesets/action/version runs `git checkout changeset-release/main` +
// `git reset --hard` immediately before this. The release branch can have
// dependency state that is out of sync with pnpm-workspace.yaml. The next
// gated pnpm call (verifyDepsBeforeRun: error) would then abort the release. `pnpm install`
// is not gated, so reconcile here, after the action's git work and before
// any `pnpm changeset` call. Do not hoist this into an earlier workflow
// step: the action's git reset runs after workflow steps.
// Must be --no-frozen-lockfile, not --prefer-frozen-lockfile: prefer-frozen
// can take the lockfile fast path and skip rewriting the stale deps-state
// hash, which is the exact condition that trips the gate.
run(["install", "--no-frozen-lockfile"]);

if (mode === "version") {
	run(["changeset", "version"]);
	run(["install", "--no-frozen-lockfile"]);
} else {
	throw new Error(`Unknown release mode: ${JSON.stringify(mode)} (expected "version")`);
}
