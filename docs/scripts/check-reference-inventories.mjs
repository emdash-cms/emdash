import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(docsDirectory, "..");
const SECTION_PATTERN = /^### `([^`]+)`$/gm;
const HOOK_TABLE_PATTERN = /^\| `([^`]+)`\s+\|/gm;
const API_CONTRACT_PATTERN = /^\| `([^`]+)` \|/gm;
const TEMPLATE_PATH_PATTERN = /\/src\/(pages|layouts|components)\//;
const EMDASH_IMPORT_PATTERN = /^import\s*\{([^;]+?)\}\s*from\s*["']emdash["'];/gm;
const TYPE_PREFIX_PATTERN = /^type\s+/;
const IMPORT_ALIAS_PATTERN = /\s+as\s+/;
const ADAPTER_ARGUMENT_PATTERN = /\(.*$/;
const EMDASH_COMMAND_PREFIX_PATTERN = /^emdash\s+/;
const COMMAND_ARGUMENT_PATTERN = /\s+<[^>]+>/g;
const CLI_HEADING_PATTERN = /^(#{3,4}) `([^`]+)`[^\n]*$/gm;
const CLI_OPTION_PATTERN = /--([A-Za-z][\w-]*)/g;
const CLI_NEGATED_OPTION_LINE_PATTERN = /^.*There is no .*$/gm;
const CLI_OPTION_TABLE_PATTERN = /^\| `--([A-Za-z][\w-]*)[^`]*`/gm;
const TEMPLATE_EXTENSIONS = new Set([".astro", ".ts", ".tsx", ".js", ".mjs"]);

function readRepositoryFile(path) {
	return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function parseSource(path) {
	return ts.createSourceFile(
		path,
		readRepositoryFile(path),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

function propertyName(node) {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
		return node.text;
	}
	return undefined;
}

function findInterface(source, name) {
	const declaration = source.statements.find(
		(statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
	);
	if (!declaration) throw new Error(`Could not find interface ${name} in ${source.fileName}`);
	return declaration;
}

function findTypeAlias(source, name) {
	const declaration = source.statements.find(
		(statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
	);
	if (!declaration) throw new Error(`Could not find type ${name} in ${source.fileName}`);
	return declaration;
}

function stringLiteralUnionMembers(type) {
	const members = ts.isUnionTypeNode(type) ? type.types : [type];
	return members.map((member) => {
		if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
			throw new Error("Expected a string-literal union");
		}
		return member.literal.text;
	});
}

function compareInventory(label, sourceValues, documentedValues) {
	const source = new Set(sourceValues);
	const documented = new Set(documentedValues);
	const missing = [...source]
		.filter((value) => !documented.has(value))
		.toSorted((a, b) => a.localeCompare(b));
	const extra = [...documented]
		.filter((value) => !source.has(value))
		.toSorted((a, b) => a.localeCompare(b));
	if (missing.length === 0 && extra.length === 0) return;

	const details = [];
	if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
	if (extra.length > 0) details.push(`not in source: ${extra.join(", ")}`);
	throw new Error(`${label} is out of date (${details.join("; ")})`);
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

function markdownSection(markdown, heading) {
	const start = markdown.indexOf(`${heading}\n`);
	if (start === -1) throw new Error(`Could not find ${heading}`);
	const next = markdown.indexOf("\n## ", start + heading.length);
	return markdown.slice(start, next === -1 ? undefined : next);
}

function checkFieldTypes() {
	const source = parseSource("packages/core/src/schema/types.ts");
	const fieldTypes = stringLiteralUnionMembers(findTypeAlias(source, "FieldType").type);
	const reference = readRepositoryFile("docs/src/content/docs/reference/field-types.mdx");
	const sections = Array.from(reference.matchAll(SECTION_PATTERN), (match) => match[1]);
	compareInventory("Field type sections", fieldTypes, sections);
}

function checkHooks() {
	const source = parseSource("packages/core/src/plugins/types.ts");
	const hooks = findInterface(source, "PluginHooks").members.map((member) =>
		propertyName(member.name),
	);
	if (hooks.some((hook) => hook === undefined))
		throw new Error("PluginHooks has an unnamed member");

	const reference = readRepositoryFile("docs/src/content/docs/reference/hooks.mdx");
	const sections = Array.from(reference.matchAll(SECTION_PATTERN), (match) => match[1]).filter(
		(name) => name === "cron" || name.includes(":"),
	);
	const overview = markdownSection(reference, "## Hook overview");
	const table = Array.from(overview.matchAll(HOOK_TABLE_PATTERN), (match) => match[1]);
	compareInventory("Hook sections", hooks, sections);
	compareInventory("Hook overview", hooks, table);
}

function exportedAdapterNames(path) {
	const source = parseSource(path);
	const names = [];
	for (const statement of source.statements) {
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			names.push(statement.name.text);
		}
		if (
			ts.isExportDeclaration(statement) &&
			!statement.isTypeOnly &&
			statement.moduleSpecifier &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) {
				if (!element.isTypeOnly) names.push(element.name.text);
			}
		}
	}
	return names;
}

function checkConfiguration() {
	const source = parseSource("packages/core/src/astro/integration/runtime.ts");
	const config = findInterface(source, "EmDashConfig");
	const authoredOptions = config.members
		.filter((member) => !member.getFullText(source).includes("not authored by the user"))
		.map((member) => propertyName(member.name));
	if (authoredOptions.some((option) => option === undefined)) {
		throw new Error("EmDashConfig has an unnamed member");
	}

	const reference = readRepositoryFile("docs/src/content/docs/reference/configuration.mdx");
	const integrationOptions = markdownSection(reference, "## Integration options");
	const optionHeadings = Array.from(
		integrationOptions.matchAll(SECTION_PATTERN),
		(match) => match[1],
	);
	const documentedOptions = optionHeadings.map((heading) => heading.split(".")[0]);
	compareInventory("EmDashConfig options", authoredOptions, documentedOptions);

	const adapterSources = [
		"packages/core/src/db/adapters.ts",
		"packages/core/src/astro/storage/adapters.ts",
		"packages/core/src/astro/object-cache/adapters.ts",
		"packages/cloudflare/src/index.ts",
	];
	const adapters = adapterSources.flatMap(exportedAdapterNames);
	const documentedAdapters = Array.from(reference.matchAll(SECTION_PATTERN), (match) => match[1])
		.filter((heading) => heading.includes("("))
		.map((heading) => heading.replace(ADAPTER_ARGUMENT_PATTERN, ""));
	compareInventory("Configuration adapter sections", adapters, documentedAdapters);
}

function siteTemplateImports() {
	const templatesRoot = resolve(repositoryRoot, "templates");
	const imports = new Set();
	for (const path of walk(templatesRoot)) {
		const repositoryPath = relative(repositoryRoot, path);
		if (!TEMPLATE_PATH_PATTERN.test(repositoryPath)) continue;
		if (!TEMPLATE_EXTENSIONS.has(extname(path))) continue;
		const contents = readFileSync(path, "utf8");
		for (const match of contents.matchAll(EMDASH_IMPORT_PATTERN)) {
			for (const specifier of match[1].split(",")) {
				const trimmed = specifier.trim();
				if (TYPE_PREFIX_PATTERN.test(trimmed)) continue;
				const name = trimmed.split(IMPORT_ALIAS_PATTERN)[0];
				if (name) imports.add(name);
			}
		}
	}
	return [...imports];
}

function checkSiteTemplateApi() {
	const reference = readRepositoryFile("docs/src/content/docs/reference/api.mdx");
	const contract = markdownSection(reference, "## Site-template API contract");
	const documented = Array.from(contract.matchAll(API_CONTRACT_PATTERN), (match) => match[1]);
	compareInventory("Site-template API contract", siteTemplateImports(), documented);
}

function cliProgram() {
	const cliRoot = resolve(repositoryRoot, "packages/core/src/cli");
	const files = walk(cliRoot).filter((path) => extname(path) === ".ts");
	return ts.createProgram(files, {
		allowJs: false,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
	});
}

function unwrapExpression(expression) {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function resolveDeclarationExpression(expression, checker) {
	const unwrapped = unwrapExpression(expression);
	if (!ts.isIdentifier(unwrapped)) return unwrapped;
	let symbol = checker.getSymbolAtLocation(unwrapped);
	if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
	const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
	return declaration?.initializer
		? resolveDeclarationExpression(declaration.initializer, checker)
		: unwrapped;
}

function resolveObject(expression, checker) {
	const resolved = resolveDeclarationExpression(expression, checker);
	if (ts.isObjectLiteralExpression(resolved)) return resolved;
	if (ts.isCallExpression(resolved) && resolved.arguments[0]) {
		const argument = unwrapExpression(resolved.arguments[0]);
		if (ts.isObjectLiteralExpression(argument)) return argument;
	}
	return undefined;
}

function objectProperty(object, name) {
	return object.properties.find(
		(property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name,
	);
}

function collectArgumentDefinitions(object, checker, definitions = new Map()) {
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			const spread = resolveObject(property.expression, checker);
			if (spread) collectArgumentDefinitions(spread, checker, definitions);
			continue;
		}
		if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
		const name = propertyName(property.name);
		if (!name) continue;
		const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
		definitions.set(name, expression);
	}
	return definitions;
}

function literalPropertyValue(expression, checker, name) {
	const object = resolveObject(expression, checker);
	const property = object && objectProperty(object, name);
	if (!property || !ts.isPropertyAssignment(property)) return undefined;
	const value = unwrapExpression(property.initializer);
	if (ts.isStringLiteral(value) || value.kind === ts.SyntaxKind.TrueKeyword) {
		return ts.isStringLiteral(value) ? value.text : true;
	}
	return undefined;
}

function collectCliContract() {
	const program = cliProgram();
	const checker = program.getTypeChecker();
	const entry = program.getSourceFile(resolve(repositoryRoot, "packages/core/src/cli/index.ts"));
	const main = entry?.statements
		.filter(ts.isVariableStatement)
		.flatMap((statement) => statement.declarationList.declarations)
		.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "main");
	if (!main?.initializer) throw new Error("Could not find the EmDash CLI command tree");
	const root = resolveObject(main.initializer, checker);
	if (!root) throw new Error("Could not resolve the EmDash CLI root command");

	const commands = new Set();
	const options = new Map();
	function visit(command, path) {
		const subCommandsProperty = objectProperty(command, "subCommands");
		const subCommands =
			subCommandsProperty && ts.isPropertyAssignment(subCommandsProperty)
				? resolveObject(subCommandsProperty.initializer, checker)
				: undefined;
		if (subCommands) {
			for (const property of subCommands.properties) {
				if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
					continue;
				const name = propertyName(property.name);
				if (!name) continue;
				const childPath = [...path, name];
				commands.add(childPath.join(" "));
				const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
				const child = resolveObject(expression, checker);
				if (!child) throw new Error(`Could not resolve CLI command ${childPath.join(" ")}`);
				visit(child, childPath);
			}
			return;
		}

		const argsProperty = objectProperty(command, "args");
		const args =
			argsProperty && ts.isPropertyAssignment(argsProperty)
				? resolveObject(argsProperty.initializer, checker)
				: undefined;
		const commandOptions = [];
		if (args) {
			for (const [name, definition] of collectArgumentDefinitions(args, checker)) {
				if (literalPropertyValue(definition, checker, "type") !== "positional") {
					commandOptions.push(name);
				}
			}
		}
		options.set(path.join(" "), commandOptions);
	}

	visit(root, []);

	const clientFactory = program.getSourceFile(
		resolve(repositoryRoot, "packages/core/src/cli/client-factory.ts"),
	);
	const connectionArgs = clientFactory?.statements
		.filter(ts.isVariableStatement)
		.flatMap((statement) => statement.declarationList.declarations)
		.find(
			(declaration) =>
				ts.isIdentifier(declaration.name) && declaration.name.text === "connectionArgs",
		);
	if (!connectionArgs?.initializer) throw new Error("Could not find shared CLI connection options");
	const connectionObject = resolveObject(connectionArgs.initializer, checker);
	if (!connectionObject) throw new Error("Could not resolve shared CLI connection options");
	const commonOptions = [...collectArgumentDefinitions(connectionObject, checker).keys()];

	return { commands: [...commands], options, commonOptions };
}

function normalizeCommandHeading(heading) {
	return heading
		.replace(EMDASH_COMMAND_PREFIX_PATTERN, "")
		.replace(COMMAND_ARGUMENT_PATTERN, "")
		.trim();
}

function cliHeadings(reference) {
	return Array.from(reference.matchAll(CLI_HEADING_PATTERN), (match) => ({
		level: match[1].length,
		command: normalizeCommandHeading(match[2]),
		start: match.index,
	}));
}

function checkCli() {
	const reference = readRepositoryFile("docs/src/content/docs/reference/cli.mdx");
	const { commands, options, commonOptions } = collectCliContract();
	const commonFlagsSection = markdownSection(reference, "## Common flags");
	const documentedCommonOptions = Array.from(
		commonFlagsSection.matchAll(CLI_OPTION_TABLE_PATTERN),
		(match) => match[1],
	);
	compareInventory("CLI common options", commonOptions, documentedCommonOptions);

	const commandsSection = markdownSection(reference, "## Commands");
	const headings = cliHeadings(commandsSection);
	const documentedCommands = headings.map(({ command }) => command);
	compareInventory("CLI command sections", commands, documentedCommands);

	const commonOptionSet = new Set(commonOptions);
	for (const [command, commandOptions] of options) {
		const headingIndex = headings.findIndex((heading) => heading.command === command);
		if (headingIndex === -1) continue;
		const heading = headings[headingIndex];
		const end = headings
			.slice(headingIndex + 1)
			.find((candidate) => candidate.level <= heading.level)?.start;
		const section = commandsSection.slice(heading.start, end);
		const positiveOptionText = section.replace(CLI_NEGATED_OPTION_LINE_PATTERN, "");
		const sectionOptions = new Set(
			Array.from(positiveOptionText.matchAll(CLI_OPTION_PATTERN), (match) => match[1]),
		);
		const expected = new Set(commandOptions);
		const documented = Array.from(sectionOptions, (option) =>
			option.startsWith("no-") && expected.has(option.slice(3)) ? option.slice(3) : option,
		);
		const expectedSpecific = commandOptions.filter((option) => !commonOptionSet.has(option));
		const documentedSpecific = documented.filter(
			(option) => !(commonOptionSet.has(option) && expected.has(option)),
		);
		compareInventory(`CLI options for ${command}`, expectedSpecific, documentedSpecific);
	}
}

checkFieldTypes();
checkHooks();
checkConfiguration();
checkSiteTemplateApi();
checkCli();

console.log("Reference inventories match their source contracts.");
