/**
 * Cloudflare Email Provider Plugin
 *
 * Delivers EmDash emails (magic links, invites, comment notifications)
 * through Cloudflare Email Sending via a `send_email` Worker binding.
 * Registers `email:deliver` as an exclusive hook — activate the plugin,
 * then select it as the provider under Settings → Email.
 *
 * Without a production provider, deployments on Cloudflare only have the
 * dev console stub, and email-dependent auth flows (magic link login,
 * invites) fail with "Email is not configured".
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [
 *         cloudflareEmail({
 *           from: { email: "cms@mails.example.com", name: "My Site CMS" },
 *           replyTo: "hello@example.com",
 *         }),
 *       ],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```jsonc
 * // wrangler.jsonc — the sender domain must be onboarded for
 * // Email Sending (Cloudflare dashboard → Email Service).
 * {
 *   "send_email": [{ "name": "EMAIL" }]
 * }
 * ```
 */

import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";

/**
 * Cloudflare Email Provider Configuration
 */
export interface CloudflareEmailConfig {
	/**
	 * Name of the `send_email` binding in the wrangler config.
	 * @default "EMAIL"
	 */
	binding?: string;

	/**
	 * Sender address. Must belong to a domain onboarded for Cloudflare
	 * Email Sending. Either a bare address or `{ email, name }`.
	 */
	from: string | { email: string; name?: string };

	/**
	 * Optional Reply-To address — useful when the sender is a
	 * no-reply style subdomain address.
	 */
	replyTo?: string;
}

/** Minimal shape of the Email Sending binding (`send_email` in wrangler). */
interface SendEmailBinding {
	send(message: {
		to: string | string[];
		from: { email: string; name?: string };
		subject: string;
		text?: string;
		html?: string;
		replyTo?: string;
	}): Promise<{ messageId?: string }>;
}

/**
 * Resolve the Worker env at delivery time.
 *
 * Hooks run without request context, so the binding cannot come from
 * `Astro.locals.runtime`. The `cloudflare:workers` module exposes the
 * same env to any code bundled into the Worker — including in `astro dev`
 * when the Cloudflare Vite plugin provides the workerd runtime.
 */
async function loadWorkerEnv(): Promise<Record<string, unknown>> {
	try {
		const mod = await import("cloudflare:workers");
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Env is deployment-specific; the binding lookup validates the shape
		return mod.env as unknown as Record<string, unknown>;
	} catch {
		throw new Error(
			"[cloudflare-email] cloudflare:workers is not available — this provider " +
				"only runs on the Cloudflare Workers runtime (deployed or via astro dev " +
				"with the Cloudflare adapter).",
		);
	}
}

/**
 * Build the email:deliver handler.
 *
 * Exported for testing — production code should use {@link cloudflareEmail}.
 *
 * @internal
 */
export function createCloudflareEmailDeliver(
	config: CloudflareEmailConfig,
	loadEnv: () => Promise<Record<string, unknown>> = loadWorkerEnv,
): (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void> {
	const bindingName = config.binding ?? "EMAIL";
	const from = typeof config.from === "string" ? { email: config.from } : config.from;

	return async (event, ctx) => {
		const { message } = event;
		const env = await loadEnv();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object; the send() check below validates the shape
		const binding = env[bindingName] as SendEmailBinding | undefined;
		if (!binding || typeof binding.send !== "function") {
			throw new Error(
				`[cloudflare-email] send_email binding "${bindingName}" not found — ` +
					`declare it in the wrangler config ("send_email": [{ "name": "${bindingName}" }]).`,
			);
		}

		const result = await binding.send({
			from,
			to: message.to,
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
			...(config.replyTo ? { replyTo: config.replyTo } : {}),
		});

		ctx.log.info("email delivered via Cloudflare Email Sending", {
			to: message.to,
			subject: message.subject,
			messageId: result?.messageId,
		});
	};
}

/** Validate the sender address early so misconfiguration fails at config time. */
function assertValidFrom(config: CloudflareEmailConfig): void {
	const fromEmail = typeof config.from === "string" ? config.from : config.from?.email;
	if (!fromEmail || !fromEmail.includes("@")) {
		throw new Error(
			'[cloudflare-email] config.from is required (e.g. { from: "cms@mails.example.com" }) — ' +
				"Cloudflare Email Sending rejects messages without a verified sender address.",
		);
	}
}

/**
 * Instantiate the Cloudflare Email Sending provider plugin.
 *
 * Called by the generated `virtual:emdash/plugins` module with the
 * `options` from the {@link cloudflareEmail} descriptor. Use
 * `cloudflareEmail()` in the astro config — this export exists so the
 * integration can bundle the plugin from a static entrypoint.
 */
export function createPlugin(config: CloudflareEmailConfig): ResolvedPlugin {
	assertValidFrom(config);
	return definePlugin({
		id: "cloudflare-email",
		version: "1.0.0",
		capabilities: ["hooks.email-transport:register"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: createCloudflareEmailDeliver(config),
			},
		},
	});
}

/**
 * Create a Cloudflare Email Sending provider plugin descriptor.
 *
 * Pass it to the emdash() integration's plugins array, activate it under
 * Admin → Extensions, then select it under Settings → Email.
 *
 * Returns a `PluginDescriptor` (not an in-process definition): the astro
 * integration requires every `plugins: []` entry to resolve to a bundlable
 * `entrypoint`, so the descriptor points at this module and the integration
 * imports {@link createPlugin} from it at build time (#1721).
 */
export function cloudflareEmail(
	config: CloudflareEmailConfig,
): PluginDescriptor<CloudflareEmailConfig> {
	assertValidFrom(config);
	return {
		id: "cloudflare-email",
		version: "1.0.0",
		entrypoint: "@emdash-cms/cloudflare/plugins/cloudflare-email",
		format: "native",
		options: config,
		capabilities: ["hooks.email-transport:register"],
	};
}

export default cloudflareEmail;
