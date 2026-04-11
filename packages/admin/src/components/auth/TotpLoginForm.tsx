/**
 * TotpLoginForm — ongoing login via an authenticator app. Rendered from
 * LoginPage when the user picks the "Authenticator app" method.
 *
 * Two internal modes:
 *   - "totp":     email + 6-digit code
 *   - "recovery": email + XXXX-XXXX recovery code
 *
 * The user switches between modes via a single "Lost your authenticator?
 * Use a recovery code" link below the code input. The link swaps the
 * input shape (different field styling so users don't conflate) but
 * preserves the email so they don't have to retype it.
 *
 * On successful TOTP login: call onSuccess (which redirects to /admin).
 * On successful recovery login: store the remaining-codes count in a
 * session-storage key so LoginPage can surface a persistent banner on
 * the next page.
 */

import { Button, Input } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import * as React from "react";

import { apiFetch } from "../../lib/api";

// Module-scoped regexes to avoid re-compiling on every keystroke.
const SANITIZE_TOTP_REGEX = /[\s-]/g;
const SIX_DIGITS_REGEX = /^\d{6}$/;
const RECOVERY_CODE_REGEX = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const UPPERCASE_ALLOWED_REGEX = /[^A-Z2-7-]/g;

/**
 * sessionStorage key LoginPage uses to surface the "N codes left"
 * banner on the next page after a successful recovery login.
 * Exported for the banner consumer.
 */
export const REMAINING_RECOVERY_CODES_KEY = "emdash:totp:remainingRecoveryCodes";

type Mode = "totp" | "recovery";

interface TotpLoginFormProps {
	onSuccess: () => void;
	onBack: () => void;
}

interface TotpLoginResponse {
	success: boolean;
	user: { id: string; email: string; name: string | null; role: number };
	remainingRecoveryCodes?: number;
}

interface ErrorBody {
	error?: { code?: string; message?: string };
}

