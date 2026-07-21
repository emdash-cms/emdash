/**
 * Email settings API client functions
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

// =============================================================================
// Types
// =============================================================================

export interface EmailProvider {
	pluginId: string;
}

export interface SmtpConfigStatus {
	configured: boolean;
	source: "db" | "env" | null;
	host?: string;
	port?: number;
	secure?: "starttls" | "tls";
	fromName?: string;
	fromEmail?: string;
	replyTo?: string;
}

export interface CloudflareConfigStatus {
	configured: boolean;
	from?: string;
	fromName?: string;
	fromEmail?: string;
	replyTo?: string;
}

export interface EmailSettings {
	available: boolean;
	providers: EmailProvider[];
	selectedProviderId: string | null;
	middleware: {
		beforeSend: string[];
		afterSend: string[];
	};
	smtp: SmtpConfigStatus;
	cloudflare: CloudflareConfigStatus;
}

// =============================================================================
// API functions
// =============================================================================

export async function fetchEmailSettings(): Promise<EmailSettings> {
	const res = await apiFetch(`${API_BASE}/settings/email`);
	return parseApiResponse<EmailSettings>(res, i18n._(msg`Failed to fetch email settings`));
}

export async function sendTestEmail(to: string): Promise<{ success: boolean; message: string }> {
	const res = await apiFetch(`${API_BASE}/settings/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to }),
	});
	return parseApiResponse<{ success: boolean; message: string }>(
		res,
		i18n._(msg`Failed to send test email`),
	);
}

export type EmailProviderChoice = "none" | "smtp" | "cloudflare";

export interface SaveEmailSettingsInput {
	provider: EmailProviderChoice;
	smtp?: {
		host: string;
		port: number;
		secure: "starttls" | "tls";
		user: string;
		pass?: string;
		fromName?: string;
		fromEmail?: string;
		replyTo?: string;
	};
	cloudflare?: {
		fromName: string;
		fromEmail: string;
		replyTo?: string;
	};
}

export async function saveEmailSettings(
	input: SaveEmailSettingsInput,
): Promise<{ success: boolean; message: string }> {
	const res = await apiFetch(`${API_BASE}/settings/email`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<{ success: boolean; message: string }>(
		res,
		i18n._(msg`Failed to save email settings`),
	);
}

export async function testCloudflareBinding(): Promise<{ available: boolean; message: string }> {
	const res = await apiFetch(`${API_BASE}/settings/email/test-binding`, {
		method: "POST",
	});
	return parseApiResponse<{ available: boolean; message: string }>(
		res,
		i18n._(msg`Failed to test Cloudflare Email binding`),
	);
}
