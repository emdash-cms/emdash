/** Current wire-format version for sandbox hook result envelopes. */
export const SANDBOX_HOOK_RESULT_VERSION = 1 as const;

/** Maximum editor-facing rejection reason accepted from a sandboxed plugin. */
export const MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH = 500;

export interface SandboxSaveRejectedError {
	code: "SAVE_REJECTED";
	reason: string;
}

/**
 * Returned from a sandboxed `content:beforeSave` hook to reject the save.
 * The host validates every field before exposing the reason to an editor.
 */
export interface SandboxHookErrorEnvelope {
	__emdashSandboxHookResult: true;
	version: typeof SANDBOX_HOOK_RESULT_VERSION;
	error: SandboxSaveRejectedError;
}

export type SandboxHookResultInspection =
	| { kind: "value" }
	| { kind: "malformed" }
	| { kind: "error"; error: SandboxSaveRejectedError };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize an untrusted value returned across the sandbox boundary. */
export function inspectSandboxHookResult(value: unknown): SandboxHookResultInspection {
	if (!isRecord(value) || !Object.hasOwn(value, "__emdashSandboxHookResult")) {
		return { kind: "value" };
	}
	if (
		value.__emdashSandboxHookResult !== true ||
		value.version !== SANDBOX_HOOK_RESULT_VERSION ||
		!isRecord(value.error) ||
		value.error.code !== "SAVE_REJECTED" ||
		typeof value.error.reason !== "string"
	) {
		return { kind: "malformed" };
	}

	const reason = value.error.reason.trim();
	if (reason.length === 0 || reason.length > MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH) {
		return { kind: "malformed" };
	}

	return { kind: "error", error: { code: "SAVE_REJECTED", reason } };
}
