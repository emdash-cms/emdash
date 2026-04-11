/**
 * TotpRegistration — enrollment component for the authenticator-app
 * setup path in the first-run wizard.
 *
 * Internal stages (driven by a discriminated-union state):
 *   1. "loading": fetching the otpauth URI from /setup/admin-totp
 *   2. "qr": showing the QR code, the base32 fallback, and the 6-digit
 *      input. User scans + types code + hits Verify.
 *   3. "verifying": spinner while /setup/admin-totp-verify is running
 *   4. "success-bridge": 800ms green check — "Authenticator connected"
 *   5. "recovery": 10 codes in a 2×5 grid, required acknowledgement
 *      checkbox, copy/download, `beforeunload` guard, Continue button
 *
 * Props:
 *   - adminData: email + name collected in the previous wizard step
 *   - onSuccess: callback fired when the user clicks Continue on the
 *     recovery codes screen (after acknowledging)
 *
 * Design decisions sourced from the Phase 2 review:
 *   - Single 6-digit <input> with inputMode="numeric",
 *     autoComplete="one-time-code", NOT six separate boxes
 *   - QR code renders on pure white (not the kumo-base tint) so
 *     scanner apps see maximum contrast
 *   - Base32 secret is shown in a collapsed "Can't scan?" disclosure
 *   - Recovery codes screen BLOCKS navigation until the acknowledgement
 *     checkbox is ticked (beforeunload + disabled Continue button)
 *   - Error copy tells the user WHY the code might have been rejected
 *     ("Check your device clock and try again")
 */

import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import QRCode from "qrcode";
import * as React from "react";

import { ApiError, apiFetch, parseApiResponse } from "../../lib/api/client";

// Module-level regexes — moving these out of handlers avoids re-compiling
// on every keystroke.
const SANITIZE_REGEX = /[\s-]/g;
const SIX_DIGITS_REGEX = /^\d{6}$/;

// ============================================================================
// Props & state
// ============================================================================

interface TotpRegistrationProps {
	email: string;
	name?: string;
	onSuccess: () => void;
}

interface AdminTotpStartResponse {
	success: boolean;
	challengeId: string;
	otpauthUri: string;
	base32Secret: string;
	recoveryCodes: string[];
}

interface AdminTotpVerifyResponse {
	success: boolean;
	user: {
		id: string;
		email: string;
		name: string | null;
		role: number;
	};
}

type Stage =
	| { kind: "loading" }
	| { kind: "config-error"; message: string }
	| {
			kind: "qr";
			challengeId: string;
			otpauthUri: string;
			base32Secret: string;
			recoveryCodes: string[];
			qrDataUrl: string;
	  }
	| { kind: "success-bridge"; recoveryCodes: string[] }
	| { kind: "recovery"; recoveryCodes: string[] };

// ============================================================================
// API calls
// ============================================================================

