/**
 * Setup Wizard - Multi-step first-run setup page
 *
 * This component is NOT wrapped in the admin Shell.
 * It's a standalone page for initial site configuration.
 *
 * Steps:
 * 1. Site Configuration (title, tagline, sample content)
 * 2. Admin Account (email, name)
 * 3. Passkey Registration
 */

import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse } from "../lib/api/client";
import { PasskeyRegistration } from "./auth/PasskeyRegistration";
import { LogoLockup } from "./Logo.js";

// ============================================================================
// Types
// ============================================================================

interface SetupStatusResponse {
	needsSetup: boolean;
	step?: "start" | "site" | "admin" | "complete";
	seedInfo?: {
		name: string;
		description: string;
		collections: number;
		hasContent: boolean;
	};
	/** Auth mode - "cloudflare-access" or "passkey" */
	authMode?: "cloudflare-access" | "passkey";
}

interface SetupSiteRequest {
	title: string;
	tagline?: string;
	includeContent: boolean;
}

interface SetupSiteResponse {
	success: boolean;
	error?: string;
	/** In Access mode, setup is complete after site config */
	setupComplete?: boolean;
	result?: {
		collections: { created: number; skipped: number };
		fields: { created: number; skipped: number };
		taxonomies: { created: number; terms: number };
		menus: { created: number; items: number };
		widgetAreas: { created: number; widgets: number };
		settings: { applied: number };
		content: { created: number; skipped: number };
	};
}

interface SetupAdminRequest {
	email: string;
	name?: string;
}

interface SetupAdminResponse {
	success: boolean;
	error?: string;
	options?: unknown; // WebAuthn registration options
}

type WizardStep = "site" | "admin" | "passkey";

// ============================================================================
// API Functions
// ============================================================================

async function fetchSetupStatus(): Promise<SetupStatusResponse> {
	const response = await apiFetch("/_emdash/api/setup/status");
	return parseApiResponse<SetupStatusResponse>(response, "Failed to fetch setup status");
}

async function executeSiteSetup(data: SetupSiteRequest): Promise<SetupSiteResponse> {
	const response = await apiFetch("/_emdash/api/setup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});

	return parseApiResponse<SetupSiteResponse>(response, "Setup failed");
}

async function executeAdminSetup(data: SetupAdminRequest): Promise<SetupAdminResponse> {
	const response = await apiFetch("/_emdash/api/setup/admin", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});

	return parseApiResponse<SetupAdminResponse>(response, "Failed to create admin");
}

// ============================================================================
// Step Components
// ============================================================================

interface SiteStepProps {
	seedInfo?: SetupStatusResponse["seedInfo"];
	onNext: (data: SetupSiteRequest) => void;
	isLoading: boolean;
	error?: string;
}

function SiteStep({ seedInfo, onNext, isLoading, error }: SiteStepProps) {
	const { t } = useLingui();
	const [title, setTitle] = React.useState("");
	const [tagline, setTagline] = React.useState("");
	const [includeContent, setIncludeContent] = React.useState(true);
	const [errors, setErrors] = React.useState<Record<string, string>>({});

	const validate = (): boolean => {
		const newErrors: Record<string, string> = {};
		if (!title.trim()) {
			newErrors.title = t`Site title is required`;
		}
		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!validate()) return;
		onNext({ title, tagline, includeContent });
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			<div className="space-y-4">
				<Input
					label={t`Site Title`}
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder={t`My Awesome Blog`}
					className={errors.title ? "border-kumo-danger" : ""}
					disabled={isLoading}
				/>
				{errors.title && <p className="text-sm text-kumo-danger mt-1">{errors.title}</p>}

				<Input
					label={t`Tagline`}
					type="text"
					value={tagline}
					onChange={(e) => setTagline(e.target.value)}
					placeholder={t`Thoughts, tutorials, and more`}
					disabled={isLoading}
				/>
			</div>

			{seedInfo?.hasContent && (
				<Checkbox
					label={t`Include sample content (recommended for new sites)`}
					checked={includeContent}
					onCheckedChange={(checked) => setIncludeContent(checked)}
					disabled={isLoading}
				/>
			)}

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">{error}</div>
			)}

			<Button type="submit" className="w-full justify-center" loading={isLoading} variant="primary">
				{isLoading ? <>{t`Setting up...`}</> : t`Continue →`}
			</Button>

			{seedInfo && (
				<p className="text-xs text-kumo-subtle text-center">
					{t`Template:`} {seedInfo.name} (
					{plural(seedInfo.collections, { one: "# collection", other: "# collections" })})
				</p>
			)}
		</form>
	);
}

