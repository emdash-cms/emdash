/**
 * Email settings API client functions
 */

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

// =============================================================================
// Types
// =============================================================================

export interface EmailProvider {
	pluginId: string;
}

export interface EmailSettings {
	available: boolean;
	providers: EmailProvider[];
	selectedProviderId: string | null;
	middleware: {
		beforeSend: string[];
		afterSend: string[];
	};
}

// =============================================================================
// API functions
// =============================================================================

export async function fetchEmailSettings(): Promise<EmailSettings> {
	const res = await apiFetch(`${API_BASE}/settings/email`);
	return parseApiResponse<EmailSettings>(res, "Failed to fetch email settings");
}

export async function sendTestEmail(to: string): Promise<{ success: boolean; message: string }> {
	const res = await apiFetch(`${API_BASE}/settings/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to }),
	});
	return parseApiResponse<{ success: boolean; message: string }>(res, "Failed to send test email");
}
