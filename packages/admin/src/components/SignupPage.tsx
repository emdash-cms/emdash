/**
 * Signup Page - Self-signup for allowed domains
 *
 * This component is NOT wrapped in the admin Shell.
 * It's a standalone public page for self-signup.
 *
 * Flow:
 * 1. Email input form
 * 2. "Check your email" confirmation
 * 3. After clicking email link: Passkey registration
 */

import { Button, Input, Loader } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { useAdminBranding } from "../lib/admin-branding-context";
import {
	ApiResponseError,
	fetchAuthMode,
	requestSignup,
	verifySignupToken,
	type SignupVerifyResult,
} from "../lib/api";
import { PasskeyRegistration } from "./auth/PasskeyRegistration";
import { TurnstileWidget } from "./auth/TurnstileWidget";
import { BrandLogo } from "./Logo.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

export function VerificationSentMessage({ email }: { email: string }) {
	return (
		<Trans>
			We've sent a verification link to{" "}
			<span className="font-medium text-kumo-default">{email}</span>
		</Trans>
	);
}

export function SignupRoleMessage({ roleName }: { roleName: string }) {
	return (
		<Trans>
			You'll be signing up as <span className="font-medium text-kumo-default">{roleName}</span>
		</Trans>
	);
}

// ============================================================================
// Types
// ============================================================================

type SignupStep = "email" | "check-email" | "verify" | "complete" | "error";

// ============================================================================
// Step Components
// ============================================================================

interface EmailStepProps {
	onSubmit: (email: string, turnstileToken?: string) => void;
	isLoading: boolean;
	error?: string;
	turnstileSiteKey?: string;
	/** Changes after each submit so the single-use Turnstile token is replaced. */
	turnstileKey: number;
}

function EmailStep({ onSubmit, isLoading, error, turnstileSiteKey, turnstileKey }: EmailStepProps) {
	const { t } = useLingui();
	const [email, setEmail] = React.useState("");
	const [validationError, setValidationError] = React.useState<string | null>(null);
	const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);

	React.useEffect(() => {
		setTurnstileToken(null);
	}, [turnstileKey]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setValidationError(null);

		if (!email.trim()) {
			setValidationError(t`Email is required`);
			return;
		}

		if (!email.includes("@") || !email.includes(".")) {
			setValidationError(t`Please enter a valid email address`);
			return;
		}

		onSubmit(email.trim().toLowerCase(), turnstileToken ?? undefined);
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			<div className="space-y-4">
				<div>
					<Input
						label={t`Email address`}
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder={t`you@company.com`}
						className={validationError ? "border-kumo-danger" : ""}
						disabled={isLoading}
						autoComplete="email"
						autoFocus
					/>
					{validationError && <p className="text-sm text-kumo-danger mt-1">{validationError}</p>}
				</div>
			</div>

			{turnstileSiteKey && (
				<TurnstileWidget
					key={turnstileKey}
					siteKey={turnstileSiteKey}
					onToken={setTurnstileToken}
				/>
			)}

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">{error}</div>
			)}

			<Button
				type="submit"
				className="w-full"
				disabled={isLoading || (!!turnstileSiteKey && !turnstileToken)}
			>
				{isLoading ? (
					<>
						<Loader size="sm" />
						{t`Sending...`}
					</>
				) : (
					t`Continue`
				)}
			</Button>

			<p className="text-xs text-kumo-subtle text-center">
				{t`Only email addresses from allowed domains can sign up.`}
			</p>
		</form>
	);
}

interface CheckEmailStepProps {
	email: string;
	onResend: (turnstileToken?: string) => void;
	isResending: boolean;
	resendCooldown: number;
	turnstileSiteKey?: string;
	turnstileKey: number;
	resendError?: string;
}

