/**
 * Email Pipeline
 *
 * Orchestrates the three-stage email pipeline:
 * 1. email:beforeSend hooks (middleware — transform, validate, cancel)
 * 2. email:deliver hook (exclusive — exactly one provider delivers)
 * 3. email:afterSend hooks (logging, analytics, fire-and-forget)
 *
 * Security features:
 * - Recursion guard prevents re-entrant sends (e.g. plugin calling ctx.email.send from a hook)
 * - System emails (source="system") bypass email:beforeSend and email:afterSend hooks entirely
 *   to protect auth tokens from exfiltration by plugin hooks
 *
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { HookPipeline } from "./hooks.js";
import type { EmailDeliverEvent, EmailMessage } from "./types.js";

/** Hook name for the exclusive email delivery hook */
const EMAIL_DELIVER_HOOK = "email:deliver";

/** Source value used for auth emails (magic links, invites, password resets) */
const SYSTEM_SOURCE = "system";

/**
 * Error thrown when ctx.email.send() is called but no provider is configured.
 */
export class EmailNotConfiguredError extends Error {
	constructor() {
		super(
			"No email provider is configured. Install and activate an email provider plugin, " +
				"then select it in Settings > Email.",
		);
		this.name = "EmailNotConfiguredError";
	}
}

/**
 * Error thrown when a recursive email send is detected.
 */
export class EmailRecursionError extends Error {
	constructor() {
		super(
			"Recursive email send detected. A plugin hook attempted to send an email " +
				"from within the email pipeline, which would cause infinite recursion.",
		);
		this.name = "EmailRecursionError";
	}
}

/**
 * Recursion guard using AsyncLocalStorage.
 *
 * EmailPipeline is a singleton (worker-lifetime cached via EmDashRuntime).
 * Instance state like `sendDepth` would false-positive under concurrent
 * requests because two unrelated sends would increment the same counter.
 * ALS scopes the guard to the current async execution context, so concurrent
 * requests each get their own independent recursion tracking.
 */
const emailSendALS = new AsyncLocalStorage<{ depth: number }>();

/**
 * EmailPipeline orchestrates email delivery through the plugin hook system.
 *
 * The pipeline runs in three stages:
 * 1. email:beforeSend — middleware hooks that can transform or cancel messages
 * 2. email:deliver — exclusive hook dispatching to the selected provider
 * 3. email:afterSend — fire-and-forget hooks for logging/analytics
 */
export class EmailPipeline {
	private pipeline: HookPipeline;

	constructor(pipeline: HookPipeline) {
		this.pipeline = pipeline;
	}

	/**
	 * Replace the underlying hook pipeline.
	 *
	 * Called by the runtime when rebuilding the hook pipeline after a
	 * plugin is enabled or disabled, so the email pipeline dispatches
	 * to the current set of active hooks.
	 */
	setPipeline(pipeline: HookPipeline): void {
		this.pipeline = pipeline;
	}

	/**
	 * Send an email through the full pipeline.
	 *
	 * @param message - The email to send
	 * @param source - Where the email originated ("system" for auth, plugin ID for plugins)
	 * @throws EmailNotConfiguredError if no provider is selected
	 * @throws EmailRecursionError if called re-entrantly from within a hook
	 * @throws Error if the provider handler throws
	 */
	async send(message: EmailMessage, source: string): Promise<void> {
		// Recursion guard: a plugin with email:send + email:intercept calling
		// ctx.email.send() from an email hook would loop forever.
		// Uses AsyncLocalStorage so concurrent requests don't interfere —
		// each async context tracks its own depth independently.
		const store = emailSendALS.getStore();
		if (store && store.depth > 0) {
			throw new EmailRecursionError();
		}

		const run = () => this.sendInner(message, source);
		if (store) {
			// Already inside an ALS context (e.g. nested call) — increment depth
			store.depth++;
			try {
				await run();
			} finally {
				store.depth--;
			}
		} else {
			// First call — create new ALS context
			await emailSendALS.run({ depth: 1 }, run);
		}
	}

	/**
	 * Inner send implementation, separated from the recursion guard.
	 */
	private async sendInner(message: EmailMessage, source: string): Promise<void> {
		// Validate message fields at the pipeline boundary. TypeScript enforces
		// this at compile time, but sandboxed plugins cross an RPC boundary
		// where runtime types aren't guaranteed.
		if (!message || typeof message !== "object") {
			throw new Error("Invalid email message: message must be an object");
		}
		if (!message.to || typeof message.to !== "string") {
			throw new Error("Invalid email message: 'to' is required and must be a string");
		}
		if (!message.subject || typeof message.subject !== "string") {
			throw new Error("Invalid email message: 'subject' is required and must be a string");
		}
		if (!message.text || typeof message.text !== "string") {
			throw new Error("Invalid email message: 'text' is required and must be a string");
		}

		const isSystemEmail = source === SYSTEM_SOURCE;

		// System emails (auth tokens, magic links, invites) skip the
		// email:beforeSend pipeline entirely. These contain sensitive tokens
		// that must never be exposed to plugin hooks — a malicious interceptor
		// could rewrite the body/URL to steal auth tokens even if the `to`
		// field is protected.
		let finalMessage: EmailMessage;
		if (isSystemEmail) {
			finalMessage = message;
		} else {
			// Stage 1: email:beforeSend middleware (can transform or cancel)
			const beforeResult = await this.pipeline.runEmailBeforeSend(message, source);

			if (beforeResult.message === false) {
				// Cancelled by middleware — find which plugin cancelled for audit log
				const cancellingResult = beforeResult.results.find((r) => r.value === false);
				const cancelledBy = cancellingResult?.pluginId ?? "unknown";

				console.info(`[email] Email to "${message.to}" cancelled by plugin "${cancelledBy}"`);
				return;
			}

			finalMessage = beforeResult.message;
		}

		// Stage 2: email:deliver (exclusive hook)
		const deliverEvent: EmailDeliverEvent = { message: finalMessage, source };
		const deliverResult = await this.pipeline.invokeExclusiveHook(EMAIL_DELIVER_HOOK, deliverEvent);

		if (!deliverResult) {
			throw new EmailNotConfiguredError();
		}

		if (deliverResult.error) {
			// The caller (e.g. auth routes) often swallows delivery errors to avoid
			// leaking whether an email address exists. Log here so the failure and
			// the responsible provider are always visible in runtime logs.
			console.error(
				`[email:deliver] Provider "${deliverResult.pluginId}" failed to send email to "${finalMessage.to}":`,
				deliverResult.error,
			);
			throw deliverResult.error;
		}

		// Stage 3: email:afterSend (fire-and-forget)
		// System emails skip afterSend for the same reason they skip beforeSend:
		// the message contains plaintext auth tokens that must not be exposed to
		// plugin hooks. A logging/analytics hook could exfiltrate magic link URLs.
		// Errors are logged internally by the pipeline, not propagated.
		if (!isSystemEmail) {
			this.pipeline
				.runEmailAfterSend(finalMessage, source)
				.catch((err) =>
					console.error(
						"[email] afterSend pipeline error:",
						err instanceof Error ? err.message : err,
					),
				);
		}
	}

	/**
	 * Check if an email provider is configured and available.
	 *
	 * Returns true if an email:deliver provider is selected in the exclusive
	 * hook system. Plugins and auth code use this to decide whether to show
	 * "send invite" vs "copy invite link" UI.
	 */
	isAvailable(): boolean {
		return this.pipeline.getExclusiveSelection(EMAIL_DELIVER_HOOK) !== undefined;
	}
}
