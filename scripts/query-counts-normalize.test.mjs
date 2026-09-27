import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSql } from "./query-counts-normalize.mjs";

await test("normalizes generated media-usage trigger identifiers", () => {
	const first =
		'CREATE TRIGGER "emdash_mu_cd1b792d0c2dccd0786492efd46cfd3c_ai" AFTER INSERT ON "ec_posts" BEGIN SELECT \'01M3FF8EHDMBBKRE803A4X5FAJ\'; END';
	const second =
		'CREATE TRIGGER "emdash_mu_fe90ada111a93c54facb3680e8b67325_ai" AFTER INSERT ON "ec_posts" BEGIN SELECT \'01M3FH0FKXXBNER0PF8GM3ZQSC\'; END';

	assert.equal(normalizeSql(first), normalizeSql(second));
	assert.equal(
		normalizeSql(first),
		'CREATE TRIGGER "emdash_mu_<collection>_ai" AFTER INSERT ON "ec_posts" BEGIN SELECT \'<collection-id>\'; END',
	);
});

await test("preserves ULID literals outside generated media-usage trigger DDL", () => {
	const sql = "SELECT * FROM entries WHERE id = '01M3FF8EHDMBBKRE803A4X5FAJ'";

	assert.equal(normalizeSql(sql), sql);
});

await test("keeps existing placeholder and whitespace normalization", () => {
	assert.equal(
		normalizeSql(" SELECT  *  FROM entries WHERE id IN (?, ?, ?) "),
		"SELECT * FROM entries WHERE id in (...)",
	);
});