function CheckEmailStep({
	email,
	onResend,
	isResending,
	resendCooldown,
	turnstileSiteKey,
	turnstileKey,
	resendError,
}: CheckEmailStepProps) {
	const { t } = useLingui();
	const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);

	React.useEffect(() => {
		setTurnstileToken(null);
	}, [turnstileKey]);
	return (
		<div className="space-y-6 text-center">
			<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-brand/10 mx-auto">
				<svg
					className="w-8 h-8 text-kumo-link"
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
					<VerificationSentMessage email={email} />
				</p>
			</div>

			<div className="text-sm text-kumo-subtle">
				<p>{t`Click the link in the email to continue setting up your account.`}</p>
				<p className="mt-2">{t`The link will expire in 15 minutes.`}</p>
			</div>

			<div className="pt-4 border-t">
				<p className="text-sm text-kumo-subtle mb-2">{t`Didn't receive the email?`}</p>
				{turnstileSiteKey && resendCooldown === 0 && (
					<div className="mb-3">
						<TurnstileWidget
							key={turnstileKey}
							siteKey={turnstileSiteKey}
							onToken={setTurnstileToken}
						/>
					</div>
				)}
				<Button
					variant="outline"
					size="sm"
					onClick={() => onResend(turnstileToken ?? undefined)}
					disabled={isResending || resendCooldown > 0 || (!!turnstileSiteKey && !turnstileToken)}
				>
					{isResending
						? t`Sending...`
						: resendCooldown > 0
							? t`Resend in ${resendCooldown}s`
							: t`Resend email`}
				</Button>
				{resendError && (
					<p role="alert" className="mt-2 text-sm text-kumo-danger">
						{resendError}
					</p>
				)}
			</div>
		</div>
	);
}

interface VerifyStepProps {
	verifyResult: SignupVerifyResult;
	token: string;
	onBack: () => void;
}

function handleSignupSuccess() {
	// Redirect to admin dashboard after successful signup
	window.location.href = "/_emdash/admin";
}

function VerifyStep({ verifyResult, token, onBack: _onBack }: VerifyStepProps) {
	const { t } = useLingui();
	const [name, setName] = React.useState("");
	const [passkeyComplete, setPasskeyComplete] = React.useState(false);

	return (
		<div className="space-y-6">
			<div className="text-center">
				<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-success/10 mx-auto mb-4">
					<svg
						className="w-8 h-8 text-kumo-success"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
					</svg>
				</div>
				<h2 className="text-xl font-semibold">{t`Email verified!`}</h2>
				<p className="text-kumo-subtle mt-2">
					<SignupRoleMessage roleName={verifyResult.roleName} />
				</p>
			</div>

			{!passkeyComplete && (
				<>
					<Input label={t`Email`} value={verifyResult.email} disabled className="bg-kumo-tint" />

					<Input
						label={t`Your name (optional)`}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t`Jane Doe`}
						autoComplete="name"
					/>
				</>
			)}

			{/* Passkey registration */}
			<div className="pt-4 border-t">
				<PasskeyRegistration
					optionsEndpoint="/_emdash/api/setup/admin"
					verifyEndpoint="/_emdash/api/auth/signup/complete"
					onSuccess={handleSignupSuccess}
					additionalData={{ token, name: name || undefined }}
					showEducation
					showSuccessStep
					successButtonText={t`Open the dashboard`}
					onSuccessReady={() => setPasskeyComplete(true)}
				/>
			</div>
		</div>
	);
}

interface ErrorStepProps {
	message: string;
	code?: string;
	onRetry?: () => void;
}

