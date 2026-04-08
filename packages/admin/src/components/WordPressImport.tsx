import { Badge, Button, Input, LinkButton, Loader, buttonVariants } from "@cloudflare/kumo";
import {
	Upload,
	Check,
	X,
	Warning,
	WarningCircle,
	Plus,
	Database,
	FileText,
	CaretDown,
	CaretRight,
	Image,
	DownloadSimple,
	Globe,
	ArrowSquareOut,
	List,
	Gear,
	Sparkle,
	User,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import {
	analyzeWxr,
	prepareWxrImport,
	executeWxrImport,
	importWxrMedia,
	rewriteContentUrls,
	probeImportUrl,
	analyzeWpPluginSite,
	executeWpPluginImport,
	fetchUsers,
	type WxrAnalysis,
	type WpPluginAnalysis,
	type PostTypeAnalysis,
	type ImportConfig,
	type ImportResult,
	type PrepareResult,
	type MediaImportResult,
	type MediaImportProgress,
	type RewriteUrlsResult,
	type AttachmentInfo,
	type ProbeResult,
	type AuthorMapping,
	type UserListItem,
} from "../lib/api";
import { cn } from "../lib/utils";

// ============================================================================
// Constants
// ============================================================================

const TRAILING_SLASH_REGEX = /\/$/;
const WHITESPACE_REGEX = /\s/g;

// ============================================================================
// Types
// ============================================================================

type ImportStep =
	| "choose" // New: choose how to import (URL or file)
	| "probing" // New: probing URL
	| "probe-result" // New: showing probe results
	| "plugin-auth" // Authenticating with WordPress plugin
	| "analyzing-plugin" // Analyzing WordPress plugin site
	| "upload"
	| "review"
	| "authors" // Author mapping step
	| "preparing"
	| "importing"
	| "media"
	| "importing-media"
	| "rewriting"
	| "complete";

/** Import source - either WXR file or Plugin API */
type ImportSource =
	| { type: "wxr"; file: File }
	| { type: "wordpress-plugin"; url: string; token: string };

interface PostTypeSelection {
	enabled: boolean;
	collection: string;
}

/** Union type for analysis results */
type ImportAnalysis = WxrAnalysis | WpPluginAnalysis;

export function WordPressImport() {
	const [step, setStep] = React.useState<ImportStep>("choose");
	const [urlInput, setUrlInput] = React.useState("");
	const [probeResult, setProbeResult] = React.useState<ProbeResult | null>(null);
	const [importSource, setImportSource] = React.useState<ImportSource | null>(null);
	const [_file, setFile] = React.useState<File | null>(null);
	const [analysis, setAnalysis] = React.useState<ImportAnalysis | null>(null);
	// Plugin auth state
	const [pluginUsername, setPluginUsername] = React.useState("");
	const [pluginPassword, setPluginPassword] = React.useState("");
	const [selections, setSelections] = React.useState<Record<string, PostTypeSelection>>({});
	const [prepareResult, setPrepareResult] = React.useState<PrepareResult | null>(null);
	const [result, setResult] = React.useState<ImportResult | null>(null);
	const [expandedTypes, setExpandedTypes] = React.useState<Set<string>>(new Set());
	const [prepareError, setPrepareError] = React.useState<string | null>(null);
	const [importError, setImportError] = React.useState<string | null>(null);
	const [mediaResult, setMediaResult] = React.useState<MediaImportResult | null>(null);
	const [rewriteResult, setRewriteResult] = React.useState<RewriteUrlsResult | null>(null);
	const [mediaError, setMediaError] = React.useState<string | null>(null);
	const [skipMedia, setSkipMedia] = React.useState(false);
	const [mediaProgress, setMediaProgress] = React.useState<MediaImportProgress | null>(null);

	// New state for import options
	const [importMenus, setImportMenus] = React.useState(true);
	const [importSiteTitle, setImportSiteTitle] = React.useState(true);
	const [importLogo, setImportLogo] = React.useState(true);
	const [importSeo, setImportSeo] = React.useState(false);

	// Author mapping state
	const [authorMappings, setAuthorMappings] = React.useState<AuthorMapping[]>([]);
	const [emdashUsers, setEmDashUsers] = React.useState<UserListItem[]>([]);

	// Initialize author mappings from analysis, auto-matching by email
	const initializeAuthorMappings = React.useCallback(
		(importAnalysis: ImportAnalysis, users: UserListItem[]) => {
			const mappings: AuthorMapping[] = importAnalysis.authors.map((author) => {
				// Try to match by email (case-insensitive)
				const matchedUser = author.email
					? users.find((u) => u.email.toLowerCase() === author.email?.toLowerCase())
					: undefined;

				return {
					wpLogin: author.login || author.displayName || "unknown",
					wpDisplayName: author.displayName || author.login || "Unknown",
					wpEmail: author.email,
					emdashUserId: matchedUser?.id ?? null,
					postCount: author.postCount,
				};
			});
			setAuthorMappings(mappings);
		},
		[],
	);

	// Check for OAuth callback on mount
	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const authStatus = params.get("auth");
		const error = params.get("error");

		if (error === "auth_rejected") {
			setImportError("WordPress authorization was rejected");
			setStep("probe-result");
			// Clean up URL
			window.history.replaceState({}, "", window.location.pathname);
			return;
		}

		if (authStatus === "success") {
			// Get credentials from cookie
			const cookie = document.cookie.split("; ").find((row) => row.startsWith("emdash_wp_auth="));

			if (cookie) {
				try {
					const encoded = cookie.split("=")[1] ?? "";
					// URL decode first (cookie values may be URL-encoded), then base64 decode
					const urlDecoded = decodeURIComponent(encoded);
					const authData = JSON.parse(atob(urlDecoded));

					// Check timestamp (5 minute expiry)
					if (Date.now() - authData.timestamp < 5 * 60 * 1000) {
						// Set up import source and start analyzing
						setImportSource({
							type: "wordpress-plugin",
							url: authData.siteUrl,
							token: authData.token,
						});
						setUrlInput(authData.siteUrl);

						// Clear the cookie
						document.cookie = "emdash_wp_auth=; path=/_emdash/; max-age=0";

						// Start analyzing
						setStep("analyzing-plugin");
						wpPluginAnalyzeMutation.mutate({
							url: authData.siteUrl,
							token: authData.token,
						});
					}
				} catch (e) {
					console.error("Failed to parse auth cookie:", e);
				}
			}

			// Clean up URL
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Probe mutation
	const probeMutation = useMutation({
		mutationFn: probeImportUrl,
		onSuccess: (data) => {
			setProbeResult(data);
			setStep("probe-result");
		},
		onError: () => {
			// On error, show probe result step with no matches
			setProbeResult({
				url: urlInput,
				isWordPress: false,
				bestMatch: null,
				allMatches: [],
			});
			setStep("probe-result");
		},
	});

	// Analyze mutation
	const analyzeMutation = useMutation({
		mutationFn: analyzeWxr,
		onSuccess: async (data) => {
			setAnalysis(data);
			// Initialize selections from analysis
			const initialSelections: Record<string, PostTypeSelection> = {};
			for (const pt of data.postTypes) {
				initialSelections[pt.name] = {
					enabled: pt.schemaStatus.canImport,
					collection: pt.suggestedCollection,
				};
			}
			setSelections(initialSelections);
			// Initialize menu import state based on analysis
			if ("navMenus" in data && data.navMenus && data.navMenus.length > 0) {
				setImportMenus(true);
			}
			// Fetch EmDash users for author mapping
			try {
				const usersResult = await fetchUsers({ limit: 100 });
				setEmDashUsers(usersResult.items);
				initializeAuthorMappings(data, usersResult.items);
			} catch {
				// If user fetch fails, continue without auto-matching
				initializeAuthorMappings(data, []);
			}
			setStep("review");
		},
	});

	// Prepare mutation (create collections/fields)
	const prepareMutation = useMutation({
		mutationFn: prepareWxrImport,
		onSuccess: (data) => {
			setPrepareError(null);
			setPrepareResult(data);
			if (data.success) {
				executeImport();
			} else {
				setStep("review");
			}
		},
		onError: (error) => {
			setPrepareError(error instanceof Error ? error.message : "Failed to prepare import");
			setStep("review");
		},
	});

	// Import mutation
	const importMutation = useMutation({
		mutationFn: ({ file, config }: { file: File; config: ImportConfig }) =>
			executeWxrImport(file, config),
		onSuccess: (data) => {
			setImportError(null);
			setResult(data);
			if (analysis && analysis.attachments.count > 0) {
				setStep("media");
			} else {
				setStep("complete");
			}
		},
		onError: (error) => {
			setImportError(error instanceof Error ? error.message : "Failed to execute import");
			setStep("review");
		},
	});

	// Media import mutation
	const mediaMutation = useMutation({
		mutationFn: (attachments: AttachmentInfo[]) =>
			importWxrMedia(attachments, (progress) => {
				setMediaProgress(progress);
			}),
		onSuccess: (data) => {
			setMediaError(null);
			setMediaProgress(null);
			setMediaResult(data);
			if (Object.keys(data.urlMap).length > 0) {
				setStep("rewriting");
				rewriteMutation.mutate(data.urlMap);
			} else {
				setStep("complete");
			}
		},
		onError: (error) => {
			setMediaProgress(null);
			setMediaError(error instanceof Error ? error.message : "Failed to import media");
			setStep("media");
		},
	});

	// URL rewrite mutation
	const rewriteMutation = useMutation({
		mutationFn: (urlMap: Record<string, string>) => rewriteContentUrls(urlMap),
		onSuccess: (data) => {
			setRewriteResult(data);
			setStep("complete");
		},
		onError: (error) => {
			setMediaError(error instanceof Error ? error.message : "Failed to rewrite URLs");
			setStep("complete");
		},
	});

	// WordPress Plugin analyze mutation
	const wpPluginAnalyzeMutation = useMutation({
		mutationFn: ({ url, token }: { url: string; token: string }) => analyzeWpPluginSite(url, token),
		onSuccess: async (data) => {
			setAnalysis(data);
			// Initialize selections from analysis
			const initialSelections: Record<string, PostTypeSelection> = {};
			for (const pt of data.postTypes) {
				initialSelections[pt.name] = {
					enabled: pt.schemaStatus.canImport,
					collection: pt.suggestedCollection,
				};
			}
			setSelections(initialSelections);
			// Initialize menu import state based on analysis
			if ("navMenus" in data && data.navMenus && data.navMenus.length > 0) {
				setImportMenus(true);
			}
			// Fetch EmDash users for author mapping
			try {
				const usersResult = await fetchUsers({ limit: 100 });
				setEmDashUsers(usersResult.items);
				initializeAuthorMappings(data, usersResult.items);
			} catch {
				// If user fetch fails, continue without auto-matching
				initializeAuthorMappings(data, []);
			}
			setStep("review");
		},
		onError: (error) => {
			setImportError(error instanceof Error ? error.message : "Failed to analyze WordPress site");
			setStep("plugin-auth");
		},
	});

	// WordPress Plugin import mutation
	const wpPluginImportMutation = useMutation({
		mutationFn: ({ url, token, config }: { url: string; token: string; config: ImportConfig }) =>
			executeWpPluginImport(url, token, config),
		onSuccess: (data) => {
			setImportError(null);
			setResult(data);
			if (analysis && analysis.attachments.count > 0) {
				setStep("media");
			} else {
				setStep("complete");
			}
		},
		onError: (error) => {
			setImportError(error instanceof Error ? error.message : "Failed to import from WordPress");
			setStep("review");
		},
	});

	const handleProbeUrl = (e: React.FormEvent) => {
		e.preventDefault();
		if (!urlInput.trim()) return;
		setStep("probing");
		probeMutation.mutate(urlInput.trim());
	};

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFile = e.target.files?.[0];
		if (selectedFile) {
			setFile(selectedFile);
			setImportSource({ type: "wxr", file: selectedFile });
			setStep("upload");
			analyzeMutation.mutate(selectedFile);
		}
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		const droppedFile = e.dataTransfer.files[0];
		if (droppedFile && droppedFile.name.endsWith(".xml")) {
			setFile(droppedFile);
			setImportSource({ type: "wxr", file: droppedFile });
			setStep("upload");
			analyzeMutation.mutate(droppedFile);
		}
	};

	const handlePluginConnect = () => {
		if (!probeResult?.url) return;

		// Check if we're on localhost - OAuth won't work, fall back to manual
		if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
			setImportError("OAuth authorization requires HTTPS. Please use manual credentials.");
			setStep("plugin-auth");
			return;
		}

		// Build the WordPress Application Password authorization URL
		const wpUrl = probeResult.url.replace(TRAILING_SLASH_REGEX, "");
		const callbackUrl = `${window.location.origin}/_emdash/api/import/wordpress-plugin/callback`;

		// WordPress requires a valid UUID for app_id
		const appId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

		const authUrl = new URL(`${wpUrl}/wp-admin/authorize-application.php`);
		authUrl.searchParams.set("app_name", "EmDash CMS");
		authUrl.searchParams.set("app_id", appId);
		authUrl.searchParams.set("success_url", callbackUrl);

		// Redirect to WordPress for authorization
		window.location.href = authUrl.toString();
	};

	const handlePluginManualAuth = () => {
		// Fallback to manual password entry
		setStep("plugin-auth");
	};

	const handlePluginAuth = (e: React.FormEvent) => {
		e.preventDefault();
		if (!pluginUsername.trim() || !pluginPassword.trim()) return;

		// Create Basic Auth token
		const cleanPassword = pluginPassword.replace(WHITESPACE_REGEX, "");
		const token = btoa(`${pluginUsername}:${cleanPassword}`);

		const probeUrl = probeResult?.url;
		if (!probeUrl) return;
		setImportSource({ type: "wordpress-plugin", url: probeUrl, token });
		setStep("analyzing-plugin");
		wpPluginAnalyzeMutation.mutate({ url: probeUrl, token });
	};

	const executeImport = () => {
		if (!analysis || !importSource) return;
		setStep("importing");

		// Build author mappings record (wpLogin -> emdashUserId)
		const authorMappingsRecord: Record<string, string | null> = {};
		for (const mapping of authorMappings) {
			authorMappingsRecord[mapping.wpLogin] = mapping.emdashUserId;
		}

		// Build extended config with new options
		const config: ImportConfig = {
			postTypeMappings: selections,
			skipExisting: true,
			authorMappings: authorMappingsRecord,
		};

		if (importSource.type === "wxr") {
			importMutation.mutate({
				file: importSource.file,
				config,
			});
		} else if (importSource.type === "wordpress-plugin") {
			wpPluginImportMutation.mutate({
				url: importSource.url,
				token: importSource.token,
				config,
			});
		}
	};

	const handleStartImport = () => {
		if (!analysis || !importSource) return;

		setPrepareError(null);
		setImportError(null);
		setPrepareResult(null);

		// If there are authors to map, show the author mapping step
		if (analysis.authors.length > 0) {
			setStep("authors");
			return;
		}

		// Otherwise, proceed directly to import
		proceedToImport();
	};

	const proceedToImport = () => {
		if (!analysis || !importSource) return;

		const needsSchemaChanges = analysis.postTypes.filter((pt) => {
			const selection = selections[pt.name];
			if (!selection?.enabled) return false;
			return (
				!pt.schemaStatus.exists ||
				Object.values(pt.schemaStatus.fieldStatus).some((f) => f.status === "missing")
			);
		});

		if (needsSchemaChanges.length > 0) {
			setStep("preparing");
			prepareMutation.mutate({
				postTypes: needsSchemaChanges.map((pt) => ({
					name: pt.name,
					collection: selections[pt.name]?.collection ?? pt.suggestedCollection,
					fields: pt.requiredFields,
				})),
			});
		} else {
			executeImport();
		}
	};

	const handleReset = () => {
		setStep("choose");
		setUrlInput("");
		setProbeResult(null);
		setImportSource(null);
		setFile(null);
		setAnalysis(null);
		setSelections({});
		setPrepareResult(null);
		setPrepareError(null);
		setImportError(null);
		setResult(null);
		setExpandedTypes(new Set());
		setMediaResult(null);
		setRewriteResult(null);
		setMediaError(null);
		setSkipMedia(false);
		setMediaProgress(null);
		setPluginUsername("");
		setPluginPassword("");
		// Reset new state
		setImportMenus(true);
		setImportSiteTitle(true);
		setImportLogo(true);
		setImportSeo(false);
		// Reset author mappings
		setAuthorMappings([]);
		setEmDashUsers([]);
	};

	const handleStartMediaImport = () => {
		if (!analysis) return;
		setMediaError(null);
		setMediaProgress(null);
		setStep("importing-media");
		mediaMutation.mutate(analysis.attachments.items);
	};

	const handleSkipMedia = () => {
		setSkipMedia(true);
		setStep("complete");
	};

	const handleProceedWithUpload = () => {
		setStep("upload");
	};

	const toggleExpanded = (name: string) => {
		setExpandedTypes((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	// Calculate summary stats
	const selectedCount = Object.values(selections).filter((s) => s.enabled).length;
	const hasIncompatible = analysis?.postTypes.some((pt) => !pt.schemaStatus.canImport) ?? false;
	const needsNewCollections =
		analysis?.postTypes.filter((pt) => selections[pt.name]?.enabled && !pt.schemaStatus.exists)
			.length ?? 0;
	const needsNewFields =
		analysis?.postTypes.filter((pt) => {
			if (!selections[pt.name]?.enabled) return false;
			if (!pt.schemaStatus.exists) return false;
			return Object.values(pt.schemaStatus.fieldStatus).some((f) => f.status === "missing");
		}).length ?? 0;

	// Check if we're using the plugin source
	const isPluginSource = importSource?.type === "wordpress-plugin";

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold">Import from WordPress</h1>
				<p className="text-kumo-subtle mt-1">
					Import posts, pages, and custom post types from WordPress.
				</p>
			</div>

			{/* Step indicator */}
			<div className="flex items-center gap-2 text-sm flex-wrap">
				<StepIndicator
					number={1}
					label="Connect"
					active={
						step === "choose" ||
						step === "probing" ||
						step === "probe-result" ||
						step === "plugin-auth" ||
						step === "analyzing-plugin" ||
						step === "upload"
					}
					complete={
						step === "review" ||
						step === "authors" ||
						step === "preparing" ||
						step === "importing" ||
						step === "media" ||
						step === "importing-media" ||
						step === "rewriting" ||
						step === "complete"
					}
				/>
				<div className="h-px w-8 bg-kumo-line" />
				<StepIndicator
					number={2}
					label="Review"
					active={step === "review" || step === "authors"}
					complete={
						step === "preparing" ||
						step === "importing" ||
						step === "media" ||
						step === "importing-media" ||
						step === "rewriting" ||
						step === "complete"
					}
				/>
				<div className="h-px w-8 bg-kumo-line" />
				<StepIndicator
					number={3}
					label="Import"
					active={step === "preparing" || step === "importing"}
					complete={
						step === "media" ||
						step === "importing-media" ||
						step === "rewriting" ||
						step === "complete"
					}
				/>
				{analysis && analysis.attachments.count > 0 && (
					<>
						<div className="h-px w-8 bg-kumo-line" />
						<StepIndicator
							number={4}
							label="Media"
							active={step === "media" || step === "importing-media" || step === "rewriting"}
							complete={step === "complete"}
						/>
					</>
				)}
			</div>

			{/* Choose step - URL input or file upload */}
			{step === "choose" && (
				<ChooseStep
					urlInput={urlInput}
					onUrlChange={setUrlInput}
					onProbeUrl={handleProbeUrl}
					onFileSelect={handleFileSelect}
					onDrop={handleDrop}
				/>
			)}

			{/* Probing step */}
			{step === "probing" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Checking {urlInput}...</p>
				</div>
			)}

			{/* Probe result step */}
			{step === "probe-result" && probeResult && (
				<ProbeResultStep
					result={probeResult}
					onUploadFile={handleProceedWithUpload}
					onPluginConnect={handlePluginConnect}
					onPluginManualAuth={handlePluginManualAuth}
					onReset={handleReset}
				/>
			)}

			{/* Plugin auth step */}
			{step === "plugin-auth" && probeResult && (
				<PluginAuthStep
					siteTitle={probeResult.bestMatch?.detected.siteTitle}
					siteUrl={probeResult.url}
					username={pluginUsername}
					password={pluginPassword}
					onUsernameChange={setPluginUsername}
					onPasswordChange={setPluginPassword}
					onSubmit={handlePluginAuth}
					onBack={() => setStep("probe-result")}
					error={importError}
				/>
			)}

			{/* Analyzing WordPress Plugin step */}
			{step === "analyzing-plugin" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Analyzing WordPress site...</p>
					<p className="text-sm text-kumo-subtle">Fetching content from the EmDash Exporter API.</p>
				</div>
			)}

			{/* Upload step (analyzing file) */}
			{step === "upload" && (
				<UploadStep
					isLoading={analyzeMutation.isPending}
					error={analyzeMutation.error}
					onFileSelect={handleFileSelect}
					onDrop={handleDrop}
					onRetry={() => analyzeMutation.reset()}
					onBack={() => setStep("choose")}
				/>
			)}

			{/* Review step */}
			{step === "review" && analysis && (
				<ReviewStep
					analysis={analysis}
					selections={selections}
					expandedTypes={expandedTypes}
					prepareError={prepareError}
					importError={importError}
					prepareResult={prepareResult}
					selectedCount={selectedCount}
					hasIncompatible={hasIncompatible}
					needsNewCollections={needsNewCollections}
					needsNewFields={needsNewFields}
					onToggleExpand={toggleExpanded}
					onToggleEnabled={(name, enabled) =>
						setSelections((prev) => {
							const existing = prev[name];
							return {
								...prev,
								[name]: {
									enabled,
									collection: existing?.collection ?? name,
								},
							};
						})
					}
					onStartImport={handleStartImport}
					onReset={handleReset}
					// New props for menus and settings
					importMenus={importMenus}
					onImportMenusChange={setImportMenus}
					isPluginSource={isPluginSource}
					importSiteTitle={importSiteTitle}
					importLogo={importLogo}
					importSeo={importSeo}
					onImportSiteTitleChange={setImportSiteTitle}
					onImportLogoChange={setImportLogo}
					onImportSeoChange={setImportSeo}
				/>
			)}

			{/* Author mapping step */}
			{step === "authors" && analysis && (
				<AuthorMappingStep
					authorMappings={authorMappings}
					emdashUsers={emdashUsers}
					onMappingChange={(wpLogin, emdashUserId) => {
						setAuthorMappings((prev) =>
							prev.map((m) => (m.wpLogin === wpLogin ? { ...m, emdashUserId } : m)),
						);
					}}
					onContinue={proceedToImport}
					onBack={() => setStep("review")}
				/>
			)}

			{/* Preparing step */}
			{step === "preparing" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Creating collections and fields...</p>
				</div>
			)}

			{/* Importing step */}
			{step === "importing" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Importing content...</p>
					<p className="text-sm text-kumo-subtle">This may take a while for large exports.</p>
				</div>
			)}

			{/* Media step */}
			{step === "media" && analysis && (
				<MediaStep
					attachments={analysis.attachments}
					error={mediaError}
					onImport={handleStartMediaImport}
					onSkip={handleSkipMedia}
				/>
			)}

			{/* Importing media step */}
			{step === "importing-media" && (
				<MediaProgressStep progress={mediaProgress} total={analysis?.attachments.count ?? 0} />
			)}

			{/* Rewriting URLs step */}
			{step === "rewriting" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">Updating content URLs...</p>
				</div>
			)}

			{/* Complete step */}
			{step === "complete" && result && (
				<CompleteStep
					result={result}
					prepareResult={prepareResult}
					mediaResult={mediaResult}
					rewriteResult={rewriteResult}
					skippedMedia={skipMedia}
					onReset={handleReset}
				/>
			)}
		</div>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

