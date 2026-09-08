/**
 * Capability Consent Dialog
 *
 * Shown before installing or updating a marketplace plugin.
 * Lists each requested capability with a human-readable explanation.
 * User must explicitly confirm before the action proceeds.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ShieldCheck, ShieldWarning, Warning } from "@phosphor-icons/react";
import * as React from "react";

import { describeCapability } from "../lib/api/marketplace.js";
import type { PluginMcpConsentTool } from "../lib/api/marketplace.js";
import type { RegistryRecordVerificationSummary } from "../lib/api/registry.js";
import { cn } from "../lib/utils.js";
import { DialogError } from "./DialogError.js";

export interface CapabilityConsentDialogProps {
	/** Dialog mode */
	mode?: "install" | "update";
	/** Plugin display name */
	pluginName: string;
	/** Capabilities the plugin requests */
	capabilities: string[];
	/** Allowed network hosts (for network:fetch capability) */
	allowedHosts?: string[];
	/** New capabilities added in an update (highlighted differently) */
	newCapabilities?: string[];
	/** Routes that change from private to public in an update. */
	newlyPublicRoutes?: string[];
	/** Plugin routes explicitly exposed as MCP tools. */
	mcpTools?: PluginMcpConsentTool[];
	/** Audit verdict badge */
	auditVerdict?: "pass" | "warn" | "fail";
	/** Independent signed-record and provenance evidence for registry plugins. */
	verification?: RegistryRecordVerificationSummary;
	/** Whether the action is in progress */
	isPending?: boolean;
	/** Error message to display inline */
	error?: string | null;
	/** Called when user confirms */
	onConfirm: () => void;
	/** Called when user cancels */
	onCancel: () => void;
}

