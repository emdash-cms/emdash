import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPageIndex, findLinkIssues } from "./lib/linkcheck.mjs";

const site = "https://docs.example.com";
const cliPath = fileURLToPath(new URL("./lint-linkcheck.mjs", import.meta.url));

function checkLinks(directory, options = { site }) {
	return findLinkIssues(buildPageIndex(directory), options);
}

function fixture(t, files) {
	const directory = mkdtempSync(join(tmpdir(), "docs-links-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	return directory;
}

void test("reports stale same-page and cross-page links after a heading is renamed", (t) => {
	const directory = fixture(t, {
		"guide/index.html": '<a href="#old-section">Local</a><h2 id="new-section">New section</h2>',
		"index.html": '<a href="/guide/#old-section">Guide</a>',
	});
	const { issues } = checkLinks(directory);
	assert.equal(issues.length, 2);
	assert.ok(issues.includes("/guide/: #old-section -> missing #old-section in /guide/"));
	assert.ok(issues.includes("/: /guide/#old-section -> missing #old-section in /guide/"));
	writeFileSync(
		join(directory, "guide/index.html"),
		'<a href="#new-section">Local</a><h2 id="new-section">New section</h2>',
	);
	writeFileSync(join(directory, "index.html"), '<a href="/guide/#new-section">Guide</a>');
	assert.deepEqual(checkLinks(directory).issues, []);
});

void test("uses rendered IDs, named anchors and browser URL resolution", (t) => {
	const directory = fixture(t, {
		"guide/index.html": `
			<h2 id="generated-1">Duplicate heading</h2><div id="custom-id"></div>
			<a name="legacy"></a><div id="a&amp;b"></div><div id="a+b"></div>
			<div id="%61"></div><div id="100%"></div>
			<a href="#generated-1">Generated ID</a><a href="?q=1#custom-id">Query</a>
			<a href="./#legacy">Named anchor</a><a href="#a&amp;b">HTML entity</a>
			<a href="#a%2Bb">Encoded plus</a><a href="#%61">Literal percent ID</a>
			<a href="#100%">Percent sign</a><a href="#">Page top</a><a href="#ToP">Page top</a>
			<a href="#generated-1:~:text=heading">Text directive with ID</a>
			<a href="#:~:text=heading">Text directive</a>
			<a href="../日本語/#見出し">Unicode</a>
			<a href="../%E6%97%A5%E6%9C%AC%E8%AA%9E/#%E8%A6%8B%E5%87%BA%E3%81%97">Encoded Unicode</a>
		`,
		"日本語/index.html": '<h2 id="見出し">Heading</h2>',
		"index.html": `
			<a href="/guide#custom-id">Without trailing slash</a>
			<a href="/guide/index.html#custom-id">HTML file</a>
			<a href="${site}/guide/#custom-id">Absolute URL</a>
			<a href="//docs.example.com/guide/#custom-id">Protocol-relative URL</a>
			<a href="/guide/?a=1&amp;b=2#custom-id">Query and entity</a>
		`,
	});
	assert.deepEqual(checkLinks(directory).issues, []);
});

void test("does not treat escaped code, scripts, comments or templates as live links", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<pre><code>&lt;a href="#missing"&gt;Example&lt;/a&gt;</code></pre>
			<script>const example = '<a href="#missing">Example</a>';</script>
			<!-- <a href="#missing">Example</a> -->
			<template><a href="#missing">Example</a></template>
		`,
	});
	assert.equal(checkLinks(directory).links, 0);
});

void test("does not accept an ID that exists only in an inert template or code example", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="#missing">Broken</a><template><h2 id="missing">Example</h2></template>
			<pre><code>&lt;h2 id="missing"&gt;Example&lt;/h2&gt;</code></pre>
		`,
	});
	assert.ok(checkLinks(directory).issues.some((issue) => issue.includes("missing #missing")));
});

void test("checks real links inside code blocks and matches IDs case-sensitively", (t) => {
	const directory = fixture(t, {
		"index.html": '<h2 id="section"></h2><pre><a href="#Section">Link</a></pre>',
	});
	assert.ok(checkLinks(directory).issues.some((issue) => issue.includes("missing #Section")));
});

