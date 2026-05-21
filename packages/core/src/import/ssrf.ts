/**
 * @deprecated Re-export shim. The SSRF helpers moved to
 * `packages/core/src/security/ssrf.ts` because they're now used outside
 * the import pipeline (registry installs, future trusted-fetch use
 * cases). New code should import from `#security/ssrf.js` directly.
 *
 * Existing import-pipeline callers keep working unchanged through this
 * shim. Remove once all callers have migrated.
 */

export {
	cloudflareDohResolver,
	resolveAndValidateExternalUrl,
	setDefaultDnsResolver,
	SsrfError,
	ssrfSafeFetch,
	stripCredentialHeaders,
	validateExternalUrl,
	normalizeIPv6MappedToIPv4,
	type DnsResolver,
} from "../security/ssrf.js";
