import { Input, LayerDialog, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useRolesConfig } from "./useRolesConfig.js";

export interface InviteUserModalProps {
	open: boolean;
	isSending?: boolean;
	error?: string | null;
	/** When set, shows a copy-link view instead of the form (no email provider) */
	inviteUrl?: string | null;
	onOpenChange: (open: boolean) => void;
	onInvite: (email: string, role: number) => void;
}

/**
 * Invite user modal — sends invite email or shows copy-link fallback
 */
export function InviteUserModal({
	open,
	isSending,
	error,
	inviteUrl,
	onOpenChange,
	onInvite,
}: InviteUserModalProps) {
	const { t } = useLingui();
	const { roles, roleLabels } = useRolesConfig();
	const [email, setEmail] = React.useState("");
	const [role, setRole] = React.useState(30); // Default to Author
	const [copied, setCopied] = React.useState(false);
	const [copyError, setCopyError] = React.useState(false);
	const formId = React.useId();

	const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// Reset form when modal opens
	React.useEffect(() => {
		if (open) {
			setEmail("");
			setRole(30);
			setCopied(false);
			setCopyError(false);
		}
	}, [open]);

	// Clean up timeout on unmount
	React.useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onInvite(email, role);
	};

	const handleCopyUrl = async () => {
		if (!inviteUrl) return;
		try {
			await navigator.clipboard.writeText(inviteUrl);
			setCopied(true);
			setCopyError(false);
			copyTimeoutRef.current = setTimeout(setCopied, 2000, false);
		} catch {
			// Clipboard API can fail in insecure contexts
			setCopyError(true);
		}
	};

	return (
		<LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={isSending}>
			<LayerDialog.Content size="sm">
				<LayerDialog.Title>{inviteUrl ? t`Invite Link Created` : t`Invite User`}</LayerDialog.Title>
				<LayerDialog.Description>
					{inviteUrl
						? t`No email provider configured. Share this link manually.`
						: t`Send an invitation email to a new team member.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					{inviteUrl ? (
						/* Copy-link view — shown when no email provider is configured */
						<div className="space-y-4">
							<div className="rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-4">
								<p className="text-sm text-kumo-warning font-medium">
									{t`Share this link with the invited user`}
								</p>
								<p className="text-xs text-kumo-subtle mt-1">
									{t`This link expires in 7 days and can only be used once.`}
								</p>
							</div>

							<code
								dir="ltr"
								className="block rounded bg-kumo-tint px-3 py-2 text-sm font-mono border truncate"
							>
								{inviteUrl}
							</code>
							{copied && <p className="text-xs text-kumo-success">{t`Copied to clipboard`}</p>}
							{copyError && (
								<p className="text-xs text-kumo-warning">
									{t`Could not copy automatically. Please select the URL above and copy manually.`}
								</p>
							)}
						</div>
					) : (
						/* Standard invite form */
						<form id={formId} onSubmit={handleSubmit}>
							<div className="grid gap-4">
								{/* Email */}
								<Input
									dir="ltr"
									label={t`Email address`}
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder={t`colleague@example.com`}
									required
									autoComplete="off"
								/>

								{/* Role */}
								<div className="grid gap-2">
									<Select
										label={t`Role`}
										value={role.toString()}
										onValueChange={(v) => v !== null && setRole(parseInt(v, 10))}
										items={roleLabels}
									>
										{roles.map((r) => (
											<Select.Option key={r.value} value={r.value.toString()}>
												<div>
													<div>{r.label}</div>
													<div className="text-xs text-kumo-subtle">{r.description}</div>
												</div>
											</Select.Option>
										))}
									</Select>
									<p className="text-xs text-kumo-subtle">
										{t`The invited user will have this role once they complete registration.`}
									</p>
								</div>

								{/* Error message */}
								{error && (
									<div className="rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
										{error}
									</div>
								)}
							</div>
						</form>
					)}
				</LayerDialog.Body>
				{inviteUrl ? (
					<LayerDialog.Actions dismissLabel={t`Done`}>
						<LayerDialog.Action onClick={handleCopyUrl}>{t`Copy invite link`}</LayerDialog.Action>
					</LayerDialog.Actions>
				) : (
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action type="submit" form={formId} disabled={isSending || !email}>
							{isSending ? t`Sending...` : t`Send Invite`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				)}
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