void test("follows configured redirects, inheriting or replacing fragments", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="/old/#section">Inherited</a><a href="/replaced#old">Replaced</a>
			<a href="/cleared#old">Cleared</a><a href="/external#missing">External</a>
		`,
		"guide/index.html": '<h2 id="section">Section</h2>',
	});
	const redirects = {
		"/old/": "/intermediate",
		"/intermediate": { destination: "/guide/", status: 301 },
		"/replaced": "/guide/#section",
		"/cleared": "/guide/#",
		"/external": "https://example.com/guide/",
	};
	assert.deepEqual(checkLinks(directory, { site, redirects }).issues, []);
	assert.ok(
		checkLinks(directory, {
			site,
			redirects: { ...redirects, "/old/": "/guide/#missing" },
		}).issues.some((issue) => issue.includes("missing #missing in /guide/")),
	);
});

void test("reports missing pages and redirect loops instead of silently skipping them", (t) => {
	const directory = fixture(t, {
		"index.html":
			'<a href="/missing/#section">Missing</a><a href="/loop#section">Loop</a><a href="/empty/#">Empty fragment</a>',
	});
	const { issues } = checkLinks(directory, { site, redirects: { "/loop": "/loop" } });
	assert.ok(issues.some((issue) => issue.includes("no generated page or file at /missing/")));
	assert.ok(issues.some((issue) => issue.includes("no generated page or file at /empty/")));
	assert.ok(issues.some((issue) => issue.includes("redirect loop")));
});

void test("ignores external URLs and non-HTTP schemes, and accepts pages and non-HTML assets", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="https://example.com/#missing">External</a><a href="mailto:me@example.com#x">Mail</a>
			<a href="blob:${site}/example#missing">Blob</a><a href="/guide/">Guide</a>
			<a href="/image.svg#icon">SVG</a><a href="/book.pdf#page=2">PDF</a>
		`,
		"image.svg": '<svg><symbol id="icon"/></svg>',
		"book.pdf": "pdf",
		"guide/index.html": "<h1>Guide</h1>",
	});
	assert.deepEqual(checkLinks(directory).issues, []);
});

void test("resolves relative links against the document base URL", (t) => {
	const directory = fixture(t, {
		"index.html": '<base href="/guide/"><a href="#section">Section</a>',
		"guide/index.html": '<h2 id="section">Section</h2>',
	});
	assert.deepEqual(checkLinks(directory).issues, []);
});

void test("fails if the build output contains no HTML", (t) => {
	const directory = fixture(t, {});
	assert.throws(
		() => buildPageIndex(directory),
		(error) => error.message.includes("No generated HTML pages found"),
	);
});

void test("reports missing internal pages without fragments", (t) => {
	const directory = fixture(t, {
		"index.html":
			'<a href="/removed-guide/">Removed guide</a><a href="/missing.svg#icon">Missing SVG</a>',
	});
	assert.deepEqual(checkLinks(directory).issues, [
		"/: /removed-guide/ -> no generated page or file at /removed-guide/",
		"/: /missing.svg#icon -> no generated page or file at /missing.svg",
	]);
});

function builtDocsFixture(t, html) {
	return fixture(t, {
		".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../output/worker.json" }),
		"output/worker.json": JSON.stringify({ assets: { directory: "../rendered" } }),
		"rendered/guide/index.html": html,
	});
}

void test("the CLI checks the asset directory from the generated deployment configuration", (t) => {
	const directory = builtDocsFixture(t, '<h2 id="section">Section</h2><a href="#section">Link</a>');
	const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes("HTML pages checked: 1; internal links checked: 1."));
});

void test("the CLI follows redirects emitted in the static build output", (t) => {
	const directory = builtDocsFixture(
		t,
		'<h2 id="section">Section</h2><a href="/old/#section">Link</a>',
	);
	writeFileSync(join(directory, "rendered/_redirects"), "# Redirects\n/old/ /guide/ 301\n");
	let result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	writeFileSync(join(directory, "rendered/_redirects"), "/old/ /guide/#missing 302\n");
	result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("missing #missing in /guide/"));
});

void test("the CLI follows redirects that add or remove a trailing slash", (t) => {
	for (const [from, destination] of [
		["/guide", "/guide/"],
		["/guide/", "/guide"],
	]) {
		const directory = builtDocsFixture(
			t,
			`<h2 id="section">Section</h2><a href="${from}#section">Link</a>`,
		);
		writeFileSync(join(directory, "rendered/_redirects"), `${from} ${destination} 301\n`);
		const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
});

void test("the CLI uses the first redirect when source paths repeat", (t) => {
	const directory = builtDocsFixture(
		t,
		'<h2 id="section">Section</h2><a href="/old#section">Link</a>',
	);
	writeFileSync(join(directory, "rendered/_redirects"), "/old /missing/ 301\n/old /guide/ 301\n");
	const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("no generated page or file at /missing/"));
});

void test("the CLI follows redirects without an explicit status code", (t) => {
	const directory = builtDocsFixture(
		t,
		'<h2 id="section">Section</h2><a href="/old#section">Link</a>',
	);
	writeFileSync(join(directory, "rendered/_redirects"), "/old /guide/\n");
	const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});

void test("the CLI reports missing pages and anchors and exits unsuccessfully", (t) => {
	const directory = builtDocsFixture(t, '<a href="/removed/">Removed</a><a href="#old">Old</a>');
	const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("/guide/: /removed/ -> no generated page or file at /removed/"));
	assert.ok(result.stderr.includes("/guide/: #old -> missing #old in /guide/"));
});

void test("the CLI exits unsuccessfully if no docs build is available", (t) => {
	const directory = fixture(t, {});
	const result = spawnSync(process.execPath, [cliPath, directory], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("Link check failed:"));
	assert.ok(result.stderr.includes(".wrangler/deploy/config.json"));
});
