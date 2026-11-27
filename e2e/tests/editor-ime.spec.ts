import { test, expect } from "../fixtures";

test("converts the first character along with the rest of an IME composition", async ({
	admin,
	page,
	context,
}) => {
	await admin.devBypassAuth();
	await admin.goToNewContent("posts");

	const editor = page.locator("#field-body .ProseMirror");
	await editor.locator("p").click();
	await expect(editor).toBeFocused();

	const ime = await context.newCDPSession(page);
	await ime.send("Input.imeSetComposition", {
		text: "い",
		selectionStart: 1,
		selectionEnd: 1,
	});
	await expect(editor).toHaveText("い");

	const reading = "いしかわけん";
	await ime.send("Input.imeSetComposition", {
		text: reading,
		selectionStart: reading.length,
		selectionEnd: reading.length,
	});
	await ime.send("Input.insertText", { text: "石川県" });
	await expect(editor).toHaveText("石川県");
});
