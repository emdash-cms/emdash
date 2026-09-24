import tsc from "typescript";

function unwrapExpression(expression: tsc.Expression): tsc.Expression {
	let current = expression;
	while (
		tsc.isParenthesizedExpression(current) ||
		tsc.isAsExpression(current) ||
		tsc.isSatisfiesExpression(current) ||
		tsc.isTypeAssertionExpression(current) ||
		tsc.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function propertyName(name: tsc.PropertyName): string | undefined {
	if (tsc.isIdentifier(name) || tsc.isStringLiteral(name)) return name.text;
	return undefined;
}

function identifierDeclarationName(node: tsc.Identifier): boolean {
	return tsc.isVariableDeclaration(node.parent) && node.parent.name === node;
}

function descendants(node: tsc.Node, names: Set<string>): void {
	if (tsc.isIdentifier(node)) names.add(node.text);
	node.forEachChild((child) => descendants(child, names));
}

export function stripBuildOnlyMcp(source: string, filename: string): string {
	const sourceFile = tsc.createSourceFile(
		filename,
		source,
		tsc.ScriptTarget.Latest,
		true,
		filename.endsWith(".tsx") ? tsc.ScriptKind.TSX : tsc.ScriptKind.TS,
	);
	const declarations = new Map<
		string,
		{ declaration: tsc.VariableDeclaration; statement: tsc.VariableStatement }
	>();
	for (const statement of sourceFile.statements) {
		if (!tsc.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (tsc.isIdentifier(declaration.name)) {
				declarations.set(declaration.name.text, { declaration, statement });
			}
		}
	}

	const exportAssignment = sourceFile.statements.find(
		(statement): statement is tsc.ExportAssignment =>
			tsc.isExportAssignment(statement) && !statement.isExportEquals,
	);
	if (!exportAssignment) return source;
	let pluginExpression = unwrapExpression(exportAssignment.expression);
	if (tsc.isIdentifier(pluginExpression)) {
		const binding = declarations.get(pluginExpression.text)?.declaration.initializer;
		if (!binding) return source;
		pluginExpression = unwrapExpression(binding);
	}
	if (!tsc.isObjectLiteralExpression(pluginExpression)) return source;

	const mcpProperty = pluginExpression.properties.find(
		(property): property is tsc.PropertyAssignment | tsc.ShorthandPropertyAssignment =>
			(tsc.isPropertyAssignment(property) || tsc.isShorthandPropertyAssignment(property)) &&
			propertyName(property.name) === "mcp",
	);
	if (!mcpProperty) return source;

	const candidates = new Set<string>();
	descendants(mcpProperty, candidates);
	let candidateCount = -1;
	while (candidateCount !== candidates.size) {
		candidateCount = candidates.size;
		for (const name of candidates) {
			const initializer = declarations.get(name)?.declaration.initializer;
			if (initializer) descendants(initializer, candidates);
		}
	}
	for (const name of candidates) {
		if (!declarations.has(name)) candidates.delete(name);
	}

	let changed = true;
	while (changed) {
		changed = false;
		const excluded = [
			mcpProperty,
			...Array.from(candidates, (name) => declarations.get(name)!.declaration),
		];
		const usedOutside = new Set<string>();
		const visit = (node: tsc.Node): void => {
			if (excluded.some((item) => node.pos >= item.pos && node.end <= item.end)) return;
			if (tsc.isIdentifier(node) && candidates.has(node.text) && !identifierDeclarationName(node)) {
				usedOutside.add(node.text);
			}
			node.forEachChild(visit);
		};
		visit(sourceFile);
		for (const name of usedOutside) {
			if (candidates.delete(name)) changed = true;
		}
	}

	const transformer: tsc.TransformerFactory<tsc.SourceFile> = (context) => {
		const visit: tsc.Visitor = (node) => {
			if (node === pluginExpression) {
				return context.factory.updateObjectLiteralExpression(
					pluginExpression,
					pluginExpression.properties.filter((property) => property !== mcpProperty),
				);
			}
			if (tsc.isVariableStatement(node)) {
				const declarationsToKeep = node.declarationList.declarations.filter(
					(declaration) =>
						!tsc.isIdentifier(declaration.name) || !candidates.has(declaration.name.text),
				);
				if (declarationsToKeep.length === 0) return undefined;
				if (declarationsToKeep.length !== node.declarationList.declarations.length) {
					return context.factory.updateVariableStatement(
						node,
						node.modifiers,
						context.factory.updateVariableDeclarationList(node.declarationList, declarationsToKeep),
					);
				}
			}
			return tsc.visitEachChild(node, visit, context);
		};
		return (node) => {
			const result = tsc.visitNode(node, visit);
			if (!result || !tsc.isSourceFile(result)) throw new Error("Runtime transform removed source");
			return result;
		};
	};
	const transformed = tsc.transform(sourceFile, [transformer]);
	try {
		return tsc
			.createPrinter({ newLine: tsc.NewLineKind.LineFeed })
			.printFile(transformed.transformed[0]!);
	} finally {
		transformed.dispose();
	}
}
