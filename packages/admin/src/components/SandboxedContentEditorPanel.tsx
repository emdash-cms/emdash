import { Button, Collapsible, SkeletonLine, Toast } from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type {
	Block,
	BlockInteraction,
	BlockResponse,
	ContentEditorPanelInteraction,
} from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { apiFetch } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";
import { editorExtensionUrl } from "../lib/sandboxed-editor-extensions.js";

interface SandboxedContentEditorPanelProps {
	pluginId: string;
	panelId: string;
	title: string;
	collection: string;
	entryId: string;
	locale?: string | null;
	versionToken?: string;
}

export function SandboxedContentEditorPanel({
	pluginId,
	panelId,
	title,
	collection,
	entryId,
	locale,
	versionToken,
}: SandboxedContentEditorPanelProps) {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const [open, setOpen] = React.useState(false);
	const [loaded, setLoaded] = React.useState(false);
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState(false);
	const [blocks, setBlocks] = React.useState<Block[]>([]);
	const generation = React.useRef(0);
	const abortController = React.useRef<AbortController | null>(null);
	const identity = `${pluginId}:${panelId}:${collection}:${entryId}:${locale ?? ""}:${versionToken ?? ""}`;
	const identityRef = React.useRef(identity);
	identityRef.current = identity;

	React.useEffect(() => {
		setOpen(false);
		setLoaded(false);
		setLoading(false);
		setError(false);
		setBlocks([]);
		generation.current++;
		abortController.current?.abort();
		return () => {
			generation.current++;
			abortController.current?.abort();
		};
	}, [identity]);

	const sendInteraction = React.useCallback(
		async (interaction: ContentEditorPanelInteraction) => {
			const requestIdentity = identity;
			const requestGeneration = ++generation.current;
			abortController.current?.abort();
			const controller = new AbortController();
			abortController.current = controller;
			setLoading(true);
			setError(false);
			try {
				const response = await apiFetch(
					editorExtensionUrl(collection, entryId, pluginId, "panel", panelId, locale),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(interaction),
						signal: controller.signal,
					},
				);
				if (requestIdentity !== identityRef.current || requestGeneration !== generation.current)
					return;
				if (!response.ok) throw new Error("Plugin panel request failed");
				const body = (await response.json()) as { data: BlockResponse };
				if (requestIdentity !== identityRef.current || requestGeneration !== generation.current)
					return;
				setBlocks(body.data.blocks);
				setLoaded(true);
				if (body.data.toast) {
					toastManager.add({ title: body.data.toast.message, type: body.data.toast.type });
				}
			} catch {
				if (
					controller.signal.aborted ||
					requestIdentity !== identityRef.current ||
					requestGeneration !== generation.current
				) {
					return;
				}
				setError(true);
			} finally {
				if (requestIdentity === identityRef.current && requestGeneration === generation.current) {
					setLoading(false);
				}
			}
		},
		[collection, entryId, identity, locale, panelId, pluginId, toastManager],
	);

	const handleOpenChange = React.useCallback(
		(nextOpen: boolean) => {
			setOpen(nextOpen);
			if (nextOpen && !loaded && !loading) void sendInteraction({ type: "panel_load" });
		},
		[loaded, loading, sendInteraction],
	);
	const handleAction = React.useCallback(
		(interaction: BlockInteraction) => {
			if (interaction.type === "page_load") return;
			const { page: _page, ...panelInteraction } = interaction;
			void sendInteraction(panelInteraction);
		},
		[sendInteraction],
	);

	return (
		<Collapsible.Root open={open} onOpenChange={handleOpenChange}>
			<Collapsible.DefaultTrigger>{title}</Collapsible.DefaultTrigger>
			<Collapsible.DefaultPanel>
				<div className="min-w-0 px-4 pb-4">
					{loading && !loaded ? (
						<div className="space-y-2 py-2" aria-label={t`Loading plugin panel`}>
							<SkeletonLine blockHeight={20} minWidth={60} maxWidth={95} />
							<SkeletonLine blockHeight={20} minWidth={35} maxWidth={80} />
						</div>
					) : error ? (
						<div role="alert" className="py-2 text-sm text-kumo-subtle">
							<p>{t`Plugin panel unavailable.`}</p>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="mt-1"
								onClick={() => void sendInteraction({ type: "panel_load" })}
							>
								{t`Retry`}
							</Button>
						</div>
					) : loaded ? (
						<BlockRenderer
							blocks={blocks}
							onAction={handleAction}
							resolveLinkTarget={(target) => resolvePluginLinkTarget(pluginId, target)}
						/>
					) : null}
				</div>
			</Collapsible.DefaultPanel>
		</Collapsible.Root>
	);
}
