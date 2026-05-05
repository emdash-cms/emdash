/**
 * Audit Log Plugin for EmDash CMS
 *
 * Tracks all content and media changes for compliance and debugging.
 *
 * Features:
 * - Logs create, update, delete operations
 * - Tracks before/after state for updates
 * - Records user information (when available)
 * - Provides admin UI for viewing audit history
 * - Configurable retention period (admin settings)
 * - Uses plugin storage for persistent audit trail
 *
 * Demonstrates:
 * - Plugin storage with indexes and queries
 * - Admin-configurable settings schema
 * - Lifecycle hooks (install, activate, deactivate, uninstall)
 * - content:afterDelete hook
 */

import type { PluginDescriptor } from "emdash";

import { version } from "../package.json";

export interface AuditEntry {
	timestamp: string;
	action: "create" | "update" | "delete" | "media:upload" | "media:delete";
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	userId?: string;
	changes?: {
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
	};
	metadata?: Record<string, unknown>;
}

/**
 * Create the audit log plugin descriptor
 */
export function auditLogPlugin(): PluginDescriptor {
	return {
		id: "audit-log",
		version,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-audit-log/sandbox",
		capabilities: ["content:read"],
		storage: {
			entries: { indexes: ["timestamp", "action", "resourceType", "collection"] },
		},
		adminPages: [{ path: "/history", label: "Audit History", icon: "history" }],
		adminWidgets: [{ id: "recent-activity", title: "Recent Activity", size: "half" }],
	};
}
