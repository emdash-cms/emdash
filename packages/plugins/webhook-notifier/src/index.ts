/**
 * Webhook Notifier Plugin for EmDash CMS
 *
 * Posts to external URLs when content changes occur.
 *
 * Features:
 * - Configurable webhook URLs (admin settings)
 * - Secret token for authentication (encrypted)
 * - Retry logic with exponential backoff
 * - Event filtering by collection and action
 * - Manual trigger via API route
 *
 * Demonstrates:
 * - network:request:unrestricted capability (unrestricted outbound for user-configured URLs)
 * - settings.secret() for encrypted tokens
 * - apiRoutes for custom endpoints
 * - content:afterDelete hook
 * - Hook dependencies (runs after audit-log)
 * - errorPolicy: "continue" (don't block save on webhook failure)
 */

import type { PluginDescriptor } from "emdash";

import { version } from "../package.json";

export interface WebhookPayload {
	event: "content:create" | "content:update" | "content:delete" | "media:upload";
	timestamp: string;
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	data?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/**
 * Create the webhook notifier plugin descriptor
 */
export function webhookNotifierPlugin(): PluginDescriptor {
	return {
		id: "webhook-notifier",
		version,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-webhook-notifier/sandbox",
		capabilities: ["network:request:unrestricted"],
		storage: {
			deliveries: { indexes: ["timestamp", "webhookUrl", "status"] },
		},
		adminPages: [{ path: "/settings", label: "Webhook Settings", icon: "send" }],
		adminWidgets: [{ id: "status", title: "Webhooks", size: "third" }],
	};
}
