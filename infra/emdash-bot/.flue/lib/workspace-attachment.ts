export const WORKSPACE_SANDBOX_ATTEMPT_LIMIT = 3;

const TRANSIENT_FAILURE_PATTERNS = [
	/^HTTP error! status: 5\d\d\b/i,
	/^internal error; reference\s*=\s*[a-z0-9]+$/i,
	/network connection lost/i,
	/container suddenly disconnected/i,
	/error proxying request to container/i,
	/container (?:is )?(?:unavailable|starting|provisioning|unhealthy|replaced)/i,
	/no container instance/i,
	/durable object.*(?:reset|upgraded)/i,
];

interface WorkspaceAttempt {
	readonly attempt: number;
	readonly sandboxId: string;
}

interface WorkspaceAttemptFailure extends WorkspaceAttempt {
	readonly error: unknown;
}

interface WorkspaceRetry extends WorkspaceAttempt {
	readonly error: unknown;
}

export async function attachWorkspaceWithRetry<T>(options: {
	readonly agentId: string;
	readonly startAttempt: number;
	readonly attach: (attempt: WorkspaceAttempt) => Promise<T>;
	readonly discard: (failure: WorkspaceAttemptFailure) => Promise<void>;
	readonly onRetry?: (retry: WorkspaceRetry) => Promise<void>;
	readonly onAttached?: (attempt: WorkspaceAttempt) => Promise<void>;
	readonly onDiscardFailure?: (
		failure: WorkspaceAttemptFailure & { readonly discardError: unknown },
	) => Promise<void>;
}): Promise<T> {
	if (
		!Number.isSafeInteger(options.startAttempt) ||
		options.startAttempt < 0 ||
		options.startAttempt >= WORKSPACE_SANDBOX_ATTEMPT_LIMIT
	) {
		throw new Error(`invalid workspace sandbox attempt: ${options.startAttempt}`);
	}

	for (
		let attempt = options.startAttempt;
		attempt < WORKSPACE_SANDBOX_ATTEMPT_LIMIT;
		attempt += 1
	) {
		const sandboxId = workspaceSandboxId(options.agentId, attempt);
		try {
			const result = await options.attach({ attempt, sandboxId });
			await options.onAttached?.({ attempt, sandboxId });
			return result;
		} catch (error) {
			if (!isTransientWorkspaceFailure(error) || attempt + 1 >= WORKSPACE_SANDBOX_ATTEMPT_LIMIT) {
				throw error;
			}

			try {
				await options.discard({ attempt, sandboxId, error });
			} catch (discardError) {
				await options.onDiscardFailure?.({ attempt, sandboxId, error, discardError });
			}

			const nextAttempt = attempt + 1;
			await options.onRetry?.({
				attempt: nextAttempt,
				sandboxId: workspaceSandboxId(options.agentId, nextAttempt),
				error,
			});
		}
	}

	throw new Error("workspace sandbox attempts exhausted");
}

export async function prepareWorkspaceBeforeModel(options: {
	readonly prepare: () => Promise<void>;
	readonly onFailure: (error: unknown) => Promise<void>;
}): Promise<void> {
	try {
		await options.prepare();
	} catch (error) {
		await options.onFailure(error);
		throw error;
	}
}

export function isTransientWorkspaceFailure(error: unknown): boolean {
	for (const candidate of errorChain(error)) {
		if (isRetryableError(candidate)) return true;
		const name = errorName(candidate);
		if (
			name === "ContainerUnavailableError" ||
			name === "OperationInterruptedError" ||
			name === "RPCTransportError"
		) {
			return true;
		}
		const message = errorMessage(candidate);
		if (TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
			return true;
		}
	}
	return false;
}

function workspaceSandboxId(agentId: string, attempt: number): string {
	return attempt === 0 ? agentId : `${agentId}-r${attempt}`;
}

function* errorChain(error: unknown): Generator {
	let current = error;
	for (let depth = 0; depth < 8 && current != null; depth += 1) {
		yield current;
		current =
			typeof current === "object" && "cause" in current
				? (current as { readonly cause?: unknown }).cause
				: undefined;
	}
}

function errorName(error: unknown): string {
	if (typeof error !== "object" || error === null || !("name" in error)) return "";
	return typeof error.name === "string" ? error.name : "";
}

function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		return typeof error.message === "string" ? error.message : "Unknown workspace error";
	}
	return typeof error === "string" ? error : "Unknown workspace error";
}

function isRetryableError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("retryable" in error && error.retryable === true) return true;
	if (!("context" in error) || typeof error.context !== "object" || error.context === null) {
		return false;
	}
	return "retryable" in error.context && error.context.retryable === true;
}
