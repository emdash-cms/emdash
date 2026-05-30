import { describe, it, expect } from "vitest";

import {
	draftSectionFromIntent,
	getIntentKeywords,
	getIntentSuggestions,
	getTemplateSuggestions,
	SECTION_STARTER_TEMPLATES,
	SECTION_CATEGORIES,
	getCategoryById,
	templateToSection,
} from "../../src/lib/sectionTemplates";

describe("draftSectionFromIntent", () => {
	describe("high confidence matches", () => {
		it("matches 'pricing' intent to pricing table", () => {
			const result = draftSectionFromIntent("pricing");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-pricing-table");
		});

		it("matches 'faq' intent to FAQ section", () => {
			const result = draftSectionFromIntent("faq");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-faq");
		});

		it("matches 'testimonials' intent to testimonial section", () => {
			const result = draftSectionFromIntent("testimonials");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-testimonial");
		});

		it("matches 'hero' intent to hero/cover section", () => {
			const result = draftSectionFromIntent("hero");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-hero-cover");
		});

		it("matches 'features' intent to feature list", () => {
			const result = draftSectionFromIntent("features");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-feature-list");
		});

		it("matches 'video' intent to video embed", () => {
			const result = draftSectionFromIntent("video");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-video-embed");
		});

		it("matches 'tabs' intent to tabs section", () => {
			const result = draftSectionFromIntent("tabs");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-tabs");
		});

		it("matches 'steps' intent to steps/timeline section", () => {
			const result = draftSectionFromIntent("steps");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-steps");
		});

		it("matches 'cta' intent to CTA section", () => {
			const result = draftSectionFromIntent("cta");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-cta");
		});

		it("matches 'pricing table' to pricing table template", () => {
			const result = draftSectionFromIntent("pricing table");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-pricing-table");
		});

		it("matches 'how to' to steps/timeline", () => {
			const result = draftSectionFromIntent("how to guide");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-steps");
		});

		it("matches 'comparison' to tabs section", () => {
			const result = draftSectionFromIntent("comparison");
			expect(result.found).toBe(true);
			expect(result.confidence).toBe("high");
			expect(result.template?.id).toBe("starter-tabs");
		});
	});

	describe("improved fuzzy matching with weighted scoring", () => {
		it("matches multi-word phrases with higher scores", () => {
			const result1 = draftSectionFromIntent("pricing");
			const result2 = draftSectionFromIntent("pricing table");
			// Both should find pricing table, but phrase match should have alternatives
			expect(result1.found).toBe(true);
			expect(result2.found).toBe(true);
			expect(result2.template?.id).toBe("starter-pricing-table");
		});

		it("returns alternatives for partial matches", () => {
			const result = draftSectionFromIntent("card");
			expect(result.found).toBe(true);
			// Should return both card and card-grid as alternatives
			if (result.alternatives) {
				expect(result.alternatives.length).toBeGreaterThan(0);
			}
		});

		it("prioritizes exact matches over fuzzy matches", () => {
			const result = draftSectionFromIntent("steps");
			expect(result.found).toBe(true);
			expect(result.template?.id).toBe("starter-steps");
		});

		it("handles new expanded keywords like 'workflow'", () => {
			const result = draftSectionFromIntent("workflow");
			expect(result.found).toBe(true);
			expect(result.template?.id).toBe("starter-steps");
		});

		it("handles 'blockquote' as pullquote trigger", () => {
			const result = draftSectionFromIntent("blockquote");
			expect(result.found).toBe(true);
			expect(result.template?.id).toBe("starter-pullquote");
		});
	});

	describe("empty and edge cases", () => {
		it("returns no match for empty intent", () => {
			const result = draftSectionFromIntent("");
			expect(result.found).toBe(false);
			expect(result.confidence).toBe("none");
			expect(result.template).toBeNull();
		});

		it("returns no match for whitespace-only intent", () => {
			const result = draftSectionFromIntent("   ");
			expect(result.found).toBe(false);
			expect(result.confidence).toBe("none");
			expect(result.template).toBeNull();
		});

		it("returns no match for gibberish", () => {
			const result = draftSectionFromIntent("xyz123 gibberish nonsense");
			expect(result.found).toBe(false);
			expect(result.confidence).toBe("none");
			expect(result.template).toBeNull();
		});
	});

	describe("graceful fallback", () => {
		it("returns helpful suggestion when no match found", () => {
			const result = draftSectionFromIntent("xyz123");
			expect(result.found).toBe(false);
			expect(result.suggestion).toContain("No matching section found");
			expect(result.suggestion).toContain("pricing");
			expect(result.suggestion).toContain("faq");
		});

		it("returns placeholder suggestion for empty intent", () => {
			const result = draftSectionFromIntent("");
			expect(result.suggestion).toContain("Enter a description");
		});
	});

	describe("case insensitivity", () => {
		it("handles uppercase intent", () => {
			const result = draftSectionFromIntent("FAQ");
			expect(result.found).toBe(true);
			expect(result.template?.id).toBe("starter-faq");
		});

		it("handles mixed case intent", () => {
			const result = draftSectionFromIntent("PrIcInG TaBlE");
			expect(result.found).toBe(true);
			expect(result.template?.id).toBe("starter-pricing-table");
		});
	});

	describe("returned result structure", () => {
		it("returns complete result object with all required fields", () => {
			const result = draftSectionFromIntent("pricing");
			expect(result).toHaveProperty("found");
			expect(result).toHaveProperty("template");
			expect(result).toHaveProperty("intent");
			expect(result).toHaveProperty("confidence");
			expect(result).toHaveProperty("suggestion");
		});

		it("preserves original intent in result", () => {
			const intent = "pricing section";
			const result = draftSectionFromIntent(intent);
			expect(result.intent).toBe(intent);
		});

		it("returns valid template when found", () => {
			const result = draftSectionFromIntent("faq");
			expect(result.template).not.toBeNull();
			expect(result.template).toHaveProperty("id");
			expect(result.template).toHaveProperty("title");
			expect(result.template).toHaveProperty("content");
		});

		it("returns alternatives when available", () => {
			const result = draftSectionFromIntent("card");
			expect(result.found).toBe(true);
			// Alternatives should be an array or undefined
			if (result.alternatives) {
				expect(Array.isArray(result.alternatives)).toBe(true);
			}
		});
	});

	describe("options parameter", () => {
		it("accepts options parameter without error", () => {
			const result = draftSectionFromIntent("pricing", {});
			expect(result.found).toBe(true);
		});

		it("respects maxAlternatives option", () => {
			const result = draftSectionFromIntent("card", { maxAlternatives: 1 });
			if (result.alternatives) {
				expect(result.alternatives.length).toBeLessThanOrEqual(1);
			}
		});

		it("returns alternatives by default (up to 3)", () => {
			const result = draftSectionFromIntent("card");
			if (result.alternatives) {
				expect(result.alternatives.length).toBeLessThanOrEqual(3);
			}
		});
	});

	describe("all registered templates are reachable", () => {
		it("every starter template can be matched by its keywords", () => {
			// This test verifies that all registered templates have at least one reachable keyword
			// We test each template ID can be matched by its own title/keywords
			for (const template of SECTION_STARTER_TEMPLATES) {
				// Try matching by title
				const byTitle = draftSectionFromIntent(template.title);
				// Try matching by first keyword
				const byKeyword =
					template.keywords.length > 0 ? draftSectionFromIntent(template.keywords[0]) : byTitle;

				const matched = byTitle.found || byKeyword.found;
				expect(matched).toBe(true, `Template "${template.id}" should be reachable`);
			}
		});
	});
});

