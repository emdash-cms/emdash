import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";
import {
	getContactState,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
	confirmContact,
	suppress,
} from "../src/notification-contacts.js";
import {
	type ContactTarget,
	resolvePublisherContact,
	seedPublisherContact,
} from "../src/publisher-contact.js";

interface TestEnv {
	DB: D1Database;
	AGGREGATOR: Fetcher;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "pepper-contact";
const TARGET: ContactTarget = { did: "did:plc:publisher", slug: "some-plugin" };

/**
 * A fake {@link AggregatorClient} whose `getPackage`/`getPublisher` return the
 * supplied verbatim `profile` (wrapped in the view envelope the real methods
 * return) or `null` for a not-indexed read. Records call counts so a test can
 * prove the tier walk short-circuits and doesn't over-fetch.
 */
function makeClient(pkgProfile: unknown, pubProfile: unknown) {
	const calls = { getPackage: 0, getPublisher: 0 };
	const client = {
		getPackage: () => {
			calls.getPackage++;
			return Promise.resolve(pkgProfile === null ? null : { profile: pkgProfile });
		},
		getPublisher: () => {
			calls.getPublisher++;
			return Promise.resolve(pubProfile === null ? null : { profile: pubProfile });
		},
	} as unknown as AggregatorClient;
	return { client, calls };
}

const packageProfile = (opts: { security?: unknown[]; authors?: unknown[] }) => ({
	$type: "com.emdashcms.experimental.package.profile",
	type: "emdash-plugin",
	license: "MIT",
	security: opts.security ?? [],
	authors: opts.authors ?? [],
});

const publisherProfile = (contact: unknown[]) => ({
	$type: "com.emdashcms.experimental.publisher.profile",
	displayName: "Acme",
	contact,
});

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("resolvePublisherContact tier walk", () => {
	it("tier 1: returns the first package security email", async () => {
		const { client, calls } = makeClient(
			packageProfile({
				security: [{ email: "sec@pkg.test" }],
				authors: [{ name: "A", email: "a@pkg.test" }],
			}),
			null,
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({ email: "sec@pkg.test", tier: "package_security" });
		// A tier-1 hit must not read the publisher profile.
		expect(calls.getPublisher).toBe(0);
	});

	it("tier 1 url-only falls through to a tier 2 author email", async () => {
		const { client } = makeClient(
			packageProfile({
				security: [{ url: "https://pkg.test/security" }],
				authors: [
					{ name: "A", url: "https://a.test" },
					{ name: "B", email: "b@pkg.test" },
				],
			}),
			null,
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({ email: "b@pkg.test", tier: "package_author" });
	});

	it("all package contacts url-only falls through to tier 3 publisher contact", async () => {
		const { client, calls } = makeClient(
			packageProfile({
				security: [{ url: "https://pkg.test/security" }],
				authors: [{ name: "A", url: "https://a.test" }],
			}),
			publisherProfile([{ kind: "general", email: "hello@acme.test" }]),
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({
			email: "hello@acme.test",
			tier: "publisher_profile",
			kind: "general",
		});
		expect(calls.getPublisher).toBe(1);
	});

	it("tier 3 prefers a kind:security channel over an earlier general one", async () => {
		const { client } = makeClient(
			packageProfile({
				security: [{ url: "https://pkg.test/s" }],
				authors: [{ name: "A", url: "https://a.test" }],
			}),
			publisherProfile([
				{ kind: "general", email: "general@acme.test" },
				{ kind: "security", email: "security@acme.test" },
			]),
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({
			email: "security@acme.test",
			tier: "publisher_profile",
			kind: "security",
		});
	});

	it("tier 3 takes the first email when no security channel carries one", async () => {
		const { client } = makeClient(
			packageProfile({
				security: [{ url: "https://pkg.test/s" }],
				authors: [{ name: "A", url: "https://a.test" }],
			}),
			publisherProfile([
				{ kind: "security", url: "https://acme.test/security" },
				{ kind: "general", email: "general@acme.test" },
			]),
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({
			email: "general@acme.test",
			tier: "publisher_profile",
			kind: "general",
		});
	});

	it("returns none when no tier carries an email", async () => {
		const { client } = makeClient(
			packageProfile({
				security: [{ url: "https://pkg.test/s" }],
				authors: [{ name: "A", url: "https://a.test" }],
			}),
			publisherProfile([{ kind: "general", url: "https://acme.test" }]),
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({ none: "no_email_contact" });
	});

	it("still resolves tier 3 when the package is not indexed", async () => {
		const { client, calls } = makeClient(
			null,
			publisherProfile([{ kind: "security", email: "security@acme.test" }]),
		);
		const result = await resolvePublisherContact(client, TARGET);
		expect(result).toEqual({
			email: "security@acme.test",
			tier: "publisher_profile",
			kind: "security",
		});
		expect(calls.getPackage).toBe(1);
		expect(calls.getPublisher).toBe(1);
	});

	it("returns none when neither package nor publisher is indexed", async () => {
		const { client } = makeClient(null, null);
		expect(await resolvePublisherContact(client, TARGET)).toEqual({ none: "no_email_contact" });
	});

	it("skips whitespace-only emails", async () => {
		const { client } = makeClient(
			packageProfile({
				security: [{ email: "   " }],
				authors: [{ name: "A", email: "real@pkg.test" }],
			}),
			null,
		);
		expect(await resolvePublisherContact(client, TARGET)).toEqual({
			email: "real@pkg.test",
			tier: "package_author",
		});
	});

	it("propagates a transport failure rather than reporting no contact", async () => {
		const client = {
			getPackage: () => Promise.reject(new Error("binding unreachable")),
			getPublisher: () => Promise.reject(new Error("binding unreachable")),
		} as unknown as AggregatorClient;
		await expect(resolvePublisherContact(client, TARGET)).rejects.toThrow("binding unreachable");
	});
});

describe("seedPublisherContact", () => {
	it("seeds an unconfirmed contact keyed by the recipient hash", async () => {
		const email = "seed-me@pkg.test";
		const { client } = makeClient(packageProfile({ security: [{ email }] }), null);
		const outcome = await seedPublisherContact(
			client,
			db(),
			PEPPER,
			TARGET,
			new Date().toISOString(),
		);

		const expectedHash = await recipientHash(PEPPER, email);
		expect(outcome).toEqual({
			seeded: true,
			recipientHash: expectedHash,
			tier: "package_security",
		});
		const state = await getContactState(db(), expectedHash);
		expect(state?.confirmState).toBe("unconfirmed");
	});

	it("does not seed a suppressed address", async () => {
		const email = "suppressed@pkg.test";
		const hash = await recipientHash(PEPPER, email);
		await suppress(db(), hash, "unsubscribe", new Date().toISOString(), Date.now());

		const { client } = makeClient(packageProfile({ security: [{ email }] }), null);
		const outcome = await seedPublisherContact(
			client,
			db(),
			PEPPER,
			TARGET,
			new Date().toISOString(),
		);

		expect(outcome).toEqual({ seeded: false, reason: "suppressed" });
		expect(await getContactState(db(), hash)).toBeNull();
	});

	it("does not reset an already-confirmed contact to unconfirmed", async () => {
		const email = "confirmed@pkg.test";
		const hash = await recipientHash(PEPPER, email);
		const token = "raw-confirm-token";
		const tokenHash = await hashConfirmToken(token);
		const now = new Date().toISOString();
		await seedPublisherContact(
			makeClient(packageProfile({ security: [{ email }] }), null).client,
			db(),
			PEPPER,
			TARGET,
			now,
		);
		await recordConfirmSent(db(), hash, tokenHash, Date.now());
		await confirmContact(db(), hash, tokenHash, now);
		expect((await getContactState(db(), hash))?.confirmState).toBe("confirmed");

		const { client } = makeClient(packageProfile({ security: [{ email }] }), null);
		const outcome = await seedPublisherContact(
			client,
			db(),
			PEPPER,
			TARGET,
			new Date().toISOString(),
		);

		expect(outcome).toEqual({ seeded: true, recipientHash: hash, tier: "package_security" });
		expect((await getContactState(db(), hash))?.confirmState).toBe("confirmed");
	});

	it("reports no contact without touching the database", async () => {
		const { client } = makeClient(
			packageProfile({ security: [{ url: "https://pkg.test/s" }] }),
			null,
		);
		const outcome = await seedPublisherContact(
			client,
			db(),
			PEPPER,
			TARGET,
			new Date().toISOString(),
		);
		expect(outcome).toEqual({ seeded: false, reason: "no_email_contact" });
	});
});

describe("resolvePublisherContact over the AGGREGATOR service binding", () => {
	// Drives the resolver through the real binding and both new read methods:
	// the stub's package view is url-only (tiers 1-2 miss) and its publisher
	// view carries a security email (tier 3 hits), so one resolution proves the
	// full walk survives the binding hop end to end.
	it("walks package + publisher reads through the binding to a tier-3 email", async () => {
		const client = new AggregatorClient(testEnv.AGGREGATOR);
		const result = await resolvePublisherContact(client, {
			did: "did:plc:stubpublisher",
			slug: "stub-plugin",
		});
		expect(result).toEqual({
			email: "security@stub.example",
			tier: "publisher_profile",
			kind: "security",
		});
	});
});
