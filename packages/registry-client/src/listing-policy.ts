import { ClientResponseError } from "@atcute/client";
import type { ListingVisibilityState } from "@emdash-cms/registry-moderation";

export interface RegistryLabelerPolicy {
	/** Official clients always require the aggregator's approved listing projection. */
	enforcement: "required";
	/** Optional bare-DID declaration used for requests and cache identity; aggregator policy remains authoritative. */
	acceptLabelers?: string;
}

function normalizeAcceptLabelers(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function registryLabelerPolicy(acceptLabelers?: string): RegistryLabelerPolicy {
	const normalized = normalizeAcceptLabelers(acceptLabelers);
	return normalized === undefined
		? { enforcement: "required" }
		: { enforcement: "required", acceptLabelers: normalized };
}

export function registryLabelerPolicyKey(policy: RegistryLabelerPolicy): string {
	return `${policy.enforcement}\u0000${normalizeAcceptLabelers(policy.acceptLabelers) ?? "aggregator-default"}`;
}

export interface ApprovedListing<T> {
	status: Extract<ListingVisibilityState, "passed">;
	value: T;
}

export interface UnavailableListing {
	status: Extract<ListingVisibilityState, "unavailable">;
	reason: "listing-unavailable";
}

export type ListingStatusResult<T> = ApprovedListing<T> | UnavailableListing;

export async function mapListingStatus<T>(request: Promise<T>): Promise<ListingStatusResult<T>> {
	try {
		return { status: "passed", value: await request };
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "ListingUnavailable") {
			return { status: "unavailable", reason: "listing-unavailable" };
		}
		throw error;
	}
}
