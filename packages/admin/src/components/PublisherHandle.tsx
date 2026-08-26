/**
 * Publisher identity for ordinary registry views.
 *
 * Mutable handles are outside the package-profile CID's moderation boundary,
 * so browse and detail pages render only an approved author name or a stable,
 * shortened DID. Routing likewise uses the full DID.
 */

export interface PublisherIdentityProfile {
	authors?: readonly { name?: unknown }[];
}

export function approvedPublisherName(
	profile: PublisherIdentityProfile | null | undefined,
): string | null {
	for (const author of profile?.authors ?? []) {
		if (typeof author.name === "string" && author.name.trim().length > 0) {
			return author.name;
		}
	}
	return null;
}

export function shortenPublisherDid(did: string): string {
	if (did.length <= 24) return did;
	return `${did.slice(0, 12)}…${did.slice(-8)}`;
}

export interface PublisherIdentityProps {
	did: string;
	profile?: PublisherIdentityProfile | null;
	variant?: "card" | "detail";
	className?: string;
}

export function PublisherIdentity({
	did,
	profile,
	variant = "card",
	className,
}: PublisherIdentityProps) {
	const name = approvedPublisherName(profile);
	const textClass = variant === "card" ? "text-xs" : "text-sm";
	return (
		<bdi
			dir="auto"
			className={`truncate ${textClass} text-kumo-subtle ${className ?? ""}`}
			title={name ? undefined : did}
		>
			{name ?? shortenPublisherDid(did)}
		</bdi>
	);
}
