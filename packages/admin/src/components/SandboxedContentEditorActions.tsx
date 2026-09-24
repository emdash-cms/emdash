import { Button, DropdownMenu, Toast } from "@cloudflare/kumo";
import type { ContentEditorActionResponse } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { DotsThree } from "@phosphor-icons/react";
import * as React from "react";

import { apiFetch } from "../lib/api/client.js";
import { resolvePluginLinkTarget } from "../lib/plugin-links.js";
import {
	editorExtensionUrl,
	type ResolvedSandboxedEditorAction,
} from "../lib/sandboxed-editor-extensions.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import type {
	BrowserEditorDraftRequest,
	EditorDraftResponse,
} from "./SandboxedContentEditorPanel.js";

const MAX_TOOLBAR_ACTIONS = 3;

interface SandboxedContentEditorActionsProps {
	actions: ResolvedSandboxedEditorAction[];
	collection: string;
	entryId: string;
	locale?: string | null;
	isMobile?: boolean;
	disabled?: boolean;
	hasUnsavedChanges?: boolean;
	onEntryRefresh?: () => void | Promise<void>;
	captureDraft?: (
		access: NonNullable<ResolvedSandboxedEditorAction["extension"]["draft"]>,
	) => BrowserEditorDraftRequest | null;
	onDraftResponse?: (
		access: NonNullable<ResolvedSandboxedEditorAction["extension"]["draft"]>,
		response: EditorDraftResponse,
	) => void;
}

