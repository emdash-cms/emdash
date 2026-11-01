import { Input, LayerDialog, Select } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { ApiResponseError } from "../../lib/api/client.js";
import {
	focusFirstInvalid,
	guardUnsavedInput,
	revealErrors,
	useValueAtFailure,
} from "../../lib/dialog-form.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { HelpLabel } from "../FieldHelpLabel.js";
import { useRolesConfig } from "./useRolesConfig.js";

const DEFAULT_ROLE = 30; // Author

/** The address check the server applies to an invite (Zod's `z.email()`). */
const EMAIL_PATTERN =
	/^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

function emailProblem(email: string): MessageDescriptor | undefined {
	if (!email) return msg`Enter an email address.`;
	if (!EMAIL_PATTERN.test(email)) {
		return msg`Enter a valid email address, such as name@example.com.`;
	}
	return undefined;
}

function isUserExists(error: unknown): boolean {
	return error instanceof ApiResponseError && error.code === "USER_EXISTS";
}

export interface InviteUserModalProps {
	open: boolean;
	isSending?: boolean;
	/** The last invite request's failure; pass the mutation's `error`. */
	error?: unknown;
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
	const [role, setRole] = React.useState(DEFAULT_ROLE);
	const [copied, setCopied] = React.useState(false);
	const [copyError, setCopyError] = React.useState(false);
	const [submitted, setSubmitted] = React.useState(false);
	const [sentEmail, setSentEmail] = React.useState<string | null>(null);
	const formId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);

	const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// Reset form when modal opens
	React.useEffect(() => {
		if (open) {
			setEmail("");
			setRole(DEFAULT_ROLE);
			setCopied(false);
			setCopyError(false);
			setSubmitted(false);
			setSentEmail(null);
		}
	}, [open]);

	const trimmedEmail = email.trim();
	const emailAtFailure = useValueAtFailure(error, trimmedEmail);
	// An address edited while the request ran isn't the one refused, so its refusal stays in the banner.
	const refusedOnField = isUserExists(error) && emailAtFailure === sentEmail;
	const emailTaken = refusedOnField && sentEmail === trimmedEmail;
	const problem = emailTaken
		? msg`Another user already uses this email address. Enter a different one.`
		: emailProblem(trimmedEmail);
	const emailError = submitted && problem ? t(problem) : undefined;
	const requestError = refusedOnField ? null : getMutationError(error);

	// Sending disables the action, so focus has left the form by the time the address is refused.
	React.useEffect(() => {
		if (refusedOnField) focusFirstInvalid(formRef.current);
	}, [error, refusedOnField]);

	// Clean up timeout on unmount
	React.useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (isSending) return;
		if (problem) {
			const form = e.currentTarget;
			revealErrors(form, () => setSubmitted(true));
			return;
		}
		setSubmitted(true);
		setSentEmail(trimmedEmail);
		onInvite(trimmedEmail, role);
	};

	// The invite link can't be shown again, so only Done or Escape may dismiss it.
	const unsaved = inviteUrl ? true : trimmedEmail !== "" || role !== DEFAULT_ROLE;

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
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(unsaved, onOpenChange)}
			dismissDisabled={isSending}
		>
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
								className="block rounded bg-kumo-tint px-3 py-2 text-sm font-mono border break-all"
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
						<form ref={formRef} id={formId} noValidate onSubmit={handleSubmit}>
							<div className="grid gap-5">
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
									error={emailError}
									aria-invalid={emailError ? true : undefined}
								/>

								{/* Role */}
								<Select
									label={
										<HelpLabel
											help={t`The invited user will have this role once they complete registration.`}
										>
											{t`Role`}
										</HelpLabel>
									}
									aria-label={t`Role`}
									className="w-full"
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

								<DialogError message={requestError} />
							</div>
						</form>
					)}
				</LayerDialog.Body>
				{inviteUrl ? (
					<LayerDialog.Actions dismissLabel={t`Done`}>
						{/* The key mounts a new button rather than reusing Send's, so autoFocus applies. */}
						<LayerDialog.Action key="copy-invite-link" autoFocus onClick={handleCopyUrl}>
							{t`Copy invite link`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				) : (
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action type="submit" form={formId} disabled={isSending}>
							{isSending ? t`Sending...` : t`Send Invite`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				)}
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
