/**
 * Device Authorization Page
 *
 * Standalone page where users enter the code displayed by `emdash login`
 * to authorize a CLI or agent to access their account.
 *
 * Flow:
 * 1. User runs `emdash login` → sees a code like ABCD-1234
 * 2. User opens this page in their browser (already logged in)
 * 3. User enters the code → clicks Authorize
 * 4. CLI receives tokens and saves them
 */

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, API_BASE, ApiResponseError, parseApiResponse } from "../lib/api";
import { cn } from "../lib/utils";
import { API_TOKEN_SCOPE_VALUES } from "./settings/ApiTokenSettings.js";

// ============================================================================
// Types
// ============================================================================

interface UserInfo {
	id: string;
	email: string;
	name: string | null;
	role: number;
}

interface DeviceCodeScopes {
	requestedScopes: string[];
	grantedScopes: string[];
}

type PageState = "input" | "submitting" | "success" | "denied" | "error";

// ============================================================================
// Constants
// ============================================================================

const ROLE_NAMES: Record<number, string> = {
	10: "Subscriber",
	20: "Contributor",
	30: "Author",
	40: "Editor",
	50: "Admin",
};

const DEVICE_CODE_INVALID_CHARS_REGEX = /[^A-Z0-9-]/g;
const DEVICE_CODE_HYPHEN_REGEX = /-/g;
const DEVICE_CODE_LENGTH = 8;

const SCOPE_DETAILS = new Map<string, (typeof API_TOKEN_SCOPE_VALUES)[number]>(
	API_TOKEN_SCOPE_VALUES.map((entry) => [entry.scope, entry]),
);
const PLUGIN_MCP_SCOPE_PREFIX = "mcp:tools:";

/** Uppercase, strip invalid characters, cap at 9 characters, and insert a hyphen once 4 are typed */
function formatDeviceCode(raw: string): string {
	let value = raw.toUpperCase().replace(DEVICE_CODE_INVALID_CHARS_REGEX, "");

	// Auto-insert hyphen after 4 chars if not already present
	if (value.length === 4 && !value.includes("-")) {
		value = value + "-";
	}

	// Limit to 9 chars (XXXX-XXXX)
	if (value.length > 9) {
		value = value.slice(0, 9);
	}

	return value;
}

// ============================================================================
// Component
// ============================================================================

