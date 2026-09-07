// pkg.pr.new preview helpers for the fix loop.
//
// The worker never publishes to pkg.pr.new -- that authenticates via the
// pkg-pr-new GitHub App + Actions OIDC and can only run inside GitHub Actions.
// The worker's job is to push `bot/fix-<n>`; `preview-releases.yml` (unchanged)
// publishes the preview on that push. What lives here is the reader half: the
// canonical install URL and a bounded readiness probe the DO alarm polls so the
// ask comment only advertises a preview that has actually resolved.

const PREVIEW_PROBE_TIMEOUT_MS = 10_000;
const PREVIEW_PACKAGE_CHARS = /^[a-zA-Z0-9@._/-]+$/;

/** The fix branch pkg.pr.new keys the preview to. */
export function fixBranch(issueNumber: number): string {
	return `bot/fix-${issueNumber}`;
}

/** The orphan branch holding this issue's reproduction screenshots. */
export function artifactsBranch(issueNumber: number): string {
	return `bot/artifacts-${issueNumber}`;
}

/**
 * The bot branches to delete when reaping an issue's fix loop. The artifacts
 * branch is always safe -- it is never a PR head. The fix branch is spared when
 * an open PR references it: deleting the ref would silently close that PR and
 * lose the bot's work with no recovery (a maintainer may have closed the issue
 * while the bot PR was still open).
 */
export function branchesToReap(issueNumber: number, hasOpenFixPr: boolean): string[] {
	return hasOpenFixPr
		? [artifactsBranch(issueNumber)]
		: [fixBranch(issueNumber), artifactsBranch(issueNumber)];
}

/**
 * The pkg.pr.new install URL. pkg.pr.new resolves branches by the FULL ref, so
 * the `bot/fix-<n>` prefix stays verbatim -- stripping `bot/` produces a URL
 * that 404s. This same URL is what the readiness probe polls and what the ask
 * comment advertises, so there is one source of truth.
 */
export function previewUrl(issueNumber: number, previewPackage = "emdash"): string {
	if (
		previewPackage === "" ||
		previewPackage.startsWith("/") ||
		previewPackage.endsWith("/") ||
		!PREVIEW_PACKAGE_CHARS.test(previewPackage) ||
		previewPackage.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error(`invalid preview package: ${previewPackage}`);
	}
	return `https://pkg.pr.new/${previewPackage}@${fixBranch(issueNumber)}`;
}

/** The one-line install command posted in the ask comment. */
export function previewInstallCommand(issueNumber: number, previewPackage = "emdash"): string {
	return `npm i ${previewUrl(issueNumber, previewPackage)}`;
}

export function playgroundPreviewUrl(issueNumber: number): string {
	return `https://${fixBranch(issueNumber).replaceAll("/", "-")}.try.emdashcms.com/`;
}

/**
 * Probe pkg.pr.new for a published preview. Returns true on a 2xx, false on
 * anything else (a 404 while publishing is still in flight, a network error, or
 * the probe timing out). Never throws: the caller treats false as "not yet" and
 * retries on the next poll until its overall deadline.
 */
export async function probePreviewReady(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			redirect: "follow",
			signal: AbortSignal.timeout(PREVIEW_PROBE_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}
