/**
 * In-memory DID document resolver. Used by both the aggregator (resolves
 * publisher DIDs to discover their PDS endpoint and signing key) and any
 * test-side code that needs to look up a DID document.
 *
 * Tests register DID documents via `register(did, doc)`; production resolves
 * via PLC directory or did:web HTTP. The interface matches the subset that
 * the aggregator's verification path actually calls.
 */

import type { AtprotoDid } from "./types.js";

/**
 * DID document subset the aggregator reads. Real DID documents have more
 * fields (alsoKnownAs, multiple verification methods, multiple services); we
 * only model what's load-bearing for verification + PDS routing.
 */
export interface DidDocument {
	id: AtprotoDid;
	alsoKnownAs?: string[];
	verificationMethod: Array<{
		id: string;
		type: string;
		controller: string;
		publicKeyMultibase: string;
	}>;
	service: Array<{
		id: string;
		type: string;
		serviceEndpoint: string;
	}>;
}

export interface BuildDidDocumentOptions {
	did: AtprotoDid;
	signingKeyMultibase: string;
	pdsEndpoint: string;
	handle?: string;
}

/**
 * Convenience builder for the most common DID document shape: one
 * `#atproto` Multikey verification method + one `#atproto_pds` PDS service.
 */
export function buildDidDocument(opts: BuildDidDocumentOptions): DidDocument {
	return {
		id: opts.did,
		alsoKnownAs: opts.handle ? [`at://${opts.handle}`] : [],
		verificationMethod: [
			{
				id: `${opts.did}#atproto`,
				type: "Multikey",
				controller: opts.did,
				publicKeyMultibase: opts.signingKeyMultibase,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: opts.pdsEndpoint,
			},
		],
	};
}

export class MockDidResolver {
	private docs = new Map<AtprotoDid, DidDocument>();

	register(did: AtprotoDid, doc: DidDocument): void {
		this.docs.set(did, doc);
	}

	resolve(did: AtprotoDid): DidDocument | null {
		return this.docs.get(did) ?? null;
	}

	/**
	 * Convenience for the aggregator's PDS-routing path: returns the
	 * `serviceEndpoint` of the `AtprotoPersonalDataServer` service entry, or
	 * null if the DID is unknown or the service is missing.
	 */
	pdsFor(did: AtprotoDid): string | null {
		const doc = this.docs.get(did);
		if (!doc) return null;
		const pds = doc.service.find(
			(s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
		);
		return pds?.serviceEndpoint ?? null;
	}

	/** Returns the `#atproto` signing key in multibase form. */
	signingKeyFor(did: AtprotoDid): string | null {
		const doc = this.docs.get(did);
		if (!doc) return null;
		const vm = doc.verificationMethod.find(
			(v) => v.id === `${did}#atproto` || v.id.endsWith("#atproto"),
		);
		return vm?.publicKeyMultibase ?? null;
	}

	clear(): void {
		this.docs.clear();
	}
}
