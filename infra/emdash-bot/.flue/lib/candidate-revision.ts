import type { ContainerBackend } from "./exec-env.js";
import { quote } from "./exec-env.js";

const CANDIDATE_FETCH_DEPTH = 50;
const CANDIDATE_DEEPEN_STEPS = [256, 1024] as const;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const CONFLICT_CHECK_TIMEOUT_MS = 2 * 60_000;

export async function applyCandidateForRevision(
	container: ContainerBackend,
	candidateSha: string,
	baseRef: string,
): Promise<void> {
	const fetch = await container.exec(
		`git fetch --depth ${CANDIDATE_FETCH_DEPTH} origin ${quote(candidateSha)}`,
		{ cwd: "/workspace/repo", timeoutMs: COMMAND_TIMEOUT_MS },
	);
	if (fetch.exitCode !== 0) {
		throw new Error(`candidate fetch failed (${fetch.exitCode}): ${fetch.stderr.slice(-500)}`);
	}

	const base = await findMergeBase(container, candidateSha, baseRef);
	const apply = await container.exec(
		`git diff --binary ${quote(base)} ${quote(candidateSha)} -- > /tmp/emdash-candidate.patch && git apply --3way --whitespace=nowarn /tmp/emdash-candidate.patch`,
		{ cwd: "/workspace/repo", timeoutMs: COMMAND_TIMEOUT_MS },
	);
	if (apply.exitCode === 0) return;
	const conflicts = await container.exec("git ls-files -u", {
		cwd: "/workspace/repo",
		timeoutMs: CONFLICT_CHECK_TIMEOUT_MS,
	});
	if (conflicts.exitCode === 0 && conflicts.stdout.trim() !== "") return;
	throw new Error(`candidate rebase setup failed (${apply.exitCode}): ${apply.stderr.slice(-500)}`);
}

async function findMergeBase(
	container: ContainerBackend,
	candidateSha: string,
	baseRef: string,
): Promise<string> {
	for (const deepen of [null, ...CANDIDATE_DEEPEN_STEPS]) {
		if (deepen !== null) {
			const result = await container.exec(
				`git fetch --deepen ${deepen} origin ${quote(candidateSha)} ${quote(baseRef)}`,
				{ cwd: "/workspace/repo", timeoutMs: COMMAND_TIMEOUT_MS },
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`candidate history deepen failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
				);
			}
		}
		const result = await container.exec(`git merge-base HEAD ${quote(candidateSha)}`, {
			cwd: "/workspace/repo",
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
		const base = result.stdout.trim();
		if (result.exitCode === 0 && base !== "") return base;
	}
	throw new Error("candidate history has no merge base after deepening");
}
