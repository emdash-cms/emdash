/**
 * Manifest-derived plugin lifecycle state, shared by the admin extension
 * hosts (content list, editor settings sidebar).
 */

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchManifest } from "./client.js";

const NO_DISABLED_PLUGINS: ReadonlySet<string> = new Set();

/**
 * Ids of plugins disabled in the runtime manifest. Extension hosts skip
 * these plugins' contributions — the same lifecycle rule dashboard widgets
 * and plugin pages already follow. Uses the shared `["manifest"]` query
 * (always warm: the admin root blocks rendering until the manifest loads),
 * so this subscribes to cached data rather than adding a request.
 */
export function useDisabledPluginIds(): ReadonlySet<string> {
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
		// The root layout owns manifest freshness. This observer only consumes
		// its cache and must not trigger another request when a content surface
		// mounts; explicit invalidation still refreshes active observers.
		staleTime: Infinity,
	});
	const plugins = manifest?.plugins;
	return React.useMemo(() => {
		const disabled = new Set<string>();
		for (const [pluginId, plugin] of Object.entries(plugins ?? {})) {
			if (plugin.enabled === false) disabled.add(pluginId);
		}
		return disabled.size > 0 ? disabled : NO_DISABLED_PLUGINS;
	}, [plugins]);
}
