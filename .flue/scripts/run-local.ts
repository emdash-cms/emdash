// Local prototype runner.
//
// Wraps `flue run investigate` for convenience. Reads an issue fixture
// (or pulls one live with `gh issue view`), constructs the payload, and
// prints the structured InvestigateResult. No GitHub writes -- the
// orchestrator that does writes lives in .github/workflows/investigate.yml,
// not here.
//
// The investigate workflow expects AGENT_GH_TOKEN to be set; we forward
// whichever of GITHUB_TOKEN / GH_TOKEN the user has, treating it as the
// "agent" token even though locally there's no orchestrator/agent split.
// The agent's read-only token only affects what `gh issue view` etc.
// inside its sandbox can do; on a maintainer's laptop the host user
// already has those reads, so the sandbox token mostly stops the agent
// from doing accidental writes from inside its bash.
//
// Required env:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_GATEWAY_ID
//   CLOUDFLARE_API_KEY
//
// Usage:
//   pnpm prototype 1021                                     # one fixture
//   pnpm prototype 1021 1049 1080                           # several
//   pnpm prototype --live 1083                              # fetch live with gh
//   FLUE_INVESTIGATE_MODEL=cloudflare-ai-gateway/claude-sonnet-4-6 pnpm prototype 1021

import { execSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Fixture {
	number: number;
	title: string;
	body: string;
	labels?: Array<{ name: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, "..", "fixtures");
const FLUE_DIR = resolve(HERE, "..");
const ISSUE_NUMBER_RE = /^\d+$/;

async function loadFixture(arg: string, live: boolean): Promise<Fixture> {
	// `arg` is interpolated into a shell command (`gh issue view`) and a
	// file path (`fixtures/issue-<arg>.json`). Restrict to plain integers
	// so a `'1 && rm -rf /'` style input cannot smuggle metachars through
	// execSync or path traversal through the fixture lookup.
	if (!ISSUE_NUMBER_RE.test(arg)) {
		throw new Error(`issueNumber must be a positive integer, got: ${JSON.stringify(arg)}`);
	}
	if (live) {
		const raw = execSync(
			`gh issue view ${arg} --repo emdash-cms/emdash --json number,title,body,labels`,
			{ encoding: "utf8" },
		);
		const parsed: Fixture = JSON.parse(raw);
		return parsed;
	}
	const path = join(FIXTURES_DIR, `issue-${arg}.json`);
	const parsed: Fixture = JSON.parse(await readFile(path, "utf8"));
	return parsed;
}

async function runOne(fixture: Fixture): Promise<void> {
	const payload = JSON.stringify({
		issueNumber: fixture.number,
		issueTitle: fixture.title,
		issueBody: fixture.body,
		owner: "emdash-cms",
		repo: "emdash",
	});

	console.error(`\n=== issue #${fixture.number}: ${fixture.title}`);
	const start = Date.now();

	// `pnpm exec` (not `npx`) so we invoke the lockfile-pinned Flue.
	// `flue run` in 0.8 generates the workflow run id itself; no --id flag.
	const result = spawnSync(
		"pnpm",
		["exec", "flue", "run", "investigate", "--target", "node", "--payload", payload],
		{
			cwd: FLUE_DIR,
			env: process.env,
			encoding: "utf8",
		},
	);

	const elapsed = Date.now() - start;
	console.error(`[${elapsed}ms] exit=${result.status}`);
	if (result.stderr) console.error(result.stderr);
	if (result.stdout) console.log(result.stdout);
}

async function main() {
	const args = process.argv.slice(2);
	const live = args.includes("--live");
	const issueArgs = args.filter((a) => !a.startsWith("--"));

	if (issueArgs.length === 0) {
		console.error("usage: tsx scripts/run-local.ts [--live] <issueNumber> [<issueNumber>...]");
		process.exit(2);
	}

	const missingGateway = [
		"CLOUDFLARE_ACCOUNT_ID",
		"CLOUDFLARE_GATEWAY_ID",
		"CLOUDFLARE_API_KEY",
	].filter((k) => !process.env[k]);
	if (missingGateway.length > 0) {
		console.error(`missing required env: ${missingGateway.join(", ")}`);
		process.exit(2);
	}

	// Normalise GITHUB_TOKEN / GH_TOKEN into AGENT_GH_TOKEN, which is
	// what investigate.ts reads. The workflow itself sets this explicitly
	// from `secrets.GITHUB_TOKEN`; locally we accept the user's gh CLI
	// token, treating it the same way.
	const agentToken = process.env.AGENT_GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (!agentToken) {
		console.error("AGENT_GH_TOKEN (or GITHUB_TOKEN / GH_TOKEN) required for the agent's sandbox");
		process.exit(2);
	}
	process.env.AGENT_GH_TOKEN = agentToken;

	for (const arg of issueArgs) {
		const fixture = await loadFixture(arg, live);
		await runOne(fixture);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
