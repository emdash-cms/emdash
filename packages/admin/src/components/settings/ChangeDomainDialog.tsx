import { Button, Input, LayerDialog } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError, changeSiteDomain, updateSettings } from "../../lib/api";
import {
	focusFirstInvalid,
	guardUnsavedInput,
	revealErrors,
	useSingleFlight,
} from "../../lib/dialog-form.js";
import { DialogError, getMutationError } from "../DialogError.js";

export interface ChangeDomainDialogProps {
	open: boolean;
	currentUrl?: string;
	configuredUrl?: string;
	onClose: () => void;
	onChanged: (url: string, checked: boolean) => void;
}

const TRAILING_SLASHES = /\/+$/;

/** Turn what the user typed into a URL to store without the domain check. */
export function uncheckedSiteUrl(input: string): string | undefined {
	const trimmed = input.trim();
	const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	if (!trimmed || !URL.canParse(candidate)) return undefined;
	const url = new URL(candidate);
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (url.username || url.password) return undefined;
	return `${url.origin}${url.pathname.replace(TRAILING_SLASHES, "")}`;
}

/** The reason a domain check failed, in the admin language, from the error's details. */
function domainCheckFailure(error: unknown): string | undefined {
	if (!(error instanceof ApiResponseError) || error.code !== "DOMAIN_CHECK_FAILED")
		return undefined;
	const { reason, host, origin, target } = error.details ?? {};
	if (reason === "NO_PUBLIC_ADDRESS" && typeof host === "string") {
		return i18n._(msg`${host} does not resolve to a public address`);
	}
	if (typeof origin !== "string") return undefined;
	switch (reason) {
		case "UNREACHABLE":
			return i18n._(msg`Could not reach ${origin}`);
		case "REDIRECT":
			return typeof target === "string"
				? i18n._(msg`${origin} redirects to ${target}. Enter that address instead.`)
				: i18n._(msg`${origin} redirects elsewhere`);
		case "NOT_SERVING":
			return i18n._(msg`${origin} does not serve this site yet`);
		default:
			return undefined;
	}
}

export function ChangeDomainDialog({
	open,
	currentUrl,
	configuredUrl,
	onClose,
	onChanged,
}: ChangeDomainDialogProps) {
	const { t } = useLingui();
	const [domain, setDomain] = React.useState("");
	const [submitted, setSubmitted] = React.useState(false);
	const formId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);

	const checkMutation = useMutation({
		mutationFn: (value: string) => changeSiteDomain(value),
		onSuccess: ({ url }) => onChanged(url, true),
	});
	const uncheckedMutation = useMutation({
		mutationFn: async (url: string) => {
			await updateSettings({ url });
			return url;
		},
		onSuccess: (url) => onChanged(url, false),
	});

	React.useEffect(() => {
		if (!open) return;
		setDomain("");
		setSubmitted(false);
		checkMutation.reset();
		uncheckedMutation.reset();
	}, [open]);

	const isPending = checkMutation.isPending || uncheckedMutation.isPending;
	const fallbackUrl = checkMutation.isError ? uncheckedSiteUrl(domain) : undefined;
	const checkError = checkMutation.error;
	const domainRejected =
		checkError instanceof ApiResponseError &&
		(checkError.code === "VALIDATION_ERROR" || checkError.code === "DOMAIN_CHECK_FAILED");
	const formatHint = t`Enter a domain such as example.com, without a path or port`;
	const fieldError = domainRejected
		? checkError.code === "VALIDATION_ERROR"
			? formatHint
			: (domainCheckFailure(checkError) ?? checkError.message)
		: submitted && !domain.trim()
			? formatHint
			: undefined;
	const errorMessage = domainRejected
		? getMutationError(uncheckedMutation.error)
		: getMutationError(checkError ?? uncheckedMutation.error);

	// The input is disabled while the check runs, so focus has left it by the time the check fails.
	React.useEffect(() => {
		if (domainRejected) focusFirstInvalid(formRef.current);
	}, [checkError, domainRejected]);

	const runCheck = useSingleFlight((value: string) => checkMutation.mutateAsync(value));
	const saveUnchecked = useSingleFlight((url: string) => uncheckedMutation.mutateAsync(url));

	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isPending) return;
		if (!domain.trim()) {
			const form = event.currentTarget;
			revealErrors(form, () => setSubmitted(true));
			return;
		}
		uncheckedMutation.reset();
		runCheck(domain.trim());
	};

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(domain.trim() !== "", (nextOpen) => {
				if (!nextOpen && !isPending) onClose();
			})}
			dismissDisabled={isPending}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Change domain`}</LayerDialog.Title>
				<LayerDialog.Description>
					{currentUrl && <>{t`Your site is currently at ${currentUrl}.`} </>}
					{configuredUrl
						? t`Sitemaps and absolute URLs in search and social metadata will use the new domain. Links in emails and plugins keep using ${configuredUrl}, set by the deployment configuration.`
						: t`Links in emails and plugins, sitemaps, and absolute URLs in search and social metadata will use the new domain.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form ref={formRef} id={formId} onSubmit={submit} noValidate className="grid gap-5">
						<ol className="grid list-decimal gap-2 ps-5 text-sm">
							<li>
								{t`Point the domain at this site. On Cloudflare, open your Worker in Workers & Pages, go to the Domains tab, and add the domain.`}
							</li>
							<li>{t`Enter the domain below. EmDash checks that it serves this site before switching.`}</li>
						</ol>

						<Input
							label={t`New domain`}
							placeholder={t`example.com`}
							value={domain}
							onChange={(event) => {
								setDomain(event.target.value);
								checkMutation.reset();
								uncheckedMutation.reset();
							}}
							autoFocus
							disabled={isPending}
							dir="ltr"
							autoComplete="off"
							spellCheck={false}
							required
							error={fieldError}
							aria-invalid={fieldError ? true : undefined}
						/>

						<p className="text-sm text-kumo-subtle">
							{t`Passkeys only work at the address where they were created. After switching, keep signing in at the current address, or use an email sign-in link at the new one.`}
						</p>

						<DialogError message={errorMessage} />
						{fallbackUrl && (
							<div className="grid gap-2 rounded-md border border-kumo-line p-3 text-sm">
								<p>
									{t`If the site can't be reached from the internet yet, for example on localhost or behind a login, you can use the address without the check.`}
								</p>
								<div>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										disabled={isPending}
										loading={uncheckedMutation.isPending}
										onClick={() => saveUnchecked(fallbackUrl)}
									>
										{t`Use ${fallbackUrl} anyway`}
									</Button>
								</div>
							</div>
						)}
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={isPending}>
						{checkMutation.isPending ? t`Checking…` : t`Check and switch`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
