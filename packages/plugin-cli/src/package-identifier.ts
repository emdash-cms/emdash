export function formatPublisherIdentifier(publisher: string): string {
	if (publisher.startsWith("did:") || publisher.startsWith("@")) return publisher;
	return `@${publisher}`;
}

export function formatPackageIdentifier(publisher: string | undefined, slug: string): string {
	return publisher ? `${formatPublisherIdentifier(publisher)}/${slug}` : slug;
}

export function formatPackageReleaseIdentifier(
	publisher: string | undefined,
	slug: string,
	version: string,
): string {
	return `${formatPackageIdentifier(publisher, slug)}@${version}`;
}

export function pluginPageUrl(publisherHandle: string, slug: string): string {
	return `https://plugins.emdashcms.com/plugins/${formatPackageIdentifier(publisherHandle, slug)}`;
}
