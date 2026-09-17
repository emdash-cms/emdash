/**
 * SandboxedPluginWidget
 *
 * Renders a plugin's dashboard widget using Block Kit. Sends a page_load
 * interaction with page="widget:<widgetId>" to the plugin's admin route.
 */

import { SkeletonLine } from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";

interface SandboxedPluginWidgetProps {
	pluginId: string;
	widgetId: string;
}

export function SandboxedPluginWidget({ pluginId, widgetId }: SandboxedPluginWidgetProps) {
	const { t } = useLingui();
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const page = `widget:${widgetId}`;

	const sendInteraction = useCallback(
		async (interaction: BlockInteraction) => {
			try {
				const requestInteraction =
					interaction.type === "page_load" ? interaction : { ...interaction, page };
				const response = await apiFetch(`${API_BASE}/plugins/${pluginId}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestInteraction),
				});

				if (!response.ok) {
					setError(t`Plugin error (${response.status})`);
					return;
				}

				const body = (await response.json()) as { data: BlockResponse };
				const data = body.data;
				setBlocks(data.blocks);
				setError(null);
			} catch {
				setError(t`Failed to load widget`);
			}
		},
		[page, pluginId, t],
	);

	// Initial widget load
	useEffect(() => {
		setLoading(true);
		void sendInteraction({ type: "page_load", page }).finally(() => setLoading(false));
	}, [page, sendInteraction]);

	const handleAction = useCallback(
		(interaction: BlockInteraction) => {
			void sendInteraction(interaction);
		},
		[sendInteraction],
	);

	if (loading) {
		return (
			<div className="space-y-3 py-1">
				{[1, 2, 3].map((i) => (
					<SkeletonLine key={i} blockHeight={24} minWidth={45} maxWidth={90} />
				))}
			</div>
		);
	}

	if (error) {
		return <p className="text-sm text-kumo-subtle">{error}</p>;
	}

	if (blocks.length === 0) {
		return <p className="text-sm text-kumo-subtle">{t`No content`}</p>;
	}

	return (
		<BlockRenderer
			blocks={blocks}
			onAction={handleAction}
			resolveLinkTarget={(target) => resolvePluginLinkTarget(pluginId, target)}
		/>
	);
}
