/**
 * SandboxedPluginPage
 *
 * Renders a plugin's admin page using Block Kit. Sends page_load/block_action/form_submit
 * interactions to the plugin's admin route and renders the returned blocks.
 */

import { Loader } from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { WarningCircle } from "@phosphor-icons/react";
import { type FocusEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";

interface SandboxedPluginPageProps {
	pluginId: string;
	page: string;
}

export function SandboxedPluginPage({ pluginId, page }: SandboxedPluginPageProps) {
	const { t } = useLingui();
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<BlockResponse["toast"] | null>(null);
	const requestGeneration = useRef(0);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const focusWithinRef = useRef(false);
	const restoreFocusRef = useRef(false);

	const handleFocusCapture = useCallback(() => {
		focusWithinRef.current = true;
	}, []);

	const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget)) {
			focusWithinRef.current = false;
		}
	}, []);

	// Send an interaction to the plugin admin route
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
			if (toastTimer.current) clearTimeout(toastTimer.current);
			toastTimer.current = null;
			setToast(null);
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
					const text = await response.text();
					if (generation !== requestGeneration.current) return;
					preserveFocus();
					setError(t`Plugin responded with ${response.status}: ${text}`);
					return;
				}

				const body = (await response.json()) as { data: BlockResponse };
				if (generation !== requestGeneration.current) return;
				const data = body.data;
				preserveFocus();
				setBlocks(data.blocks);
				setError(null);

				if (data.toast) {
					setToast(data.toast);
					toastTimer.current = setTimeout(() => {
						if (generation === requestGeneration.current) setToast(null);
						toastTimer.current = null;
					}, 4000);
				}
			} catch (err) {
				if (generation === requestGeneration.current) {
					preserveFocus();
					setError(err instanceof Error ? err.message : t`Failed to communicate with plugin`);
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

	// Initial page load
	useEffect(() => {
		focusWithinRef.current = false;
		restoreFocusRef.current = false;
		void sendInteraction({ type: "page_load", page }, true);
		return () => {
			requestGeneration.current++;
			if (toastTimer.current) clearTimeout(toastTimer.current);
		};
	}, [sendInteraction, page]);

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
				<Loader aria-label={t`Loading...`} className="text-kumo-subtle" />
			</div>
		);
	}

	if (error) {
		return (
			<div
				ref={contentRef}
				tabIndex={-1}
				onFocusCapture={handleFocusCapture}
				onBlurCapture={handleBlurCapture}
				className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/5 p-6 outline-none"
			>
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
					className={`fixed end-4 top-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${
						toast.type === "success"
							? "border-kumo-success/50 bg-kumo-success-tint text-kumo-success"
							: toast.type === "error"
								? "border-kumo-danger/50 bg-kumo-danger/10 text-kumo-danger"
								: "border-kumo-info/50 bg-kumo-info-tint text-kumo-info"
					}`}
				>
					{toast.message}
				</div>
			)}

			<div
				ref={contentRef}
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
