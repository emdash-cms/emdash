import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../dist/index.js", import.meta.url);
const source = await readFile(path, "utf8");
await writeFile(path, source.replaceAll(/[\t ]+$/gm, ""), "utf8");
