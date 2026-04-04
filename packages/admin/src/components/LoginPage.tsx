/**
 * Login Page - Standalone login page for the admin
 *
 * This component is NOT wrapped in the admin Shell.
 * It's a standalone page for authentication.
 *
 * Supports:
 * - Passkey authentication (primary)
 * - OAuth (GitHub, Google) when configured
 * - Magic link (email) when configured
 *
 * When external auth (e.g., Cloudflare Access) is configured, this page
 * redirects to the admin dashboard since authentication is handled externally.
 */

import { Button, Input, Loader } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { apiFetch, fetchManifest } from "../lib/api";
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

interface OAuthProvider {
	id: string;
	name: string;
	icon: React.ReactNode;
}

// ============================================================================
// OAuth Icons
// ============================================================================

function GitHubIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
		</svg>
	);
}

function GoogleIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24">
			<path
				fill="#4285F4"
				d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
			/>
			<path
				fill="#34A853"
				d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
			/>
			<path
				fill="#FBBC05"
				d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
			/>
			<path
				fill="#EA4335"
				d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
			/>
		</svg>
	);
}

// ============================================================================
// OAuth Providers
// ============================================================================

const OAUTH_PROVIDERS: OAuthProvider[] = [
	{
		id: "github",
		name: "GitHub",
		icon: <GitHubIcon className="h-5 w-5" />,
	},
	{
		id: "google",
		name: "Google",
		icon: <GoogleIcon className="h-5 w-5" />,
	},
];

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

function handleOAuthClick(providerId: string) {
	// Redirect to OAuth endpoint
	window.location.href = `/_emdash/api/auth/oauth/${providerId}`;
}

export function LoginPage({ redirectUrl = "/_emdash/admin" }: LoginPageProps) {
	// Defense-in-depth: sanitize even if the caller already validated
	const safeRedirectUrl = sanitizeRedirectUrl(redirectUrl);
	const { t } = useLingui();
	const { locale, setLocale } = useLocale();
	const [method, setMethod] = React.useState<LoginMethod>("passkey");
	const [urlError, setUrlError] = React.useState<string | null>(null);

	// Fetch manifest to check auth mode
	const { data: manifest, isLoading: manifestLoading } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	// Redirect to admin when using external auth (authentication is handled externally)
	React.useEffect(() => {
		if (manifest?.authMode && manifest.authMode !== "passkey") {
			window.location.href = safeRedirectUrl;
		}
	}, [manifest, safeRedirectUrl]);

	// Check for error in URL (from OAuth redirect)
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

	// Show loading state while checking auth mode
	if (manifestLoading || (manifest?.authMode && manifest.authMode !== "passkey")) {
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
						{method === "passkey" && t`Sign in to your site`}
						{method === "magic-link" && t`Sign in with email`}
					</h1>
				</div>

				{/* Error from URL (OAuth failure) */}
				{urlError && (
					<div className="mb-6 rounded-lg bg-kumo-danger/10 border border-kumo-danger/20 p-4 text-sm text-kumo-danger">
						{urlError}
					</div>
				)}

				{/* Login Card */}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{method === "passkey" && (
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

							{/* OAuth Providers */}
							<div className="grid grid-cols-2 gap-3">
								{OAUTH_PROVIDERS.map((provider) => (
									<Button
										key={provider.id}
										variant="outline"
										type="button"
										onClick={() => handleOAuthClick(provider.id)}
										className="w-full justify-center"
									>
										{provider.icon}
										<span className="ml-2">{provider.name}</span>
									</Button>
								))}
							</div>

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

					{method === "magic-link" && <MagicLinkForm onBack={() => setMethod("passkey")} />}
				</div>

				{/* Help text */}
				<p className="text-center mt-6 text-sm text-kumo-subtle">
					{method === "passkey"
						? t`Use your registered passkey to sign in securely.`
						: t`We'll send you a link to sign in without a password.`}
				</p>

				{/* Signup link — only shown when self-signup is enabled */}
				{manifest?.signupEnabled && (
					<p className="text-center mt-4 text-sm text-kumo-subtle">
						<Trans>
							Don't have an account?{" "}
							<Link to="/signup" className="text-kumo-brand hover:underline font-medium">
								Sign up
							</Link>
						</Trans>
					</p>
				)}

				{/* Language selector */}
				<div className="mt-6 flex justify-center gap-2 text-xs text-kumo-subtle">
					{SUPPORTED_LOCALES.map((l, i) => (
						<React.Fragment key={l.code}>
							{i > 0 && <span>·</span>}
							<button
								onClick={() => setLocale(l.code)}
								className={
									l.code === locale
										? "font-medium text-kumo-default"
										: "hover:text-kumo-default transition-colors"
								}
							>
								{l.label}
							</button>
						</React.Fragment>
					))}
				</div>
			</div>
		</div>
	);
}
