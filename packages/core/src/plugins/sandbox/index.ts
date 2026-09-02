/**
 * Plugin Sandbox Exports
 *
 */

export { NoopSandboxRunner, SandboxNotAvailableError, createNoopSandboxRunner } from "./noop.js";
export {
	SandboxUnavailableError,
	createSandboxRouteError,
	createSandboxRouteErrorEnvelope,
	getSandboxRouteErrorDetails,
	getSandboxRouteErrorEnvelope,
} from "./types.js";
export {
	MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH,
	SANDBOX_HOOK_RESULT_VERSION,
	inspectSandboxHookResult,
} from "./hook-result.js";

export type {
	SandboxRunner,
	SandboxedPluginInstance,
	SandboxRunnerFactory,
	SandboxOptions,
	SandboxEmailMessage,
	SandboxEmailSendCallback,
	ResourceLimits,
	PluginCodeStorage,
	SerializedRequest,
	SandboxRouteErrorCode,
	SandboxRouteErrorDetails,
	SandboxRouteErrorEnvelope,
} from "./types.js";
export type {
	SandboxHookErrorEnvelope,
	SandboxHookResultInspection,
	SandboxSaveRejectedError,
} from "./hook-result.js";
