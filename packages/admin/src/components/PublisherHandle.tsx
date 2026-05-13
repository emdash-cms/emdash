/**
 * Renders an atproto publisher's identity, with three branches:
 *
 *   - **Verified handle**: shows `@handle`. Our local
 *     `LocalActorResolver` round-tripped the DID document's
 *     `alsoKnownAs` back to the same DID (verified by DNS TXT or
 *     `.well-known`, not by the aggregator).
 *   - **Unverified publisher**: DID document claims a handle but the
 *     handle's domain doesn't point back to the same DID, OR the
 *     aggregator's claimed handle doesn't match the bidirectionally
 *     verified one. Treat as untrusted -- the publisher might be
 *     impersonating someone else, or the aggregator might be lying
 *     about a handle. Surface as `Unverified publisher` in error
 *     styling. Callers should also disable destructive actions
 *     (install, etc.).
 *   - **Missing handle**: no handle claimed in the DID document (no
 *     `alsoKnownAs`), or the DID document couldn't be fetched
 *     (network error, unsupported DID method).
 *
 * `aggregatorHandle` is what the registry's `searchPackages` /
 * `resolvePackage` endpoint returned for this DID. It is NEVER trusted
 * on its own -- the aggregator is an untrusted indexer that could be
 * compromised or buggy. We always run our own DID->handle round-trip
 * via `LocalActorResolver` (cached in localStorage for 24h) and use
 * the aggregator's value only to *cross-check*: if the aggregator
 * claims a handle that differs from what the DID document
 * bidirectionally verifies, the publisher is marked invalid.
 */

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { resolveDidToHandle } from "../lib/api/registry.js";

/** Trailing dot(s) on an FQDN, stripped before handle comparison. */
const TRAILING_DOT = /\.+$/;

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
	// Always run the local DID->handle round-trip. We never trust the
	// aggregator's `aggregatorHandle` on its own: a compromised
	// aggregator could label an attacker DID as `stripe.com` and any
	// shortcut that returns the aggregator's value as verified would
	// let the impersonation through unchecked.
	const { data: didHandleResolution, isPending } = useQuery({
		queryKey: ["registry", "did-handle", did],
		queryFn: () => resolveDidToHandle(did),
		enabled: Boolean(did),
		staleTime: 5 * 60 * 1000,
	});

	if (isPending || !didHandleResolution) return { status: "missing" };

	// DID document didn't claim a handle (or the document was
	// unreachable). The aggregator might have one, but without our own
	// verification we can't display it.
	if (didHandleResolution.status === "missing") {
		return { status: "missing" };
	}

	// DID document claims a handle but it doesn't round-trip.
	// `invalid` always wins over an aggregator-supplied handle.
	if (didHandleResolution.status === "invalid") {
		return { status: "invalid" };
	}

	// Bidirectionally verified handle. Cross-check against the
	// aggregator's claim: if they differ, flag the publisher as
	// invalid. The aggregator may simply be stale, but we shouldn't
	// silently disagree with our own verification by showing the
	// aggregator's value -- the conservative read is "something is
	// off, surface it to the admin".
	const verifiedHandle = didHandleResolution.handle.toLowerCase();
	if (aggregatorHandle) {
		const claimed = aggregatorHandle.toLowerCase().replace(TRAILING_DOT, "");
		if (claimed !== verifiedHandle) {
			return { status: "invalid" };
		}
	}

	return { status: "ok", handle: didHandleResolution.handle };
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