interface AdminStepProps {
	onNext: (data: SetupAdminRequest) => void;
	onBack: () => void;
	isLoading: boolean;
	error?: string;
}

function AdminStep({ onNext, onBack, isLoading, error }: AdminStepProps) {
	const { t } = useLingui();
	const [email, setEmail] = React.useState("");
	const [name, setName] = React.useState("");
	const [errors, setErrors] = React.useState<Record<string, string>>({});

	const validate = (): boolean => {
		const newErrors: Record<string, string> = {};
		if (!email.trim()) {
			newErrors.email = t`Email is required`;
		} else if (!email.includes("@")) {
			newErrors.email = t`Please enter a valid email`;
		}
		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!validate()) return;
		onNext({ email, name: name || undefined });
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			<div className="space-y-4">
				<Input
					label={t`Your Email`}
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					placeholder={t`you@example.com`}
					className={errors.email ? "border-kumo-danger" : ""}
					disabled={isLoading}
					autoComplete="email"
				/>
				{errors.email && <p className="text-sm text-kumo-danger mt-1">{errors.email}</p>}

				<Input
					label={t`Your Name`}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t`Jane Doe`}
					disabled={isLoading}
					autoComplete="name"
				/>
			</div>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">{error}</div>
			)}

			<div className="flex gap-3">
				<Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
					{t`← Back`}
				</Button>
				<Button
					type="submit"
					className="flex-1 justify-center"
					loading={isLoading}
					variant="primary"
				>
					{isLoading ? <>{t`Preparing...`}</> : t`Continue →`}
				</Button>
			</div>
		</form>
	);
}

interface PasskeyStepProps {
	adminData: SetupAdminRequest;
	onBack: () => void;
}

function handlePasskeySuccess() {
	// Redirect to admin dashboard after successful registration
	window.location.href = "/_emdash/admin";
}

function PasskeyStep({ adminData, onBack }: PasskeyStepProps) {
	const { t } = useLingui();
	return (
		<div className="space-y-6">
			<div className="text-center">
				<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-kumo-brand/10 mb-4">
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
							d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"
						/>
					</svg>
				</div>
				<h3 className="text-lg font-medium">{t`Set up your passkey`}</h3>
				<p className="text-sm text-kumo-subtle mt-1">
					{t`Passkeys are more secure than passwords. You'll use your device's biometrics, PIN, or security key to sign in.`}
				</p>
			</div>

			<PasskeyRegistration
				optionsEndpoint="/_emdash/api/setup/admin"
				verifyEndpoint="/_emdash/api/setup/admin/verify"
				onSuccess={handlePasskeySuccess}
				buttonText={t`Create Passkey`}
				additionalData={{ ...adminData }}
			/>

			<Button type="button" variant="ghost" onClick={onBack} className="w-full">
				{t`← Back`}
			</Button>
		</div>
	);
}

// ============================================================================
// Progress Indicator
// ============================================================================

interface StepIndicatorProps {
	currentStep: WizardStep;
	useAccessAuth?: boolean;
}

