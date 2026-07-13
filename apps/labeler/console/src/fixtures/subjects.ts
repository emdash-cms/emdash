import type { SubjectRecord } from "../api/types.js";

/**
 * Read-only sample data (plan W9.3, static W8.1 fixtures dependency).
 * Shapes mirror apps/labeler/src/assessment-store.ts's `subjects` table.
 */

export const SUBJECT_ALPHA: SubjectRecord = {
	uri: "at://did:plc:z7x3g4k9m2q8w1r5t6y0u3i7/com.emdashcms.experimental.package.release/3lduzalpha0001",
	cid: "bafyreirk3vaepohxuw5ujlpiwztlnr3xj3bdiuivzl7dkxvzqqqzyxbziy",
	did: "did:plc:z7x3g4k9m2q8w1r5t6y0u3i7",
	collection: "com.emdashcms.experimental.package.release",
	rkey: "3lduzalpha0001",
	observedAt: "2026-07-08T09:10:00.000Z",
	deletedAt: null,
};

export const SUBJECT_BETA: SubjectRecord = {
	uri: "at://did:plc:h4n8b2v6c1x9z3m7k5j0q8w2/com.emdashcms.experimental.package.release/3lduzbeta0002",
	cid: "bafyreidmvd2b5c2cjdwk34ymwydyy3eh6n7ce5p4dm37bltiaputjjvb6w",
	did: "did:plc:h4n8b2v6c1x9z3m7k5j0q8w2",
	collection: "com.emdashcms.experimental.package.release",
	rkey: "3lduzbeta0002",
	observedAt: "2026-07-12T08:00:00.000Z",
	deletedAt: null,
};

export const SUBJECT_GAMMA: SubjectRecord = {
	uri: "at://did:plc:p9q2r5t8v1w4x7y0z3a6b9c2/com.emdashcms.experimental.package.release/3lduzgamma0003",
	cid: "bafyreirtyymrfqymf5zhtpyzzotvg3fy67qgmemz2ux6iheu6wvetl3ias",
	did: "did:plc:p9q2r5t8v1w4x7y0z3a6b9c2",
	collection: "com.emdashcms.experimental.package.release",
	rkey: "3lduzgamma0003",
	observedAt: "2026-07-12T11:25:00.000Z",
	deletedAt: null,
};

export const SUBJECT_DELTA: SubjectRecord = {
	uri: "at://did:plc:d2f5g8h1j4k7m0n3p6q9r2s5/com.emdashcms.experimental.package.release/3lduzdelta0004",
	cid: "bafyreiq2fy4ydmg6jz5aljtgdwgwp4fr6tgvte25pv55k4ynibtva2p3hx",
	did: "did:plc:d2f5g8h1j4k7m0n3p6q9r2s5",
	collection: "com.emdashcms.experimental.package.release",
	rkey: "3lduzdelta0004",
	observedAt: "2026-07-13T07:48:00.000Z",
	deletedAt: null,
};

export const SUBJECT_EPSILON: SubjectRecord = {
	uri: "at://did:plc:e3g6i9k2m5o8q1s4u7w0y3a6/com.emdashcms.experimental.package.release/3lduzepsilon05",
	cid: "bafyreic4ioya7s4elpagcfebx3hwhltmbmzgag7yx3q2smjhvt45i2dmts",
	did: "did:plc:e3g6i9k2m5o8q1s4u7w0y3a6",
	collection: "com.emdashcms.experimental.package.release",
	rkey: "3lduzepsilon05",
	observedAt: "2026-07-12T22:10:00.000Z",
	deletedAt: null,
};

export const FIXTURE_SUBJECTS: readonly SubjectRecord[] = [
	SUBJECT_ALPHA,
	SUBJECT_BETA,
	SUBJECT_GAMMA,
	SUBJECT_DELTA,
	SUBJECT_EPSILON,
];
