const FORWARD_SLASH_PATTERN = "/";
const MCP_SAFE_PLUGIN_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PLUGIN_SCOPE_PREFIX_PATTERN = /^@/;
const PLUGIN_ID_DASH_PATTERN = /-/g;
const PLUGIN_ID_UNDERSCORE_PATTERN = /_/;
const AMBIGUOUS_PLUGIN_SEGMENT_PATTERN = /__/;
const AMBIGUOUS_JOINED_PLUGIN_ID_PATTERN = /_{3,}/;

export function pluginToolName(pluginId: string, toolName: string): string {
	if (
		MCP_SAFE_PLUGIN_ID_PATTERN.test(pluginId) &&
		!AMBIGUOUS_PLUGIN_SEGMENT_PATTERN.test(pluginId)
	) {
		return `${pluginId}__${toolName}`;
	}

	const readableSegments = pluginId
		.replace(PLUGIN_SCOPE_PREFIX_PATTERN, "")
		.split(FORWARD_SLASH_PATTERN)
		.map((segment) => segment.replace(PLUGIN_ID_DASH_PATTERN, "_"));
	const readablePluginId = readableSegments.join("__");
	if (
		PLUGIN_ID_UNDERSCORE_PATTERN.test(pluginId) ||
		AMBIGUOUS_JOINED_PLUGIN_ID_PATTERN.test(readablePluginId) ||
		readableSegments.some((segment) => AMBIGUOUS_PLUGIN_SEGMENT_PATTERN.test(segment))
	) {
		return `${readablePluginId}__${stableToolNameHash(pluginId)}__${toolName}`;
	}
	return `${readablePluginId}__${toolName}`;
}

function stableToolNameHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
