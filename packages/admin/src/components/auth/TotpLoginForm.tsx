/**
 * TotpLoginForm — ongoing login via an authenticator app or recovery code.
 * Swaps between "totp" and "recovery" modes in place, preserving the
 * email when switching.
 */

import { Button, Input } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import * as React from "react";

import { apiFetch } from "../../lib/api";

const SANITIZE_TOTP_REGEX = /[\s-]/g;
const SIX_DIGITS_REGEX = /^\d{6}$/;
const RECOVERY_CODE_REGEX = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const UPPERCASE_ALLOWED_REGEX = /[^A-Z2-7-]/g;

/** Key RecoveryCodesBanner reads on mount after a recovery-code login. */
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
				const errorBody: { error?: { code?: string; message?: string } } = await response
					.json()
					.catch(() => ({}));
				const errorCode = errorBody.error?.code ?? "INVALID_CREDENTIALS";

				if (errorCode === "AUTH_SECRET_MISSING") {
					setError(errorBody.error?.message ?? t`Server configuration needed.`);
				} else if (errorCode === "RATE_LIMITED") {
					setError(t`Too many attempts. Wait a few minutes and try again.`);
				} else {
					setError(t`Email or code is wrong. Try again.`);
					setFailedAttempts((n) => n + 1);
					if (mode === "totp") setCode("");
					else setRecoveryCode("");
				}
				setIsLoading(false);
				return;
			}

			// Server wraps successes in { data: ... } — unwrap before reading.
			const envelope: { data: TotpLoginResponse } = await response.json();
			const data = envelope.data;

			if (mode === "recovery" && typeof data.remainingRecoveryCodes === "number") {
				try {
					window.sessionStorage.setItem(
						REMAINING_RECOVERY_CODES_KEY,
						String(data.remainingRecoveryCodes),
					);
				} catch {
					/* sessionStorage unavailable — skip banner */
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
