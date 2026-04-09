/**
 * Setup Wizard - Multi-step first-run setup page
 *
 * This component is NOT wrapped in the admin Shell.
 * It's a standalone page for initial site configuration.
 *
 * Steps:
 * 1. Site Configuration (title, tagline, sample content)
 * 2. Create admin account — user picks any available auth method:
 *    - Passkey (always available)
 *    - Any configured auth provider (AT Protocol, GitHub, Google, etc.)
 */

import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse } from "../lib/api/client";
import { useAuthProviderList, type AuthProviderModule } from "../lib/auth-provider-context";
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
	const [title, setTitle] = React.useState("");
	const [tagline, setTagline] = React.useState("");
	const [includeContent, setIncludeContent] = React.useState(true);
	const [errors, setErrors] = React.useState<Record<string, string>>({});

	const validate = (): boolean => {
		const newErrors: Record<string, string> = {};
		if (!title.trim()) {
			newErrors.title = "Site title is required";
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
					label="Site Title"
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="My Awesome Blog"
					className={errors.title ? "border-kumo-danger" : ""}
					disabled={isLoading}
				/>
				{errors.title && <p className="text-sm text-kumo-danger mt-1">{errors.title}</p>}

				<Input
					label="Tagline"
					type="text"
					value={tagline}
					onChange={(e) => setTagline(e.target.value)}
					placeholder="Thoughts, tutorials, and more"
					disabled={isLoading}
				/>
			</div>

			{seedInfo?.hasContent && (
				<Checkbox
					label="Include sample content (recommended for new sites)"
					checked={includeContent}
					onCheckedChange={(checked) => setIncludeContent(checked)}
					disabled={isLoading}
				/>
			)}

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">{error}</div>
			)}

			<Button type="submit" className="w-full justify-center" loading={isLoading} variant="primary">
				{isLoading ? <>Setting up...</> : "Continue →"}
			</Button>

			{seedInfo && (
				<p className="text-xs text-kumo-subtle text-center">
					Template: {seedInfo.name} ({seedInfo.collections} collection
					{seedInfo.collections !== 1 ? "s" : ""})
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
	const [email, setEmail] = React.useState("");
	const [name, setName] = React.useState("");
	const [errors, setErrors] = React.useState<Record<string, string>>({});

	const validate = (): boolean => {
		const newErrors: Record<string, string> = {};
		if (!email.trim()) {
			newErrors.email = "Email is required";
		} else if (!email.includes("@")) {
			newErrors.email = "Please enter a valid email";
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
					label="Your Email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					placeholder="you@example.com"
					className={errors.email ? "border-kumo-danger" : ""}
					disabled={isLoading}
					autoComplete="email"
				/>
				{errors.email && <p className="text-sm text-kumo-danger mt-1">{errors.email}</p>}

				<Input
					label="Your Name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Jane Doe"
					disabled={isLoading}
					autoComplete="name"
				/>
			</div>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">{error}</div>
			)}

			<div className="flex gap-3">
				<Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
					← Back
				</Button>
				<Button
					type="submit"
					className="flex-1 justify-center"
					loading={isLoading}
					variant="primary"
				>
					{isLoading ? <>Preparing...</> : "Continue →"}
				</Button>
			</div>
		</form>
	);
}

function handleSetupSuccess() {
	window.location.href = "/_emdash/admin";
}

interface AuthMethodStepProps {
	adminData: SetupAdminRequest;
	providers: AuthProviderModule[];
	onBack: () => void;
}

