export const SITE_PACKAGE_FORMAT = "emdash-site-package";
export const SITE_PACKAGE_FORMAT_VERSION = "1";
export const SITE_PACKAGE_PROFILE = "full-transfer";

export const SUPPORTED_FORMAT_VERSIONS: readonly string[] = Object.freeze([
	SITE_PACKAGE_FORMAT_VERSION,
]);

export type SitePackageFormatVersion = typeof SITE_PACKAGE_FORMAT_VERSION;