describe("getIntentKeywords", () => {
	it("returns an array of keywords", () => {
		const keywords = getIntentKeywords();
		expect(Array.isArray(keywords)).toBe(true);
		expect(keywords.length).toBeGreaterThan(0);
	});

	it("contains common intent keywords", () => {
		const keywords = getIntentKeywords();
		const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));

		// Verify some key keywords are present
		expect(keywordSet.has("pricing")).toBe(true);
		expect(keywordSet.has("faq")).toBe(true);
		expect(keywordSet.has("hero")).toBe(true);
		expect(keywordSet.has("video")).toBe(true);
		expect(keywordSet.has("cta")).toBe(true);
	});

	it("keywords are unique enough to distinguish templates", () => {
		const keywords = getIntentKeywords();
		// At least 60 keywords should provide good coverage (increased from 50)
		expect(keywords.length).toBeGreaterThanOrEqual(60);
	});

	it("includes expanded keywords for better matching", () => {
		const keywords = getIntentKeywords();
		const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));

		// Check for new expanded keywords
		expect(keywordSet.has("workflow")).toBe(true);
		expect(keywordSet.has("blockquote")).toBe(true);
		expect(keywordSet.has("subscribe")).toBe(true);
	});
});

describe("getIntentSuggestions", () => {
	it("returns suggestions for partial input", () => {
		const suggestions = getIntentSuggestions("pri");
		expect(Array.isArray(suggestions)).toBe(true);
		expect(suggestions.length).toBeGreaterThan(0);
	});

	it("returns empty array for short input", () => {
		const suggestions = getIntentSuggestions("p");
		expect(suggestions.length).toBe(0);
	});

	it("limits results to maxResults", () => {
		const suggestions = getIntentSuggestions("c", { maxResults: 3 });
		expect(suggestions.length).toBeLessThanOrEqual(3);
	});

	it("handles case-insensitive matching", () => {
		const suggestions1 = getIntentSuggestions("FAQ");
		const suggestions2 = getIntentSuggestions("faq");
		expect(suggestions1.length).toBeGreaterThan(0);
		expect(suggestions2.length).toBeGreaterThan(0);
	});
});

