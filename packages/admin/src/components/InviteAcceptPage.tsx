/**
 * Standalone invite acceptance page (not wrapped in admin Shell).
 * Validates an invite token, then registers a passkey to complete signup.
 */

import { Button, Input, Loader } from "@cloudflare/kumo";
import { Link, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { validateInviteToken, type InviteVerifyResult } from "../lib/api";
import { PasskeyRegistration } from "./auth/PasskeyRegistration";
import { LogoLockup } from "./Logo.js";

type InviteStep = "verify" | "register" | "error";

interface RegisterStepProps {
	inviteData: InviteVerifyResult;
	token: string;
}

function handleInviteSuccess() {
	window.location.href = "/_emdash/admin";
}

function RegisterStep({ inviteData, token }: RegisterStepProps) {
	const [name, setName] = React.useState("");

	return (
		<div className="space-y-6">
			<div className="text-center">
				<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-brand/10 mx-auto mb-4">
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
							d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
						/>
					</svg>
				</div>
				<h2 className="text-xl font-semibold">You've been invited!</h2>
				<p className="text-kumo-subtle mt-2">
					You'll be joining as{" "}
					<span className="font-medium text-kumo-default">{inviteData.roleName}</span>
				</p>
			</div>

			<Input label="Email" value={inviteData.email} disabled className="bg-kumo-tint" />

			<Input
				label="Your name (optional)"
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Jane Doe"
				autoComplete="name"
				autoFocus
			/>

			<div className="pt-4 border-t">
				<h3 className="text-sm font-medium mb-3">Create your passkey</h3>
				<p className="text-sm text-kumo-subtle mb-4">
					Passkeys are a secure, passwordless way to sign in using your device's biometrics, PIN, or
					security key.
				</p>

				<PasskeyRegistration
					optionsEndpoint="/_emdash/api/auth/invite/register-options"
					verifyEndpoint="/_emdash/api/auth/invite/complete"
					onSuccess={handleInviteSuccess}
					buttonText="Create Account"
					additionalData={{ token, name: name || undefined }}
				/>
			</div>
		</div>
	);
}

interface ErrorStepProps {
	message: string;
	code?: string;
}

function ErrorStep({ message, code }: ErrorStepProps) {
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
					{code === "TOKEN_EXPIRED"
						? "Invite expired"
						: code === "INVALID_TOKEN"
							? "Invalid invite link"
							: code === "USER_EXISTS"
								? "Account already exists"
								: "Something went wrong"}
				</h2>
				<p className="text-kumo-subtle mt-2">{message}</p>
			</div>

			<div className="space-y-2">
				{code === "USER_EXISTS" ? (
					<Link to="/login">
						<Button className="w-full">Sign in instead</Button>
					</Link>
				) : (
					<>
						<p className="text-sm text-kumo-subtle">
							Please ask your administrator to send a new invite.
						</p>
						<Link to="/login">
							<Button variant="ghost" className="w-full">
								Back to login
							</Button>
						</Link>
					</>
				)}
			</div>
		</div>
	);
}

export function InviteAcceptPage() {
	const { token: urlToken } = useSearch({ strict: false });
	const [step, setStep] = React.useState<InviteStep>("verify");
	const [error, setError] = React.useState<string | undefined>();
	const [errorCode, setErrorCode] = React.useState<string | undefined>();
	const [isLoading, setIsLoading] = React.useState(true);
	const [inviteData, setInviteData] = React.useState<InviteVerifyResult | null>(null);
	const [token, setToken] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!urlToken) {
			setError("No invite token provided");
			setStep("error");
			setIsLoading(false);
			return;
		}

		setToken(urlToken);
		void verifyToken(urlToken);
	}, [urlToken]);

	const verifyToken = async (tokenToVerify: string) => {
		setIsLoading(true);
		setError(undefined);
		setErrorCode(undefined);

		try {
			const result = await validateInviteToken(tokenToVerify);
			setInviteData(result);
			setStep("register");
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

	if (isLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Verifying your invite...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-md">
				<div className="text-center mb-8">
					<LogoLockup className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">
						{step === "register" && "Accept Invite"}
						{step === "error" && "Invite Error"}
					</h1>
				</div>

				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{step === "register" && inviteData && token && (
						<RegisterStep inviteData={inviteData} token={token} />
					)}

					{step === "error" && (
						<ErrorStep message={error ?? "An unknown error occurred"} code={errorCode} />
					)}
				</div>
			</div>
		</div>
	);
}

export default InviteAcceptPage;
