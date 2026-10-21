// Runs the review workflow against fixed PR heads with each candidate model
// and records the ReviewResult, wall time and token usage per run.
//
// Each model gets its own `flue dev` server in a scratch directory under
// eval/.work that links the real .flue sources, so the reviewed code is the
// package's own. No GitHub App credentials are ever given to the server: the
// workflow then reviews the given head once, fetches the public tarball and
// diff unauthenticated, and posts nothing.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

import * as v from "valibot";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(EVAL_DIR, "..");
const RESULTS_DIR = join(EVAL_DIR, "results");
const WORK_DIR = join(EVAL_DIR, ".work");

interface ModelSpec {
	readonly key: string;
	readonly model: string;
	readonly gateway: boolean;
	// Runs the production reviewer panel: `model` is the REVIEW_MODELS list.
	readonly panel?: boolean;
	// USD per million tokens: input, output, cache read, cache write.
	readonly price: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MODELS: readonly ModelSpec[] = [
	{
		key: "kimi",
		model: "cloudflare/@cf/moonshotai/kimi-k2.7-code",
		gateway: false,
		price: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	},
	{
		key: "opus",
		model: "anthropic/claude-opus-5-5",
		gateway: true,
		price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	},
	{
		key: "sol",
		model: "openai/gpt-6.1-sol",
		gateway: true,
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	},
	{
		key: "panel",
		model: "anthropic/claude-opus-5-5,openai/gpt-6.1-sol",
		gateway: true,
		panel: true,
		price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

const SHA = /^[0-9a-f]{40}$/;
const LABEL = /^[a-z0-9-]+$/;
const WORKER_NAME = /"name":\s*"emdash-flue-review"/;
const REQUIRED_SECRETS = /"required":\s*\[[^\]]*\]/;

const GATEWAY_KEYS = ["AI_GATEWAY_ACCOUNT_ID", "AI_GATEWAY_NAME", "AI_GATEWAY_TOKEN"] as const;
const EVAL_SECRET_KEYS = [
	"REVIEW_EVAL",
	"REVIEW_MODEL",
	"REVIEW_MODELS",
	"REVIEW_MERGE_MODEL",
	"REVIEW_FOLLOWUP_MODELS",
	"REVIEW_FOLLOWUP_MAX_LINES",
	...GATEWAY_KEYS,
];

const casesFileSchema = v.object({
	owner: v.string(),
	repo: v.string(),
	cases: v.array(v.looseObject({ pr: v.number(), headSha: v.pipe(v.string(), v.regex(SHA)) })),
});
type CasesFile = v.InferOutput<typeof casesFileSchema>;
type EvalCase = CasesFile["cases"][number];

const payloadSchema = v.object({
	prNumber: v.number(),
	prTitle: v.string(),
	prBody: v.string(),
	headRef: v.string(),
	headSha: v.string(),
	baseRef: v.string(),
	baseSha: v.string(),
	owner: v.string(),
	repo: v.string(),
	linkedIssues: v.optional(
		v.array(v.object({ number: v.number(), title: v.string(), body: v.string() })),
	),
	reviewMode: v.optional(v.literal("scoped")),
	priorHeadSha: v.optional(v.string()),
	priorReview: v.optional(v.string()),
	interHeadDiff: v.optional(v.string()),
});
type ReviewPayload = v.InferOutput<typeof payloadSchema>;

const pullRequestSchema = v.object({
	title: v.string(),
	body: v.string(),
	headRefName: v.string(),
	baseRefName: v.string(),
	baseRefOid: v.string(),
});

const tokenUsageSchema = v.looseObject({
	input: v.optional(v.number(), 0),
	output: v.optional(v.number(), 0),
	cacheRead: v.optional(v.number(), 0),
	cacheWrite: v.optional(v.number(), 0),
	cost: v.optional(v.looseObject({ total: v.optional(v.number(), 0) })),
});

const eventsSchema = v.array(
	v.looseObject({
		type: v.string(),
		response: v.optional(v.looseObject({ usage: v.optional(tokenUsageSchema) })),
		usage: v.optional(tokenUsageSchema),
	}),
);

const runRecordSchema = v.looseObject({
	status: v.optional(v.string()),
	result: v.optional(v.unknown()),
	error: v.optional(v.unknown()),
	durationMs: v.optional(v.number()),
});

const previousOutcomeSchema = v.looseObject({ status: v.string(), headSha: v.string() });

function readJson<const TSchema extends v.GenericSchema>(
	schema: TSchema,
	text: string,
): v.InferOutput<TSchema> {
	return v.parse(schema, JSON.parse(text));
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	toolCalls: number;
	compactions: number;
	costUsd: number;
}

interface RunOutcome {
	case: number;
	headSha: string;
	model: string;
	modelKey: string;
	runId?: string;
	status: string;
	attempt: number;
	wallMs: number;
	durationMs?: number;
	usage: Usage;
	costUsd: number;
	result?: unknown;
	error?: unknown;
	finishedAt: string;
}

const { values: args } = parseArgs({
	options: {
		models: { type: "string", default: MODELS.map((m) => m.key).join(",") },
		cases: { type: "string" },
		"gateway-env": { type: "string" },
		"base-port": { type: "string", default: "3591" },
		concurrency: { type: "string", default: "1" },
		force: { type: "boolean", default: false },
		"timeout-min": { type: "string", default: "45" },
		label: { type: "string" },
		reviewers: { type: "string" },
		"merge-model": { type: "string" },
		head: { type: "string" },
		"prior-head": { type: "string" },
		"prior-result": { type: "string" },
	},
});

const label = v.parse(v.optional(v.pipe(v.string(), v.regex(LABEL))), args.label);
const resultSuffix = label ?? "";

function runKey(spec: ModelSpec): string {
	return resultSuffix ? `${spec.key}-${resultSuffix}` : spec.key;
}

function resultPath(pr: number, spec: ModelSpec): string {
	return join(RESULTS_DIR, `${pr}-${spec.key}${resultSuffix ? `-${resultSuffix}` : ""}.json`);
}

function log(message: string): void {
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function assertNoGitHubCredentials(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GITHUB_APP_")) {
			throw new Error(`refusing to run with ${key} in the environment`);
		}
	}
}

function gatewayEnv(): Record<string, string> {
	const source: Record<string, string | undefined> = args["gateway-env"]
		? parseEnv(readFileSync(args["gateway-env"], "utf8"))
		: process.env;
	const out: Record<string, string> = {};
	for (const key of GATEWAY_KEYS) {
		const value = source[key];
		if (!value) throw new Error(`${key} is not set (pass --gateway-env or export it)`);
		out[key] = value;
	}
	return out;
}

function gh(ghArgs: string[]): string {
	return execFileSync("gh", ghArgs, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

const issueSchema = v.object({ title: v.string(), body: v.string() });
const closingIssuesSchema = v.object({
	closingIssuesReferences: v.array(v.looseObject({ number: v.number() })),
});

// The issues a PR says it resolves, without comments. Cached per PR.
function linkedIssuesFor(file: CasesFile, pr: number): NonNullable<ReviewPayload["linkedIssues"]> {
	const cachePath = join(RESULTS_DIR, "payloads", `${pr}-issues.json`);
	const schema = v.array(v.object({ number: v.number(), title: v.string(), body: v.string() }));
	if (existsSync(cachePath)) return readJson(schema, readFileSync(cachePath, "utf8"));
	const repo = `${file.owner}/${file.repo}`;
	const { closingIssuesReferences } = readJson(
		closingIssuesSchema,
		gh(["pr", "view", String(pr), "-R", repo, "--json", "closingIssuesReferences"]),
	);
	const issues = closingIssuesReferences.map(({ number }) => ({
		number,
		...readJson(
			issueSchema,
			gh(["issue", "view", String(number), "-R", repo, "--json", "title,body"]),
		),
	}));
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, `${JSON.stringify(issues, null, "\t")}\n`);
	return issues;
}

const priorResultSchema = v.looseObject({
	result: v.object({
		verdict: v.string(),
		summary: v.string(),
		findings: v.array(v.looseObject({ path: v.string(), line: v.number(), body: v.string() })),
	}),
});

// The prior-review context production builds from the bot's last review,
// rendered from an earlier result file: the review body and its findings, with
// no author replies.
function priorReviewFrom(path: string): string {
	const { result } = readJson(priorResultSchema, readFileSync(path, "utf8"));
	const state = result.verdict === "approve" ? "APPROVED" : "COMMENTED";
	const findings = result.findings.toReversed().map(
		({ path: file, line, body }) =>
			`- \`${file}:${line}\`\n${body
				.trim()
				.split("\n")
				.map((text) => `  > ${text}`)
				.join("\n")}`,
	);
	return `Your previous review (state: ${state}):\n\n${result.summary}${
		findings.length > 0
			? `\n\n### Your inline findings, newest first, with the replies to each\n\n${findings.join("\n\n")}`
			: ""
	}`;
}

// A scoped follow-up of the head against an earlier head: the runner supplies
// the earlier review and the inter-head diff, which production reads with its
// installation token.
function followUpFor(file: CasesFile, headSha: string): Partial<ReviewPayload> {
	const priorHead = args["prior-head"];
	const priorResult = args["prior-result"];
	if (!priorHead || !priorResult) return {};
	return {
		reviewMode: "scoped",
		priorHeadSha: priorHead,
		priorReview: priorReviewFrom(priorResult),
		interHeadDiff: gh([
			"api",
			`repos/${file.owner}/${file.repo}/compare/${priorHead}...${headSha}`,
			"-H",
			"Accept: application/vnd.github.v3.diff",
		]),
	};
}

// Production fetches the linked issues with its installation token; the
// runner has none, so it supplies them in the payload.
function payloadFor(file: CasesFile, evalCase: EvalCase): ReviewPayload {
	const base = basePayloadFor(file, evalCase);
	return {
		...base,
		linkedIssues: linkedIssuesFor(file, evalCase.pr),
		...followUpFor(file, base.headSha),
	};
}

function basePayloadFor(file: CasesFile, evalCase: EvalCase): ReviewPayload {
	const cachePath = join(RESULTS_DIR, "payloads", `${evalCase.pr}.json`);
	if (existsSync(cachePath)) {
		const cached = readJson(payloadSchema, readFileSync(cachePath, "utf8"));
		if (cached.headSha === evalCase.headSha) return cached;
	}
	const repo = `${file.owner}/${file.repo}`;
	const pr = readJson(
		pullRequestSchema,
		gh([
			"pr",
			"view",
			String(evalCase.pr),
			"-R",
			repo,
			"--json",
			"title,body,headRefName,baseRefName,baseRefOid",
		]),
	);
	const baseSha = gh([
		"api",
		`repos/${repo}/compare/${pr.baseRefOid}...${evalCase.headSha}`,
		"--jq",
		".merge_base_commit.sha",
	]);
	if (!SHA.test(baseSha) || baseSha === evalCase.headSha) {
		throw new Error(`PR ${evalCase.pr}: no usable merge base (${baseSha})`);
	}
	const payload: ReviewPayload = {
		prNumber: evalCase.pr,
		prTitle: pr.title,
		prBody: pr.body,
		headRef: pr.headRefName,
		headSha: evalCase.headSha,
		baseRef: pr.baseRefName,
		baseSha,
		owner: file.owner,
		repo: file.repo,
	};
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, `${JSON.stringify(payload, null, "\t")}\n`);
	return payload;
}

// The package's wrangler.jsonc lists only the production secrets, and local
// dev loads only listed secrets from .dev.vars. The scratch copy lists the
// evaluation settings instead, so GitHub App secrets cannot load at all.
function evalWranglerConfig(key: string): string {
	const source = readFileSync(join(PACKAGE_DIR, "wrangler.jsonc"), "utf8");
	const secrets = `"required": ${JSON.stringify(EVAL_SECRET_KEYS)}`;
	const out = source
		.replace(WORKER_NAME, `"name": "emdash-flue-review-eval-${key}"`)
		.replace(REQUIRED_SECRETS, secrets);
	if (!out.includes(`emdash-flue-review-eval-${key}`) || !out.includes(secrets)) {
		throw new Error("wrangler.jsonc no longer has the expected name and secrets shape");
	}
	return out;
}

function prepareWorkDir(spec: ModelSpec, gateway: Record<string, string> | undefined): string {
	const dir = join(WORK_DIR, runKey(spec));
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	symlinkSync(join(PACKAGE_DIR, ".flue"), join(dir, ".flue"));
	symlinkSync(join(PACKAGE_DIR, "node_modules"), join(dir, "node_modules"));
	for (const file of ["package.json", "tsconfig.json"]) {
		copyFileSync(join(PACKAGE_DIR, file), join(dir, file));
	}
	writeFileSync(join(dir, "wrangler.jsonc"), evalWranglerConfig(runKey(spec)));
	const vars: Record<string, string> = {
		REVIEW_EVAL: "1",
		...(spec.panel
			? {
					REVIEW_MODELS: args.reviewers ?? spec.model,
					...(args["merge-model"] ? { REVIEW_MERGE_MODEL: args["merge-model"] } : {}),
				}
			: { REVIEW_MODEL: spec.model }),
		...(spec.gateway ? gateway : {}),
	};
	const devVars = Object.entries(vars)
		.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
		.join("\n");
	writeFileSync(join(dir, ".dev.vars"), `${devVars}\n`, { mode: 0o600 });
	return dir;
}

async function startServer(spec: ModelSpec, dir: string, port: number): Promise<ChildProcess> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GITHUB_") || key.startsWith("AI_GATEWAY_")) delete env[key];
	}
	mkdirSync(join(RESULTS_DIR, "logs"), { recursive: true });
	const logFile = createWriteStream(join(RESULTS_DIR, "logs", `${runKey(spec)}-server.log`));
	const child = spawn(
		join(PACKAGE_DIR, "node_modules", ".bin", "flue"),
		["dev", "--target", "cloudflare", "--port", String(port)],
		{ cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
	);
	child.stdout?.pipe(logFile);
	child.stderr?.pipe(logFile);
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`${spec.key} server exited early`);
		try {
			// An empty body fails workflow input validation only when the
			// evaluation mount is active; otherwise the app answers 404.
			const res = await fetch(`${base}/eval/workflows/review`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			const body = v.safeParse(
				v.object({ error: v.object({ type: v.literal("action_input_validation") }) }),
				await res.json().catch(() => undefined),
			);
			if (body.success) return child;
		} catch {}
		await sleep(2_000);
	}
	throw new Error(`${spec.key} server did not become ready on ${base}`);
}

function stopServer(child: ChildProcess): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
	}
}

// Unauthenticated GitHub API calls share a 60/hour allowance per IP; each run
// spends two (tarball and compare). Reading the limit itself is free.
async function waitForGitHubAllowance(calls: number): Promise<void> {
	for (;;) {
		const res = await fetch("https://api.github.com/rate_limit", {
			headers: { "user-agent": "emdash-flue-review-eval" },
		}).catch(() => undefined);
		if (!res?.ok) {
			await sleep(10_000);
			continue;
		}
		const { resources } = v.parse(
			v.object({
				resources: v.object({ core: v.object({ remaining: v.number(), reset: v.number() }) }),
			}),
			await res.json(),
		);
		if (resources.core.remaining >= calls + 2) return;
		const waitMs = Math.max(5_000, resources.core.reset * 1_000 - Date.now() + 5_000);
		log(`GitHub unauthenticated limit low; waiting ${Math.round(waitMs / 1_000)}s`);
		await sleep(waitMs);
	}
}

// Admissions are spaced so a started run spends its calls before the next
// admission reads the remaining allowance.
let githubGate: Promise<void> = Promise.resolve();
async function reserveGitHubCalls(calls: number): Promise<void> {
	const turn = githubGate.then(() => waitForGitHubAllowance(calls));
	const space = () => sleep(15_000);
	githubGate = turn.then(space, space);
	await turn;
}

async function readUsage(base: string, runId: string, eventsPath: string): Promise<Usage> {
	const raw: unknown[] = [];
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
		toolCalls: 0,
		compactions: 0,
		costUsd: 0,
	};
	let offset = "-1";
	for (let page = 0; page < 500; page++) {
		const res = await fetch(`${base}/eval/runs/${runId}?offset=${encodeURIComponent(offset)}`);
		if (!res.ok) throw new Error(`run events read failed: ${res.status}`);
		const eventPage = await res.json();
		if (Array.isArray(eventPage)) raw.push(...eventPage);
		const events = v.parse(eventsSchema, eventPage);
		for (const event of events) {
			const counted =
				event.type === "turn"
					? event.response?.usage
					: event.type === "compaction"
						? event.usage
						: undefined;
			if (event.type === "turn") usage.turns++;
			if (event.type === "tool") usage.toolCalls++;
			if (event.type === "compaction") usage.compactions++;
			if (counted) {
				usage.input += counted.input;
				usage.output += counted.output;
				usage.cacheRead += counted.cacheRead;
				usage.cacheWrite += counted.cacheWrite;
				usage.costUsd += counted.cost?.total ?? 0;
			}
		}
		const next = res.headers.get("stream-next-offset");
		if (res.headers.get("stream-up-to-date") === "true" || !next || next === offset) break;
		offset = next;
	}
	mkdirSync(dirname(eventsPath), { recursive: true });
	writeFileSync(eventsPath, JSON.stringify(raw));
	return usage;
}

// A panel mixes models, so it reports the cost Flue recorded per turn; the
// merge call runs outside Flue and is logged by the workflow instead.
function cost(spec: ModelSpec, usage: Usage): number {
	if (spec.panel) return usage.costUsd;
	const { price } = spec;
	return (
		(usage.input * price.input +
			usage.output * price.output +
			usage.cacheRead * price.cacheRead +
			usage.cacheWrite * price.cacheWrite) /
		1_000_000
	);
}

async function runOnce(
	spec: ModelSpec,
	base: string,
	payload: ReviewPayload,
	attempt: number,
): Promise<RunOutcome> {
	await reserveGitHubCalls(2);
	const started = Date.now();
	const admitted = await fetch(`${base}/eval/workflows/review`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const admission = v.parse(
		v.looseObject({ runId: v.optional(v.string()) }),
		await admitted.json().catch(() => ({})),
	);
	const outcome: RunOutcome = {
		case: payload.prNumber,
		headSha: payload.headSha,
		model: spec.model,
		modelKey: spec.key,
		runId: admission.runId,
		status: "admission_failed",
		attempt,
		wallMs: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			turns: 0,
			toolCalls: 0,
			compactions: 0,
			costUsd: 0,
		},
		costUsd: 0,
		finishedAt: "",
	};
	if (!admitted.ok || !admission.runId) {
		outcome.error = `admission returned ${admitted.status}`;
	} else {
		log(`${runKey(spec)} #${payload.prNumber} attempt ${attempt}: run ${admission.runId}`);
		const deadline = started + Number(args["timeout-min"]) * 60_000;
		let record: v.InferOutput<typeof runRecordSchema> = {};
		while (Date.now() < deadline) {
			await sleep(15_000);
			const res = await fetch(`${base}/eval/runs/${admission.runId}?meta`).catch(() => undefined);
			if (!res?.ok) continue;
			record = v.parse(runRecordSchema, await res.json());
			if (record.status && record.status !== "active") break;
		}
		outcome.wallMs = Date.now() - started;
		outcome.status = record.status === "active" || !record.status ? "timed_out" : record.status;
		outcome.durationMs = record.durationMs;
		outcome.result = record.result;
		outcome.error = record.error;
		try {
			outcome.usage = await readUsage(
				base,
				admission.runId,
				join(RESULTS_DIR, "events", basename(resultPath(payload.prNumber, spec))),
			);
			outcome.costUsd = cost(spec, outcome.usage);
		} catch (error) {
			log(`${runKey(spec)} #${payload.prNumber}: usage unavailable: ${String(error)}`);
		}
	}
	outcome.finishedAt = new Date().toISOString();
	return outcome;
}

