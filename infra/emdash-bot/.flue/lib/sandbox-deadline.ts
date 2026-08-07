import type { SandboxFactory, SessionEnv } from "@flue/runtime";

interface SandboxDeadlineOptions {
	defaultTimeoutMs: number;
	execGraceMs: number;
}

export class DeadlineExceededError extends Error {
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "DeadlineExceededError";
	}
}

export async function withDeadline<T>(
	operation: PromiseLike<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DeadlineExceededError(label, timeoutMs)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function withSandboxDeadlines(
	factory: SandboxFactory,
	options: SandboxDeadlineOptions,
): SandboxFactory {
	return {
		...factory,
		async createSessionEnv(context) {
			const env = await withDeadline(
				factory.createSessionEnv(context),
				options.defaultTimeoutMs,
				"Sandbox session creation",
			);
			return wrapSessionEnv(env, options);
		},
	};
}

function wrapSessionEnv(env: SessionEnv, options: SandboxDeadlineOptions): SessionEnv {
	const bounded = <T>(operation: PromiseLike<T>, operationName: string) =>
		withDeadline(operation, options.defaultTimeoutMs, `Sandbox ${operationName}`);

	return {
		exec(command, execOptions) {
			const timeoutMs = execOptions?.timeoutMs
				? execOptions.timeoutMs + options.execGraceMs
				: options.defaultTimeoutMs;
			return withDeadline(env.exec(command, execOptions), timeoutMs, "Sandbox exec");
		},
		readFile: (path) => bounded(env.readFile(path), "readFile"),
		readFileBuffer: (path) => bounded(env.readFileBuffer(path), "readFileBuffer"),
		writeFile: (path, content) => bounded(env.writeFile(path, content), "writeFile"),
		stat: (path) => bounded(env.stat(path), "stat"),
		readdir: (path) => bounded(env.readdir(path), "readdir"),
		exists: (path) => bounded(env.exists(path), "exists"),
		mkdir: (path, mkdirOptions) => bounded(env.mkdir(path, mkdirOptions), "mkdir"),
		rm: (path, rmOptions) => bounded(env.rm(path, rmOptions), "rm"),
		cwd: env.cwd,
		resolvePath: (path) => env.resolvePath(path),
	};
}
