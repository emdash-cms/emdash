/**
 * Plugin Manager Component
 *
 * Displays list of configured plugins with enable/disable controls.
 * Extended with marketplace features: source badges, update checking,
 * update/uninstall for marketplace-installed plugins.
 */

import { Badge, Button, Switch, Toast } from "@cloudflare/kumo";
import {
	PuzzlePiece,
	Gear,
	FileText,
	SquaresFour,
	WebhooksLogo,
	CaretDown,
	CaretRight,
	ArrowsClockwise,
	Storefront,
	Trash,
	ShieldCheck,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchPlugins,
	enablePlugin,
	disablePlugin,
	type PluginInfo,
	type AdminManifest,
	CAPABILITY_LABELS,
} from "../lib/api";
import {
	checkPluginUpdates,
	updateMarketplacePlugin,
	uninstallMarketplacePlugin,
	type PluginUpdateInfo,
} from "../lib/api/marketplace.js";
import { safeIconUrl } from "../lib/url.js";
import { cn } from "../lib/utils";
import { CapabilityConsentDialog } from "./CapabilityConsentDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";

export interface PluginManagerProps {
	/** Admin manifest — used to check if marketplace is configured */
	manifest?: AdminManifest;
}

export function PluginManager({ manifest }: PluginManagerProps) {
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const hasMarketplace = !!manifest?.marketplace;

	const {
		data: plugins,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["plugins"],
		queryFn: fetchPlugins,
	});

	const {
		data: updates,
		refetch: refetchUpdates,
		isFetching: isCheckingUpdates,
	} = useQuery({
		queryKey: ["plugin-updates"],
		queryFn: checkPluginUpdates,
		enabled: false, // Only fetch on demand
	});

	const enableMutation = useMutation({
		mutationFn: enablePlugin,
		onSuccess: (plugin) => {
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			toastManager.add({
				title: "Plugin enabled",
				description: `${plugin.name} is now active`,
			});
		},
		onError: (err) => {
			toastManager.add({
				title: "Failed to enable plugin",
				description: err instanceof Error ? err.message : "An error occurred",
				type: "error",
			});
		},
	});

	const disableMutation = useMutation({
		mutationFn: disablePlugin,
		onSuccess: (plugin) => {
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			toastManager.add({
				title: "Plugin disabled",
				description: `${plugin.name} has been deactivated`,
			});
		},
		onError: (err) => {
			toastManager.add({
				title: "Failed to disable plugin",
				description: err instanceof Error ? err.message : "An error occurred",
				type: "error",
			});
		},
	});

	const updateMap = React.useMemo(() => {
		if (!updates) return new Map<string, PluginUpdateInfo>();
		return new Map(updates.map((u) => [u.pluginId, u]));
	}, [updates]);

	const hasMarketplacePlugins = plugins?.some((p) => p.source === "marketplace");

	if (isLoading) {
		return (
			<div className="space-y-6">
				<h1 className="text-3xl font-bold">Plugins</h1>
				<div className="text-kumo-subtle">Loading plugins...</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-3xl font-bold">Plugins</h1>
				<div className="text-kumo-danger">Failed to load plugins: {error.message}</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-3xl font-bold">Plugins</h1>
				<div className="flex items-center gap-3">
					{hasMarketplacePlugins && (
						<Button
							variant="ghost"
							onClick={() => void refetchUpdates()}
							disabled={isCheckingUpdates}
						>
							<ArrowsClockwise
								className={cn("mr-2 h-4 w-4", isCheckingUpdates && "animate-spin")}
							/>
							Check for updates
						</Button>
					)}
					{hasMarketplace && (
						<Link to="/plugins/marketplace">
							<Button variant="ghost">
								<Storefront className="mr-2 h-4 w-4" />
								Marketplace
							</Button>
						</Link>
					)}
					<span className="text-sm text-kumo-subtle">{plugins?.length ?? 0} plugins</span>
				</div>
			</div>

			<p className="text-kumo-subtle">
				Manage installed plugins. Enable or disable plugins to control their functionality.
			</p>

			<div className="grid gap-4">
				{plugins?.map((plugin) => (
					<PluginCard
						key={plugin.id}
						plugin={plugin}
						updateInfo={updateMap.get(plugin.id)}
						onEnable={() => enableMutation.mutate(plugin.id)}
						onDisable={() => disableMutation.mutate(plugin.id)}
						isToggling={enableMutation.isPending || disableMutation.isPending}
						hasMarketplace={hasMarketplace}
					/>
				))}
			</div>

			{plugins?.length === 0 && (
				<div className="rounded-lg border bg-kumo-base p-8 text-center">
					<PuzzlePiece className="mx-auto h-12 w-12 text-kumo-subtle" />
					<h3 className="mt-4 text-lg font-medium">No plugins configured</h3>
					<p className="mt-2 text-sm text-kumo-subtle">
						{hasMarketplace ? (
							<>
								Browse the{" "}
								<Link to="/plugins/marketplace" className="text-kumo-brand hover:underline">
									marketplace
								</Link>{" "}
								to install plugins, or add them to your astro.config.mjs.
							</>
						) : (
							"Add plugins to your astro.config.mjs to extend EmDash functionality."
						)}
					</p>
				</div>
			)}
		</div>
	);
}

