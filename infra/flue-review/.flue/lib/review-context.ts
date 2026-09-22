export const GENERATED_WORKER_TYPES_FILENAME = "worker-configuration.d.ts";
export const GENERATED_WORKER_TYPES_NOTICE =
	"(generated Worker types omitted from model review context)\n";
export const COMPILED_RELEASE_ACTION_PATH = "apps/release-action/dist/index.js";
export const COMPILED_RELEASE_ACTION_NOTICE =
	"(compiled release-action artifact changed; contents omitted from model review context)\n";

interface ReviewWorkspace {
	glob(pattern: string): Promise<Array<string | { path: string }>>;
	exists(path: string): Promise<boolean>;
	writeFile(path: string, content: string): Promise<void>;
}

export async function omitGeneratedWorkerTypes(
	workspace: ReviewWorkspace,
	repoDir: string,
): Promise<void> {
	const files = await workspace.glob(`${repoDir}/**/${GENERATED_WORKER_TYPES_FILENAME}`);
	await Promise.all(
		files.map((file) =>
			workspace.writeFile(
				typeof file === "string" ? file : file.path,
				GENERATED_WORKER_TYPES_NOTICE,
			),
		),
	);
}

export async function omitReviewArtifacts(
	workspace: ReviewWorkspace,
	repoDir: string,
): Promise<void> {
	await omitGeneratedWorkerTypes(workspace, repoDir);
	const compiledReleaseAction = `${repoDir}/${COMPILED_RELEASE_ACTION_PATH}`;
	if (await workspace.exists(compiledReleaseAction)) {
		await workspace.writeFile(compiledReleaseAction, COMPILED_RELEASE_ACTION_NOTICE);
	}
}
