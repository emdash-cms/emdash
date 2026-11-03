import {
	Button,
	Collapsible,
	Loader,
	SkeletonLine,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { BlockRenderer } from "@emdash-cms/blocks";
import type {
	Block,
	BlockInteraction,
	BlockResponse,
	ContentEditorPanelInteraction,
	EditorDraftInvocationReceipt,
	EditorDraftPatchEffect,
} from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import * as React from "react";

import { apiFetch } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";
import { editorExtensionUrl } from "../lib/sandboxed-editor-extensions.js";
import type { EditorDraftAccessDeclaration } from "../lib/sandboxed-editor-extensions.js";
import { cn } from "../lib/utils.js";

export interface BrowserEditorDraftRequest {
	collection: string;
	entryId: string;
	locale: string | null;
	baseRevision: string;
	generation: number;
	invocationId: string;
	fields: Record<string, unknown>;
}

export interface EditorDraftResponse {
	patch?: EditorDraftPatchEffect;
	editorInvocation?: EditorDraftInvocationReceipt;
}

interface SandboxedContentEditorPanelProps {
	pluginId: string;
	panelId: string;
	title: string;
	collection: string;
	entryId: string;
	locale?: string | null;
	versionToken?: string;
	draftAccess?: EditorDraftAccessDeclaration;
	captureDraft?: (access: EditorDraftAccessDeclaration) => BrowserEditorDraftRequest | null;
	onDraftResponse?: (access: EditorDraftAccessDeclaration, response: EditorDraftResponse) => void;
	onEntryRefresh?: () => void | Promise<void>;
	/** Reserve the inline end of the disclosure header for an external control. */
	reserveHeaderEnd?: boolean;
}

type PanelAction = Exclude<ContentEditorPanelInteraction, { type: "panel_load" }>;
type EditorDraftIdentity = Omit<BrowserEditorDraftRequest, "invocationId">;

function getEditorDraftIdentity(
	draft: BrowserEditorDraftRequest | null | undefined,
): EditorDraftIdentity | null {
	if (!draft) return null;
	const { invocationId: _invocationId, ...identity } = draft;
	return identity;
}

function sameInteractionValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameInteractionValue(value, right[index]))
		);
	}
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(
			([key, value]) =>
				Object.hasOwn(right, key) &&
				sameInteractionValue(value, (right as Record<string, unknown>)[key]),
		)
	);
}

