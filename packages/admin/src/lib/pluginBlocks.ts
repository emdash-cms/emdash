import type { PluginBlockDef } from "../components/PortableTextEditor";
import type { AdminManifest } from "./api";

/** Extract plugin block definitions from the manifest for the Portable Text editor. */
export function getPluginBlocks(manifest: AdminManifest): PluginBlockDef[] {
	const blocks: PluginBlockDef[] = [];
	for (const [pluginId, plugin] of Object.entries(manifest.plugins)) {
		if (plugin.portableTextBlocks) {
			for (const block of plugin.portableTextBlocks) {
				blocks.push({ ...block, pluginId });
			}
		}
	}
	return blocks;
}
