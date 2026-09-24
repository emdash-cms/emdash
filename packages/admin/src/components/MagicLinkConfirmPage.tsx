/**
 * Standalone magic link confirmation page (not wrapped in admin Shell).
 * The token is only used when the recipient presses Continue.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useAdminBranding } from "../lib/admin-branding-context.js";
import { apiFetch } from "../lib/api.js";
import { BrandLogo } from "./Logo.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

interface MagicLinkConfirmPageProps {
	token: string | null;
	redirectUrl: string;
}

export function MagicLinkConfirmPage({ token, redirectUrl }: MagicLinkConfirmPageProps) {
	const { t } = useLingui();
	const { logo: brandLogo, siteName: brandSiteName } = useAdminBranding();
	const [isLoading, setIsLoading] = React.useState(false);
	const [errorCode, setErrorCode] = React.useState<string | null>(token ? null : "INVALID_TOKEN");

	const handleContinue = async () => {
		if (!token) return;
		setIsLoading(true);
		setErrorCode(null);
		try {
			const response = await apiFetch("/_emdash/api/auth/magic-link/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			if (response.ok) {
				window.history.replaceState({}, "", window.location.pathname);
				window.location.href = redirectUrl;
				return;
			}
			const body: { error?: { code?: string } } = await response.json().catch(() => ({}));
			setErrorCode(body.error?.code ?? "UNKNOWN_ERROR");
		} catch {
			setErrorCode("UNKNOWN_ERROR");
		}
		setIsLoading(false);
	};

	const errorMessage =
		errorCode === "TOKEN_EXPIRED"
			? t`This sign-in link has expired. Request a new one from the login page.`
			: errorCode === "INVALID_TOKEN" || errorCode === "USER_NOT_FOUND"
				? t`This sign-in link is invalid or has already been used. Request a new one from the login page.`
				: t`Signing in failed. Please try again.`;

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-md">
				<div className="text-center mb-8">
					<BrandLogo logoUrl={brandLogo} siteName={brandSiteName} className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">{t`Sign in with email`}</h1>
				</div>

				<div className="bg-kumo-base border rounded-lg shadow-sm p-6 space-y-4">
					{errorCode ? (
						<div role="alert" className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
							{errorMessage}
						</div>
					) : (
						<p className="text-kumo-subtle">{t`Continue to finish signing in. The link works only once.`}</p>
					)}

					{token && (errorCode === null || errorCode === "UNKNOWN_ERROR") && (
						<Button
							className="w-full justify-center"
							variant="primary"
							onClick={handleContinue}
							loading={isLoading}
						>
							{t`Continue`}
						</Button>
					)}

					<RouterLinkButton
						to="/login"
						activeOptions={{ exact: true }}
						variant="ghost"
						className="w-full justify-center"
					>
						{t`Back to login`}
					</RouterLinkButton>
				</div>
			</div>
		</div>
	);
}
