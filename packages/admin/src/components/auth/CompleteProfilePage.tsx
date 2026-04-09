/**
 * Complete Profile Page - Collects email when ATProto PDS doesn't return one
 *
 * Standalone page (not wrapped in admin Shell), like LoginPage and SignupPage.
 * Shown after ATProto OAuth callback when the PDS didn't provide an email.
 *
 * Sends a verification email — the user must click the link to complete sign-in.
 */

import { Button, Input } from "@cloudflare/kumo";
import * as React from "react";

import { apiFetch } from "../../lib/api";
import { LogoLockup } from "../Logo.js";

export function CompleteProfilePage() {
	const [email, setEmail] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [emailSent, setEmailSent] = React.useState(false);

	// Get state from URL params
	const state = React.useMemo(() => {
		const params = new URLSearchParams(window.location.search);
		return params.get("state") || "";
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setIsLoading(true);

		try {
			const response = await apiFetch("/_emdash/api/auth/atproto/complete-profile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: email.trim().toLowerCase(), state }),
			});

			if (!response.ok) {
				const body: { error?: { message?: string } } = await response.json().catch(() => ({}));
				throw new Error(body?.error?.message || "Failed to send verification email");
			}

			setEmailSent(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to send verification email");
			setIsLoading(false);
		}
	};

	if (!state) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
				<div className="w-full max-w-md text-center">
					<LogoLockup className="h-10 mx-auto mb-4" />
					<p className="text-kumo-subtle">
						Invalid or missing session. Please try logging in again.
					</p>
					<a
						href="/_emdash/admin/login"
						className="text-kumo-brand hover:underline mt-4 inline-block"
					>
						Back to login
					</a>
				</div>
			</div>
		);
	}

	if (emailSent) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
				<div className="w-full max-w-md">
					<div className="text-center mb-8">
						<LogoLockup className="h-10 mx-auto mb-2" />
					</div>

					<div className="bg-kumo-base border rounded-lg shadow-sm p-6 space-y-6 text-center">
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
							<h2 className="text-xl font-semibold">Check your email</h2>
							<p className="text-kumo-subtle mt-2">
								We sent a verification link to{" "}
								<span className="font-medium text-kumo-default">{email}</span>.
							</p>
						</div>

						<div className="text-sm text-kumo-subtle">
							<p>Click the link in the email to complete sign-in.</p>
							<p className="mt-2">The link will expire in 15 minutes.</p>
						</div>

						<Button
							variant="outline"
							onClick={() => {
								setEmailSent(false);
								setIsLoading(false);
							}}
							className="mt-4 w-full justify-center"
						>
							Use a different email
						</Button>
					</div>

					<p className="text-center mt-6 text-sm text-kumo-subtle">
						<a href="/_emdash/admin/login" className="text-kumo-brand hover:underline">
							Back to login
						</a>
					</p>
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
					<h1 className="text-2xl font-semibold text-kumo-default">Almost there</h1>
					<p className="text-kumo-subtle mt-2">
						Enter your email to complete sign-in. We'll send a verification link.
					</p>
				</div>

				{/* Form */}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					<form onSubmit={handleSubmit} className="space-y-4">
						<Input
							label="Email address"
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
							<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
								{error}
							</div>
						)}

						<Button
							type="submit"
							className="w-full justify-center"
							variant="primary"
							loading={isLoading}
							disabled={!email}
						>
							{isLoading ? "Sending..." : "Send verification email"}
						</Button>
					</form>
				</div>

				{/* Back link */}
				<p className="text-center mt-6 text-sm text-kumo-subtle">
					<a href="/_emdash/admin/login" className="text-kumo-brand hover:underline">
						Back to login
					</a>
				</p>
			</div>
		</div>
	);
}
