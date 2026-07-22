import { Trans } from "@lingui/react/macro";
import * as React from "react";

import type { AdminManifest, ContentItem } from "./api.js";

/** Context passed to a trusted plugin's content-list column header. */
export interface ContentListColumnHeaderContext {
	collection: string;
	locale?: string;
}

/** Context passed to a trusted plugin's content-list column cell. */
export interface ContentListColumnCellContext extends ContentListColumnHeaderContext {
	item: ContentItem;
}

/** A content-list column contributed by a trusted React plugin. */
export interface ContentListColumnExtension {
	/** Stable identifier, unique within this plugin's list columns. */
	id: string;
	/** Host-rendered fallback label for the column header. */
	label: string;
	cell: React.ComponentType<ContentListColumnCellContext>;
	/** Optional custom header content. The host still owns the table header. */
	header?: React.ComponentType<ContentListColumnHeaderContext>;
	/** Restrict this column to selected collections. Omit to support every collection. */
	collections?: readonly string[] | ((collection: string) => boolean);
	/** Minimum numeric admin role required to see this column. */
	minRole?: number;
	/** Lower values render first among contributed columns. */
	order?: number;
	align?: "start" | "end";
}

export interface ResolvedContentListColumn {
	pluginId: string;
	extension: ContentListColumnExtension;
}

type ContentListColumnRegistry = Record<
	string,
	{ contentListColumns?: readonly ContentListColumnExtension[] } | undefined
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(pluginId: string, message: string): void {
	console.warn(`[content-list-columns] Plugin "${pluginId}": ${message}`);
}

function isValidCollections(value: unknown): boolean {
	return (
		value === undefined ||
		typeof value === "function" ||
		(Array.isArray(value) && value.every((collection) => typeof collection === "string"))
	);
}

function isValidColumn(value: unknown, pluginId: string): value is ContentListColumnExtension {
	if (!isRecord(value)) {
		warn(pluginId, "ignored a column that is not an object.");
		return false;
	}
	if (typeof value.id !== "string" || value.id.trim() === "") {
		warn(pluginId, "ignored a column without a non-empty id.");
		return false;
	}
	if (typeof value.label !== "string" || value.label.trim() === "") {
		warn(pluginId, `ignored column "${value.id}" because its label is invalid.`);
		return false;
	}
	if (typeof value.cell !== "function") {
		warn(pluginId, `ignored column "${value.id}" because its cell is invalid.`);
		return false;
	}
	if (value.header !== undefined && typeof value.header !== "function") {
		warn(pluginId, `ignored column "${value.id}" because its header is invalid.`);
		return false;
	}
	if (!isValidCollections(value.collections)) {
		warn(
			pluginId,
			`ignored column "${value.id}" because collections must be an array of strings or a predicate.`,
		);
		return false;
	}
	if (value.minRole !== undefined && !Number.isFinite(value.minRole)) {
		warn(pluginId, `ignored column "${value.id}" because minRole must be finite.`);
		return false;
	}
	if (value.order !== undefined && !Number.isFinite(value.order)) {
		warn(pluginId, `ignored column "${value.id}" because order must be finite.`);
		return false;
	}
	if (value.align !== undefined && value.align !== "start" && value.align !== "end") {
		warn(pluginId, `ignored column "${value.id}" because align is invalid.`);
		return false;
	}
	return true;
}

function appliesToCollection(
	pluginId: string,
	column: ContentListColumnExtension,
	collection: string,
): boolean {
	if (column.collections === undefined) return true;
	if (typeof column.collections !== "function") {
		return column.collections.includes(collection);
	}

	try {
		return column.collections(collection);
	} catch (error) {
		console.error(
			`Plugin "${pluginId}" failed while checking content-list column "${column.id}".`,
			error,
		);
		return false;
	}
}

/**
 * Select valid trusted-plugin columns for one active content collection list.
 * Invalid, disabled, unauthorized, and inapplicable contributions are omitted
 * so a plugin cannot make the host list unusable.
 */
export function resolveContentListColumns(
	pluginAdmins: ContentListColumnRegistry,
	collection: string,
	userRole: number,
	pluginStates?: AdminManifest["plugins"],
): ResolvedContentListColumn[] {
	const resolved: ResolvedContentListColumn[] = [];
	const seen = new Set<string>();

	for (const pluginId of Object.keys(pluginAdmins).toSorted()) {
		const pluginState = pluginStates?.[pluginId];
		if (pluginStates && (!pluginState || pluginState.enabled === false)) continue;

		const columns: unknown = pluginAdmins[pluginId]?.contentListColumns;
		if (columns === undefined) continue;
		if (!Array.isArray(columns)) {
			warn(pluginId, "ignored contentListColumns because it is not an array.");
			continue;
		}

		for (const candidate of columns) {
			if (!isValidColumn(candidate, pluginId)) continue;
			const identity = `${pluginId}:${candidate.id}`;
			if (seen.has(identity)) {
				warn(pluginId, `ignored duplicate column id "${candidate.id}".`);
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

interface ContentListColumnBoundaryProps {
	pluginId: string;
	columnId: string;
	children: React.ReactNode;
	fallback?: React.ReactNode;
}

interface ContentListColumnBoundaryState {
	hasError: boolean;
}

/** Prevents one faulty trusted column from unmounting the content list. */
export class ContentListColumnBoundary extends React.Component<
	ContentListColumnBoundaryProps,
	ContentListColumnBoundaryState
> {
	override state: ContentListColumnBoundaryState = { hasError: false };

	static getDerivedStateFromError(): ContentListColumnBoundaryState {
		return { hasError: true };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo): void {
		console.error(
			`Plugin "${this.props.pluginId}" failed while rendering content-list column "${this.props.columnId}".`,
			error,
			info,
		);
	}

	override render(): React.ReactNode {
		if (!this.state.hasError) return this.props.children;
		if (this.props.fallback !== undefined) return this.props.fallback;

		return (
			<span className="text-kumo-subtle">
				<span aria-hidden="true">—</span>
				<span className="sr-only">
					<Trans>Plugin column unavailable</Trans>
				</span>
			</span>
		);
	}
}
