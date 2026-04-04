/**
 * SandboxedPluginPage
 *
 * Renders a plugin's admin page using Block Kit. Sends page_load/block_action/form_submit
 * interactions to the plugin's admin route and renders the returned blocks.
 */

import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";

interface SandboxedPluginPageProps {
	pluginId: string;
	page: string;
}

export function SandboxedPluginPage({ pluginId, page }: SandboxedPluginPageProps) {
	const { t } = useLingui();
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<BlockResponse["toast"] | null>(null);

	// Send an interaction to the plugin admin route
	const sendInteraction = useCallback(
		async (interaction: BlockInteraction) => {
			try {
				const response = await apiFetch(`${API_BASE}/plugins/${pluginId}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(interaction),
				});

				if (!response.ok) {
					const text = await response.text();
					setError(`Plugin responded with ${response.status}: ${text}`);
					return;
				}

				const body = (await response.json()) as { data: BlockResponse };
				const data = body.data;
				setBlocks(data.blocks);
				setError(null);

				if (data.toast) {
					setToast(data.toast);
					setTimeout(setToast, 4000, null);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : t`Failed to communicate with plugin`);
			}
		},
		[pluginId],
	);

	// Initial page load
	useEffect(() => {
		setLoading(true);
		setError(null);
		void sendInteraction({ type: "page_load", page }).finally(() => setLoading(false));
	}, [sendInteraction, page]);

	// Handle block actions
	const handleAction = useCallback(
		(interaction: BlockInteraction) => {
			void sendInteraction(interaction);
		},
		[sendInteraction],
	);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-16">
				<CircleNotch className="h-6 w-6 animate-spin text-kumo-subtle" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/5 p-6">
				<div className="flex items-start gap-3">
					<WarningCircle className="h-5 w-5 shrink-0 text-kumo-danger" />
					<div>
						<h3 className="font-semibold text-kumo-danger">{t`Plugin Error`}</h3>
						<p className="mt-1 text-sm text-kumo-subtle">{error}</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="relative">
			{/* Toast notification */}
			{toast && (
				<div
					className={`fixed right-4 top-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${
						toast.type === "success"
							? "border-green-200 bg-green-50 text-green-800"
							: toast.type === "error"
								? "border-red-200 bg-red-50 text-red-800"
								: "border-blue-200 bg-blue-50 text-blue-800"
					}`}
				>
					{toast.message}
				</div>
			)}

			<BlockRenderer blocks={blocks} onAction={handleAction} />
		</div>
	);
}