async function runModel(
	spec: ModelSpec,
	port: number,
	file: CasesFile,
	cases: readonly EvalCase[],
	gateway: Record<string, string> | undefined,
): Promise<void> {
	const pending = cases.filter((evalCase) => {
		const out = resultPath(evalCase.pr, spec);
		if (args.force || !existsSync(out)) return true;
		const previous = readJson(previousOutcomeSchema, readFileSync(out, "utf8"));
		return previous.status !== "completed" || previous.headSha !== evalCase.headSha;
	});
	if (pending.length === 0) {
		log(`${runKey(spec)}: all cases already have results`);
		return;
	}
	const dir = prepareWorkDir(spec, gateway);
	log(`${runKey(spec)}: starting server on port ${port}`);
	const server = await startServer(spec, dir, port);
	const base = `http://127.0.0.1:${port}`;
	try {
		const queue = [...pending];
		const worker = async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const payload = payloadFor(file, next);
				let outcome = await runOnce(spec, base, payload, 1);
				if (outcome.status !== "completed") {
					log(`${runKey(spec)} #${next.pr}: ${outcome.status}; retrying once`);
					outcome = await runOnce(spec, base, payload, 2);
				}
				writeFileSync(resultPath(next.pr, spec), `${JSON.stringify(outcome, null, "\t")}\n`);
				log(
					`${runKey(spec)} #${next.pr}: ${outcome.status} in ${Math.round(outcome.wallMs / 1_000)}s, $${outcome.costUsd.toFixed(3)}`,
				);
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
	} finally {
		stopServer(server);
	}
}

