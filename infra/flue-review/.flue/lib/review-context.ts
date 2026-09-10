export const GENERATED_WORKER_TYPES_FILENAME = "worker-configuration.d.ts";
export const GENERATED_WORKER_TYPES_NOTICE =
	"(generated Worker types omitted from model review context)\n";

interface ReviewWorkspace {
	glob(pattern: string): Promise<Array<string | { path: string }>>;
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