function ErrorStep({ message, code, onRetry }: ErrorStepProps) {
	const { t } = useLingui();
	return (
		<div className="space-y-6 text-center">
			<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-danger/10 mx-auto">
				<svg
					className="w-8 h-8 text-kumo-danger"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
			</div>

			<div>
				<h2 className="text-xl font-semibold text-kumo-danger">
					{code === "token_expired"
						? t`Link expired`
						: code === "invalid_token"
							? t`Invalid link`
							: code === "user_exists"
								? t`Account exists`
								: t`Something went wrong`}
				</h2>
				<p className="text-kumo-subtle mt-2">{message}</p>
			</div>

			<div className="space-y-2">
				{code === "user_exists" ? (
					<RouterLinkButton to="/login" className="w-full">{t`Sign in instead`}</RouterLinkButton>
				) : (
					onRetry && (
						<Button onClick={onRetry} className="w-full">
							{t`Request a new link`}
						</Button>
					)
				)}
				<RouterLinkButton
					to="/login"
					variant="ghost"
					className="w-full"
				>{t`Back to login`}</RouterLinkButton>
			</div>
		</div>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function SignupPage() {
	const { logo: brandLogo, siteName: brandSiteName } = useAdminBranding();
	const [step, setStep] = React.useState<SignupStep>("email");
	const [email, setEmail] = React.useState("");
	const [error, setError] = React.useState<string | undefined>();
	const [errorCode, setErrorCode] = React.useState<string | undefined>();
	const [isLoading, setIsLoading] = React.useState(false);
	const [verifyResult, setVerifyResult] = React.useState<SignupVerifyResult | null>(null);
	const [token, setToken] = React.useState<string | null>(null);
	const [resendCooldown, setResendCooldown] = React.useState(0);
	const [turnstileKey, setTurnstileKey] = React.useState(0);
	const [resendError, setResendError] = React.useState<string | undefined>();
	const { data: authInfo, isLoading: authModeLoading } = useQuery({
		queryKey: ["authMode"],
		queryFn: fetchAuthMode,
	});
	const turnstileSiteKey = authInfo?.turnstileSiteKey;

	// Check for token in URL on mount
	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const urlToken = params.get("token");

		if (urlToken) {
			setToken(urlToken);
			void verifyToken(urlToken);
		}
	}, []);

	// Resend cooldown timer
	React.useEffect(() => {
		if (resendCooldown > 0) {
			const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
			return () => clearTimeout(timer);
		}
	}, [resendCooldown]);

	const verifyToken = async (tokenToVerify: string) => {
		setIsLoading(true);
		setError(undefined);
		setErrorCode(undefined);

		try {
			const result = await verifySignupToken(tokenToVerify);
			setVerifyResult(result);
			setStep("verify");
		} catch (err) {
			const verifyError = err instanceof Error ? err : new Error(String(err));
			const errorWithCode = verifyError as Error & { code?: string };
			setError(verifyError.message);
			setErrorCode(typeof errorWithCode.code === "string" ? errorWithCode.code : undefined);
			setStep("error");
		} finally {
			setIsLoading(false);
		}
	};

	const handleEmailSubmit = async (submittedEmail: string, turnstileToken?: string) => {
		setIsLoading(true);
		setError(undefined);
		setEmail(submittedEmail);

		try {
			await requestSignup(submittedEmail, turnstileToken);
			setStep("check-email");
		} catch (err) {
			setError(
				err instanceof ApiResponseError && err.code === "TURNSTILE_FAILED"
					? t`The security check failed. Please try again.`
					: err instanceof Error
						? err.message
						: t`Failed to send verification email`,
			);
		} finally {
			setIsLoading(false);
			setTurnstileKey((key) => key + 1);
		}
	};

	const handleResend = async (turnstileToken?: string) => {
		if (!email || resendCooldown > 0) return;

		setIsLoading(true);
		setResendError(undefined);
		try {
			await requestSignup(email, turnstileToken);
			setResendCooldown(60); // 60 second cooldown
		} catch (err) {
			// Other failures stay silent so they don't reveal whether the email exists
			if (err instanceof ApiResponseError && err.code === "TURNSTILE_FAILED") {
				setResendError(t`The security check failed. Please try again.`);
			}
		} finally {
			setIsLoading(false);
			setTurnstileKey((key) => key + 1);
		}
	};

	const handleRetry = () => {
		setStep("email");
		setError(undefined);
		setErrorCode(undefined);
		setToken(null);
		// Clear token from URL
		window.history.replaceState({}, "", window.location.pathname);
	};

	const { t } = useLingui();

	// Loading state for token verification
	if (isLoading && token) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">{t`Verifying your link...`}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-md">
				{/* Header */}
				<div className="text-center mb-8">
					<BrandLogo logoUrl={brandLogo} siteName={brandSiteName} className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">
						{step === "email" && t`Create an account`}
						{step === "check-email" && t`Check your email`}
						{step === "verify" && t`Complete signup`}
						{step === "error" && t`Oops!`}
					</h1>
				</div>

				{/* Form Card */}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{step === "email" && authModeLoading && (
						<div className="flex justify-center py-8">
							<Loader />
						</div>
					)}

					{step === "email" && !authModeLoading && (
						<EmailStep
							onSubmit={handleEmailSubmit}
							isLoading={isLoading}
							error={error}
							turnstileSiteKey={turnstileSiteKey}
							turnstileKey={turnstileKey}
						/>
					)}

					{step === "check-email" && (
						<CheckEmailStep
							email={email}
							onResend={handleResend}
							isResending={isLoading}
							resendCooldown={resendCooldown}
							turnstileSiteKey={turnstileSiteKey}
							turnstileKey={turnstileKey}
							resendError={resendError}
						/>
					)}

					{step === "verify" && verifyResult && token && (
						<VerifyStep verifyResult={verifyResult} token={token} onBack={handleRetry} />
					)}

					{step === "error" && (
						<ErrorStep
							message={error ?? "An unknown error occurred"}
							code={errorCode}
							onRetry={handleRetry}
						/>
					)}
				</div>

				{/* Login link */}
				{step === "email" && (
					<p className="text-center mt-6 text-sm text-kumo-subtle">
						{t`Already have an account?`}{" "}
						<Link to="/login" className="text-kumo-link hover:underline font-medium">
							{t`Sign in`}
						</Link>
					</p>
				)}
			</div>
		</div>
	);
}

export default SignupPage;
