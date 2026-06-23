// flue-blueprint: sandbox/cloudflare-shell@1
//
// Project-owned Cloudflare Shell sandbox adapter (from `flue add sandbox
// cloudflare-shell`). Adapts a @cloudflare/shell Workspace into a Flue
// SandboxFactory: a durable Workspace filesystem (Durable Object SQLite) plus a
// model-facing JavaScript `code` tool executed via a Worker Loader binding.
// There is NO Linux shell -- exec() throws; agents use the `code` tool + fs.

import {
	DynamicWorkerExecutor,
	type DynamicWorkerExecutorOptions,
	type ResolvedProvider,
	resolveProvider,
} from "@cloudflare/codemode";
import {
	type FsStat as CfFsStat,
	STATE_TYPES,
	Workspace,
	WorkspaceFileSystem,
} from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type {
	FileStat,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	ShellResult,
} from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";

export interface GetShellSandboxOptions {
	workspace: Workspace;
	loader: WorkerLoader;
	executor?: Pick<DynamicWorkerExecutorOptions, "timeout" | "globalOutbound" | "modules">;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
	if (!options?.workspace) {
		throw new Error("[flue] getShellSandbox requires a workspace.");
	}
	if (!options.loader) {
		throw new Error(
			"[flue] getShellSandbox requires a WorkerLoader binding. Add { \"worker_loaders\": [{ \"binding\": \"LOADER\" }] } to wrangler.jsonc and pass loader: env.LOADER.",
		);
	}

	const { workspace, loader, executor: executorOptions } = options;
	const fs = new WorkspaceFileSystem(workspace);
	const executor = new DynamicWorkerExecutor({ loader, ...executorOptions });
	const stateProvider = resolveProvider(stateTools(workspace));
	const toolFactory: SessionToolFactory = () => [createCodeTool(executor, stateProvider)];

	return {
		async createSessionEnv() {
			return createWorkspaceSessionEnv(workspace, fs, "/");
		},
		tools: toolFactory,
	};
}

function normalizePath(p: string): string {
	const parts = p.split("/");
	const result: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") result.pop();
		else result.push(part);
	}
	return `/${result.join("/")}`;
}

function createWorkspaceSessionEnv(
	workspace: Workspace,
	fs: WorkspaceFileSystem,
	cwd: string,
): SessionEnv {
	const normalizedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith("/")) return normalizePath(p);
		if (normalizedCwd === "/") return normalizePath(`/${p}`);
		return normalizePath(`${normalizedCwd}/${p}`);
	};
	const exec = (): Promise<ShellResult> => {
		throw new Error(EXEC_NOT_SUPPORTED_MESSAGE);
	};

	return {
		exec,
		async readFile(path: string): Promise<string> {
			return fs.readFile(resolvePath(path));
		},
		async readFileBuffer(path: string): Promise<Uint8Array> {
			return fs.readFileBytes(resolvePath(path));
		},
		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			const write = async (): Promise<void> => {
				if (typeof content === "string") await workspace.writeFile(resolved, content);
				else await workspace.writeFileBytes(resolved, content);
			};
			try {
				await write();
			} catch {
				const parent = resolved.slice(0, resolved.lastIndexOf("/")) || "/";
				try {
					await fs.mkdir(parent, { recursive: true });
				} catch {}
				await write();
			}
		},
		async stat(path: string): Promise<FileStat> {
			return adaptStat(await fs.stat(resolvePath(path)));
		},
		async readdir(path: string): Promise<string[]> {
			return fs.readdir(resolvePath(path));
		},
		async exists(path: string): Promise<boolean> {
			return fs.exists(resolvePath(path));
		},
		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await fs.mkdir(resolvePath(path), opts);
		},
		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			await fs.rm(resolvePath(path), opts);
		},
		cwd: normalizedCwd,
		resolvePath,
	};
}

const EXEC_NOT_SUPPORTED_MESSAGE =
	"[flue] The cf-shell sandbox does not support exec(). Use the `code` tool (JavaScript over `state.*`) or session.fs.";

function adaptStat(s: CfFsStat): FileStat {
	return {
		isFile: s.type === "file",
		isDirectory: s.type === "directory",
		isSymbolicLink: s.type === "symlink",
		size: s.size,
		mtime: s.mtime,
	};
}

const CodeParams = {
	type: "object",
	properties: {
		code: {
			type: "string",
			description:
				"A single async arrow function `async () => { ... return result; }`. Call `state.*` to operate on the workspace (see the declarations below). Runs in an isolated Worker -- no network, no imports. Return a JSON-serializable value; it is returned as the tool result.",
		},
	},
	required: ["code"],
};

function createCodeTool(executor: DynamicWorkerExecutor, stateProvider: ResolvedProvider) {
	return {
		name: "code",
		label: "Run Code",
		description: buildCodeToolDescription(),
		parameters: CodeParams,
		async execute(_toolCallId: string, params: unknown) {
			const code = (params as { code: string }).code;
			const { result, error, logs } = await executor.execute(code, [stateProvider]);
			if (error) {
				const logsTail = logs?.length ? `\n\nlogs:\n${logs.join("\n")}` : "";
				throw new Error(`code tool failed: ${error}${logsTail}`);
			}
			const resultText = formatResult(result);
			const logsText = logs?.length ? `\n\n--- logs ---\n${logs.join("\n")}` : "";
			return {
				content: [{ type: "text" as const, text: resultText + logsText }],
				details: logs?.length ? { logs } : {},
			};
		},
	};
}

function formatResult(result: unknown): string {
	if (result === undefined) return "(no result)";
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function buildCodeToolDescription(): string {
	return [
		"Run a snippet of JavaScript inside an isolated Worker against a durable",
		"workspace filesystem. The snippet must be a single async arrow function:",
		"",
		"  async () => {",
		'    const text = await state.readFile("/notes.md");',
		"    return { bytes: text.length };",
		"  }",
		"",
		"Rules:",
		"- Write JavaScript, not TypeScript -- no type annotations.",
		"- Do not use `import` statements. Everything you need is on `state`.",
		"- Always `return` the value you want back.",
		"- For tree-wide search, use `state.replaceInFiles()` / search helpers.",
		"- Network access is disabled.",
		"",
		"The `state` API (TypeScript declaration; the runtime is JavaScript):",
		"",
		"```typescript",
		STATE_TYPES,
		"```",
	].join("\n");
}

export function getDefaultWorkspace(r2?: R2Bucket, name?: string): Workspace {
	const { storage } = getCloudflareContext();
	return new Workspace({
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		sql: storage.sql as SqlStorage,
		// `name` keys R2 objects and namespaces this workspace; required when an
		// R2 bucket is provided (large files spill under r2://<name>/...).
		...(name ? { name } : {}),
		...(r2 ? { r2 } : {}),
	});
}