async function startTotpSetup(data: {
	email: string;
	name?: string;
}): Promise<AdminTotpStartResponse> {
	const response = await apiFetch("/_emdash/api/setup/admin-totp", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	return parseApiResponse<AdminTotpStartResponse>(response, "Failed to start TOTP setup");
}

async function verifyTotpSetup(data: {
	challengeId: string;
	code: string;
}): Promise<AdminTotpVerifyResponse> {
	const response = await apiFetch("/_emdash/api/setup/admin-totp-verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	return parseApiResponse<AdminTotpVerifyResponse>(response, "Failed to verify code");
}

// ============================================================================
// Stage 1+2: Start TOTP setup, render QR
// ============================================================================

export function TotpRegistration({ email, name, onSuccess }: TotpRegistrationProps) {
	const { t } = useLingui();
	const [stage, setStage] = React.useState<Stage>({ kind: "loading" });
	const [error, setError] = React.useState<string | null>(null);
	const [failedAttempts, setFailedAttempts] = React.useState(0);
	const [code, setCode] = React.useState("");
	const codeInputRef = React.useRef<HTMLInputElement | null>(null);

	// Kick off the start request on mount. We deliberately do NOT use
	// react-query's useQuery here because this call has side effects
	// (it generates and persists a TOTP secret on the server), so it
	// shouldn't be cached, retried automatically, or refetched.
	const startMutation = useMutation({
		mutationFn: () => startTotpSetup({ email, name }),
		onSuccess: async (data) => {
			try {
				const qrDataUrl = await QRCode.toDataURL(data.otpauthUri, {
					errorCorrectionLevel: "M",
					margin: 1,
					width: 240,
					// Pure black on pure white — scanner apps need maximum
					// contrast and the kumo background tint would hurt
					// recognition on some devices.
					color: { dark: "#000000", light: "#FFFFFF" },
				});
				setStage({
					kind: "qr",
					challengeId: data.challengeId,
					otpauthUri: data.otpauthUri,
					base32Secret: data.base32Secret,
					recoveryCodes: data.recoveryCodes,
					qrDataUrl,
				});
			} catch {
				setError(t`Couldn't render the QR code. Try the manual code below.`);
				// Still move to the qr stage so the base32 fallback is
				// visible even though the QR image failed.
				setStage({
					kind: "qr",
					challengeId: data.challengeId,
					otpauthUri: data.otpauthUri,
					base32Secret: data.base32Secret,
					recoveryCodes: data.recoveryCodes,
					qrDataUrl: "",
				});
			}
		},
		onError: (err: Error) => {
			// Some error codes from the server are configuration
			// problems the deployer must fix (e.g., missing auth
			// secret). Surface those as a distinct stage with the
			// server's actionable message rather than a generic
			// "try again" banner that can't help.
			if (err instanceof ApiError && err.code === "AUTH_SECRET_MISSING") {
				setStage({ kind: "config-error", message: err.message });
				return;
			}
			setError(err.message || t`Couldn't start setup. Refresh and try again.`);
		},
	});

	// eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
	React.useEffect(() => {
		startMutation.mutate();
	}, []);

	const verifyMutation = useMutation({
		mutationFn: verifyTotpSetup,
		onSuccess: () => {
			if (stage.kind !== "qr") return;
			const codes = stage.recoveryCodes;
			// Success bridge: show the green check for 800ms, then hand
			// the user off to the recovery codes screen. Without this
			// brief pause, the recovery codes screen reads as an error
			// state ("what just happened?") instead of a reward.
			setStage({ kind: "success-bridge", recoveryCodes: codes });
			const reducedMotion =
				typeof window !== "undefined" &&
				window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			const delay = reducedMotion ? 200 : 800;
			window.setTimeout(() => {
				setStage({ kind: "recovery", recoveryCodes: codes });
			}, delay);
		},
		onError: (err: Error) => {
			setFailedAttempts((n) => n + 1);
			setCode("");
			setError(err.message || t`Code didn't match. Check your device clock and try again.`);
			// Return focus to the code input so the user can retry
			// without mouse/touch.
			requestAnimationFrame(() => codeInputRef.current?.focus());
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (stage.kind !== "qr") return;
		if (code.length !== 6 || !SIX_DIGITS_REGEX.test(code)) return;
		setError(null);
		verifyMutation.mutate({ challengeId: stage.challengeId, code });
	};

	// Sanitize paste events so "123 456" or "123-456" still works.
	const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const sanitized = e.target.value.replace(SANITIZE_REGEX, "").slice(0, 6);
		setCode(sanitized);
		// Auto-submit once 6 digits are entered — matches the
		// authenticator-app ergonomic of "type the code, done".
		if (sanitized.length === 6 && SIX_DIGITS_REGEX.test(sanitized) && stage.kind === "qr") {
			verifyMutation.mutate({ challengeId: stage.challengeId, code: sanitized });
		}
	};

	// ──────────────────────────────────────────────────────────────────
	// Render per stage
	// ──────────────────────────────────────────────────────────────────

	if (stage.kind === "loading") {
		return (
			<div className="flex flex-col items-center py-12 text-center">
				<Loader />
				<p className="mt-4 text-sm text-kumo-subtle">{t`Preparing your authenticator setup…`}</p>
				{error && (
					<p className="mt-4 text-sm text-kumo-danger" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	if (stage.kind === "config-error") {
		// Deployer-facing error card. Shows the server's actionable
		// message verbatim (which tells them exactly which env var
		// to set), plus a Retry button for after they've fixed it
		// and restarted the dev server.
		return (
			<div
				className="space-y-4 rounded-lg border border-kumo-warning/40 bg-kumo-warning/10 p-4"
				role="alert"
			>
				<div className="flex items-start gap-3">
					<svg
						className="mt-0.5 h-5 w-5 flex-shrink-0 text-kumo-warning"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
					<div className="flex-1">
						<h3 className="text-sm font-medium text-kumo-default">
							{t`Server configuration needed`}
						</h3>
						<p className="mt-1 text-sm text-kumo-default">{stage.message}</p>
					</div>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setStage({ kind: "loading" });
						startMutation.mutate();
					}}
					className="w-full justify-center"
				>
					{t`Retry`}
				</Button>
			</div>
		);
	}

	if (stage.kind === "qr") {
		return (
			<QrStage
				qrDataUrl={stage.qrDataUrl}
				base32Secret={stage.base32Secret}
				code={code}
				onCodeChange={handleCodeChange}
				onSubmit={handleSubmit}
				isVerifying={verifyMutation.isPending}
				error={error}
				failedAttempts={failedAttempts}
				codeInputRef={codeInputRef}
			/>
		);
	}

	if (stage.kind === "success-bridge") {
		return (
			<div
				className="flex flex-col items-center justify-center py-16 text-center"
				aria-live="polite"
			>
				<div className="flex h-16 w-16 items-center justify-center rounded-full bg-kumo-brand/10">
					<svg
						className="h-10 w-10 text-kumo-brand"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={3}
							d="M5 13l4 4L19 7"
						/>
					</svg>
				</div>
				<p className="mt-4 text-lg font-medium text-kumo-default">
					{t`Authenticator connected`}
				</p>
			</div>
		);
	}

	// stage.kind === "recovery"
	return <RecoveryCodesStage codes={stage.recoveryCodes} onContinue={onSuccess} />;
}

// ============================================================================
// QR stage subcomponent
// ============================================================================

interface QrStageProps {
	qrDataUrl: string;
	base32Secret: string;
	code: string;
	onCodeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSubmit: (e: React.FormEvent) => void;
	isVerifying: boolean;
	error: string | null;
	failedAttempts: number;
	codeInputRef: React.RefObject<HTMLInputElement | null>;
}

function QrStage({
	qrDataUrl,
	base32Secret,
	code,
	onCodeChange,
	onSubmit,
	isVerifying,
	error,
	failedAttempts,
	codeInputRef,
}: QrStageProps) {
	const { t } = useLingui();
	const [copied, setCopied] = React.useState(false);

	const handleCopySecret = async () => {
		try {
			await navigator.clipboard.writeText(base32Secret);
			setCopied(true);
			window.setTimeout(setCopied, 1500, false);
		} catch {
			// Clipboard API can fail on insecure contexts or if the
			// user denies permission — the user can still manually
			// select the text, so swallow the error silently.
		}
	};

	return (
		<div className="space-y-6">
			<div className="text-center">
				<h3 className="text-lg font-medium">{t`Scan this code`}</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{t`Use an authenticator app like 1Password, Google Authenticator, Authy, or Bitwarden.`}
				</p>
			</div>

			{/* Pure white background — required for scanner contrast,
			    do NOT swap for a kumo-base color token. */}
			<div className="mx-auto flex w-fit items-center justify-center rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
				{qrDataUrl ? (
					<img
						src={qrDataUrl}
						width={240}
						height={240}
						alt={t`QR code for setting up your authenticator app`}
					/>
				) : (
					<div className="flex h-[240px] w-[240px] items-center justify-center bg-gray-100 text-sm text-gray-500">
						{t`QR unavailable — use the manual code below`}
					</div>
				)}
			</div>

			{/* Manual code disclosure — collapsed by default so the
			    primary path (QR) stays visually dominant. */}
			<details className="rounded-md bg-kumo-tint/40 p-3">
				<summary className="cursor-pointer text-sm text-kumo-default">
					{t`Can't scan? Enter this code instead`}
				</summary>
				<div className="mt-3 space-y-2">
					<code className="block break-all rounded bg-kumo-base px-3 py-2 font-mono text-sm">
						{base32Secret}
					</code>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={handleCopySecret}
						className="w-full justify-center"
					>
						{copied ? t`Copied!` : t`Copy`}
					</Button>
				</div>
			</details>

			<form onSubmit={onSubmit} className="space-y-3">
				<Input
					ref={codeInputRef}
					label={t`6-digit code`}
					type="text"
					inputMode="numeric"
					pattern="[0-9]*"
					autoComplete="one-time-code"
					maxLength={6}
					value={code}
					onChange={onCodeChange}
					disabled={isVerifying}
					autoFocus
					className="text-center font-mono tracking-[0.3em] text-lg"
					aria-label={t`6-digit code from your authenticator app`}
					aria-describedby="totp-code-help"
				/>
				<p id="totp-code-help" className="text-xs text-kumo-subtle">
					{t`Codes refresh every 30 seconds. Enter the current code.`}
				</p>

				{error && (
					<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger" role="alert">
						{error}
					</div>
				)}

				{failedAttempts >= 2 && !error && (
					<div className="rounded-lg bg-kumo-warning/10 p-3 text-sm text-kumo-default">
						<Trans>
							If your codes keep failing, check that your phone's time is set automatically.
						</Trans>
					</div>
				)}

				<Button
					type="submit"
					variant="primary"
					className="w-full justify-center"
					loading={isVerifying}
					disabled={code.length !== 6 || isVerifying}
				>
					{isVerifying ? t`Verifying…` : t`Verify`}
				</Button>
			</form>
		</div>
	);
}

// ============================================================================
// Recovery codes stage
// ============================================================================

interface RecoveryCodesStageProps {
	codes: string[];
	onContinue: () => void;
}

function RecoveryCodesStage({ codes, onContinue }: RecoveryCodesStageProps) {
	const { t } = useLingui();
	const [acknowledged, setAcknowledged] = React.useState(false);
	const [copied, setCopied] = React.useState(false);

	// beforeunload guard — warn the user if they try to close the tab
	// or navigate away without acknowledging. Detached once the user
	// ticks the box, because at that point they've committed to saving
	// the codes and further warnings are just noise.
	React.useEffect(() => {
		if (acknowledged) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			// Modern browsers ignore the returned string, but setting
			// returnValue is still required for the prompt to fire in
			// some Chromium versions.
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [acknowledged]);

	const handleCopyAll = async () => {
		try {
			await navigator.clipboard.writeText(codes.join("\n"));
			setCopied(true);
			window.setTimeout(setCopied, 1500, false);
		} catch {
			// Clipboard failures are silent — user can still
			// hand-copy or use the download.
		}
	};

	const handleDownload = () => {
		// Plain-text file so the user can save it anywhere. One code
		// per line + a header line with the context.
		const content = [
			"EmDash recovery codes",
			"Save these somewhere safe. Each code can be used exactly once.",
			"",
			...codes,
			"",
		].join("\n");
		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "emdash-recovery-codes.txt";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-lg font-medium">{t`Save your recovery codes`}</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{t`You'll need one of these if you lose your authenticator. Each code can be used exactly once.`}
				</p>
			</div>

			{/* 2-column grid of monospace codes. Uses <ol> with an
			    aria-label so screen readers can enumerate them. */}
			<ol
				aria-label={t`Recovery codes`}
				className="grid grid-cols-2 gap-2 rounded-md bg-kumo-tint/40 p-4"
			>
				{codes.map((c) => (
					<li key={c} className="list-none">
						<code className="block rounded bg-kumo-base px-3 py-2 text-center font-mono text-sm">
							{c}
						</code>
					</li>
				))}
			</ol>

			<div className="flex gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={handleCopyAll}
					className="flex-1 justify-center"
				>
					{copied ? t`Copied!` : t`Copy all`}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={handleDownload}
					className="flex-1 justify-center"
				>
					{t`Download`}
				</Button>
			</div>

			<Checkbox
				label={t`I have saved these codes in a safe place`}
				checked={acknowledged}
				onCheckedChange={(checked) => setAcknowledged(checked)}
			/>

			<Button
				type="button"
				variant="primary"
				onClick={onContinue}
				disabled={!acknowledged}
				className="w-full justify-center"
			>
				{t`Continue to admin`}
			</Button>
		</div>
	);
}