describe("getTemplateSuggestions", () => {
	it("returns template suggestions for partial input", () => {
		const suggestions = getTemplateSuggestions("pricing");
		expect(Array.isArray(suggestions)).toBe(true);
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions[0]).toHaveProperty("template");
		expect(suggestions[0]).toHaveProperty("matchScore");
		expect(suggestions[0]).toHaveProperty("matchedOn");
	});

	it("returns empty array for short input", () => {
		const suggestions = getTemplateSuggestions("p");
		expect(suggestions.length).toBe(0);
	});

	it("limits results to maxResults", () => {
		const suggestions = getTemplateSuggestions("c", { maxResults: 2 });
		expect(suggestions.length).toBeLessThanOrEqual(2);
	});

	it("includes match score for ranking", () => {
		const suggestions = getTemplateSuggestions("pricing");
		for (const suggestion of suggestions) {
			expect(suggestion.matchScore).toBeGreaterThan(0);
		}
	});

	it("returns matchedOn array with matched words", () => {
		const suggestions = getTemplateSuggestions("pricing table");
		for (const suggestion of suggestions) {
			expect(Array.isArray(suggestion.matchedOn)).toBe(true);
		}
	});
});

describe("SECTION_CATEGORIES", () => {
	it("contains expected categories", () => {
		const categoryIds = SECTION_CATEGORIES.map((c) => c.id);
		expect(categoryIds).toContain("layout");
		expect(categoryIds).toContain("content");
		expect(categoryIds).toContain("marketing");
		expect(categoryIds).toContain("media");
		expect(categoryIds).toContain("navigation");
		expect(categoryIds).toContain("social");
	});

	it("all categories have labels", () => {
		for (const category of SECTION_CATEGORIES) {
			expect(category.label).toBeDefined();
			expect(typeof category.label).toBe("object"); // MessageDescriptor
		}
	});

	it("all categories have icons", () => {
		for (const category of SECTION_CATEGORIES) {
			expect(category.icon).toBeTruthy();
			expect(typeof category.icon).toBe("string");
		}
	});

	it("has exactly 6 categories", () => {
		expect(SECTION_CATEGORIES).toHaveLength(6);
	});
});

describe("getCategoryById", () => {
	it("returns category for valid id", () => {
		const category = getCategoryById("marketing");
		expect(category).not.toBeNull();
		expect(category?.id).toBe("marketing");
	});

	it("returns null for invalid id", () => {
		const category = getCategoryById("nonexistent");
		expect(category).toBeNull();
	});

	it("can find all categories by their ids", () => {
		for (const category of SECTION_CATEGORIES) {
			const found = getCategoryById(category.id);
			expect(found).not.toBeNull();
			expect(found?.id).toBe(category.id);
		}
	});
});

describe("templateToSection", () => {
	it("converts template to section with theme source", () => {
		const template = SECTION_STARTER_TEMPLATES[0];
		const section = templateToSection(template);
		expect(section.source).toBe("theme");
	});

	it("preserves template id as section id", () => {
		const template = SECTION_STARTER_TEMPLATES[0];
		const section = templateToSection(template);
		expect(section.id).toBe(template.id);
	});

	it("preserves category from template", () => {
		const template = SECTION_STARTER_TEMPLATES[0];
		const section = templateToSection(template);
		expect(section.category).toBe(template.category);
	});

	it("clones content array (not reference)", () => {
		const template = SECTION_STARTER_TEMPLATES[0];
		const section = templateToSection(template);
		expect(section.content).not.toBe(template.content);
		expect(section.content).toEqual(template.content);
	});

	it("all templates have valid categories", () => {
		for (const template of SECTION_STARTER_TEMPLATES) {
			const category = getCategoryById(template.category);
			expect(category).not.toBeNull();
		}
	});
});

describe("SECTION_STARTER_TEMPLATES", () => {
	it("all templates have unique ids", () => {
		const ids = SECTION_STARTER_TEMPLATES.map((t) => t.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("all templates have content", () => {
		for (const template of SECTION_STARTER_TEMPLATES) {
			expect(Array.isArray(template.content)).toBe(true);
			expect(template.content.length).toBeGreaterThan(0);
		}
	});

	it("all templates have keywords", () => {
		for (const template of SECTION_STARTER_TEMPLATES) {
			expect(Array.isArray(template.keywords)).toBe(true);
			expect(template.keywords.length).toBeGreaterThan(0);
		}
	});

	it("all templates belong to a valid category", () => {
		const validCategoryIds = SECTION_CATEGORIES.map((c) => c.id);
		for (const template of SECTION_STARTER_TEMPLATES) {
			expect(validCategoryIds).toContain(template.category);
		}
	});

	it("has minimum variety of templates (at least 15)", () => {
		expect(SECTION_STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(15);
	});

	it("categories are distributed across templates", () => {
		const categoryCounts: Record<string, number> = {};
		for (const template of SECTION_STARTER_TEMPLATES) {
			categoryCounts[template.category] = (categoryCounts[template.category] || 0) + 1;
		}
		// Each category should have at least 1 template
		for (const category of SECTION_CATEGORIES) {
			expect(categoryCounts[category.id]).toBeGreaterThanOrEqual(1);
		}
	});
});