export function CapabilityConsentDialog({
	mode,
	pluginName,
	capabilities,
	allowedHosts,
	newCapabilities = [],
	newlyPublicRoutes = [],
	mcpTools = [],
	auditVerdict,
	verification,
	isPending = false,
	error,
	onConfirm,
	onCancel,
}: CapabilityConsentDialogProps) {
	const { t } = useLingui();
	const newSet = new Set(newCapabilities);
	const isUpdate = mode === "update" || newCapabilities.length > 0 || newlyPublicRoutes.length > 0;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-label={t`Capability consent`}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/50" onClick={() => !isPending && onCancel()} />

			{/* Dialog */}
			<div className="relative w-full max-w-lg rounded-lg border bg-kumo-base shadow-lg">
				{/* Header */}
				<div className="border-b px-6 py-4">
					<h2 className="text-lg font-semibold">
						{verification
							? isUpdate
								? t`Review Verified Update`
								: t`Review Verified Plugin`
							: isUpdate
								? t`Review New Permissions`
								: t`Plugin Permissions`}
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{verification
							? t`Review the independently verified release evidence and permissions for ${pluginName} before continuing.`
							: isUpdate
								? t`${pluginName} is requesting additional permissions:`
								: t`${pluginName} requires the following permissions:`}
					</p>
				</div>

				{/* Capabilities list */}
				<div className="max-h-[70vh] space-y-3 overflow-y-auto px-6 py-4">
					{verification ? (
						<div className="rounded-md border border-kumo-success/30 bg-kumo-success/10 p-3 text-sm">
							<div className="flex items-start gap-2">
								<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-kumo-success" />
								<div>
									<div className="font-medium">{t`Independent verification`}</div>
									<p className="mt-1 text-xs text-kumo-subtle">
										{verification.provenance === "verified"
											? t`Provenance is verified against the signed release and artifact.`
											: t`No provenance was supplied; the signed publisher policy permits this.`}
									</p>
								</div>
							</div>
							<dl className="mt-3 space-y-2 text-xs">
								<div>
									<dt className="font-medium text-kumo-subtle">{t`Profile CID`}</dt>
									<dd className="break-all font-mono">
										<bdi dir="ltr">{verification.profileCid}</bdi>
									</dd>
								</div>
								<div>
									<dt className="font-medium text-kumo-subtle">{t`Release CID`}</dt>
									<dd className="break-all font-mono">
										<bdi dir="ltr">{verification.releaseCid}</bdi>
									</dd>
								</div>
								<div>
									<dt className="font-medium text-kumo-subtle">{t`Publisher release policy`}</dt>
									<dd>
										{verification.policy.requireProvenance
											? t`Provenance required`
											: t`Provenance optional`}
										{" · "}
										{verification.policy.confirmation === "always"
											? t`Publisher approval required for every delegated release`
											: t`Publisher approval required only for permission escalation`}
									</dd>
								</div>
								{verification.policy.approvers.length > 0 ? (
									<div>
										<dt className="font-medium text-kumo-subtle">{t`Authorized approvers`}</dt>
										{verification.policy.approvers.map((approver) => (
											<dd key={approver} className="break-all font-mono">
												<bdi dir="ltr">{approver}</bdi>
											</dd>
										))}
									</div>
								) : null}
							</dl>
						</div>
					) : null}

					{capabilities.map((cap) => {
						const isNew = newSet.has(cap);
						return (
							<div
								key={cap}
								className={cn(
									"flex items-start gap-3 rounded-md p-2 text-sm",
									isNew ? "bg-kumo-warning/10 border border-kumo-warning/30" : "bg-kumo-tint/50",
								)}
							>
								<ShieldCheck
									className={cn(
										"mt-0.5 h-4 w-4 shrink-0",
										isNew ? "text-kumo-warning" : "text-kumo-subtle",
									)}
								/>
								<div>
									<span className={cn(isNew && "font-medium")}>
										{describeCapability(cap, allowedHosts)}
									</span>
									{isNew && (
										<span className="ms-2 text-xs text-kumo-warning font-medium">{t`NEW`}</span>
									)}
								</div>
							</div>
						);
					})}

					{newlyPublicRoutes.length > 0 && (
						<div className="rounded-md border border-kumo-warning/30 bg-kumo-warning/10 p-3 text-sm">
							<div className="flex items-center gap-2 font-medium text-kumo-warning">
								<Warning className="h-4 w-4 shrink-0" />
								{t`New public routes`}
							</div>
							<p className="mt-1 text-xs text-kumo-subtle">
								{t`This update exposes the following routes without authentication:`}
							</p>
							<ul className="mt-2 space-y-1 ps-5 text-xs">
								{newlyPublicRoutes.map((route) => (
									<li key={route} className="list-disc font-mono">
										{route}
									</li>
								))}
							</ul>
						</div>
					)}

					{mcpTools.length > 0 && (
						<div className="rounded-md border border-kumo-warning/30 bg-kumo-warning/10 p-3 text-sm">
							<div className="font-medium text-kumo-warning">{t`Agent-callable MCP tools`}</div>
							<p className="mt-1 text-xs text-kumo-subtle">
								{t`These tools remain disabled after installation until you explicitly enable agent access.`}
							</p>
							<ul className="mt-2 space-y-2">
								{mcpTools.map((tool) => (
									<li key={tool.name} className="rounded bg-kumo-base p-2 text-xs">
										<div className="font-mono">{tool.name}</div>
										<p className="mt-1 text-kumo-subtle">{tool.description}</p>
										<p className="mt-1 text-kumo-subtle">
											{t`Route: ${tool.route} · Permission: ${tool.permission}`}
										</p>
										{tool.destructive && (
											<span className="mt-1 inline-block font-medium text-kumo-danger">
												{t`Destructive`}
											</span>
										)}
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Audit verdict banner */}
					{auditVerdict && auditVerdict !== "pass" && (
						<div
							className={cn(
								"flex items-center gap-2 rounded-md p-3 text-sm mt-2",
								auditVerdict === "warn"
									? "bg-kumo-warning/10 text-kumo-warning"
									: "bg-kumo-danger/10 text-kumo-danger",
							)}
						>
							{auditVerdict === "warn" ? (
								<Warning className="h-4 w-4 shrink-0" />
							) : (
								<ShieldWarning className="h-4 w-4 shrink-0" />
							)}
							<span>
								{auditVerdict === "warn"
									? t`Security audit flagged potential concerns with this plugin.`
									: t`Security audit flagged this plugin as potentially unsafe.`}
							</span>
						</div>
					)}
				</div>

				{/* Error */}
				<DialogError message={error} className="mx-6" />

				{/* Actions */}
				<div className="flex justify-end gap-3 border-t px-6 py-4">
					<Button variant="ghost" onClick={onCancel} disabled={isPending}>
						{t`Cancel`}
					</Button>
					<Button onClick={onConfirm} disabled={isPending}>
						{isPending
							? isUpdate
								? t`Updating...`
								: t`Installing...`
							: isUpdate
								? t`Accept & Update`
								: t`Accept & Install`}
					</Button>
				</div>
			</div>
		</div>
	);
}

export default CapabilityConsentDialog;
