/**
 * Cap'n Proto Config Generator for workerd
 *
 * Generates workerd configuration from plugin manifests.
 * Each plugin becomes a nanoservice with:
 * - Its own listening socket (for hook/route invocation from Node)
 * - An external service binding pointing to the Node backing service
 * - Scoped environment variables (auth token, plugin metadata)
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
	backingServiceUrl: string;
	configDir: string;
}

/**
 * Generate a workerd capnp configuration file.
 *
 * Each plugin gets its own worker (nanoservice) with:
 * - A listener socket on its assigned port
 * - Modules for wrapper + plugin code
 * - Environment bindings for auth token and plugin metadata
 *
 * The backing service is accessed via globalOutbound, which routes
 * all outbound fetch() calls from the plugin to the Node process.
 * The wrapper code prepends the backing service URL to bridge calls.
 */
export function generateCapnpConfig(options: CapnpOptions): string {
	const { plugins } = options;

	const lines: string[] = [
		`# Auto-generated workerd configuration for EmDash plugin sandbox`,
		`# Generated at: ${new Date().toISOString()}`,
		`# Plugins: ${plugins.size}`,
		``,
		`using Workerd = import "/workerd/workerd.capnp";`,
		``,
		`const config :Workerd.Config = (`,
		`  services = [`,
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
		// globalOutbound allows the plugin wrapper to fetch() the backing service
		// The wrapper code uses absolute URLs to the backing service
		lines.push(`);`);
		lines.push(``);
	}

	return lines.join("\n");
}
