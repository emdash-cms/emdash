/**
 * SandboxedPluginWidget
 *
 * Renders a plugin's dashboard widget using Block Kit. Sends a page_load
 * interaction with page="widget:<widgetId>" to the plugin's admin route.
 */

import { Loader, SkeletonLine } from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { type FocusEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const page = `widget:${widgetId}`;
	const requestGeneration = useRef(0);
	const contentRef = useRef<HTMLElement | null>(null);
	const focusWithinRef = useRef(false);
	const restoreFocusRef = useRef(false);

	const setContentNode = useCallback((node: HTMLElement | null) => {
		contentRef.current = node;
	}, []);

	const handleFocusCapture = useCallback(() => {
		focusWithinRef.current = true;
	}, []);

	const handleBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget)) {
			focusWithinRef.current = false;
		}
	}, []);

	const sendInteraction = useCallback(
		async (interaction: BlockInteraction, showLoading = false) => {
			const generation = ++requestGeneration.current;
			const preserveFocus = () => {
				if (
					!showLoading &&
					(focusWithinRef.current || Boolean(contentRef.current?.contains(document.activeElement)))
				) {
					restoreFocusRef.current = true;
				}
			};
			if (showLoading) {
				setLoading(true);
				setError(null);
			} else {
				setPending(true);
			}
			try {
				const requestInteraction =
					interaction.type === "page_load" ? interaction : { ...interaction, page };
				const response = await apiFetch(`${API_BASE}/plugins/${pluginId}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestInteraction),
				});
				if (generation !== requestGeneration.current) return;

				if (!response.ok) {
					preserveFocus();
					setError(t`Plugin error (${response.status})`);
					return;
				}

				const body = (await response.json()) as { data: BlockResponse };
				if (generation !== requestGeneration.current) return;
				const data = body.data;
				preserveFocus();
				setBlocks(data.blocks);
				setError(null);
			} catch {
				if (generation === requestGeneration.current) {
					preserveFocus();
					setError(t`Failed to load widget`);
				}
			} finally {
				if (generation === requestGeneration.current) {
					if (showLoading) setLoading(false);
					setPending(false);
				}
			}
		},
		[page, pluginId, t],
	);

	// Initial widget load
	useEffect(() => {
		focusWithinRef.current = false;
		restoreFocusRef.current = false;
		void sendInteraction({ type: "page_load", page }, true);
		return () => {
			requestGeneration.current++;
		};
	}, [page, sendInteraction]);

	useLayoutEffect(() => {
		const container = contentRef.current;
		if (restoreFocusRef.current) {
			restoreFocusRef.current = false;
			const active = document.activeElement;
			if (
				container &&
				!container.contains(active) &&
				(active === null ||
					active === document.body ||
					active === document.documentElement ||
					!active.isConnected)
			) {
				container.focus({ preventScroll: true });
			}
		}
		if (!container?.contains(document.activeElement)) {
			focusWithinRef.current =
				focusWithinRef.current && Boolean(document.activeElement?.closest("[data-base-ui-portal]"));
		}
	}, [blocks, error]);

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
		return (
			<p
				ref={setContentNode}
				tabIndex={-1}
				onFocusCapture={handleFocusCapture}
				onBlurCapture={handleBlurCapture}
				className="text-sm text-kumo-subtle outline-none"
			>
				{error}
			</p>
		);
	}

	if (blocks.length === 0) {
		return (
			<p
				ref={setContentNode}
				tabIndex={-1}
				onFocusCapture={handleFocusCapture}
				onBlurCapture={handleBlurCapture}
				className="text-sm text-kumo-subtle outline-none"
			>
				{t`No content`}
			</p>
		);
	}

	return (
		<div className="relative">
			<div
				ref={setContentNode}
				tabIndex={-1}
				aria-busy={pending || undefined}
				onFocusCapture={handleFocusCapture}
				onBlurCapture={handleBlurCapture}
				className={
					pending ? "opacity-60 outline-none transition-opacity" : "outline-none transition-opacity"
				}
			>
				<BlockRenderer
					blocks={blocks}
					onAction={handleAction}
					resolveLinkTarget={(target) => resolvePluginLinkTarget(pluginId, target)}
				/>
			</div>
			{pending && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 flex items-center justify-center"
				>
					<Loader aria-label={t`Updating...`} className="text-kumo-subtle" />
				</div>
			)}
			<span role="status" className="sr-only">
				{pending ? t`Updating...` : ""}
			</span>
		</div>
	);
}
