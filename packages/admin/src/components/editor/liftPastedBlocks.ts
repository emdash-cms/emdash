/** Blocks that neither a quote nor a list item can hold. */
const BLOCKS_OUTSIDE_QUOTES_AND_LISTS =
	"h1, h2, h3, h4, h5, h6, pre, blockquote, hr, figure, img, table, iframe, video";
const LISTS = "ul, ol";
const CONTENT_WITHOUT_TEXT = "img, video, iframe, hr, table";
const QUOTE_OR_ITEM_TAG = /<(?:blockquote|li)\b/i;

/**
 * Quotes hold only paragraphs and list items only text and nested lists. In
 * pasted HTML, a quote or list holding another block, such as a heading, is
 * split around it, so the block lands between the two halves. Left to the
 * parser, the block would leave an empty quote or bullet behind, and what
 * followed it would lose its quote or list.
 */
export function liftPastedBlocks(html: string): string {
	if (!QUOTE_OR_ITEM_TAG.test(html)) return html;
	const template = document.createElement("template");
	template.innerHTML = html;
	let lifted = false;
	let block = findMisplacedBlock(template.content);
	while (block && liftOut(block)) {
		lifted = true;
		block = findMisplacedBlock(template.content);
	}
	return lifted ? template.innerHTML : html;
}

function findMisplacedBlock(root: DocumentFragment): Element | null {
	for (const element of root.querySelectorAll(`${BLOCKS_OUTSIDE_QUOTES_AND_LISTS}, ${LISTS}`)) {
		// A list can sit in a list item, but not in a quote.
		if (element.parentElement?.closest(element.matches(LISTS) ? "blockquote" : "blockquote, li")) {
			return element;
		}
	}
	return null;
}

/** Splits the outermost quote or list around `block`, which goes between the halves. */
function liftOut(block: Element): boolean {
	const wrappers = block.matches(LISTS) ? "blockquote" : `blockquote, li, ${LISTS}`;
	const between: Element[] = [];
	let outer: Element | null = null;
	for (let node = block.parentElement; node; node = node.parentElement) {
		if (node.matches(wrappers)) outer = node;
		between.unshift(node);
	}
	if (!outer) return false;
	const path = between.slice(between.indexOf(outer));

	const range = outer.ownerDocument.createRange();
	range.setStart(outer, 0);
	range.setEndBefore(block);
	const before = emptyCopy(outer);
	before.append(range.extractContents());
	range.setStartAfter(block);
	range.setEnd(outer, outer.childNodes.length);
	const after = emptyCopy(outer);
	after.append(range.extractContents());

	// The halves hold copies of the elements between `outer` and `block`, last in
	// `before` and first in `after`.
	const beforePath = edgePath(before, path.length, "lastChild");
	const afterPath = edgePath(after, path.length, "firstChild");
	for (const element of [...beforePath, ...afterPath].toReversed()) {
		if (isEmpty(element)) element.remove();
	}
	path.forEach((original, index) => {
		const head = beforePath[index];
		const tail = afterPath[index];
		if (
			original instanceof HTMLOListElement &&
			head instanceof HTMLOListElement &&
			tail instanceof HTMLOListElement
		) {
			tail.start = head.start + head.querySelectorAll(":scope > li").length;
		}
	});

	const parts = outer.ownerDocument.createDocumentFragment();
	parts.append(before, block, after);
	// An item left holding only a nested list would add an empty bullet, so the
	// nested list moves out in front of the list holding it.
	for (let index = 1; index < afterPath.length; index++) {
		const list = afterPath[index - 1]!;
		const item = afterPath[index]!;
		const nested = item.matches("li") && list.matches(LISTS) ? leadingList(item) : null;
		if (!nested) continue;
		list.before(nested);
		// Its numbers counted from where it was nested.
		nested.removeAttribute("start");
		if (isEmpty(item)) item.remove();
		if (!list.querySelector("li")) list.remove();
	}
	for (const half of [before, after]) if (isEmpty(half)) half.remove();
	outer.replaceWith(parts);
	return true;
}

/** The list an item starts with, when no text comes before it. */
function leadingList(item: Element): Element | null {
	for (const node of item.childNodes) {
		if (node instanceof Element) return node.matches(LISTS) ? node : null;
		if (node.textContent?.trim()) return null;
	}
	return null;
}

function emptyCopy(element: Element): Element {
	const copy = element.ownerDocument.createElement(element.localName);
	for (const { name, value } of element.attributes) copy.setAttribute(name, value);
	return copy;
}

function edgePath(root: Element, length: number, edge: "firstChild" | "lastChild"): Element[] {
	const path: Element[] = [root];
	for (let node = root[edge]; path.length < length && node instanceof Element; node = node[edge]) {
		path.push(node);
	}
	return path;
}

function isEmpty(element: Element): boolean {
	return !element.textContent?.trim() && !element.querySelector(CONTENT_WITHOUT_TEXT);
}
