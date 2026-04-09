import { definePlugin } from "emdash";
import type { PluginDescriptor, ResolvedPlugin } from "emdash";

import {
	DEFAULT_AUTH_TYPE,
	DEFAULT_TRANSPORT_SECURITY,
	PLUGIN_ID,
	TLS_REQUIRED_MESSAGE,
	VERSION,
	defaultPortForTransportSecurity,
	installDefaults,
	readConfig,
	sendWithWorkerMailer,
	type WorkerMailerPluginOptions,
} from "./shared.js";

/**
 * Descriptor for use in astro.config.mjs / live.config.ts.
 */
export function workerMailerPlugin(options: WorkerMailerPluginOptions = {}): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		entrypoint: "@emdash-cms/plugin-worker-mailer",
		options,
		capabilities: ["email:provide"],
		adminPages: [{ path: "/settings", label: "SMTP", icon: "envelope" }],
	};
}

export function createPlugin(options: WorkerMailerPluginOptions = {}): ResolvedPlugin {
	const transportSecurity = options.transportSecurity ?? DEFAULT_TRANSPORT_SECURITY;

	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["email:provide"],

		hooks: {
			"plugin:install": {
				handler: async (_event, ctx) => {
					await installDefaults(ctx, options);
				},
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					const config = await readConfig(ctx, options);
					await sendWithWorkerMailer(ctx, config, event.message);
				},
			},
		},

		admin: {
			settingsSchema: {
				host: {
					type: "string",
					label: "SMTP Host",
					description: "SMTP server hostname (for example: smtp.example.com)",
					default: options.host ?? "",
				},
				transportSecurity: {
					type: "select",
					label: "Transport Security",
					options: [
						{ value: "starttls", label: "STARTTLS" },
						{ value: "implicit_tls", label: "Implicit TLS / SMTPS" },
					],
					description: TLS_REQUIRED_MESSAGE,
					default: transportSecurity,
				},
				port: {
					type: "number",
					label: "SMTP Port",
					description: "Use 587 for STARTTLS or 465 for implicit TLS.",
					default: options.port ?? defaultPortForTransportSecurity(transportSecurity),
					min: 1,
					max: 65535,
				},
				authType: {
					type: "select",
					label: "Auth Type",
					options: [
						{ value: "plain", label: "PLAIN" },
						{ value: "login", label: "LOGIN" },
						{ value: "cram-md5", label: "CRAM-MD5" },
					],
					default: options.authType ?? DEFAULT_AUTH_TYPE,
				},
				username: {
					type: "string",
					label: "SMTP Username",
					default: options.username ?? "",
				},
				password: {
					type: "secret",
					label: "SMTP Password",
					description: "Stored encrypted at rest",
				},
				fromEmail: {
					type: "string",
					label: "From Email",
					description: "Defaults to SMTP username when empty",
					default: options.fromEmail ?? "",
				},
				fromName: {
					type: "string",
					label: "From Name",
					description: "Optional display name for outgoing emails",
					default: options.fromName ?? "",
				},
			},
			pages: [{ path: "/settings", label: "SMTP", icon: "envelope" }],
		},
	});
}

export default createPlugin;