async function main(): Promise<void> {
	assertNoGitHubCredentials();
	const file = readJson(casesFileSchema, readFileSync(join(EVAL_DIR, "cases.json"), "utf8"));
	const wanted = args.cases?.split(",").map(Number);
	const head = v.parse(v.optional(v.pipe(v.string(), v.regex(SHA))), args.head);
	const listed = wanted ? file.cases.filter((c) => wanted.includes(c.pr)) : file.cases;
	// With --head, a single PR outside cases.json can be reviewed too.
	const [onlyPr] = wanted ?? [];
	const selected =
		head && listed.length === 0 && wanted?.length === 1 && onlyPr !== undefined
			? [{ pr: onlyPr, headSha: head }]
			: listed;
	if (head && selected.length !== 1) throw new Error("--head needs exactly one case");
	const cases = head ? selected.map((c) => ({ ...c, headSha: head })) : selected;
	const specs = (args.models ?? "").split(",").map((key) => {
		const spec = MODELS.find((m) => m.key === key.trim());
		if (!spec) throw new Error(`unknown model key: ${key}`);
		return spec;
	});
	const gateway = specs.some((s) => s.gateway) ? gatewayEnv() : undefined;
	mkdirSync(RESULTS_DIR, { recursive: true });
	for (const evalCase of cases) payloadFor(file, evalCase);
	const basePort = Number(args["base-port"]);
	const runs = await Promise.allSettled(
		specs.map((spec, index) => runModel(spec, basePort + index, file, cases, gateway)),
	);
	for (const [index, run] of runs.entries()) {
		if (run.status === "rejected") log(`${specs[index]?.key}: ${String(run.reason)}`);
	}
}

await main();
