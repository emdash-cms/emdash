/**
 * Renders an atproto publisher's identity, with three branches:
 *
 *   - **Verified handle**: shows `@handle`. Either the aggregator
 *     already resolved the handle at ingest (we trust that), or our
 *     local `LocalActorResolver` round-tripped the DID document's
 *     `alsoKnownAs` back to the same DID.
 *   - **Unverified publisher**: DID document claims a handle but the
 *     handle's domain doesn't point back to the same DID. Treat as
 *     untrusted -- the publisher might be impersonating someone else.
 *     Surface as `Unverified publisher` in error styling. Callers
 *     should also disable destructive actions (install, etc.).
 *   - **Missing handle**: no claimed handle at all (or DID document
 *     resolution failed entirely). Fall back to the raw DID.
 *
 * `aggregatorHandle` is what the registry's `searchPackages` /
 * `resolvePackage` endpoint returned for this DID -- best-effort, may
 * be `null`. When absent, this component falls back to a per-DID
 * `LocalActorResolver` lookup via `resolveDidToHandle`, cached in
 * localStorage for 24h so repeat renders don't refetch.
 */

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { resolveDidToHandle } from "../lib/api/registry.js";

export type PublisherHandleStatus = "ok" | "invalid" | "missing";

export interface PublisherHandleResult {
	status: PublisherHandleStatus;
	/** Verified handle (only present when `status === "ok"`). */
	handle?: string;
}

export interface PublisherHandleProps {
	did: string;
	aggregatorHandle?: string | null;
	/**
	 * Called every time the resolution status changes, so callers can
	 * gate install buttons or other side effects on
	 * `status === "invalid"`. Optional.
	 */
	onResolved?: (result: PublisherHandleResult) => void;
	/** Visual variant. `card` is the smaller list-item form. */
	variant?: "card" | "detail";
	className?: string;
}

/**
 * Hook form: returns the same tri-state result without rendering. Use
 * when a parent needs to coordinate UI (e.g. disable install) based on
 * the resolution.
 */
export function usePublisherHandle(
	did: string,
	aggregatorHandle?: string | null,
): PublisherHandleResult {
	const { data: didHandleResolution } = useQuery({
		queryKey: ["registry", "did-handle", did],
		queryFn: () => resolveDidToHandle(did),
		enabled: Boolean(did) && !aggregatorHandle,
		staleTime: 5 * 60 * 1000,
	});

	if (aggregatorHandle) return { status: "ok", handle: aggregatorHandle };
	if (!didHandleResolution) return { status: "missing" };
	if (didHandleResolution.status === "ok") {
		return { status: "ok", handle: didHandleResolution.handle };
	}
	return { status: didHandleResolution.status };
}

export function PublisherHandle({
	did,
	aggregatorHandle,
	onResolved,
	variant = "card",
	className,
}: PublisherHandleProps) {
	const { t } = useLingui();
	const result = usePublisherHandle(did, aggregatorHandle);

	// Notify the caller every time the result changes. Effect (not
	// inline) so we don't re-fire on every parent re-render.
	const onResolvedRef = React.useRef(onResolved);
	onResolvedRef.current = onResolved;
	React.useEffect(() => {
		onResolvedRef.current?.(result);
	}, [result.status, result.handle]);

	const textClass = variant === "card" ? "text-xs" : "text-sm";

	if (result.status === "ok" && result.handle) {
		return (
			<span className={`truncate ${textClass} text-kumo-subtle ${className ?? ""}`}>
				@{result.handle}
			</span>
		);
	}

	if (result.status === "invalid") {
		return (
			<span className={`truncate ${textClass} font-medium text-kumo-error ${className ?? ""}`}>
				{t`Unverified publisher`}
			</span>
		);
	}

	return <span className={`truncate ${textClass} text-kumo-subtle ${className ?? ""}`}>{did}</span>;
}
