/**
 * Login Page - Standalone login page for the admin
 *
 * This component is NOT wrapped in the admin Shell.
 * It's a standalone page for authentication.
 *
 * Supports:
 * - Passkey authentication (always available)
 * - Pluggable auth providers (AT Protocol, GitHub, Google, etc.) when configured
 * - Magic link (email) when configured
 *
 * When external auth (e.g., Cloudflare Access) is configured, this page
 * redirects to the admin dashboard since authentication is handled externally.
 */

import { Button, Input, Loader, Select } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { apiFetch, fetchAuthMode } from "../lib/api";
import { useAuthProviderList } from "../lib/auth-provider-context";
import { sanitizeRedirectUrl } from "../lib/url";
import { SUPPORTED_LOCALES } from "../locales/index.js";
import { useLocale } from "../locales/useLocale.js";
import { PasskeyLogin } from "./auth/PasskeyLogin";
import { LogoLockup } from "./Logo.js";

// ============================================================================
// Types
// ============================================================================

interface LoginPageProps {
	/** URL to redirect to after successful login */
	redirectUrl?: string;
}

type LoginMethod = "passkey" | "magic-link";

// ============================================================================
// Components
// ============================================================================

interface MagicLinkFormProps {
	onBack: () => void;
}

function MagicLinkForm({ onBack }: MagicLinkFormProps) {
	const { t } = useLingui();
	const [email, setEmail] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [sent, setSent] = React.useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setIsLoading(true);

		try {
			const response = await apiFetch("/_emdash/api/auth/magic-link/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: email.trim().toLowerCase() }),
			});

			if (!response.ok) {
				const body: { error?: { message?: string } } = await response.json().catch(() => ({}));
				throw new Error(body?.error?.message || t`Failed to send magic link`);
			}

			setSent(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Failed to send magic link`);
		} finally {
			setIsLoading(false);
		}
	};

	if (sent) {
		return (
			<div className="space-y-6 text-center">
				<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-brand/10 mx-auto">
					<svg
						className="w-8 h-8 text-kumo-brand"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						/>
					</svg>
				</div>

				<div>
					<h2 className="text-xl font-semibold">{t`Check your email`}</h2>
					<p className="text-kumo-subtle mt-2">
						<Trans>
							If an account exists for{" "}
							<span className="font-medium text-kumo-default">{email}</span>, we've sent a sign-in
							link.
						</Trans>
					</p>
				</div>

				<div className="text-sm text-kumo-subtle">
					<p>{t`Click the link in the email to sign in.`}</p>
					<p className="mt-2">{t`The link will expire in 15 minutes.`}</p>
				</div>

				<Button variant="outline" onClick={onBack} className="mt-4 w-full justify-center">
					{t`Back to login`}
				</Button>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<Input
				label={t`Email address`}
				type="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				placeholder="you@example.com"
				className={error ? "border-kumo-danger" : ""}
				disabled={isLoading}
				autoComplete="email"
				autoFocus
				required
			/>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</div>
			)}

			<Button
				type="submit"
				className="w-full justify-center"
				variant="primary"
				loading={isLoading}
				disabled={!email}
			>
				{isLoading ? t`Sending...` : t`Send magic link`}
			</Button>

			<Button type="button" variant="ghost" className="w-full justify-center" onClick={onBack}>
				{t`Back to login`}
			</Button>
		</form>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function LoginPage({ redirectUrl = "/_emdash/admin" }: LoginPageProps) {
	// Defense-in-depth: sanitize even if the caller already validated
	const safeRedirectUrl = sanitizeRedirectUrl(redirectUrl);
	const { t } = useLingui();
	const { locale, setLocale } = useLocale();
	const [method, setMethod] = React.useState<LoginMethod>("passkey");
	const [urlError, setUrlError] = React.useState<string | null>(null);
	const [activeProvider, setActiveProvider] = React.useState<string | null>(null);

	// Auth provider components from virtual module (via context)
	const authProviderList = useAuthProviderList();

	// Fetch auth mode from public endpoint (works without authentication)
	const { data: authInfo, isLoading: authModeLoading } = useQuery({
		queryKey: ["authMode"],
		queryFn: fetchAuthMode,
	});

	// Redirect to admin when using external auth (authentication is handled externally)
	React.useEffect(() => {
		if (authInfo?.authMode && authInfo.authMode !== "passkey") {
			window.location.href = safeRedirectUrl;
		}
	}, [authInfo, safeRedirectUrl]);

	// Check for error in URL (from OAuth/provider redirect)
	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const error = params.get("error");
		const message = params.get("message");

		if (error) {
			setUrlError(message || t`Authentication error: ${error}`);
			// Clean up URL
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, []);

	const handleSuccess = () => {
		// Redirect after successful login
		window.location.href = safeRedirectUrl;
	};

	// All providers with a LoginButton show in the button grid
	const buttonProviders = authProviderList.filter((p) => p.LoginButton);

	// Show loading state while checking auth mode
	if (authModeLoading || (authInfo?.authMode && authInfo.authMode !== "passkey")) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
				<div className="text-center">
					<LogoLockup className="h-10 mx-auto mb-4" />
					<Loader />
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-md">
				{/* Header */}
				<div className="text-center mb-8">
					<LogoLockup className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">
						{method === "magic-link"
							? t`Sign in with email`
							: activeProvider
								? t`Sign in with ${authProviderList.find((p) => p.id === activeProvider)?.label ?? activeProvider}`
								: t`Sign in to your site`}
					</h1>
				</div>

				{/* Error from URL (provider failure) */}
				{urlError && (
					<div className="mb-6 rounded-lg bg-kumo-danger/10 border border-kumo-danger/20 p-4 text-sm text-kumo-danger">
						{urlError}
					</div>
				)}

				{/* Login Card */}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{method === "passkey" && !activeProvider && (
						<div className="space-y-6">
							{/* Passkey Login */}
							<PasskeyLogin
								optionsEndpoint="/_emdash/api/auth/passkey/options"
								verifyEndpoint="/_emdash/api/auth/passkey/verify"
								onSuccess={handleSuccess}
								buttonText={t`Sign in with Passkey`}
							/>

							{/* Divider */}
							<div className="relative">
								<div className="absolute inset-0 flex items-center">
									<span className="w-full border-t" />
								</div>
								<div className="relative flex justify-center text-xs uppercase">
									<span className="bg-kumo-base px-2 text-kumo-subtle">{t`Or continue with`}</span>
								</div>
							</div>

							{/* Auth provider buttons */}
							{buttonProviders.length > 0 && (
								<div
									className={`grid gap-3 ${buttonProviders.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
								>
									{buttonProviders.map((provider) => {
										const Btn = provider.LoginButton!;
										const hasForm = !!provider.LoginForm;
										const selectProvider = () => setActiveProvider(provider.id);
										return (
											<div key={provider.id} onClick={hasForm ? selectProvider : undefined}>
												<Btn />
											</div>
										);
									})}
								</div>
							)}

							{/* Magic Link Option */}
							<Button
								variant="ghost"
								className="w-full justify-center"
								type="button"
								onClick={() => setMethod("magic-link")}
							>
								{t`Sign in with email link`}
							</Button>
						</div>
					)}

					{/* Provider form (full card replacement, like magic link) */}
					{method === "passkey" &&
						activeProvider &&
						(() => {
							const provider = authProviderList.find((p) => p.id === activeProvider);
							if (!provider?.LoginForm) return null;
							const Form = provider.LoginForm;
							return (
								<div className="space-y-4">
									<Form />
									<Button
										type="button"
										variant="ghost"
										className="w-full justify-center"
										onClick={() => setActiveProvider(null)}
									>
										{t`Back to login`}
									</Button>
								</div>
							);
						})()}

					{method === "magic-link" && <MagicLinkForm onBack={() => setMethod("passkey")} />}
				</div>

				{/* Help text */}
				<p className="text-center mt-6 text-sm text-kumo-subtle">
					{method === "magic-link"
						? t`We'll send you a link to sign in without a password.`
						: activeProvider
							? t`Enter your handle to sign in.`
							: t`Use your registered passkey to sign in securely.`}
				</p>

				{/* Signup link — only shown when self-signup is enabled */}
				{authInfo?.signupEnabled && (
					<p className="text-center mt-4 text-sm text-kumo-subtle">
						<Trans>
							Don't have an account?{" "}
							<Link to="/signup" className="text-kumo-brand hover:underline font-medium">
								Sign up
							</Link>
						</Trans>
					</p>
				)}

				{/* Language selector — only shown when multiple locales are available */}
				{SUPPORTED_LOCALES.length > 1 && (
					<div className="mt-6 flex justify-center">
						<Select
							aria-label={t`Language`}
							className="w-48"
							value={locale}
							onValueChange={(v) => v && setLocale(v)}
							items={Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.label]))}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
