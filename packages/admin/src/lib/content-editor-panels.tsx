import { Button } from "@cloudflare/kumo";
import { Trans } from "@lingui/react/macro";
import * as React from "react";

import type { AdminManifest, ContentItem } from "./api";

export interface ContentEditorPanelContext {
	collection: string;
	entry: ContentItem;
	locale?: string;
}

export interface ContentEditorPanelExtension {
	/** Stable identifier, unique within this plugin's editor panels. */
	id: string;
	/** Host-rendered section heading. */
	title: string;
	component: React.ComponentType<ContentEditorPanelContext>;
	/** Restrict this panel to selected collections. Omit to support every collection. */
	collections?: readonly string[] | ((collection: string) => boolean);
	/** Minimum numeric admin role required to see this panel. */
	minRole?: number;
	/** Lower values render first among contributed panels. */
	order?: number;
}

export interface ResolvedContentEditorPanel {
	pluginId: string;
	extension: ContentEditorPanelExtension;
}

type ContentEditorPanelRegistry = Record<
	string,
	{ contentEditorPanels?: readonly ContentEditorPanelExtension[] } | undefined
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function warn(pluginId: string, message: string): void {
	console.warn(`[content-editor-panels] Plugin "${pluginId}": ${message}`);
}

function isValidCollections(value: unknown): boolean {
	return (
		value === undefined ||
		typeof value === "function" ||
		(Array.isArray(value) && value.every((collection) => typeof collection === "string"))
	);
}

function isValidPanel(value: unknown, pluginId: string): value is ContentEditorPanelExtension {
	if (!isRecord(value)) {
		warn(pluginId, "ignored a panel that is not an object.");
		return false;
	}
	if (typeof value.id !== "string" || value.id.trim() === "") {
		warn(pluginId, "ignored a panel without a non-empty id.");
		return false;
	}
	if (typeof value.title !== "string" || value.title.trim() === "") {
		warn(pluginId, `ignored panel "${value.id}" because its title is invalid.`);
		return false;
	}
	if (typeof value.component !== "function") {
		warn(pluginId, `ignored panel "${value.id}" because its component is invalid.`);
		return false;
	}
	if (!isValidCollections(value.collections)) {
		warn(
			pluginId,
			`ignored panel "${value.id}" because collections must be an array of strings or a predicate.`,
		);
		return false;
	}
	if (value.minRole !== undefined && !Number.isFinite(value.minRole)) {
		warn(pluginId, `ignored panel "${value.id}" because minRole must be finite.`);
		return false;
	}
	if (value.order !== undefined && !Number.isFinite(value.order)) {
		warn(pluginId, `ignored panel "${value.id}" because order must be finite.`);
		return false;
	}
	return true;
}

function appliesToCollection(
	pluginId: string,
	panel: ContentEditorPanelExtension,
	collection: string,
): boolean {
	if (panel.collections === undefined) return true;
	if (typeof panel.collections !== "function") {
		return panel.collections.includes(collection);
	}

	try {
		return panel.collections(collection);
	} catch (error) {
		console.error(
			`Plugin "${pluginId}" failed while checking content editor panel "${panel.id}".`,
			error,
		);
		return false;
	}
}

/**
 * Select valid trusted-plugin panels for one saved content editor.
 * Invalid, disabled, unauthorized, and inapplicable contributions are omitted
 * so the host settings sidebar remains usable.
 */
export function resolveContentEditorPanels(
	pluginAdmins: ContentEditorPanelRegistry,
	collection: string,
	userRole: number,
	pluginStates?: AdminManifest["plugins"],
): ResolvedContentEditorPanel[] {
	const resolved: ResolvedContentEditorPanel[] = [];
	const seen = new Set<string>();

	for (const pluginId of Object.keys(pluginAdmins).toSorted()) {
		const pluginState = pluginStates?.[pluginId];
		if (pluginStates && (!pluginState || pluginState.enabled === false)) continue;

		const panels: unknown = pluginAdmins[pluginId]?.contentEditorPanels;
		if (panels === undefined) continue;
		if (!Array.isArray(panels)) {
			warn(pluginId, "ignored contentEditorPanels because it is not an array.");
			continue;
		}

		for (const candidate of panels) {
			if (!isValidPanel(candidate, pluginId)) continue;
			const identity = `${pluginId}:${candidate.id}`;
			if (seen.has(identity)) {
				warn(pluginId, `ignored duplicate panel id "${candidate.id}".`);
				continue;
			}
			seen.add(identity);

			if (!appliesToCollection(pluginId, candidate, collection)) continue;
			if (candidate.minRole !== undefined && userRole < candidate.minRole) continue;
			resolved.push({ pluginId, extension: candidate });
		}
	}

	return resolved.toSorted(
		(a, b) =>
			(a.extension.order ?? 0) - (b.extension.order ?? 0) ||
			a.pluginId.localeCompare(b.pluginId) ||
			a.extension.id.localeCompare(b.extension.id),
	);
}

interface ContentEditorPanelBoundaryProps {
	pluginId: string;
	panelId: string;
	children: React.ReactNode;
}

interface ContentEditorPanelBoundaryState {
	hasError: boolean;
}

/** Prevents one faulty trusted panel from unmounting the content editor. */
export class ContentEditorPanelBoundary extends React.Component<
	ContentEditorPanelBoundaryProps,
	ContentEditorPanelBoundaryState
> {
	override state: ContentEditorPanelBoundaryState = { hasError: false };

	static getDerivedStateFromError(): ContentEditorPanelBoundaryState {
		return { hasError: true };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo): void {
		console.error(
			`Plugin "${this.props.pluginId}" failed while rendering content editor panel "${this.props.panelId}".`,
			error,
			info,
		);
	}

	override render(): React.ReactNode {
		if (!this.state.hasError) return this.props.children;

		return (
			<div role="alert" className="text-sm text-kumo-subtle">
				<p>
					<Trans>Plugin panel unavailable.</Trans>
				</p>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="mt-1"
					onClick={() => this.setState({ hasError: false })}
				>
					<Trans>Retry</Trans>
				</Button>
			</div>
		);
	}
}
