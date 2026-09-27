export function formatAdminVersion(
	version?: string,
	commit?: string,
	footerLabel: string | false = "EmDash",
): string {
	const versionText = `v${version || "0.0.0"}${commit ? ` (${commit})` : ""}`;
	return footerLabel === false ? versionText : `${footerLabel || "EmDash"} ${versionText}`;
}