function AuthMethodStep({ adminData, providers, onBack }: AuthMethodStepProps) {
	const [activeProvider, setActiveProvider] = React.useState<string | null>(null);

	const buttonProviders = providers.filter((p) => p.LoginButton);
	const hasProviders = buttonProviders.length > 0;

	// Show provider form (full card replacement)
	if (activeProvider) {
		const provider = providers.find((p) => p.id === activeProvider);
		if (provider && (provider.SetupStep || provider.LoginForm)) {
			return (
				<div className="space-y-4">
					<div className="text-center mb-2">
						<h3 className="text-lg font-medium">Sign in with {provider.label}</h3>
					</div>
					{provider.SetupStep ? (
						<provider.SetupStep onComplete={handleSetupSuccess} />
					) : provider.LoginForm ? (
						<provider.LoginForm />
					) : null}
					<Button
						type="button"
						variant="ghost"
						className="w-full justify-center"
						onClick={() => setActiveProvider(null)}
					>
						← Back
					</Button>
				</div>
			);
		}
	}

	return (
		<div className="space-y-6">
			{/* Passkey option */}
			<div className="text-center">
				<h3 className="text-lg font-medium">Choose how to sign in</h3>
				<p className="text-sm text-kumo-subtle mt-1">
					Pick any method to create your admin account.
				</p>
			</div>

			<PasskeyRegistration
				optionsEndpoint="/_emdash/api/setup/admin"
				verifyEndpoint="/_emdash/api/setup/admin/verify"
				onSuccess={handleSetupSuccess}
				buttonText="Create Passkey"
				additionalData={{ ...adminData }}
			/>

			{/* Auth provider options */}
			{hasProviders && (
				<>
					<div className="relative">
						<div className="absolute inset-0 flex items-center">
							<span className="w-full border-t" />
						</div>
						<div className="relative flex justify-center text-xs uppercase">
							<span className="bg-kumo-base px-2 text-kumo-subtle">Or continue with</span>
						</div>
					</div>

					<div
						className={`grid gap-3 ${buttonProviders.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
					>
						{buttonProviders.map((provider) => {
							const Btn = provider.LoginButton!;
							const hasForm = !!provider.LoginForm || !!provider.SetupStep;
							const selectProvider = () => setActiveProvider(provider.id);
							return (
								<div key={provider.id} onClick={hasForm ? selectProvider : undefined}>
									<Btn />
								</div>
							);
						})}
					</div>
				</>
			)}

			<Button type="button" variant="ghost" onClick={onBack} className="w-full">
				← Back
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
	// In Access mode, only show the site step
	const steps = useAccessAuth
		? ([{ key: "site", label: "Site Settings" }] as const)
		: ([
				{ key: "site", label: "Site" },
				{ key: "admin", label: "Account" },
				{ key: "passkey", label: "Sign In" },
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
							className={`ml-2 text-sm ${
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
	const [urlError, setUrlError] = React.useState<string | null>(null);

	// Auth provider components from virtual module (via context)
	const authProviderList = useAuthProviderList();

	// Check for error in URL (from OAuth/provider redirect)
	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const errorParam = params.get("error");
		const message = params.get("message");

		if (errorParam) {
			setUrlError(message || `Authentication error: ${errorParam}`);
			// Clean up URL
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, []);

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
			// Continue to admin account creation
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

	// Loading state
	if (statusLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Loading setup...</p>
				</div>
			</div>
		);
	}

	// Error state
	if (statusError) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-kumo-base">
				<div className="text-center">
					<h1 className="text-xl font-bold text-kumo-danger">Error</h1>
					<p className="mt-2 text-kumo-subtle">
						{statusError instanceof Error ? statusError.message : "Failed to load setup"}
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
						{currentStep === "site" && "Set up your site"}
						{currentStep === "admin" && "Create your account"}
						{currentStep === "passkey" && "Secure your account"}
					</h1>
					{useAccessAuth && currentStep === "site" && (
						<p className="text-sm text-kumo-subtle mt-2">You're signed in via Cloudflare Access</p>
					)}
				</div>

				{/* Error from URL (provider failure) */}
				{urlError && (
					<div className="mb-6 rounded-lg bg-kumo-danger/10 border border-kumo-danger/20 p-4 text-sm text-kumo-danger">
						{urlError}
					</div>
				)}

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
						<AuthMethodStep
							adminData={adminData}
							providers={authProviderList}
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