export function DeviceAuthorizePage() {
	const { t } = useLingui();
	const [code, setCode] = React.useState("");
	const [pageState, setPageState] = React.useState<PageState>("input");
	const [errorMessage, setErrorMessage] = React.useState("");

	// Check if user is logged in
	const {
		data: user,
		isLoading,
		error: authError,
	} = useQuery<UserInfo>({
		queryKey: ["auth-me"],
		queryFn: async () => {
			const res = await apiFetch(`${API_BASE}/auth/me`);
			return parseApiResponse<UserInfo>(res, "Not authenticated");
		},
		retry: false,
	});

	const normalizedCode = code.replace(DEVICE_CODE_HYPHEN_REGEX, "");
	const codeComplete = normalizedCode.length === DEVICE_CODE_LENGTH;

	const scopesQuery = useQuery<DeviceCodeScopes>({
		queryKey: ["device-code-scopes", normalizedCode],
		queryFn: async () => {
			const params = new URLSearchParams({ user_code: normalizedCode });
			const res = await apiFetch(`${API_BASE}/oauth/device/authorize?${params}`);
			return parseApiResponse<DeviceCodeScopes>(res, t`Could not check this code`);
		},
		enabled: !!user && codeComplete && (pageState === "input" || pageState === "error"),
		retry: false,
	});

	const canApprove = (scopesQuery.data?.grantedScopes.length ?? 0) > 0;

	// Pre-populate from URL query param (?code=ABCD-1234)
	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const urlCode = params.get("code");
		if (urlCode) {
			setCode(formatDeviceCode(urlCode));
		}
	}, []);

	// Not authenticated — redirect to login
	React.useEffect(() => {
		if (!isLoading && (authError || !user)) {
			const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
			window.location.href = `/_emdash/admin/login?redirect=${returnUrl}`;
		}
	}, [isLoading, authError, user]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();

		const trimmed = code.trim();
		if (!trimmed || !canApprove) return;

		setPageState("submitting");
		setErrorMessage("");

		try {
			const res = await apiFetch(`${API_BASE}/oauth/device/authorize`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user_code: trimmed, action: "approve" }),
			});

			const data = await parseApiResponse<{ authorized: boolean }>(res, t`Authorization failed`);
			setPageState(data.authorized ? "success" : "denied");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Network error");
			setPageState("error");
		}
	}

	async function handleDeny(e: React.FormEvent) {
		e.preventDefault();

		const trimmed = code.trim();
		if (!trimmed) return;

		setPageState("submitting");

		try {
			await apiFetch(`${API_BASE}/oauth/device/authorize`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user_code: trimmed, action: "deny" }),
			});
			setPageState("denied");
		} catch {
			setPageState("denied");
		}
	}

	function handleCodeChange(e: React.ChangeEvent<HTMLInputElement>) {
		setCode(formatDeviceCode(e.target.value));
	}

	if (isLoading) {
		return (
			<PageWrapper>
				<p className="text-kumo-subtle text-sm">{t`Checking authentication...`}</p>
			</PageWrapper>
		);
	}

	if (!user) {
		return (
			<PageWrapper>
				<p className="text-kumo-subtle text-sm">{t`Redirecting to login...`}</p>
			</PageWrapper>
		);
	}

	return (
		<PageWrapper>
			<div className="w-full max-w-sm">
				{/* Header */}
				<div className="text-center mb-8">
					<div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-kumo-brand/10 mb-4">
						<TerminalIcon className="w-6 h-6 text-kumo-link" />
					</div>
					<h1 className="text-xl font-semibold tracking-tight">{t`Authorize Device`}</h1>
					<p className="text-kumo-subtle text-sm mt-1.5">{t`Enter the code from your terminal`}</p>
				</div>

				{/* Success state */}
				{pageState === "success" && (
					<div className="rounded-lg border border-kumo-success/50 bg-kumo-success-tint p-6 text-center">
						<div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-kumo-success/15 mb-3">
							<CheckIcon className="w-5 h-5 text-kumo-success" />
						</div>
						<h2 className="font-medium text-kumo-success">{t`Device authorized`}</h2>
						<p className="text-sm text-kumo-subtle mt-1">
							{t`You can close this page and return to your terminal.`}
						</p>
						<p className="text-xs text-kumo-subtle mt-3">{t`Signed in as ${user.email}`}</p>
					</div>
				)}

				{/* Denied state */}
				{pageState === "denied" && (
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
						<h2 className="font-medium">{t`Authorization denied`}</h2>
						<p className="text-sm text-kumo-subtle mt-1">{t`The device will not be granted access.`}</p>
						<Button
							className="mt-4"
							variant="outline"
							onClick={() => {
								setPageState("input");
								setCode("");
							}}
						>
							{t`Try another code`}
						</Button>
					</div>
				)}

				{/* Input / Error state */}
				{(pageState === "input" || pageState === "submitting" || pageState === "error") && (
					<form onSubmit={handleSubmit}>
						<div className="rounded-lg border border-kumo-line bg-kumo-base p-6">
							{/* User badge */}
							<div className="flex items-center gap-2 mb-5 pb-4 border-b border-kumo-line">
								<div className="w-8 h-8 rounded-full bg-kumo-tint flex items-center justify-center text-xs font-medium">
									{(user.name || user.email).charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0">
									<p className="text-sm font-medium truncate">{user.name || user.email}</p>
									<p className="text-xs text-kumo-subtle">{ROLE_NAMES[user.role] || t`User`}</p>
								</div>
							</div>

							{/* Code input */}
							<label className="block text-sm font-medium mb-2" htmlFor="user-code">
								{t`Device code`}
							</label>
							<Input
								id="user-code"
								type="text"
								value={code}
								onChange={handleCodeChange}
								placeholder="XXXX-XXXX"
								className="text-center text-lg font-mono tracking-widest"
								autoFocus
								autoComplete="off"
								spellCheck={false}
								disabled={pageState === "submitting"}
							/>

							{/* Error message */}
							{pageState === "error" && errorMessage && (
								<p className="text-sm text-kumo-danger mt-2">{errorMessage}</p>
							)}

							{codeComplete && (
								<RequestedScopes
									isLoading={scopesQuery.isLoading}
									error={scopesQuery.error}
									scopes={scopesQuery.data}
								/>
							)}

							{/* Actions */}
							<div className="flex gap-2 mt-4">
								<Button
									type="submit"
									className="flex-1"
									disabled={!codeComplete || !canApprove || pageState === "submitting"}
								>
									{pageState === "submitting" ? t`Authorizing...` : t`Authorize`}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={handleDeny}
									disabled={!codeComplete || pageState === "submitting"}
								>
									{t`Deny`}
								</Button>
							</div>
						</div>

						<p className="text-xs text-kumo-subtle text-center mt-4">
							{t`Only authorize codes you recognize.`}
						</p>
					</form>
				)}
			</div>
		</PageWrapper>
	);
}

