import { isSafePluginPagePath, normalizePluginPagePath, type LinkTarget } from "@emdash-cms/blocks";

export function resolvePluginLinkTarget(pluginId: string, target: LinkTarget): string | null {
	switch (target.kind) {
		case "content": {
			if (!target.collection || !target.id) return null;
			const url = `/_emdash/admin/content/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}`;
			return target.locale ? `${url}?locale=${encodeURIComponent(target.locale)}` : url;
		}
		case "plugin-page": {
			const path = normalizePluginPagePath(target.path);
			if (!isSafePluginPagePath(path)) return null;
			return `/_emdash/admin/plugins/${encodeURIComponent(pluginId)}${path}`;
		}
		case "plugin-settings":
			return `/_emdash/admin/plugins-manager/${encodeURIComponent(pluginId)}/settings`;
		case "external": {
			try {
				const url = new URL(target.url);
				return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
					? url.href
					: null;
			} catch {
				return null;
			}
		}
	}
}