export function TotpLoginForm({ onSuccess, onBack }: TotpLoginFormProps) {
	const { t } = useLingui();
	const [mode, setMode] = React.useState<Mode>("totp");
	const [email, setEmail] = React.useState("");
	const [code, setCode] = React.useState("");
	const [recoveryCode, setRecoveryCode] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [failedAttempts, setFailedAttempts] = React.useState(0);
	const [isLoading, setIsLoading] = React.useState(false);

	const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const sanitized = e.target.value.replace(SANITIZE_TOTP_REGEX, "").slice(0, 6);
		setCode(sanitized);
	};

	const handleRecoveryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		// Accept lowercase too — recovery codes are base32 uppercase but
		// users writing them down may use lowercase. We uppercase and
		// reject anything outside the base32 alphabet + hyphen, then
		// clamp the length so the input can't grow past the expected
		// format (9 chars: 4 + 1 hyphen + 4).
		const upper = e.target.value.toUpperCase().replace(UPPERCASE_ALLOWED_REGEX, "");
		setRecoveryCode(upper.slice(0, 9));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!email.trim()) {
			setError(t`Enter your email`);
			return;
		}
		if (mode === "totp" && !SIX_DIGITS_REGEX.test(code)) {
			setError(t`Enter the 6-digit code from your authenticator app`);
			return;
		}
		if (mode === "recovery" && !RECOVERY_CODE_REGEX.test(recoveryCode)) {
			setError(t`Recovery codes look like ABCD-2345`);
			return;
		}

		setIsLoading(true);
		try {
			const body =
				mode === "totp"
					? { method: "totp" as const, email: email.trim().toLowerCase(), code }
					: {
							method: "recovery" as const,
							email: email.trim().toLowerCase(),
							recoveryCode,
						};

			const response = await apiFetch("/_emdash/api/auth/totp/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				// Parse the structured error body and map error codes to
				// friendly copy. Anything we don't recognize falls back
				// to the generic INVALID_CREDENTIALS message.
				const errorBody: ErrorBody = await response.json().catch(() => ({}));
				const errorCode = errorBody.error?.code ?? "INVALID_CREDENTIALS";

				if (errorCode === "AUTH_SECRET_MISSING") {
					// Server config problem, not a wrong code. Show the
					// server's verbatim message which tells the deployer
					// exactly which env var to set. Don't increment the
					// failed-attempts counter — this isn't a login
					// failure, it's a 500 that'll happen on every try
					// until the deployer fixes the server.
					setError(errorBody.error?.message ?? t`Server configuration needed.`);
				} else if (errorCode === "TOTP_LOCKED") {
					setError(t`Too many attempts. Use a recovery code instead.`);
					setMode("recovery");
				} else if (errorCode === "RATE_LIMITED") {
					setError(t`Too many attempts. Wait a few minutes and try again.`);
				} else {
					setError(t`Email or code is wrong. Try again.`);
					setFailedAttempts((n) => n + 1);
					// Clear the code field on error so the user can
					// retype without having to select-and-delete.
					if (mode === "totp") setCode("");
					else setRecoveryCode("");
				}
				setIsLoading(false);
				return;
			}

			const data: TotpLoginResponse = await response.json();

			// If recovery path, stash the remaining count so LoginPage
			// can show a persistent banner on the next page.
			if (mode === "recovery" && typeof data.remainingRecoveryCodes === "number") {
				try {
					window.sessionStorage.setItem(
						REMAINING_RECOVERY_CODES_KEY,
						String(data.remainingRecoveryCodes),
					);
				} catch {
					// sessionStorage can be unavailable in private modes
					// on some browsers — swallow and skip the banner.
				}
			}

			onSuccess();
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Something went wrong. Try again.`);
			setIsLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<Input
				label={t`Email`}
				type="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				placeholder="you@example.com"
				disabled={isLoading}
				autoComplete="email"
				autoFocus={email === ""}
				required
			/>

			{mode === "totp" ? (
				<>
					<Input
						label={t`6-digit code`}
						type="text"
						inputMode="numeric"
						pattern="[0-9]*"
						autoComplete="one-time-code"
						maxLength={6}
						value={code}
						onChange={handleCodeChange}
						disabled={isLoading}
						className="text-center font-mono tracking-[0.3em] text-lg"
						aria-label={t`6-digit code from your authenticator app`}
						autoFocus={email !== ""}
					/>
					{failedAttempts >= 2 && !error && (
						<div className="rounded-lg bg-kumo-warning/10 p-3 text-sm text-kumo-default">
							<Trans>
								If your codes keep failing, check that your phone's time is set automatically.
							</Trans>
						</div>
					)}
				</>
			) : (
				<Input
					label={t`Recovery code`}
					type="text"
					inputMode="text"
					autoComplete="off"
					autoCapitalize="characters"
					maxLength={9}
					value={recoveryCode}
					onChange={handleRecoveryChange}
					disabled={isLoading}
					placeholder="ABCD-2345"
					className="text-center font-mono tracking-[0.2em] text-lg"
					aria-label={t`Recovery code`}
					autoFocus={email !== ""}
				/>
			)}

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger" role="alert">
					{error}
				</div>
			)}

			<Button
				type="submit"
				className="w-full justify-center"
				variant="primary"
				loading={isLoading}
				disabled={
					isLoading || !email || (mode === "totp" ? !SIX_DIGITS_REGEX.test(code) : !RECOVERY_CODE_REGEX.test(recoveryCode))
				}
			>
				{isLoading ? t`Signing in…` : t`Sign in`}
			</Button>

			{mode === "totp" ? (
				<Button
					type="button"
					variant="ghost"
					className="w-full justify-center text-sm"
					onClick={() => {
						setError(null);
						setCode("");
						setMode("recovery");
					}}
				>
					{t`Lost your authenticator? Use a recovery code`}
				</Button>
			) : (
				<Button
					type="button"
					variant="ghost"
					className="w-full justify-center text-sm"
					onClick={() => {
						setError(null);
						setRecoveryCode("");
						setMode("totp");
					}}
				>
					{t`Back to 6-digit code`}
				</Button>
			)}

			<Button type="button" variant="ghost" className="w-full justify-center" onClick={onBack}>
				{t`Back to login`}
			</Button>
		</form>
	);
}