export function SandboxedContentEditorActions({
	actions,
	collection,
	entryId,
	locale,
	isMobile = false,
	disabled = false,
	hasUnsavedChanges = false,
	onEntryRefresh,
	captureDraft,
	onDraftResponse,
}: SandboxedContentEditorActionsProps) {
	const { t, i18n } = useLingui();
	const toastManager = Toast.useToastManager();
	const [pending, setPending] = React.useState<Set<string>>(() => new Set());
	const pendingRef = React.useRef(new Set<string>());
	const [confirming, setConfirming] = React.useState<ResolvedSandboxedEditorAction | null>(null);
	const [confirmError, setConfirmError] = React.useState<unknown>(null);
	const identity = `${collection}:${entryId}:${locale ?? ""}`;
	const identityRef = React.useRef(identity);
	identityRef.current = identity;
	const generations = React.useRef(new Map<string, number>());

	React.useEffect(() => {
		setPending(new Set());
		setConfirming(null);
		setConfirmError(null);
		pendingRef.current.clear();
		generations.current.clear();
	}, [identity]);

	const applyNavigation = React.useCallback(
		(action: ResolvedSandboxedEditorAction, response: ContentEditorActionResponse) => {
			if (!response.navigate) return;
			const href = resolvePluginLinkTarget(action.pluginId, response.navigate);
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
		[],
	);

	const invoke = React.useCallback(
		async (action: ResolvedSandboxedEditorAction) => {
			if (disabled || (hasUnsavedChanges && !action.extension.draft)) return;
			const key = `${action.pluginId}:${action.extension.id}`;
			if (pendingRef.current.has(key)) return;
			pendingRef.current.add(key);
			const requestIdentity = identity;
			const requestGeneration = (generations.current.get(key) ?? 0) + 1;
			generations.current.set(key, requestGeneration);
			setPending((current) => new Set(current).add(key));
			setConfirmError(null);
			try {
				const draft = action.extension.draft ? captureDraft?.(action.extension.draft) : null;
				const response = await apiFetch(
					editorExtensionUrl(
						collection,
						entryId,
						action.pluginId,
						"action",
						action.extension.id,
						locale,
					),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(draft ? { draft } : {}),
					},
				);
				if (
					requestIdentity !== identityRef.current ||
					generations.current.get(key) !== requestGeneration
				) {
					return;
				}
				if (!response.ok) throw new Error(t`Plugin action failed`);
				const body = (await response.json()) as {
					data: ContentEditorActionResponse & EditorDraftResponse;
				};
				if (
					requestIdentity !== identityRef.current ||
					generations.current.get(key) !== requestGeneration
				) {
					return;
				}
				if (body.data.refresh) await onEntryRefresh?.();
				if (
					requestIdentity !== identityRef.current ||
					generations.current.get(key) !== requestGeneration
				) {
					return;
				}
				if (body.data.toast) {
					toastManager.add({ title: body.data.toast.message, type: body.data.toast.type });
				}
				if (action.extension.draft && (body.data.patch || body.data.editorInvocation)) {
					onDraftResponse?.(action.extension.draft, body.data);
				}
				applyNavigation(action, body.data);
				setConfirming(null);
			} catch (error) {
				if (
					requestIdentity !== identityRef.current ||
					generations.current.get(key) !== requestGeneration
				) {
					return;
				}
				if (action.extension.confirm) setConfirmError(error);
				else toastManager.add({ title: t`Plugin action failed`, type: "error" });
			} finally {
				if (requestIdentity === identityRef.current) {
					pendingRef.current.delete(key);
					setPending((current) => {
						const next = new Set(current);
						next.delete(key);
						return next;
					});
				}
			}
		},
		[
			applyNavigation,
			captureDraft,
			collection,
			disabled,
			hasUnsavedChanges,
			entryId,
			identity,
			locale,
			onEntryRefresh,
			onDraftResponse,
			t,
			toastManager,
		],
	);

	const choose = React.useCallback(
		(action: ResolvedSandboxedEditorAction) => {
			if (disabled || (hasUnsavedChanges && !action.extension.draft)) return;
			if (action.extension.confirm) {
				setConfirmError(null);
				setConfirming(action);
				return;
			}
			void invoke(action);
		},
		[disabled, hasUnsavedChanges, invoke],
	);

	const toolbarCandidates = isMobile
		? []
		: actions.filter((action) => action.extension.placement === "toolbar");
	const toolbarActions = toolbarCandidates.slice(0, MAX_TOOLBAR_ACTIONS);
	const overflowActions = actions.filter(
		(action) =>
			isMobile ||
			action.extension.placement === "overflow" ||
			(toolbarCandidates.includes(action) && !toolbarActions.includes(action)),
	);
	const actionLabel = (action: ResolvedSandboxedEditorAction) =>
		i18n._({ id: action.extension.label, message: action.extension.label });
	const confirmingKey = confirming ? `${confirming.pluginId}:${confirming.extension.id}` : null;
	const isActionDisabled = (action: ResolvedSandboxedEditorAction) =>
		disabled || (hasUnsavedChanges && !action.extension.draft);
	const allActionsDisabled = actions.every(isActionDisabled);

	if (actions.length === 0) return null;
	return (
		<>
			{toolbarActions.map((action) => {
				const key = `${action.pluginId}:${action.extension.id}`;
				return (
					<Button
						key={key}
						type="button"
						size="sm"
						variant={action.extension.style === "danger" ? "destructive" : "secondary"}
						loading={pending.has(key)}
						disabled={isActionDisabled(action)}
						title={
							isActionDisabled(action) ? t`Save changes before running plugin actions` : undefined
						}
						onClick={() => choose(action)}
					>
						{actionLabel(action)}
					</Button>
				);
			})}
			{overflowActions.length > 0 ? (
				<DropdownMenu>
					<DropdownMenu.Trigger
						render={
							<Button
								type="button"
								variant="ghost"
								shape="square"
								aria-label={t`Plugin actions`}
								disabled={allActionsDisabled}
								title={
									allActionsDisabled ? t`Save changes before running plugin actions` : undefined
								}
								icon={<DotsThree aria-hidden="true" />}
							/>
						}
					/>
					<DropdownMenu.Content align="end">
						{overflowActions.map((action) => {
							const key = `${action.pluginId}:${action.extension.id}`;
							return (
								<DropdownMenu.Item
									key={key}
									variant={action.extension.style === "danger" ? "danger" : "default"}
									disabled={isActionDisabled(action) || pending.has(key)}
									onClick={() => choose(action)}
								>
									{actionLabel(action)}
								</DropdownMenu.Item>
							);
						})}
					</DropdownMenu.Content>
				</DropdownMenu>
			) : null}
			{confirming?.extension.confirm ? (
				<ConfirmDialog
					open
					onClose={() => {
						if (!confirmingKey || !pending.has(confirmingKey)) {
							setConfirming(null);
							setConfirmError(null);
						}
					}}
					role={confirming.extension.style === "danger" ? "alertdialog" : "dialog"}
					title={confirming.extension.confirm.title}
					description={confirming.extension.confirm.text}
					confirmLabel={confirming.extension.confirm.confirm}
					cancelLabel={confirming.extension.confirm.deny}
					pendingLabel={t`Working…`}
					variant={confirming.extension.style === "danger" ? "destructive" : "primary"}
					preventCloseWhilePending
					confirmDisabled={isActionDisabled(confirming)}
					isPending={confirmingKey ? pending.has(confirmingKey) : false}
					error={confirmError}
					onConfirm={() => void invoke(confirming)}
				/>
			) : null}
		</>
	);
}
