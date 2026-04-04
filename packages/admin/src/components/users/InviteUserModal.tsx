import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, Copy, X } from "@phosphor-icons/react";
import * as React from "react";

import { ROLES } from "./RoleBadge";

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
	const [email, setEmail] = React.useState("");
	const [role, setRole] = React.useState(30); // Default to Author
	const [copied, setCopied] = React.useState(false);
	const [copyError, setCopyError] = React.useState(false);

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
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-md" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<div className="flex flex-col space-y-1.5">
						<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
							{inviteUrl ? t`Invite Link Created` : t`Invite User`}
						</Dialog.Title>
						<Dialog.Description className="text-sm text-kumo-subtle">
							{inviteUrl
								? t`No email provider configured. Share this link manually.`
								: t`Send an invitation email to a new team member.`}
						</Dialog.Description>
					</div>
					<Dialog.Close
						aria-label={t`Close`}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label={t`Close`}
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">{t`Close`}</span>
							</Button>
						)}
					/>
				</div>

				{inviteUrl ? (
					/* Copy-link view — shown when no email provider is configured */
					<div className="py-4 space-y-4">
						<div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
							<p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
								{t`Share this link with the invited user`}
							</p>
							<p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
								{t`This link expires in 7 days and can only be used once.`}
							</p>
						</div>

						<div className="flex items-center gap-2">
							<code className="flex-1 rounded bg-kumo-tint px-3 py-2 text-sm font-mono border truncate">
								{inviteUrl}
							</code>
							<Button
								variant="ghost"
								shape="square"
								onClick={handleCopyUrl}
								aria-label={t`Copy invite link`}
							>
								{copied ? (
									<Check className="h-4 w-4 text-green-600" />
								) : (
									<Copy className="h-4 w-4" />
								)}
							</Button>
						</div>
						{copied && (
							<p className="text-xs text-green-600 dark:text-green-400">{t`Copied to clipboard`}</p>
						)}
						{copyError && (
							<p className="text-xs text-amber-600 dark:text-amber-400">
								{t`Could not copy automatically. Please select the URL above and copy manually.`}
							</p>
						)}

						<div className="flex justify-end">
							<Button type="button" onClick={() => onOpenChange(false)}>
								{t`Done`}
							</Button>
						</div>
					</div>
				) : (
					/* Standard invite form */
					<form onSubmit={handleSubmit}>
						<div className="grid gap-4 py-4">
							{/* Email */}
							<Input
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
									items={Object.fromEntries(ROLES.map((r) => [r.value.toString(), r.label]))}
								>
									{ROLES.map((r) => (
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

						<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={isSending}
							>
								{t`Cancel`}
							</Button>
							<Button type="submit" disabled={isSending || !email}>
								{isSending ? t`Sending...` : t`Send Invite`}
							</Button>
						</div>
					</form>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
