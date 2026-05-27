/**
 * Email send callback state — shared between the sandbox runner and PluginBridge.
 *
 * Keeping this in its own module breaks the direct dependency of runner.ts on
 * bridge.ts. With that dependency severed, Rollup's tree-shaker sees that
 * bridge.ts (and therefore PluginBridge) is only reachable from the worker
 * entry-point export (`export { PluginBridge } from "@emdash-cms/cloudflare/sandbox"`),
 * so it bundles bridge.ts directly into entry.mjs rather than pulling it into a
 * shared chunk.  That matters because Cloudflare's
 * `import { exports } from "cloudflare:workers"` only exposes WorkerEntrypoint
 * subclasses that are **defined inline** in the entry module — re-exports from
 * chunks return null.
 */

import type { SandboxEmailSendCallback } from "emdash";

let emailSendCallback: SandboxEmailSendCallback | null = null;

/**
 * Set the email send callback for all bridge instances.
 * Called by the sandbox runner when the EmailPipeline is available.
 */
export function setEmailSendCallback(callback: SandboxEmailSendCallback | null): void {
	emailSendCallback = callback;
}

/**
 * Get the current email send callback.
 * Used by PluginBridge.emailSend to invoke the host-side email sender.
 */
export function getEmailSendCallback(): SandboxEmailSendCallback | null {
	return emailSendCallback;
}