function StepIndicator({ currentStep, useAccessAuth }: StepIndicatorProps) {
	const { t } = useLingui();
	// In Access mode, only show the site step
	const steps = useAccessAuth
		? ([{ key: "site", label: t`Site Settings` }] as const)
		: ([
				{ key: "site", label: t`Site` },
				{ key: "admin", label: t`Account` },
				{ key: "passkey", label: t`Passkey` },
			] as const);

	const currentIndex = steps.findIndex((s) => s.key === currentStep);

	return (
		<div className="flex items-center justify-center mb-8">
			{steps.map((step, index) => (
				<React.Fragment key={step.key}>
					<div className="flex items-center">
						<div
							className={`
								w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
								${
									index < currentIndex
										? "bg-kumo-brand text-white"
										: index === currentIndex
											? "bg-kumo-brand text-white"
											: "bg-kumo-tint text-kumo-subtle"
								}
							`}
						>
							{index < currentIndex ? (
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 13l4 4L19 7"
									/>
								</svg>
							) : (
								index + 1
							)}
						</div>
						<span
							className={`ms-2 text-sm ${
								index <= currentIndex ? "text-kumo-default" : "text-kumo-subtle"
							}`}
						>
							{step.label}
						</span>
					</div>
					{index < steps.length - 1 && (
						<div
							className={`w-12 h-0.5 mx-2 ${index < currentIndex ? "bg-kumo-brand" : "bg-kumo-tint"}`}
						/>
					)}
				</React.Fragment>
			))}
		</div>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function SetupWizard() {
	const [currentStep, setCurrentStep] = React.useState<WizardStep>("site");
	const [_siteData, setSiteData] = React.useState<SetupSiteRequest | null>(null);
	const [adminData, setAdminData] = React.useState<SetupAdminRequest | null>(null);
	const [error, setError] = React.useState<string | undefined>();

	// Check setup status
	const {
		data: status,
		isLoading: statusLoading,
		error: statusError,
	} = useQuery({
		queryKey: ["setup", "status"],
		queryFn: fetchSetupStatus,
		retry: false,
	});

	// Check if using Cloudflare Access auth
	const useAccessAuth = status?.authMode === "cloudflare-access";

	// Site setup mutation
	const siteMutation = useMutation({
		mutationFn: executeSiteSetup,
		onSuccess: (data) => {
			setError(undefined);
			// In Access mode, setup is complete - redirect to admin
			if (data.setupComplete) {
				window.location.href = "/_emdash/admin";
				return;
			}
			// Otherwise continue to admin account creation
			setCurrentStep("admin");
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	// Admin setup mutation
	const adminMutation = useMutation({
		mutationFn: executeAdminSetup,
		onSuccess: () => {
			setError(undefined);
			setCurrentStep("passkey");
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	// Handle site step completion
	const handleSiteNext = (data: SetupSiteRequest) => {
		setSiteData(data);
		siteMutation.mutate(data);
	};

	// Handle admin step completion
	const handleAdminNext = (data: SetupAdminRequest) => {
		setAdminData(data);
		adminMutation.mutate(data);
	};

	// Redirect if setup already complete
	if (!statusLoading && status && !status.needsSetup) {
		window.location.href = "/_emdash/admin";
		return null;
	}

	const { t } = useLingui();

	// Loading state
	if (statusLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">{t`Loading setup...`}</p>
				</div>
			</div>
		);
	}

	// Error state
	if (statusError) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<h1 className="text-xl font-bold text-kumo-danger">{t`Error`}</h1>
					<p className="mt-2 text-kumo-subtle">
						{statusError instanceof Error ? statusError.message : t`Failed to load setup`}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-lg">
				{/* Header */}
				<div className="text-center mb-6">
					<LogoLockup className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">
						{currentStep === "site" && t`Set up your site`}
						{currentStep === "admin" && t`Create your account`}
						{currentStep === "passkey" && t`Secure your account`}
					</h1>
					{useAccessAuth && currentStep === "site" && (
						<p className="text-sm text-kumo-subtle mt-2">{t`You're signed in via Cloudflare Access`}</p>
					)}
				</div>

				{/* Progress */}
				<StepIndicator currentStep={currentStep} useAccessAuth={useAccessAuth} />

				{/* Form Card */}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{currentStep === "site" && (
						<SiteStep
							seedInfo={status?.seedInfo}
							onNext={handleSiteNext}
							isLoading={siteMutation.isPending}
							error={error}
						/>
					)}

					{currentStep === "admin" && (
						<AdminStep
							onNext={handleAdminNext}
							onBack={() => {
								setError(undefined);
								setCurrentStep("site");
							}}
							isLoading={adminMutation.isPending}
							error={error}
						/>
					)}

					{currentStep === "passkey" && adminData && (
						<PasskeyStep
							adminData={adminData}
							onBack={() => {
								setError(undefined);
								setCurrentStep("admin");
							}}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