function StepIndicator({
	number,
	label,
	active,
	complete,
}: {
	number: number;
	label: string;
	active: boolean;
	complete: boolean;
}) {
	return (
		<div className="flex items-center gap-2">
			<div
				className={cn(
					"w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium",
					complete
						? "bg-kumo-brand text-white"
						: active
							? "bg-kumo-brand text-white"
							: "bg-kumo-tint text-kumo-subtle",
				)}
			>
				{complete ? <Check className="h-3 w-3" /> : number}
			</div>
			<span
				className={cn("text-sm", active || complete ? "text-kumo-default" : "text-kumo-subtle")}
			>
				{label}
			</span>
		</div>
	);
}

function ChooseStep({
	urlInput,
	onUrlChange,
	onProbeUrl,
	onFileSelect,
	onDrop,
}: {
	urlInput: string;
	onUrlChange: (url: string) => void;
	onProbeUrl: (e: React.FormEvent) => void;
	onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onDrop: (e: React.DragEvent) => void;
}) {
	return (
		<div className="space-y-6">
			{/* URL input - primary path */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-start gap-4">
					<div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
						<Globe className="h-6 w-6 text-blue-600 dark:text-blue-400" />
					</div>
					<div className="flex-1">
						<h3 className="text-lg font-medium">Enter your WordPress site URL</h3>
						<p className="text-kumo-subtle mt-1">
							We'll check what import options are available for your site.
						</p>
						<form onSubmit={onProbeUrl} className="mt-4 flex gap-2">
							<Input
								type="text"
								placeholder="https://yoursite.com"
								value={urlInput}
								onChange={(e) => onUrlChange(e.target.value)}
								className="flex-1"
							/>
							<Button type="submit" disabled={!urlInput.trim()}>
								Check Site
							</Button>
						</form>
					</div>
				</div>
			</div>

			<div className="relative">
				<div className="absolute inset-0 flex items-center">
					<div className="w-full border-t" />
				</div>
				<div className="relative flex justify-center text-xs uppercase">
					<span className="bg-kumo-base px-2 text-kumo-subtle">or upload directly</span>
				</div>
			</div>

			{/* File upload - fallback */}
			<div
				className="border-2 border-dashed rounded-lg p-8 text-center transition-colors hover:border-kumo-brand/50 cursor-pointer"
				onDragOver={(e) => e.preventDefault()}
				onDrop={onDrop}
			>
				<Upload className="mx-auto h-10 w-10 text-kumo-subtle" />
				<h3 className="mt-3 text-sm font-medium">Upload WordPress export file</h3>
				<p className="mt-1 text-sm text-kumo-subtle">Drag and drop or click to browse (.xml)</p>
				<label className="mt-3 inline-block">
					<input type="file" accept=".xml" className="sr-only" onChange={onFileSelect} />
					<span className={buttonVariants({ variant: "outline", size: "sm" })}>Browse Files</span>
				</label>
			</div>
		</div>
	);
}

// =============================================================================
// Feature Comparison Component
// =============================================================================

interface FeatureComparisonItem {
	feature: string;
	wxr: "full" | "partial" | "none";
	wxrNote?: string;
	plugin: "full" | "partial" | "none";
	pluginNote?: string;
}

const FEATURE_COMPARISON: FeatureComparisonItem[] = [
	{ feature: "Posts & Pages", wxr: "full", plugin: "full" },
	{ feature: "Media", wxr: "full", plugin: "full" },
	{ feature: "Categories & Tags", wxr: "full", plugin: "full" },
	{ feature: "Custom Taxonomies", wxr: "full", plugin: "full" },
	{ feature: "Featured Images", wxr: "full", plugin: "full" },
	{ feature: "Menus", wxr: "full", plugin: "full" },
	{
		feature: "Site Settings",
		wxr: "partial",
		wxrNote: "Partial",
		plugin: "full",
		pluginNote: "Full",
	},
	{ feature: "Widgets", wxr: "none", plugin: "full" },
	{ feature: "ACF Fields", wxr: "none", plugin: "full" },
	{
		feature: "Yoast/RankMath",
		wxr: "partial",
		wxrNote: "Raw meta",
		plugin: "full",
		pluginNote: "Structured",
	},
	{ feature: "Drafts & Private", wxr: "full", plugin: "full" },
];

function FeatureComparison() {
	return (
		<div className="rounded-lg border bg-kumo-base overflow-hidden">
			<div className="border-b p-4 bg-kumo-tint/30">
				<h3 className="font-medium text-sm">Import Capabilities</h3>
			</div>
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b bg-kumo-tint/20">
							<th className="text-left p-3 font-medium">Feature</th>
							<th className="text-center p-3 font-medium whitespace-nowrap">WXR File</th>
							<th className="text-center p-3 font-medium whitespace-nowrap">Plugin</th>
						</tr>
					</thead>
					<tbody>
						{FEATURE_COMPARISON.map((item) => (
							<tr key={item.feature} className="border-b last:border-0">
								<td className="p-3 text-kumo-subtle">{item.feature}</td>
								<td className="p-3 text-center">
									<FeatureStatus status={item.wxr} note={item.wxrNote} />
								</td>
								<td className="p-3 text-center">
									<FeatureStatus status={item.plugin} note={item.pluginNote} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="border-t p-3 bg-blue-50 dark:bg-blue-900/20">
				<div className="flex items-start gap-2 text-sm">
					<Sparkle className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
					<p className="text-blue-800 dark:text-blue-200">
						For the best import experience, install the{" "}
						<span className="font-medium">EmDash Exporter</span> plugin on your WordPress site.
					</p>
				</div>
			</div>
		</div>
	);
}

function FeatureStatus({ status, note }: { status: "full" | "partial" | "none"; note?: string }) {
	if (status === "full") {
		return (
			<span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
				<Check className="h-4 w-4" />
			</span>
		);
	}
	if (status === "partial") {
		return (
			<span className="inline-flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
				<Warning className="h-3.5 w-3.5" />
				{note && <span className="text-xs">{note}</span>}
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-kumo-subtle">
			<X className="h-4 w-4" />
		</span>
	);
}

function ProbeResultStep({
	result,
	onUploadFile,
	onPluginConnect,
	onPluginManualAuth,
	onReset,
}: {
	result: ProbeResult;
	onUploadFile: () => void;
	onPluginConnect: () => void;
	onPluginManualAuth: () => void;
	onReset: () => void;
}) {
	const bestMatch = result.bestMatch;
	const hasPlugin = bestMatch?.sourceId === "wordpress-plugin";

	if (!result.isWordPress) {
		return (
			<div className="space-y-6">
				<div className="rounded-lg border-l-4 border-l-orange-500 border border-kumo-line bg-kumo-base p-6">
					<div className="flex items-start gap-4">
						<Warning className="h-6 w-6 text-orange-500 flex-shrink-0" />
						<div>
							<h3 className="font-medium">Couldn't detect WordPress</h3>
							<p className="mt-1 text-sm text-kumo-subtle">
								We couldn't connect to a WordPress site at {result.url}. This could mean the site
								isn't WordPress, the REST API is disabled, or the site isn't accessible.
							</p>
						</div>
					</div>
				</div>

				<div className="rounded-lg border bg-kumo-base p-6">
					<h3 className="font-medium">Export from WordPress manually</h3>
					<ol className="mt-3 space-y-2 text-sm text-kumo-subtle">
						<li>1. Log into your WordPress admin dashboard</li>
						<li>
							2. Go to <strong>Tools → Export</strong>
						</li>
						<li>3. Select "All content"</li>
						<li>4. Click "Download Export File"</li>
						<li>5. Upload the file here</li>
					</ol>
					<div className="mt-4 flex gap-2">
						<Button onClick={onUploadFile}>Upload Export File</Button>
						<Button variant="outline" onClick={onReset}>
							Try Another URL
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// WordPress detected
	return (
		<div className="space-y-6">
			{/* Detection success */}
			<div className="rounded-lg border-l-4 border-l-green-500 border border-kumo-line bg-kumo-base p-6">
				<div className="flex items-start gap-4">
					<Check className="h-6 w-6 text-green-500 flex-shrink-0" />
					<div>
						<h3 className="font-medium">
							{bestMatch?.detected.siteTitle || "WordPress site"} detected
						</h3>
						<p className="mt-1 text-sm text-kumo-subtle">
							{hasPlugin
								? "EmDash Exporter plugin detected! You can import directly."
								: "This is a WordPress site."}
						</p>
					</div>
				</div>
			</div>

			{/* Preview counts if available */}
			{bestMatch?.preview && (
				<div className="rounded-lg border bg-kumo-base p-4">
					<h4 className="text-sm font-medium mb-3">Content found:</h4>
					<div className="grid grid-cols-3 gap-4 text-center">
						{bestMatch.preview.posts !== undefined && (
							<div>
								<p className="text-2xl font-bold">{bestMatch.preview.posts}</p>
								<p className="text-xs text-kumo-subtle">Posts</p>
							</div>
						)}
						{bestMatch.preview.pages !== undefined && (
							<div>
								<p className="text-2xl font-bold">{bestMatch.preview.pages}</p>
								<p className="text-xs text-kumo-subtle">Pages</p>
							</div>
						)}
						{bestMatch.preview.media !== undefined && (
							<div>
								<p className="text-2xl font-bold">{bestMatch.preview.media}</p>
								<p className="text-xs text-kumo-subtle">Media</p>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Feature comparison - only show when plugin is NOT detected (to explain the benefits) */}
			{!hasPlugin && <FeatureComparison />}

			{/* EmDash Exporter plugin detected - primary option */}
			{hasPlugin && (
				<div className="rounded-lg border-l-4 border-l-green-500 border border-kumo-line bg-kumo-base p-6">
					<div className="flex items-start gap-4">
						<div className="p-2 rounded-full bg-green-100 dark:bg-green-900/50">
							<svg
								viewBox="0 0 24 24"
								className="h-5 w-5 text-green-600 dark:text-green-400"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								aria-hidden="true"
								focusable="false"
							>
								<path d="M12 2L2 7l10 5 10-5-10-5z" />
								<path d="M2 17l10 5 10-5" />
								<path d="M2 12l10 5 10-5" />
							</svg>
						</div>
						<div className="flex-1">
							<h3 className="font-medium">Import via EmDash Exporter</h3>
							<p className="mt-1 text-sm text-kumo-subtle">
								Import all content directly including drafts, custom post types, ACF fields, and SEO
								data. No file download needed.
							</p>
							<p className="mt-2 text-xs text-kumo-subtle">
								You'll be redirected to WordPress to authorize the connection.
							</p>
							<div className="mt-3 flex items-center gap-3">
								<Button icon={<ArrowSquareOut />} onClick={onPluginConnect}>
									Connect with WordPress
								</Button>
								<button
									type="button"
									className="text-xs text-kumo-subtle hover:text-kumo-default underline"
									onClick={onPluginManualAuth}
								>
									Enter credentials manually
								</button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* File upload fallback */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<h3 className="font-medium">
					{hasPlugin ? "Or upload an export file" : "Upload an export file"}
				</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{hasPlugin
						? "Alternatively, you can export from WordPress (Tools → Export) and upload the file."
						: bestMatch?.capabilities.privateContent
							? "Export your content from WordPress to import everything including drafts."
							: "For a complete import including drafts and all content, export from WordPress."}
				</p>
				{bestMatch?.suggestedAction.type === "upload" && (
					<p className="mt-2 text-sm text-kumo-subtle">{bestMatch.suggestedAction.instructions}</p>
				)}
				<div className="mt-4 flex gap-2">
					<Button variant={hasPlugin ? "outline" : "primary"} onClick={onUploadFile}>
						Upload Export File
					</Button>
					<Button variant="outline" onClick={onReset}>
						Try Another URL
					</Button>
				</div>
			</div>
		</div>
	);
}

function PluginAuthStep({
	siteTitle,
	siteUrl,
	username,
	password,
	onUsernameChange,
	onPasswordChange,
	onSubmit,
	onBack,
	error,
}: {
	siteTitle?: string;
	siteUrl: string;
	username: string;
	password: string;
	onUsernameChange: (value: string) => void;
	onPasswordChange: (value: string) => void;
	onSubmit: (e: React.FormEvent) => void;
	onBack: () => void;
	error: string | null;
}) {
	return (
		<div className="space-y-6">
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-start gap-4">
					<div className="p-3 rounded-full bg-green-100 dark:bg-green-900/30">
						<svg
							viewBox="0 0 24 24"
							className="h-6 w-6 text-green-600 dark:text-green-400"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							aria-hidden="true"
							focusable="false"
						>
							<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
							<path d="M7 11V7a5 5 0 0 1 10 0v4" />
						</svg>
					</div>
					<div className="flex-1">
						<h3 className="text-lg font-medium">Connect to {siteTitle || "WordPress"}</h3>
						<p className="text-kumo-subtle mt-1">
							Enter your WordPress credentials to import content directly.
						</p>
					</div>
				</div>

				{error && (
					<div className="mt-4 p-3 rounded-lg border border-kumo-danger/50 bg-kumo-danger/10">
						<div className="flex gap-2">
							<WarningCircle className="h-4 w-4 text-kumo-danger flex-shrink-0 mt-0.5" />
							<p className="text-sm text-kumo-danger">{error}</p>
						</div>
					</div>
				)}

				<form onSubmit={onSubmit} className="mt-6 space-y-4">
					<div>
						<label htmlFor="wp-username" className="block text-sm font-medium mb-1">
							WordPress Username
						</label>
						<Input
							id="wp-username"
							type="text"
							value={username}
							onChange={(e) => onUsernameChange(e.target.value)}
							placeholder="admin"
							autoComplete="username"
						/>
					</div>

					<div>
						<label htmlFor="wp-password" className="block text-sm font-medium mb-1">
							Application Password
						</label>
						<Input
							id="wp-password"
							type="password"
							value={password}
							onChange={(e) => onPasswordChange(e.target.value)}
							placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
							autoComplete="current-password"
						/>
						<p className="mt-1 text-xs text-kumo-subtle">
							Create one in WordPress: Users → Profile → Application Passwords
						</p>
					</div>

					<div className="flex gap-2 pt-2">
						<Button type="submit" disabled={!username.trim() || !password.trim()}>
							Connect & Analyze
						</Button>
						<Button type="button" variant="outline" onClick={onBack}>
							Back
						</Button>
					</div>
				</form>
			</div>

			<div className="rounded-lg border-l-4 border-l-blue-500 border border-kumo-line bg-kumo-base p-4">
				<div className="flex gap-3">
					<ArrowSquareOut className="h-5 w-5 text-blue-500 flex-shrink-0" />
					<div className="text-sm">
						<p className="font-medium">How to create an Application Password</p>
						<ol className="mt-2 space-y-1 text-kumo-subtle">
							<li>1. Log into your WordPress admin</li>
							<li>2. Go to Users → Profile</li>
							<li>3. Scroll to "Application Passwords"</li>
							<li>4. Enter "EmDash" and click "Add New"</li>
							<li>5. Copy the generated password</li>
						</ol>
						<a
							href={`${siteUrl}/wp-admin/profile.php#application-passwords-section`}
							target="_blank"
							rel="noopener noreferrer"
							className="mt-2 inline-flex items-center gap-1 text-blue-600 hover:underline"
						>
							Open WordPress Profile
							<ArrowSquareOut className="h-3 w-3" />
						</a>
					</div>
				</div>
			</div>
		</div>
	);
}

function UploadStep({
	isLoading,
	error,
	onFileSelect,
	onDrop,
	onRetry,
	onBack,
}: {
	isLoading: boolean;
	error: Error | null;
	onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onDrop: (e: React.DragEvent) => void;
	onRetry: () => void;
	onBack?: () => void;
}) {
	return (
		<div className="space-y-4">
			<div
				className={cn(
					"border-2 border-dashed rounded-lg p-12 text-center transition-colors",
					isLoading
						? "border-kumo-brand bg-kumo-brand/5"
						: "border-kumo-line hover:border-kumo-brand/50",
				)}
				onDragOver={(e) => e.preventDefault()}
				onDrop={onDrop}
			>
				{isLoading ? (
					<div className="space-y-4">
						<Loader />
						<p className="text-kumo-subtle">Analyzing export file...</p>
					</div>
				) : error ? (
					<div className="space-y-4">
						<Warning className="mx-auto h-12 w-12 text-kumo-danger" />
						<p className="text-kumo-danger">{error.message}</p>
						<Button variant="outline" onClick={onRetry}>
							Try Again
						</Button>
					</div>
				) : (
					<>
						<Upload className="mx-auto h-12 w-12 text-kumo-subtle" />
						<h3 className="mt-4 text-lg font-medium">Drop your WordPress export file here</h3>
						<p className="mt-2 text-sm text-kumo-subtle">
							Or click to browse. Accepts .xml files exported from WordPress.
						</p>
						<label className="mt-4 inline-block">
							<input type="file" accept=".xml" className="sr-only" onChange={onFileSelect} />
							<span className={buttonVariants({ variant: "outline" })}>Browse Files</span>
						</label>
					</>
				)}
			</div>
			{onBack && !isLoading && !error && (
				<Button variant="ghost" onClick={onBack}>
					← Back
				</Button>
			)}
		</div>
	);
}

// =============================================================================
// Menu Info (Type-safe helper for navMenus)
// =============================================================================

interface NavMenuItem {
	name: string;
	slug: string;
	count: number;
}

function getNavMenus(analysis: ImportAnalysis): NavMenuItem[] | undefined {
	if ("navMenus" in analysis && Array.isArray(analysis.navMenus)) {
		return analysis.navMenus as NavMenuItem[];
	}
	return undefined;
}

// =============================================================================
// Review Step with Menus and Settings
// =============================================================================

function ReviewStep({
	analysis,
	selections,
	expandedTypes,
	prepareError,
	importError,
	prepareResult,
	selectedCount,
	hasIncompatible,
	needsNewCollections,
	needsNewFields,
	onToggleExpand,
	onToggleEnabled,
	onStartImport,
	onReset,
	// New props
	importMenus,
	onImportMenusChange,
	isPluginSource,
	importSiteTitle,
	importLogo,
	importSeo,
	onImportSiteTitleChange,
	onImportLogoChange,
	onImportSeoChange,
}: {
	analysis: ImportAnalysis;
	selections: Record<string, PostTypeSelection>;
	expandedTypes: Set<string>;
	prepareError: string | null;
	importError: string | null;
	prepareResult: PrepareResult | null;
	selectedCount: number;
	hasIncompatible: boolean;
	needsNewCollections: number;
	needsNewFields: number;
	onToggleExpand: (name: string) => void;
	onToggleEnabled: (name: string, enabled: boolean) => void;
	onStartImport: () => void;
	onReset: () => void;
	// New props
	importMenus: boolean;
	onImportMenusChange: (value: boolean) => void;
	isPluginSource: boolean;
	importSiteTitle: boolean;
	importLogo: boolean;
	importSeo: boolean;
	onImportSiteTitleChange: (value: boolean) => void;
	onImportLogoChange: (value: boolean) => void;
	onImportSeoChange: (value: boolean) => void;
}) {
	const navMenus = getNavMenus(analysis);
	const hasMenus = navMenus && navMenus.length > 0;

	return (
		<div className="space-y-6">
			{/* Site info */}
			<div className="rounded-lg border bg-kumo-base p-4">
				<h3 className="font-medium">{analysis.site.title}</h3>
				<p className="text-sm text-kumo-subtle">{analysis.site.url}</p>
			</div>

			{/* Errors */}
			{(prepareError || importError) && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
					<div className="flex gap-3">
						<WarningCircle className="h-5 w-5 text-kumo-danger flex-shrink-0" />
						<div>
							<p className="font-medium text-kumo-danger">
								{prepareError ? "Schema preparation failed" : "Import failed"}
							</p>
							<p className="mt-1 text-sm text-kumo-danger/90 font-mono">
								{prepareError || importError}
							</p>
						</div>
					</div>
				</div>
			)}

			{prepareResult && !prepareResult.success && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
					<div className="flex gap-3">
						<WarningCircle className="h-5 w-5 text-kumo-danger flex-shrink-0" />
						<div>
							<p className="font-medium text-kumo-danger">Failed to create some collections</p>
							<ul className="mt-2 text-sm space-y-1">
								{prepareResult.errors.map((err, i) => (
									<li key={i}>
										<strong>{err.collection}:</strong>{" "}
										<span className="font-mono">{err.error}</span>
									</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			)}

			{/* Post type list */}
			<div className="rounded-lg border bg-kumo-base">
				<div className="border-b p-4">
					<h3 className="font-medium">Content to Import</h3>
					<p className="text-sm text-kumo-subtle mt-1">Select which content types to import.</p>
				</div>
				<div className="divide-y">
					{analysis.postTypes.map((pt) => (
						<PostTypeRow
							key={pt.name}
							postType={pt}
							selection={selections[pt.name]}
							expanded={expandedTypes.has(pt.name)}
							onToggleExpand={() => onToggleExpand(pt.name)}
							onToggleEnabled={(enabled) => onToggleEnabled(pt.name, enabled)}
						/>
					))}
				</div>
			</div>

			{/* Structure section - Menus and Taxonomies */}
			{hasMenus && (
				<div className="rounded-lg border bg-kumo-base">
					<div className="border-b p-4">
						<h3 className="font-medium">Structure</h3>
						<p className="text-sm text-kumo-subtle mt-1">Additional data to import.</p>
					</div>
					<div className="divide-y">
						{/* Menus */}
						<div className="p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<input
										type="checkbox"
										checked={importMenus}
										onChange={(e) => onImportMenusChange(e.target.checked)}
										className="h-4 w-4 rounded border-gray-300"
										aria-label="Import navigation menus"
									/>
									<div className="flex items-center gap-2">
										<List className="h-4 w-4 text-kumo-subtle" />
										<div>
											<p className="font-medium">Menus ({navMenus.length})</p>
											<p className="text-sm text-kumo-subtle">
												{navMenus.map((m) => m.name).join(", ")}
											</p>
										</div>
									</div>
								</div>
							</div>
						</div>

						{/* Categories count */}
						{analysis.categories > 0 && (
							<div className="p-4">
								<div className="flex items-center gap-3">
									<input
										type="checkbox"
										checked={true}
										disabled
										className="h-4 w-4 rounded border-gray-300"
										aria-label="Categories will be imported"
									/>
									<div>
										<p className="font-medium">Categories ({analysis.categories})</p>
									</div>
								</div>
							</div>
						)}

						{/* Tags count */}
						{analysis.tags > 0 && (
							<div className="p-4">
								<div className="flex items-center gap-3">
									<input
										type="checkbox"
										checked={true}
										disabled
										className="h-4 w-4 rounded border-gray-300"
										aria-label="Tags will be imported"
									/>
									<div>
										<p className="font-medium">Tags ({analysis.tags})</p>
									</div>
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Site Settings section - Plugin only */}
			{isPluginSource && (
				<div className="rounded-lg border bg-kumo-base">
					<div className="border-b p-4">
						<div className="flex items-center gap-2">
							<Gear className="h-4 w-4 text-kumo-subtle" />
							<h3 className="font-medium">Settings</h3>
						</div>
						<p className="text-sm text-kumo-subtle mt-1">
							Import site configuration from WordPress.
						</p>
					</div>
					<div className="divide-y">
						{/* Site title & tagline */}
						<div className="p-4">
							<div className="flex items-center gap-3">
								<input
									type="checkbox"
									checked={importSiteTitle}
									onChange={(e) => onImportSiteTitleChange(e.target.checked)}
									className="h-4 w-4 rounded border-gray-300"
									aria-label="Import site title and tagline"
								/>
								<div>
									<p className="font-medium">Site title & tagline</p>
								</div>
							</div>
						</div>

						{/* Logo & favicon */}
						<div className="p-4">
							<div className="flex items-center gap-3">
								<input
									type="checkbox"
									checked={importLogo}
									onChange={(e) => onImportLogoChange(e.target.checked)}
									className="h-4 w-4 rounded border-gray-300"
									aria-label="Import logo and favicon"
								/>
								<div>
									<p className="font-medium">Logo & favicon</p>
								</div>
							</div>
						</div>

						{/* SEO settings */}
						<div className="p-4">
							<div className="flex items-center gap-3">
								<input
									type="checkbox"
									checked={importSeo}
									onChange={(e) => onImportSeoChange(e.target.checked)}
									className="h-4 w-4 rounded border-gray-300"
									aria-label="Import SEO settings"
								/>
								<div>
									<p className="font-medium">SEO settings (Yoast)</p>
									<p className="text-sm text-kumo-subtle">
										Meta titles, descriptions, and social images
									</p>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}

			{hasIncompatible && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
					<div className="flex gap-3">
						<WarningCircle className="h-5 w-5 text-kumo-danger flex-shrink-0" />
						<div>
							<p className="font-medium text-kumo-danger">Some content types cannot be imported</p>
							<p className="text-sm text-kumo-subtle mt-1">
								The existing collection has fields with incompatible types.
							</p>
						</div>
					</div>
				</div>
			)}

			{selectedCount > 0 && (
				<div className="rounded-lg border-l-4 border-l-blue-500 border border-kumo-line bg-kumo-base p-4">
					<div className="flex gap-3">
						<Database className="h-5 w-5 text-blue-500 flex-shrink-0" />
						<div className="space-y-2">
							<p className="font-medium">What will happen when you import</p>
							<ul className="text-sm text-kumo-subtle space-y-1">
								{needsNewCollections > 0 && (
									<li className="flex items-center gap-2">
										<Plus className="h-4 w-4" />
										{needsNewCollections} new collection
										{needsNewCollections > 1 ? "s" : ""} will be created
									</li>
								)}
								{needsNewFields > 0 && (
									<li className="flex items-center gap-2">
										<Plus className="h-4 w-4" />
										Fields will be added to {needsNewFields} existing collection
										{needsNewFields > 1 ? "s" : ""}
									</li>
								)}
								<li className="flex items-center gap-2">
									<FileText className="h-4 w-4" />
									{analysis.postTypes
										.filter((pt) => selections[pt.name]?.enabled)
										.reduce((sum, pt) => sum + pt.count, 0)}{" "}
									items will be imported
								</li>
								{hasMenus && importMenus && (
									<li className="flex items-center gap-2">
										<List className="h-4 w-4" />
										{navMenus.length} menu{navMenus.length > 1 ? "s" : ""} will be imported
									</li>
								)}
							</ul>
						</div>
					</div>
				</div>
			)}

			<div className="flex gap-3">
				<Button variant="outline" onClick={onReset}>
					Cancel
				</Button>
				<Button onClick={onStartImport} disabled={selectedCount === 0}>
					{needsNewCollections > 0 || needsNewFields > 0
						? "Create Schema & Import"
						: "Start Import"}
				</Button>
			</div>
		</div>
	);
}

function PostTypeRow({
	postType,
	selection,
	expanded,
	onToggleExpand,
	onToggleEnabled,
}: {
	postType: PostTypeAnalysis;
	selection: PostTypeSelection | undefined;
	expanded: boolean;
	onToggleExpand: () => void;
	onToggleEnabled: (enabled: boolean) => void;
}) {
	const { schemaStatus } = postType;
	const canImport = schemaStatus.canImport;
	const isNew = !schemaStatus.exists;
	const hasMissingFields =
		schemaStatus.exists &&
		Object.values(schemaStatus.fieldStatus).some((f) => f.status === "missing");

	return (
		<div className="p-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<input
						type="checkbox"
						checked={selection?.enabled ?? false}
						disabled={!canImport}
						onChange={(e) => onToggleEnabled(e.target.checked)}
						className="h-4 w-4 rounded border-gray-300"
						aria-label={`Import ${postType.name}`}
					/>
					<button
						onClick={onToggleExpand}
						className="flex items-center gap-1 text-left"
						aria-expanded={expanded}
					>
						{expanded ? (
							<CaretDown className="h-4 w-4 text-kumo-subtle" />
						) : (
							<CaretRight className="h-4 w-4 text-kumo-subtle" />
						)}
						<div>
							<p className="font-medium">{postType.name}</p>
							<p className="text-sm text-kumo-subtle">
								{postType.count} items → {postType.suggestedCollection}
							</p>
						</div>
					</button>
				</div>
				<div className="flex items-center gap-2">
					{!canImport ? (
						<Badge variant="destructive">Incompatible</Badge>
					) : isNew ? (
						<Badge variant="secondary">New collection</Badge>
					) : hasMissingFields ? (
						<Badge variant="secondary">Add fields</Badge>
					) : (
						<Badge>Ready</Badge>
					)}
				</div>
			</div>

			{expanded && (
				<div className="mt-4 ml-8 p-3 rounded-lg bg-kumo-tint/50 text-sm">
					{!canImport && schemaStatus.reason && (
						<div className="mb-3 p-2 rounded bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300">
							<WarningCircle className="inline h-4 w-4 mr-1" />
							{schemaStatus.reason}
						</div>
					)}
					<p className="font-medium mb-2">Required fields:</p>
					<div className="space-y-1">
						{postType.requiredFields.map((field) => {
							const status = schemaStatus.fieldStatus[field.slug];
							return (
								<div key={field.slug} className="flex items-center justify-between">
									<span>
										{field.label} <span className="text-kumo-subtle">({field.type})</span>
									</span>
									{status?.status === "compatible" ? (
										<span className="text-green-600 dark:text-green-400">
											<Check className="inline h-3 w-3" /> Exists
										</span>
									) : status?.status === "missing" ? (
										<span className="text-blue-600 dark:text-blue-400">
											<Plus className="inline h-3 w-3" /> Will create
										</span>
									) : status?.status === "type_mismatch" ? (
										<span className="text-red-600 dark:text-red-400">
											<X className="inline h-3 w-3" /> Type mismatch ({status.existingType})
										</span>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}

function MediaStep({
	attachments,
	error,
	onImport,
	onSkip,
}: {
	attachments: { count: number; items: AttachmentInfo[] };
	error: string | null;
	onImport: () => void;
	onSkip: () => void;
}) {
	const byType = attachments.items.reduce(
		(acc, att) => {
			const type = att.mimeType?.split("/")[0] || "other";
			acc[type] = (acc[type] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	return (
		<div className="space-y-6">
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-start gap-4">
					<div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
						<Image className="h-6 w-6 text-blue-600 dark:text-blue-400" />
					</div>
					<div className="flex-1">
						<h3 className="text-lg font-medium">Import Media Files</h3>
						<p className="text-kumo-subtle mt-1">
							Your WordPress export contains {attachments.count} media files.
						</p>
					</div>
				</div>

				<div className="mt-4 p-4 rounded-lg bg-kumo-tint/50">
					<div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
						{Object.entries(byType).map(([type, count]) => (
							<div key={type}>
								<p className="text-kumo-subtle capitalize">{type}</p>
								<p className="font-medium">{count} files</p>
							</div>
						))}
					</div>
				</div>

				{error && (
					<div className="mt-4 p-3 rounded-lg border border-kumo-danger/50 bg-kumo-danger/10">
						<div className="flex gap-2">
							<WarningCircle className="h-4 w-4 text-kumo-danger flex-shrink-0 mt-0.5" />
							<p className="text-sm text-kumo-danger">{error}</p>
						</div>
					</div>
				)}

				<div className="mt-4 p-4 rounded-lg border-l-4 border-l-blue-500 border border-kumo-line bg-kumo-base">
					<div className="flex gap-3">
						<DownloadSimple className="h-5 w-5 text-blue-500 flex-shrink-0" />
						<div className="text-sm">
							<p className="font-medium">What happens when you import:</p>
							<ul className="mt-1 space-y-1 text-kumo-subtle">
								<li>• Files are downloaded from your WordPress site</li>
								<li>• Uploaded to your EmDash media storage</li>
								<li>• URLs in your content are updated automatically</li>
							</ul>
						</div>
					</div>
				</div>
			</div>

			<div className="flex gap-3">
				<Button variant="outline" onClick={onSkip}>
					Skip Media Import
				</Button>
				<Button icon={<DownloadSimple />} onClick={onImport}>
					Import Media
				</Button>
			</div>
		</div>
	);
}

function MediaProgressStep({
	progress,
	total,
}: {
	progress: MediaImportProgress | null;
	total: number;
}) {
	const current = progress?.current ?? 0;
	const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

	const statusLabels: Record<MediaImportProgress["status"], string> = {
		downloading: "Downloading",
		uploading: "Uploading",
		done: "Done",
		skipped: "Skipped",
		failed: "Failed",
	};

	return (
		<div className="rounded-lg border bg-kumo-base p-8">
			<div className="flex flex-col items-center text-center">
				<Loader size="lg" />
				<p className="text-sm font-medium mt-2">{percentage}%</p>

				<h3 className="mt-6 text-lg font-medium">Importing Media</h3>

				<div className="w-full max-w-md mt-4">
					<div className="flex justify-between text-sm text-kumo-subtle mb-1">
						<span>
							{current} of {total}
						</span>
						<span>{percentage}%</span>
					</div>
					<div className="h-2 bg-kumo-tint rounded-full overflow-hidden">
						<div
							className="h-full bg-kumo-brand transition-all duration-300"
							style={{ width: `${percentage}%` }}
						/>
					</div>
				</div>

				{progress && (
					<div className="mt-4 p-3 rounded-lg bg-kumo-tint/50 w-full max-w-md">
						<div className="flex items-center justify-between text-sm">
							<span className="font-medium truncate max-w-[70%]">
								{progress.filename || `File ${progress.current}`}
							</span>
							<span
								className={cn(
									"px-2 py-0.5 rounded text-xs",
									progress.status === "downloading" &&
										"bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
									progress.status === "uploading" &&
										"bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
									progress.status === "done" &&
										"bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
									progress.status === "skipped" &&
										"bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
									progress.status === "failed" &&
										"bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
								)}
							>
								{statusLabels[progress.status]}
							</span>
						</div>
						{progress.error && <p className="mt-1 text-xs text-kumo-danger">{progress.error}</p>}
					</div>
				)}

				{!progress && (
					<p className="mt-4 text-sm text-kumo-subtle">
						Preparing to download files from WordPress...
					</p>
				)}
			</div>
		</div>
	);
}

function CompleteStep({
	result,
	prepareResult,
	mediaResult,
	rewriteResult,
	skippedMedia,
	onReset,
}: {
	result: ImportResult;
	prepareResult: PrepareResult | null;
	mediaResult: MediaImportResult | null;
	rewriteResult: RewriteUrlsResult | null;
	skippedMedia: boolean;
	onReset: () => void;
}) {
	const hasMediaErrors = mediaResult && mediaResult.failed.length > 0;
	const hasContentErrors = result.errors.length > 0;
	const overallSuccess = !hasContentErrors && (!mediaResult || mediaResult.failed.length === 0);

	const wasMediaOnlyImport =
		result.imported === 0 && result.skipped > 0 && mediaResult && mediaResult.imported.length > 0;

	const getSummaryMessage = () => {
		const parts: string[] = [];
		if (result.imported > 0) {
			parts.push(`${result.imported} content items imported`);
		}
		if (result.skipped > 0 && result.imported > 0) {
			parts.push(`${result.skipped} skipped (already exist)`);
		}
		if (mediaResult && mediaResult.imported.length > 0) {
			parts.push(`${mediaResult.imported.length} media files imported`);
		}
		if (hasContentErrors) {
			parts.push(`${result.errors.length} content errors`);
		}
		if (hasMediaErrors) {
			parts.push(`${mediaResult.failed.length} media errors`);
		}
		return parts.join(" · ");
	};

	return (
		<div className="space-y-6">
			<div
				className={cn(
					"rounded-lg border p-6 text-center",
					overallSuccess
						? "border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-900/20"
						: "border-yellow-200 bg-yellow-50 dark:border-yellow-900/50 dark:bg-yellow-900/20",
				)}
			>
				{overallSuccess ? (
					<Check className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" />
				) : (
					<Warning className="mx-auto h-12 w-12 text-yellow-600 dark:text-yellow-400" />
				)}
				<h3 className="mt-4 text-lg font-medium">
					{overallSuccess
						? wasMediaOnlyImport
							? "Media Import Complete"
							: "Import Complete"
						: "Import Completed with Errors"}
				</h3>
				<p className="mt-2 text-kumo-subtle">{getSummaryMessage()}</p>
				{wasMediaOnlyImport && (
					<p className="text-sm text-kumo-subtle mt-1">
						Content was skipped because it already exists
					</p>
				)}
				{skippedMedia && <p className="text-sm text-kumo-subtle mt-1">Media import was skipped</p>}
			</div>

			{prepareResult &&
				(prepareResult.collectionsCreated.length > 0 || prepareResult.fieldsCreated.length > 0) && (
					<div className="rounded-lg border bg-kumo-base">
						<div className="border-b p-4">
							<h3 className="font-medium">Schema Changes</h3>
						</div>
						<div className="p-4 space-y-2 text-sm">
							{prepareResult.collectionsCreated.length > 0 && (
								<p>
									<strong>Collections created:</strong>{" "}
									{prepareResult.collectionsCreated.join(", ")}
								</p>
							)}
							{prepareResult.fieldsCreated.length > 0 && (
								<p>
									<strong>Fields created:</strong>{" "}
									{prepareResult.fieldsCreated.map((f) => `${f.collection}.${f.field}`).join(", ")}
								</p>
							)}
						</div>
					</div>
				)}

			{Object.keys(result.byCollection).length > 0 && (
				<div className="rounded-lg border bg-kumo-base">
					<div className="border-b p-4">
						<h3 className="font-medium">Imported by Collection</h3>
					</div>
					<div className="divide-y">
						{Object.entries(result.byCollection).map(([collection, count]) => (
							<div key={collection} className="flex items-center justify-between p-4">
								<span className="font-medium">{collection}</span>
								<span className="text-kumo-subtle">{count} items</span>
							</div>
						))}
					</div>
				</div>
			)}

			{mediaResult && mediaResult.imported.length > 0 && (
				<div className="rounded-lg border bg-kumo-base">
					<div className="border-b p-4">
						<h3 className="font-medium">Media Import</h3>
					</div>
					<div className="p-4 space-y-2 text-sm">
						<p>
							<strong>{mediaResult.imported.length}</strong> files imported
						</p>
						{rewriteResult && rewriteResult.updated > 0 && (
							<p>
								<strong>{rewriteResult.urlsRewritten}</strong> image URLs updated in{" "}
								<strong>{rewriteResult.updated}</strong> content items
							</p>
						)}
					</div>
				</div>
			)}

			{result.errors.length > 0 && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10">
					<div className="border-b border-kumo-danger/50 p-4">
						<h3 className="font-medium text-kumo-danger">
							Content Errors ({result.errors.length})
						</h3>
					</div>
					<div className="divide-y divide-destructive/20 max-h-64 overflow-y-auto">
						{result.errors.map((error, i) => (
							<div key={i} className="p-4">
								<p className="font-medium">{error.title}</p>
								<p className="text-sm text-kumo-subtle">{error.error}</p>
							</div>
						))}
					</div>
				</div>
			)}

			{hasMediaErrors && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10">
					<div className="border-b border-kumo-danger/50 p-4">
						<h3 className="font-medium text-kumo-danger">
							Media Errors ({mediaResult.failed.length})
						</h3>
					</div>
					<div className="divide-y divide-destructive/20 max-h-64 overflow-y-auto">
						{mediaResult.failed.map((error, i) => (
							<div key={i} className="p-4">
								<p className="font-medium text-sm font-mono truncate">{error.originalUrl}</p>
								<p className="text-sm text-kumo-subtle">{error.error}</p>
							</div>
						))}
					</div>
				</div>
			)}

			<div className="flex gap-3">
				<Button variant="outline" onClick={onReset}>
					Import Another File
				</Button>
				<LinkButton href="/_emdash/admin">Go to Dashboard</LinkButton>
			</div>
		</div>
	);
}

// =============================================================================
// Author Mapping Step
// =============================================================================

function AuthorMappingStep({
	authorMappings,
	emdashUsers,
	onMappingChange,
	onContinue,
	onBack,
}: {
	authorMappings: AuthorMapping[];
	emdashUsers: UserListItem[];
	onMappingChange: (wpLogin: string, emdashUserId: string | null) => void;
	onContinue: () => void;
	onBack: () => void;
}) {
	// Count matched vs unmatched
	const matchedCount = authorMappings.filter((m) => m.emdashUserId !== null).length;
	const totalCount = authorMappings.length;

	return (
		<div className="space-y-6">
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-start gap-4">
					<div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
						<User className="h-6 w-6 text-blue-600 dark:text-blue-400" />
					</div>
					<div>
						<h3 className="text-lg font-medium">Map Authors</h3>
						<p className="text-kumo-subtle mt-1">
							Assign WordPress authors to EmDash users. Posts will be attributed to the selected
							user.
						</p>
						{matchedCount > 0 && (
							<p className="text-sm text-green-600 dark:text-green-400 mt-2">
								<Check className="inline h-4 w-4 mr-1" />
								{matchedCount} of {totalCount} authors matched by email
							</p>
						)}
					</div>
				</div>
			</div>

			<div className="rounded-lg border bg-kumo-base">
				<div className="border-b p-4">
					<div className="flex items-center justify-between">
						<h3 className="font-medium">Author Mapping</h3>
						<span className="text-sm text-kumo-subtle">
							{matchedCount} of {totalCount} assigned
						</span>
					</div>
				</div>
				<div className="divide-y">
					{authorMappings.map((mapping) => (
						<div key={mapping.wpLogin} className="p-4 flex items-center justify-between gap-4">
							<div className="flex-1 min-w-0">
								<p className="font-medium truncate">{mapping.wpDisplayName}</p>
								<p className="text-sm text-kumo-subtle">
									{mapping.wpEmail || mapping.wpLogin}
									{mapping.postCount > 0 && (
										<span className="ml-2">• {mapping.postCount} posts</span>
									)}
								</p>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-kumo-subtle">→</span>
								<select
									value={mapping.emdashUserId || ""}
									onChange={(e) => onMappingChange(mapping.wpLogin, e.target.value || null)}
									className="w-48 px-3 py-2 rounded-md border bg-kumo-base text-sm"
								>
									<option value="">Leave unassigned</option>
									{emdashUsers.map((user) => (
										<option key={user.id} value={user.id}>
											{user.name || user.email}
										</option>
									))}
								</select>
							</div>
						</div>
					))}
				</div>
			</div>

			{emdashUsers.length === 0 && (
				<div className="rounded-lg border-l-4 border-l-yellow-500 border border-kumo-line bg-kumo-base p-4">
					<div className="flex gap-3">
						<Warning className="h-5 w-5 text-yellow-500 flex-shrink-0" />
						<div>
							<p className="font-medium">No EmDash users found</p>
							<p className="text-sm text-kumo-subtle mt-1">
								All imported content will be unassigned. You can reassign authors later from the
								content editor.
							</p>
						</div>
					</div>
				</div>
			)}

			<div className="flex gap-3">
				<Button variant="outline" onClick={onBack}>
					Back
				</Button>
				<Button onClick={onContinue}>Continue Import</Button>
			</div>
		</div>
	);
}
