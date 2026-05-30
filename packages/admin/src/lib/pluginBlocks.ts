import type { PluginBlockDef } from "../components/PortableTextEditor";
import type { AdminManifest } from "./api";
import { SECTION_TEMPLATE_PLUGIN_BLOCKS } from "./sectionTemplates";

export function getSectionTemplatePluginBlocks(): PluginBlockDef[] {
	return SECTION_TEMPLATE_PLUGIN_BLOCKS;
}

/** Extract plugin block definitions from the manifest for the Portable Text editor. */
export function getPluginBlocks(manifest: AdminManifest): PluginBlockDef[] {
	const blocks: PluginBlockDef[] = [...SECTION_TEMPLATE_PLUGIN_BLOCKS];
	for (const [pluginId, plugin] of Object.entries(manifest.plugins)) {
		if (plugin.portableTextBlocks) {
			for (const block of plugin.portableTextBlocks) {
				blocks.push({ ...block, pluginId });
			}
		}
	}
	return blocks;
}
