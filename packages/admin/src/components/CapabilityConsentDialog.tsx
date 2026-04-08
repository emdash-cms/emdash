/**
 * Capability Consent Dialog
 *
 * Shown before installing or updating a marketplace plugin.
 * Lists each requested capability with a human-readable explanation.
 * User must explicitly confirm before the action proceeds.
 */

import { Button } from "@cloudflare/kumo";
import { ShieldCheck, ShieldWarning, Warning } from "@phosphor-icons/react";
import * as React from "react";

import { describeCapability } from "../lib/api/marketplace.js";
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
	/** Audit verdict badge */
	auditVerdict?: "pass" | "warn" | "fail";
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
	auditVerdict,
	isPending = false,
	error,
	onConfirm,
	onCancel,
}: CapabilityConsentDialogProps) {
	const newSet = new Set(newCapabilities);
	const isUpdate = mode === "update" || newCapabilities.length > 0;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-label="Capability consent"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/50" onClick={() => !isPending && onCancel()} />

			{/* Dialog */}
			<div className="relative w-full max-w-md rounded-lg border bg-kumo-base shadow-lg">
				{/* Header */}
				<div className="border-b px-6 py-4">
					<h2 className="text-lg font-semibold">
						{isUpdate ? "Review New Permissions" : "Plugin Permissions"}
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{isUpdate
							? `${pluginName} is requesting additional permissions:`
							: `${pluginName} requires the following permissions:`}
					</p>
				</div>

				{/* Capabilities list */}
				<div className="px-6 py-4 space-y-3">
					{capabilities.map((cap) => {
						const isNew = newSet.has(cap);
						return (
							<div
								key={cap}
								className={cn(
									"flex items-start gap-3 rounded-md p-2 text-sm",
									isNew ? "bg-warning/10 border border-warning/30" : "bg-kumo-tint/50",
								)}
							>
								<ShieldCheck
									className={cn(
										"mt-0.5 h-4 w-4 shrink-0",
										isNew ? "text-warning" : "text-kumo-subtle",
									)}
								/>
								<div>
									<span className={cn(isNew && "font-medium")}>
										{describeCapability(cap, allowedHosts)}
									</span>
									{isNew && <span className="ml-2 text-xs text-warning font-medium">NEW</span>}
								</div>
							</div>
						);
					})}

					{/* Audit verdict banner */}
					{auditVerdict && auditVerdict !== "pass" && (
						<div
							className={cn(
								"flex items-center gap-2 rounded-md p-3 text-sm mt-2",
								auditVerdict === "warn"
									? "bg-warning/10 text-warning"
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
									? "Security audit flagged potential concerns with this plugin."
									: "Security audit flagged this plugin as potentially unsafe."}
							</span>
						</div>
					)}
				</div>

				{/* Error */}
				<DialogError message={error} className="mx-6" />

				{/* Actions */}
				<div className="flex justify-end gap-3 border-t px-6 py-4">
					<Button variant="ghost" onClick={onCancel} disabled={isPending}>
						Cancel
					</Button>
					<Button onClick={onConfirm} disabled={isPending}>
						{isPending
							? isUpdate
								? "Updating..."
								: "Installing..."
							: isUpdate
								? "Accept & Update"
								: "Accept & Install"}
					</Button>
				</div>
			</div>
		</div>
	);
}

export default CapabilityConsentDialog;
