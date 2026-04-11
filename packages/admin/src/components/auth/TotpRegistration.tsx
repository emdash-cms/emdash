/**
 * TotpRegistration — authenticator-app enrollment component for the
 * first-run setup wizard. Fetches the secret, renders the QR code,
 * verifies the first code, and gates Continue on acknowledging the
 * recovery codes.
 */

import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import QRCode from "qrcode";
import * as React from "react";

import { ApiError, apiFetch, parseApiResponse } from "../../lib/api/client";

const SANITIZE_REGEX = /[\s-]/g;
const SIX_DIGITS_REGEX = /^\d{6}$/;

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

export function TotpRegistration({ email, name, onSuccess }: TotpRegistrationProps) {
	const { t } = useLingui();
	const [stage, setStage] = React.useState<Stage>({ kind: "loading" });
	const [error, setError] = React.useState<string | null>(null);
	const [failedAttempts, setFailedAttempts] = React.useState(0);
	const [code, setCode] = React.useState("");
	const codeInputRef = React.useRef<HTMLInputElement | null>(null);

	const startMutation = useMutation({
		mutationFn: () => startTotpSetup({ email, name }),
		onSuccess: async (data) => {
			try {
				const qrDataUrl = await QRCode.toDataURL(data.otpauthUri, {
					errorCorrectionLevel: "M",
					margin: 1,
					width: 240,
					// Pure white required for scanner contrast.
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

	const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const sanitized = e.target.value.replace(SANITIZE_REGEX, "").slice(0, 6);
		setCode(sanitized);
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
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
					</svg>
				</div>
				<p className="mt-4 text-lg font-medium text-kumo-default">{t`Authenticator connected`}</p>
			</div>
		);
	}

	return <RecoveryCodesStage codes={stage.recoveryCodes} onContinue={onSuccess} />;
}

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
			/* clipboard unavailable — user can select manually */
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

			{/* Pure white background required for scanner contrast. */}
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

interface RecoveryCodesStageProps {
	codes: string[];
	onContinue: () => void;
}

function RecoveryCodesStage({ codes, onContinue }: RecoveryCodesStageProps) {
	const { t } = useLingui();
	const [acknowledged, setAcknowledged] = React.useState(false);
	const [copied, setCopied] = React.useState(false);

	// beforeunload guard stays attached until the user acknowledges,
	// so closing the tab without saving the codes triggers a warning.
	React.useEffect(() => {
		if (acknowledged) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
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
			/* clipboard unavailable */
		}
	};

	const handleDownload = () => {
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
