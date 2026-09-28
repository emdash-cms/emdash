import { describe, expect, it } from "vitest";

import { untarInto, type UntarTarget } from "../.flue/lib/untar.js";

const encoder = new TextEncoder();

function header(fields: {
	name: string;
	size?: number;
	type?: string;
	linkTarget?: string;
	prefix?: string;
}): Uint8Array {
	const block = new Uint8Array(512);
	const put = (offset: number, value: string, length: number) => {
		const bytes = encoder.encode(value);
		block.set(bytes.subarray(0, length), offset);
	};
	put(0, fields.name, 100);
	put(100, "0000644", 8);
	put(124, (fields.size ?? 0).toString(8).padStart(11, "0"), 12);
	block[156] = (fields.type ?? "0").charCodeAt(0);
	if (fields.linkTarget) put(157, fields.linkTarget, 100);
	put(257, "ustar", 6);
	if (fields.prefix) put(345, fields.prefix, 155);
	return block;
}

function contentBlocks(data: Uint8Array): Uint8Array {
	const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
	padded.set(data);
	return padded;
}

function tarball(entries: Uint8Array[]): ReadableStream<Uint8Array> {
	const terminator = new Uint8Array(1024);
	const all = [...entries, terminator];
	return new ReadableStream({
		start(controller) {
			for (const chunk of all) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function fileEntry(name: string, text: string): Uint8Array[] {
	const data = encoder.encode(text);
	return [header({ name, size: data.length }), contentBlocks(data)];
}

interface Recorded {
	target: UntarTarget;
	files: Map<string, Uint8Array>;
	symlinks: Map<string, string>;
	dirs: Set<string>;
}

function recorder(): Recorded {
	const files = new Map<string, Uint8Array>();
	const symlinks = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		files,
		symlinks,
		dirs,
		target: {
			mkdir: async (path) => {
				dirs.add(path);
			},
			symlink: async (target, path) => {
				symlinks.set(path, target);
			},
			writeFileBytes: async (path, content) => {
				files.set(path, content);
			},
		},
	};
}

describe("untarInto", () => {
	it("extracts regular files, directories and symlinks with the root stripped", async () => {
		const r = recorder();
		const result = await untarInto(
			r.target,
			tarball([
				header({ name: "repo-abc/", type: "5" }),
				header({ name: "repo-abc/src/", type: "5" }),
				...fileEntry("repo-abc/src/index.ts", "export {}\n"),
				...fileEntry("repo-abc/empty.txt", ""),
				header({ name: "repo-abc/link.md", type: "2", linkTarget: "src/index.ts" }),
			]),
			"/repo",
		);

		expect(result.files).toBe(2);
		expect(new TextDecoder().decode(r.files.get("/repo/src/index.ts"))).toBe("export {}\n");
		expect(r.files.get("/repo/empty.txt")).toEqual(new Uint8Array(0));
		expect(r.symlinks.get("/repo/link.md")).toBe("src/index.ts");
		expect(r.dirs.has("/repo/src")).toBe(true);
	});

	it("applies GNU longname and pax path overrides", async () => {
		const longName = `repo-abc/deep/${"d/".repeat(60)}long-file.txt`;
		const longNameBytes = encoder.encode(longName);
		// pax record: "<len> key=value\n" where len counts the whole record.
		const paxBody = "path=repo-abc/pax-named.txt\n";
		const paxLen = String(paxBody.length + 3).length + 1 + paxBody.length;
		const paxBytes = encoder.encode(`${paxLen} ${paxBody}`);
		const r = recorder();
		await untarInto(
			r.target,
			tarball([
				header({ name: "repo-abc/@LongLink", type: "L", size: longNameBytes.length }),
				contentBlocks(longNameBytes),
				header({ name: "repo-abc/truncated", size: 2 }),
				contentBlocks(encoder.encode("ok")),
				header({ name: "repo-abc/PaxHeader", type: "x", size: paxBytes.length }),
				contentBlocks(paxBytes),
				...fileEntry("repo-abc/ignored-name.txt", "pax"),
			]),
			"/repo",
		);

		expect([...r.files.keys()].some((k) => k.endsWith("/long-file.txt"))).toBe(true);
		expect(r.files.has("/repo/pax-named.txt")).toBe(true);
		expect(r.files.has("/repo/ignored-name.txt")).toBe(false);
	});

	it("applies pax linkpath and GNU longlink overrides to symlink targets", async () => {
		const longTarget = `deep/${"d/".repeat(40)}target.txt`;
		const paxBody = `linkpath=${longTarget}\n`;
		const paxLen = String(paxBody.length + 3).length + 1 + paxBody.length;
		const paxBytes = encoder.encode(`${paxLen} ${paxBody}`);
		const longLinkBytes = encoder.encode(longTarget);
		const r = recorder();
		await untarInto(
			r.target,
			tarball([
				header({ name: "repo-abc/PaxHeader", type: "x", size: paxBytes.length }),
				contentBlocks(paxBytes),
				header({ name: "repo-abc/pax-link", type: "2", linkTarget: "short" }),
				header({ name: "repo-abc/@LongLink", type: "K", size: longLinkBytes.length }),
				contentBlocks(longLinkBytes),
				header({ name: "repo-abc/gnu-link", type: "2", linkTarget: "short" }),
				header({ name: "repo-abc/plain-link", type: "2", linkTarget: "short" }),
			]),
			"/repo",
		);
		expect(r.symlinks.get("/repo/pax-link")).toBe(longTarget);
		expect(r.symlinks.get("/repo/gnu-link")).toBe(longTarget);
		expect(r.symlinks.get("/repo/plain-link")).toBe("short");
	});

	it("rejects pax linkpath targets that escape the destination", async () => {
		const paxBody = "linkpath=../../etc/passwd\n";
		const paxLen = String(paxBody.length + 3).length + 1 + paxBody.length;
		const paxBytes = encoder.encode(`${paxLen} ${paxBody}`);
		const r = recorder();
		await expect(
			untarInto(
				r.target,
				tarball([
					header({ name: "repo-abc/PaxHeader", type: "x", size: paxBytes.length }),
					contentBlocks(paxBytes),
					header({ name: "repo-abc/evil", type: "2", linkTarget: "harmless" }),
				]),
				"/repo",
			),
		).rejects.toThrow(/escapes the destination/);
		expect(r.symlinks.size).toBe(0);
	});

	it("rejects entries whose size field is not strictly octal", async () => {
		for (const sizeField of ["10x", "size!", "-0000001"]) {
			const block = header({ name: "repo-abc/bad.bin" });
			block.set(encoder.encode(sizeField), 124);
			const r = recorder();
			await expect(untarInto(r.target, tarball([block]), "/repo")).rejects.toThrow(/not octal/);
			expect(r.files.size).toBe(0);
		}
	});

	it("rejects entries whose declared size exceeds the cap", async () => {
		const r = recorder();
		await expect(
			untarInto(
				r.target,
				tarball([header({ name: "repo-abc/huge.bin", size: 128 * 1024 * 1024 })]),
				"/repo",
			),
		).rejects.toThrow(/size out of range/);
		expect(r.files.size).toBe(0);
	});

	it("joins the ustar prefix field with the name", async () => {
		const r = recorder();
		await untarInto(
			r.target,
			tarball([
				header({ name: "nested.txt", prefix: "repo-abc/prefixed", size: 2 }),
				contentBlocks(encoder.encode("hi")),
			]),
			"/repo",
		);
		expect(r.files.has("/repo/prefixed/nested.txt")).toBe(true);
	});

	it("rejects entry paths that traverse out of the destination", async () => {
		const r = recorder();
		await expect(
			untarInto(r.target, tarball([...fileEntry("repo-abc/../../escape.txt", "x")]), "/repo"),
		).rejects.toThrow(/escapes the destination/);
		expect(r.files.size).toBe(0);
	});

	it("rejects absolute entry paths", async () => {
		const r = recorder();
		await expect(
			untarInto(r.target, tarball([...fileEntry("/etc/passwd", "x")]), "/repo"),
		).rejects.toThrow(/absolute/);
	});

	it("rejects symlink targets that escape the destination", async () => {
		const r = recorder();
		await expect(
			untarInto(
				r.target,
				tarball([header({ name: "repo-abc/evil", type: "2", linkTarget: "../../etc/passwd" })]),
				"/repo",
			),
		).rejects.toThrow(/escapes the destination/);
		await expect(
			untarInto(
				r.target,
				tarball([header({ name: "repo-abc/evil", type: "2", linkTarget: "/etc/passwd" })]),
				"/repo",
			),
		).rejects.toThrow(/absolute/);
		expect(r.symlinks.size).toBe(0);
	});

	it("allows in-tree relative symlink targets that use ..", async () => {
		const r = recorder();
		await untarInto(
			r.target,
			tarball([
				header({ name: "repo-abc/.claude/", type: "5" }),
				header({ name: "repo-abc/.claude/skills", type: "2", linkTarget: "../skills" }),
			]),
			"/repo",
		);
		expect(r.symlinks.get("/repo/.claude/skills")).toBe("../skills");
	});

	it("throws on a truncated archive instead of writing partial content", async () => {
		const r = recorder();
		// No terminator and only 100 of the 600 declared content bytes.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(header({ name: "repo-abc/cut.txt", size: 600 }));
				controller.enqueue(new Uint8Array(100));
				controller.close();
			},
		});
		await expect(untarInto(r.target, stream, "/repo")).rejects.toThrow(/truncated/);
		expect(r.files.size).toBe(0);
	});
});
