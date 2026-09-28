import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { resolveDidToHandle } from "../lib/api/registry.js";
import {
	registryIdentity,
	registryIdentityPublisherParam,
	type RegistryIdentity,
} from "../lib/registry-identity.js";
import { cn } from "../lib/utils.js";

export function useRegistryPluginIdentity(
	did: string | undefined,
	slug: string | undefined,
): RegistryIdentity | null {
	const { data } = useQuery({
		queryKey: ["registry", "publisher-handle", did],
		queryFn: () => resolveDidToHandle(did!),
		enabled: Boolean(did && slug),
	});
	if (!did || !slug) return null;
	return registryIdentity(did, slug, data);
}

export interface RegistryPluginIdentityProps {
	identity: RegistryIdentity;
	invalidMessage: string;
	className?: string;
	linked?: boolean;
}

export function RegistryPluginIdentity({
	identity,
	invalidMessage,
	className,
	linked = true,
}: RegistryPluginIdentityProps) {
	const { t } = useLingui();

	if (identity.status === "ok") {
		const publicName = (
			<code className="truncate font-mono text-kumo-link" dir="auto">
				{identity.publicName}
			</code>
		);
		return (
			<div className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)}>
				{linked ? (
					<Link
						to="/plugins/registry/$publisher/$slug"
						params={{
							publisher: registryIdentityPublisherParam(identity),
							slug: identity.slug,
						}}
						className="min-w-0 hover:underline"
					>
						{publicName}
					</Link>
				) : (
					publicName
				)}
				<CheckCircle
					className="h-4 w-4 shrink-0 text-kumo-success"
					weight="fill"
					aria-label={t`Verified publisher`}
				/>
			</div>
		);
	}

	if (identity.status === "invalid") {
		return (
			<div className={cn("mt-1 flex flex-wrap items-center gap-2", className)} role="alert">
				<Badge variant="destructive">
					<WarningCircle className="me-1 h-3.5 w-3.5" weight="fill" aria-hidden="true" />
					{t`INVALID HANDLE`}
				</Badge>
				<span className="text-sm font-medium text-kumo-danger">{invalidMessage}</span>
			</div>
		);
	}

	const fallbackName = `${identity.did}/${identity.slug}`;
	return (
		<div
			className={cn(
				"flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-kumo-subtle",
				className,
			)}
		>
			<code className="min-w-0 max-w-full truncate font-mono" dir="auto" title={fallbackName}>
				{fallbackName}
			</code>
			{identity.status === "missing" ? (
				<span>{t`Handle unavailable`}</span>
			) : (
				<span>{t`Resolving publisher handle...`}</span>
			)}
		</div>
	);
}