export function SandboxedContentEditorPanel({
	pluginId,
	panelId,
	title,
	collection,
	entryId,
	locale,
	versionToken,
	draftAccess,
	captureDraft,
	onDraftResponse,
	onEntryRefresh,
	reserveHeaderEnd = false,
}: SandboxedContentEditorPanelProps) {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const [open, setOpen] = React.useState(false);
	const [loaded, setLoaded] = React.useState(false);
	const [loading, setLoading] = React.useState(false);
	const [pendingInteractions, setPendingInteractions] = React.useState(0);
	const [error, setError] = React.useState(false);
	const [blocks, setBlocks] = React.useState<Block[]>([]);
	const generation = React.useRef(0);
	const activeRequest = React.useRef<{
		controller: AbortController;
		type: ContentEditorPanelInteraction["type"];
		versionToken: string | undefined;
	} | null>(null);
	const lastInteraction = React.useRef<{
		interaction: PanelAction;
		draftIdentity: EditorDraftIdentity | null;
	} | null>(null);
	const requestQueue = React.useRef(Promise.resolve());
	const pendingRequests = React.useRef(0);
	const panelIdentity = `${pluginId}:${panelId}:${collection}:${entryId}:${locale ?? ""}`;
	const identityRef = React.useRef(panelIdentity);
	identityRef.current = panelIdentity;
	const versionRef = React.useRef(versionToken);
	versionRef.current = versionToken;
	const previousVersion = React.useRef({ panelIdentity, versionToken });
	const applyNavigation = React.useCallback(
		(response: BlockResponse) => {
			if (!response.navigate) return;
			const href = resolvePluginLinkTarget(pluginId, response.navigate);
			if (!href) return;
			if (response.navigate.kind === "external") {
				const protocol = new URL(href).protocol;
				if (protocol === "http:" || protocol === "https:") {
					window.open(href, "_blank", "noopener,noreferrer");
					return;
				}
			}
			window.location.assign(href);
		},
		[pluginId],
	);

	const cancelRequests = React.useCallback(() => {
		generation.current++;
		activeRequest.current?.controller.abort();
		activeRequest.current = null;
		lastInteraction.current = null;
		requestQueue.current = Promise.resolve();
		pendingRequests.current = 0;
		setLoading(false);
		setPendingInteractions(0);
	}, []);

	React.useEffect(() => {
		setOpen(false);
		setLoaded(false);
		setError(false);
		setBlocks([]);
		cancelRequests();
		return cancelRequests;
	}, [cancelRequests, panelIdentity]);

	const sendInteraction = React.useCallback(
		(
			interaction: ContentEditorPanelInteraction,
			showPending = interaction.type !== "panel_load",
		) => {
			const requestGeneration = generation.current;
			const isCurrent = () =>
				panelIdentity === identityRef.current && requestGeneration === generation.current;
			const isInteraction = interaction.type !== "panel_load";
			if (isInteraction) {
				// Compare the draft at click time; the invocation captures it again when dequeued.
				let draftIdentity: EditorDraftIdentity | null = null;
				if (draftAccess) {
					try {
						draftIdentity = getEditorDraftIdentity(captureDraft?.(draftAccess));
					} catch {
						draftIdentity = null;
					}
				}
				const previous = lastInteraction.current;
				if (
					previous?.interaction.type === interaction.type &&
					previous.interaction.action_id === interaction.action_id &&
					previous.interaction.block_id === interaction.block_id &&
					sameInteractionValue(
						previous.interaction.type === "form_submit"
							? previous.interaction.values
							: previous.interaction.value,
						interaction.type === "form_submit" ? interaction.values : interaction.value,
					) &&
					(!draftAccess ||
						(draftIdentity !== null &&
							previous.draftIdentity !== null &&
							sameInteractionValue(previous.draftIdentity, draftIdentity)))
				)
					return Promise.resolve();
				lastInteraction.current = { interaction, draftIdentity };
			}
			pendingRequests.current++;
			setLoading(true);
			if (showPending) setPendingInteractions((count) => count + 1);

			const runRequest = async () => {
				if (!isCurrent()) return;
				const controller = new AbortController();
				activeRequest.current = { controller, type: interaction.type, versionToken };
				const canApplyResponse = () =>
					isCurrent() &&
					!controller.signal.aborted &&
					(interaction.type !== "panel_load" || versionToken === versionRef.current);
				const aborted = new Promise<void>((resolve) => {
					controller.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				const executeRequest = async () => {
					try {
						if (!canApplyResponse()) return;
						setError(false);
						const draft = !isInteraction || !draftAccess ? null : captureDraft?.(draftAccess);
						if (lastInteraction.current?.interaction === interaction) {
							lastInteraction.current.draftIdentity = getEditorDraftIdentity(draft);
						}
						const requestInteraction = draft ? { ...interaction, draft } : interaction;
						const response = await apiFetch(
							editorExtensionUrl(collection, entryId, pluginId, "panel", panelId, locale),
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify(requestInteraction),
								signal: controller.signal,
							},
						);
						if (!canApplyResponse()) return;
						if (!response.ok) throw new Error("Plugin panel request failed");
						const body = (await response.json()) as { data: BlockResponse & EditorDraftResponse };
						if (!canApplyResponse()) return;
						setBlocks(body.data.blocks);
						setLoaded(true);
						if (body.data.toast) {
							toastManager.add({ title: body.data.toast.message, variant: body.data.toast.type });
						}
						if (body.data.refresh) await onEntryRefresh?.();
						if (!canApplyResponse()) return;
						applyNavigation(body.data);
						if (draftAccess && (body.data.patch || body.data.editorInvocation)) {
							onDraftResponse?.(draftAccess, body.data);
						}
					} catch {
						if (canApplyResponse()) {
							if (pendingRequests.current > 1) {
								toastManager.add({ title: t`Plugin panel unavailable.`, variant: "error" });
							} else {
								setError(true);
							}
						}
					}
				};
				try {
					// Release the queue on abort even if response decoding or refresh effects are still pending.
					await Promise.race([executeRequest(), aborted]);
				} finally {
					if (activeRequest.current?.controller === controller) activeRequest.current = null;
					if (isCurrent()) {
						pendingRequests.current--;
						setLoading(pendingRequests.current > 0);
						if (showPending) setPendingInteractions((count) => count - 1);
						if (lastInteraction.current?.interaction === interaction)
							lastInteraction.current = null;
					}
				}
			};
			const request = requestQueue.current.then(runRequest);
			requestQueue.current = request;
			return request;
		},
		[
			applyNavigation,
			captureDraft,
			collection,
			draftAccess,
			entryId,
			locale,
			onDraftResponse,
			onEntryRefresh,
			panelId,
			panelIdentity,
			pluginId,
			t,
			toastManager,
			versionToken,
		],
	);

	React.useEffect(() => {
		const previous = previousVersion.current;
		previousVersion.current = { panelIdentity, versionToken };
		if (previous.panelIdentity !== panelIdentity || previous.versionToken === versionToken) return;
		if (open) {
			const active = activeRequest.current;
			if (active?.type === "panel_load" && active.versionToken !== versionToken)
				active.controller.abort();
			void sendInteraction({ type: "panel_load" });
			return;
		}
		cancelRequests();
		setError(false);
		setLoaded(false);
	}, [cancelRequests, open, panelIdentity, sendInteraction, versionToken]);

	const handleOpenChange = React.useCallback(
		(nextOpen: boolean) => {
			setOpen(nextOpen);
			if (!nextOpen && pendingRequests.current > 0) {
				cancelRequests();
				setLoaded(false);
				return;
			}
			if (nextOpen && !loaded && pendingRequests.current === 0)
				void sendInteraction({ type: "panel_load" });
		},
		[cancelRequests, loaded, sendInteraction],
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
			<Collapsible.Trigger
				render={
					<Button
						type="button"
						variant="ghost"
						className="relative justify-between"
						style={{
							width: reserveHeaderEnd ? "calc(100% - 1.5rem)" : "calc(100% + 1.5rem)",
							insetInlineStart: "-0.75rem",
						}}
					/>
				}
			>
				<Text as="span" truncate title={title} DANGEROUS_className="font-semibold">
					{title}
				</Text>
				<span className="flex shrink-0 items-center gap-2">
					{pendingInteractions > 0 && (
						<span aria-hidden="true">
							<Loader size="sm" className="text-kumo-subtle" />
						</span>
					)}
					<CaretDown
						className={cn(
							"h-4 w-4 shrink-0 text-kumo-subtle transition-transform duration-150 ease-out motion-reduce:transition-none",
							open && "rotate-180",
						)}
					/>
				</span>
			</Collapsible.Trigger>
			<Collapsible.Panel
				className="-mx-2 overflow-hidden transition-[height] duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
				style={({ transitionStatus }) => ({
					height:
						transitionStatus === "starting" || transitionStatus === "ending"
							? 0
							: "var(--collapsible-panel-height)",
				})}
			>
				<span role="status" className="sr-only">
					{(loading && !loaded) || pendingInteractions > 0 ? t`Loading plugin panel` : ""}
				</span>
				<div
					className="min-w-0 px-2 pt-2 pb-1"
					aria-busy={(loading && !loaded) || pendingInteractions > 0 || undefined}
				>
					{loading && !loaded ? (
						<div className="space-y-2 py-2" aria-hidden="true">
							<SkeletonLine blockHeight={20} minWidth={60} maxWidth={95} />
							<SkeletonLine blockHeight={20} minWidth={35} maxWidth={80} />
						</div>
					) : error ? (
						<div role="alert" className="py-2 text-xs leading-4 text-kumo-subtle">
							<p>{t`Plugin panel unavailable.`}</p>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="mt-1"
								onClick={() => void sendInteraction({ type: "panel_load" }, true)}
							>
								{t`Retry`}
							</Button>
						</div>
					) : null}
					{loaded && !error && (
						<BlockRenderer
							blocks={blocks}
							onAction={handleAction}
							resolveLinkTarget={(target) => resolvePluginLinkTarget(pluginId, target)}
						/>
					)}
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
