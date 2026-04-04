/**
 * SandboxedPluginWidget
 *
 * Renders a plugin's dashboard widget using Block Kit. Sends a page_load
 * interaction with page="widget:<widgetId>" to the plugin's admin route.
 */

import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { CircleNotch } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";

interface SandboxedPluginWidgetProps {
	pluginId: string;
	widgetId: string;
}

export function SandboxedPluginWidget({ pluginId, widgetId }: SandboxedPluginWidgetProps) {
	const { t } = useLingui();
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const sendInteraction = useCallback(
		async (interaction: BlockInteraction) => {
			try {
				const response = await apiFetch(`${API_BASE}/plugins/${pluginId}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(interaction),
				});

				if (!response.ok) {
					setError(`Plugin error (${response.status})`);
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
		[pluginId],
	);

	// Initial widget load
	useEffect(() => {
		setLoading(true);
		void sendInteraction({ type: "page_load", page: `widget:${widgetId}` }).finally(() =>
			setLoading(false),
		);
	}, [sendInteraction, widgetId]);

	const handleAction = useCallback(
		(interaction: BlockInteraction) => {
			void sendInteraction(interaction);
		},
		[sendInteraction],
	);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-6">
				<CircleNotch className="h-5 w-5 animate-spin text-kumo-subtle" />
			</div>
		);
	}

	if (error) {
		return <p className="text-sm text-kumo-subtle">{error}</p>;
	}

	if (blocks.length === 0) {
		return <p className="text-sm text-kumo-subtle">{t`No content`}</p>;
	}

	return <BlockRenderer blocks={blocks} onAction={handleAction} />;
}