// ============================================================================
// Requested scopes
// ============================================================================

function RequestedScopes({
	isLoading,
	error,
	scopes,
}: {
	isLoading: boolean;
	error: Error | null;
	scopes: DeviceCodeScopes | undefined;
}) {
	const { t } = useLingui();
	const grantedHeadingId = React.useId();
	const withheldHeadingId = React.useId();

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-sm text-kumo-subtle mt-4">
				<Loader size="sm" />
				{t`Checking code...`}
			</div>
		);
	}

	if (error) {
		let message = t`Could not check this code.`;
		if (error instanceof ApiResponseError && error.code === "INVALID_CODE") {
			message = t`This code is invalid or has already been used.`;
		} else if (error instanceof ApiResponseError && error.code === "EXPIRED_CODE") {
			message = t`This code has expired. Start the sign-in again from your terminal to get a new one.`;
		}
		return (
			<p className="text-sm text-kumo-danger mt-2" role="alert">
				{message}
			</p>
		);
	}

	if (!scopes) return null;

	const withheld = scopes.requestedScopes.filter((scope) => !scopes.grantedScopes.includes(scope));

	return (
		<div className="mt-4 space-y-4">
			{scopes.grantedScopes.length > 0 ? (
				<section aria-labelledby={grantedHeadingId}>
					<h2
						id={grantedHeadingId}
						className="text-sm font-medium mb-2"
					>{t`This device is requesting permission to use:`}</h2>
					<ScopeList scopes={scopes.grantedScopes} />
				</section>
			) : (
				<p className="text-sm text-kumo-danger" role="alert">
					{t`Your role does not permit any of the permissions this device requested.`}
				</p>
			)}
			{withheld.length > 0 && (
				<section aria-labelledby={withheldHeadingId}>
					<h2 id={withheldHeadingId} className="text-sm font-medium mb-2 text-kumo-subtle">
						{t`Also requested, but not available to your role:`}
					</h2>
					<ScopeList scopes={withheld} muted />
				</section>
			)}
		</div>
	);
}

function ScopeList({ scopes, muted = false }: { scopes: string[]; muted?: boolean }) {
	const { t } = useLingui();

	return (
		<ul
			className={cn(
				"rounded-md border border-kumo-line divide-y divide-kumo-line",
				muted && "opacity-70",
			)}
		>
			{scopes.map((scope) => {
				const details = SCOPE_DETAILS.get(scope);
				let label = scope;
				let description: string | undefined;
				if (details) {
					label = t(details.label);
					description = t(details.description);
				} else if (scope.startsWith(PLUGIN_MCP_SCOPE_PREFIX)) {
					const pluginId = scope.slice(PLUGIN_MCP_SCOPE_PREFIX.length);
					label = t`Plugin MCP Tools`;
					description = t`Invoke MCP tools from the ${pluginId} plugin`;
				}
				return (
					<li key={scope} className="px-3 py-2">
						<div className="text-sm font-medium">{label}</div>
						{description && <div className="text-xs text-kumo-subtle mt-0.5">{description}</div>}
					</li>
				);
			})}
		</ul>
	);
}

// ============================================================================
// Layout wrapper
// ============================================================================

function PageWrapper({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-sm">{children}</div>
		</div>
	);
}

// ============================================================================
// Icons (inline SVG to avoid dependency on icon library for this simple page)
// ============================================================================

function TerminalIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</svg>
	);
}

function CheckIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}