interface PluginCardProps {
	plugin: PluginInfo;
	updateInfo?: PluginUpdateInfo;
	onEnable: () => void;
	onDisable: () => void;
	isToggling: boolean;
	/** Whether the marketplace is configured (controls "View in Marketplace" link) */
	hasMarketplace: boolean;
}

function PluginCard({
	plugin,
	updateInfo,
	onEnable,
	onDisable,
	isToggling,
	hasMarketplace,
}: PluginCardProps) {
	const [expanded, setExpanded] = React.useState(false);
	const [showUpdateConsent, setShowUpdateConsent] = React.useState(false);
	const [showUninstallConfirm, setShowUninstallConfirm] = React.useState(false);
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();

	const isMarketplace = plugin.source === "marketplace";
	const hasUpdate = !!updateInfo && updateInfo.installed !== updateInfo.latest;

	const updateMutation = useMutation({
		mutationFn: () => updateMarketplacePlugin(plugin.id, { confirmCapabilities: true }),
		onSuccess: () => {
			setShowUpdateConsent(false);
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["plugin-updates"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			toastManager.add({
				title: "Plugin updated",
				description: `${plugin.name} updated to v${updateInfo?.latest}`,
			});
		},
	});

	const uninstallMutation = useMutation({
		mutationFn: (deleteData: boolean) => uninstallMarketplacePlugin(plugin.id, { deleteData }),
		onSuccess: () => {
			setShowUninstallConfirm(false);
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			toastManager.add({
				title: "Plugin uninstalled",
				description: `${plugin.name} has been removed`,
			});
		},
	});

	const handleToggle = () => {
		if (plugin.enabled) {
			onDisable();
		} else {
			onEnable();
		}
	};

	return (
		<>
			<div
				className={cn(
					"rounded-lg border bg-kumo-base transition-colors",
					!plugin.enabled && "opacity-75",
				)}
			>
				<div className="flex items-center gap-4 p-4">
					{/* Plugin icon */}
					{plugin.iconUrl ? (
						<img
							src={safeIconUrl(plugin.iconUrl, 80) ?? undefined}
							alt=""
							className="h-10 w-10 rounded-lg object-cover"
							loading="lazy"
						/>
					) : (
						<div
							className={cn(
								"flex h-10 w-10 items-center justify-center rounded-lg",
								plugin.enabled ? "bg-kumo-brand/10" : "bg-kumo-tint",
							)}
						>
							<PuzzlePiece
								className={cn("h-5 w-5", plugin.enabled ? "text-kumo-brand" : "text-kumo-subtle")}
							/>
						</div>
					)}

					{/* Plugin info */}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="font-semibold truncate">{plugin.name}</h3>
							<span className="text-xs text-kumo-subtle">v{plugin.version}</span>
							{!plugin.enabled && <Badge variant="secondary">Disabled</Badge>}
							{isMarketplace && <Badge variant="secondary">Marketplace</Badge>}
							{hasUpdate && (
								<Badge variant="outline" className="border-kumo-brand text-kumo-brand">
									v{updateInfo.latest} available
								</Badge>
							)}
						</div>

						{/* Description */}
						{plugin.description && (
							<p className="mt-0.5 text-sm text-kumo-subtle line-clamp-1">{plugin.description}</p>
						)}

						{/* Feature indicators + inline capabilities */}
						<div className="flex items-center gap-3 mt-1 text-sm text-kumo-subtle">
							{plugin.hasAdminPages && (
								<span className="flex items-center gap-1">
									<FileText className="h-3 w-3" />
									Pages
								</span>
							)}
							{plugin.hasDashboardWidgets && (
								<span className="flex items-center gap-1">
									<SquaresFour className="h-3 w-3" />
									Widgets
								</span>
							)}
							{plugin.hasHooks && (
								<span className="flex items-center gap-1">
									<WebhooksLogo className="h-3 w-3" />
									Hooks
								</span>
							)}
							{plugin.capabilities.length > 0 && (
								<span
									className="flex items-center gap-1"
									title={plugin.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(", ")}
								>
									<ShieldCheck className="h-3 w-3" />
									{plugin.capabilities.length} permission
									{plugin.capabilities.length !== 1 ? "s" : ""}
								</span>
							)}
						</div>
					</div>

					{/* Actions */}
					<div className="flex items-center gap-2">
						{hasUpdate && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setShowUpdateConsent(true)}
								disabled={updateMutation.isPending}
							>
								{updateMutation.isPending ? "Updating..." : `Update to v${updateInfo.latest}`}
							</Button>
						)}

						{isMarketplace && hasMarketplace && (
							<Link to="/plugins/marketplace/$pluginId" params={{ pluginId: plugin.id }}>
								<Button variant="ghost" size="sm">
									<Storefront className="mr-1.5 h-3.5 w-3.5" />
									View in Marketplace
								</Button>
							</Link>
						)}

						{plugin.hasAdminPages && plugin.enabled && (
							<Link to="/plugins/$pluginId/$" params={{ pluginId: plugin.id, _splat: "settings" }}>
								<Button variant="ghost" shape="square" aria-label="Settings">
									<Gear className="h-4 w-4" />
									<span className="sr-only">Settings</span>
								</Button>
							</Link>
						)}

						<Switch
							checked={plugin.enabled}
							onCheckedChange={handleToggle}
							disabled={isToggling}
							aria-label={plugin.enabled ? "Disable plugin" : "Enable plugin"}
						/>

						<Button
							variant="ghost"
							shape="square"
							aria-label={expanded ? "Collapse details" : "Expand details"}
							onClick={() => setExpanded(!expanded)}
							aria-expanded={expanded}
						>
							{expanded ? <CaretDown className="h-4 w-4" /> : <CaretRight className="h-4 w-4" />}
							<span className="sr-only">{expanded ? "Collapse" : "Expand"} details</span>
						</Button>
					</div>
				</div>

				{/* Expanded details */}
				{expanded && (
					<div className="border-t px-4 py-3 space-y-3">
						{/* Capabilities */}
						{plugin.capabilities.length > 0 && (
							<div>
								<h4 className="text-xs font-medium text-kumo-subtle uppercase tracking-wider mb-1">
									Capabilities
								</h4>
								<div className="flex flex-wrap gap-1">
									{plugin.capabilities.map((cap) => (
										<span
											key={cap}
											className="inline-flex items-center rounded-md bg-kumo-tint px-2 py-0.5 text-xs"
											title={CAPABILITY_LABELS[cap]}
										>
											{CAPABILITY_LABELS[cap] ?? cap}
										</span>
									))}
								</div>
							</div>
						)}

						{/* Source */}
						{isMarketplace && (
							<div>
								<h4 className="text-xs font-medium text-kumo-subtle uppercase tracking-wider mb-1">
									Source
								</h4>
								<span className="text-xs text-kumo-subtle">
									Installed from marketplace (v{plugin.marketplaceVersion || plugin.version})
								</span>
							</div>
						)}

						{/* Package */}
						{plugin.package && (
							<div>
								<h4 className="text-xs font-medium text-kumo-subtle uppercase tracking-wider mb-1">
									Package
								</h4>
								<code className="text-xs bg-kumo-tint px-2 py-0.5 rounded">{plugin.package}</code>
							</div>
						)}

						{/* Timestamps */}
						<div className="grid grid-cols-2 gap-4 text-xs">
							{plugin.installedAt && (
								<div>
									<span className="text-kumo-subtle">Installed:</span>{" "}
									{new Date(plugin.installedAt).toLocaleDateString()}
								</div>
							)}
							{plugin.activatedAt && (
								<div>
									<span className="text-kumo-subtle">Last enabled:</span>{" "}
									{new Date(plugin.activatedAt).toLocaleDateString()}
								</div>
							)}
							{plugin.deactivatedAt && !plugin.enabled && (
								<div>
									<span className="text-kumo-subtle">Disabled:</span>{" "}
									{new Date(plugin.deactivatedAt).toLocaleDateString()}
								</div>
							)}
						</div>

						{/* Uninstall button for marketplace plugins */}
						{isMarketplace && (
							<div className="pt-2 border-t">
								<Button
									variant="ghost"
									className="text-kumo-danger hover:text-kumo-danger"
									onClick={() => setShowUninstallConfirm(true)}
									disabled={uninstallMutation.isPending}
								>
									<Trash className="mr-2 h-4 w-4" />
									Uninstall
								</Button>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Update consent dialog */}
			{showUpdateConsent && updateInfo && (
				<CapabilityConsentDialog
					mode="update"
					pluginName={plugin.name}
					capabilities={plugin.capabilities}
					newCapabilities={[]} // WS3 will populate this from the diff
					isPending={updateMutation.isPending}
					error={getMutationError(updateMutation.error)}
					onConfirm={() => updateMutation.mutate()}
					onCancel={() => {
						setShowUpdateConsent(false);
						updateMutation.reset();
					}}
				/>
			)}

			{/* Uninstall confirmation */}
			{showUninstallConfirm && (
				<UninstallConfirmDialog
					pluginName={plugin.name}
					isPending={uninstallMutation.isPending}
					error={getMutationError(uninstallMutation.error)}
					onConfirm={(deleteData) => uninstallMutation.mutate(deleteData)}
					onCancel={() => {
						setShowUninstallConfirm(false);
						uninstallMutation.reset();
					}}
				/>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Uninstall confirmation dialog
// ---------------------------------------------------------------------------

interface UninstallConfirmDialogProps {
	pluginName: string;
	isPending: boolean;
	error?: string | null;
	onConfirm: (deleteData: boolean) => void;
	onCancel: () => void;
}

export function UninstallConfirmDialog({
	pluginName,
	isPending,
	error,
	onConfirm,
	onCancel,
}: UninstallConfirmDialogProps) {
	const [deleteData, setDeleteData] = React.useState(false);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-label="Uninstall confirmation"
		>
			<div className="absolute inset-0 bg-black/50" onClick={() => !isPending && onCancel()} />
			<div className="relative w-full max-w-sm rounded-lg border bg-kumo-base shadow-lg">
				<div className="p-6 space-y-4">
					<h2 className="text-lg font-semibold">Uninstall {pluginName}?</h2>
					<p className="text-sm text-kumo-subtle">
						This will remove the plugin and its bundle from your site.
					</p>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={deleteData}
							onChange={(e) => setDeleteData(e.target.checked)}
							className="rounded border"
						/>
						Also delete plugin storage data
					</label>
					<DialogError message={error} />
				</div>
				<div className="flex justify-end gap-3 border-t px-6 py-4">
					<Button variant="ghost" onClick={onCancel} disabled={isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={() => onConfirm(deleteData)} disabled={isPending}>
						{isPending ? "Uninstalling..." : "Uninstall"}
					</Button>
				</div>
			</div>
		</div>
	);
}

export default PluginManager;
