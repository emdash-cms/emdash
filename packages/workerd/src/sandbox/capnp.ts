/**
 * Cap'n Proto Config Generator for workerd
 *
 * Generates workerd configuration from plugin manifests.
 * Each plugin becomes a nanoservice with:
 * - Its own listening socket (for hook/route invocation from Node)
 * - An external service definition for the Node backing service
 * - globalOutbound set to the backing service (all fetch() calls route
 *   through the backing service, which enforces capability checks)
 */

import type { PluginManifest } from "emdash";

const SAFE_ID_RE = /[^a-z0-9_-]/gi;

interface LoadedPlugin {
	manifest: PluginManifest;
	code: string;
	port: number;
	token: string;
}

interface CapnpOptions {
	plugins: Map<string, LoadedPlugin>;
	backingServiceAddress: string;
	configDir: string;
}

/**
 * Generate a workerd capnp configuration file.
 *
 * Each plugin gets its own worker (nanoservice) with:
 * - A listener socket on its assigned port
 * - Modules for wrapper + plugin code
 * - globalOutbound pointing to the backing service external server
 *   (all outbound fetch() goes through the backing service for
 *   capability enforcement, SSRF protection, and host allowlist checks)
 *
 * KNOWN LIMITATION on resource limits:
 * Standalone workerd does NOT support per-worker cpuMs/memoryMb/subrequests
 * limits — those are Cloudflare platform features, not workerd capnp options.
 * The only limit we enforce on the Node path is wallTimeMs, which is wrapped
 * via Promise.race in WorkerdSandboxedPlugin.invokeHook/invokeRoute.
 * For true CPU/memory isolation, deploy on Cloudflare Workers.
 */
export function generateCapnpConfig(options: CapnpOptions): string {
	const { plugins, backingServiceAddress } = options;

	const lines: string[] = [
		`# Auto-generated workerd configuration for EmDash plugin sandbox`,
		`# Generated at: ${new Date().toISOString()}`,
		`# Plugins: ${plugins.size}`,
		``,
		`using Workerd = import "/workerd/workerd.capnp";`,
		``,
		`const config :Workerd.Config = (`,
		`  services = [`,
		// External service: the Node backing service
		`    (name = "emdash-backing", external = (address = "${backingServiceAddress}")),`,
	];

	// Add a service + socket for each plugin
	const socketEntries: string[] = [];

	for (const [pluginId, plugin] of plugins) {
		const safeId = pluginId.replace(SAFE_ID_RE, "_");

		lines.push(`    (name = "plugin-${safeId}", worker = .plugin_${safeId}),`);
		socketEntries.push(
			`    (name = "socket-${safeId}", address = "127.0.0.1:${plugin.port}", service = "plugin-${safeId}"),`,
		);
	}

	lines.push(`  ],`);

	// Socket definitions
	lines.push(`  sockets = [`);
	for (const socket of socketEntries) {
		lines.push(socket);
	}
	lines.push(`  ],`);
	lines.push(`);`);
	lines.push(``);

	// Worker definitions for each plugin
	for (const [pluginId] of plugins) {
		const safeId = pluginId.replace(SAFE_ID_RE, "_");
		const wrapperFile = `${safeId}-wrapper.js`;
		const pluginFile = `${safeId}-plugin.js`;

		lines.push(`const plugin_${safeId} :Workerd.Worker = (`);
		lines.push(`  modules = [`);
		lines.push(`    (name = "worker.js", esModule = embed "${wrapperFile}"),`);
		lines.push(`    (name = "sandbox-plugin.js", esModule = embed "${pluginFile}"),`);
		lines.push(`  ],`);
		lines.push(`  compatibilityDate = "2025-01-01",`);
		lines.push(`  compatibilityFlags = ["nodejs_compat"],`);
		// globalOutbound routes ALL outbound fetch() calls from the plugin
		// through the backing service. This is intentional security posture:
		//
		// - Bridge calls (e.g., fetch("http://bridge/content/get")) are
		//   dispatched normally by the backing service path router.
		// - Direct fetch() calls to arbitrary URLs (e.g., fetch("https://evil.com"))
		//   also arrive at the backing service. They will NOT match any known
		//   bridge method and will return 500 "Unknown bridge method".
		//
		// In other words: plugins cannot reach the internet by calling plain
		// fetch(). They must use ctx.http.fetch(), which goes through the
		// http/fetch bridge handler, which enforces network:fetch capability
		// and the allowedHosts allowlist.
		lines.push(`  globalOutbound = "emdash-backing",`);
		// Note: workerd capnp config does not support per-worker cpu/memory
		// limits. Wall-time is enforced in WorkerdSandboxedPlugin via
		// Promise.race. See generateCapnpConfig docstring above.
		lines.push(`);`);
		lines.push(``);
	}

	return lines.join("\n");
}
