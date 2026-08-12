# EmDash Investigation-Bot Eval Dataset

26 real closed issues from `emdash-cms/emdash`, selected so the **issue body alone**
carries enough to attempt (or correctly decline) a reproduction. All data gathered
read-only; nothing posted to GitHub.

## Counts

| Category                   | Count  | Share | Target |
| -------------------------- | ------ | ----- | ------ |
| CONFIRMED_BUG              | 19     | 73%   | ~60%   |
| NOT_REPRODUCIBLE / INVALID | 3      | 12%   | ~25%   |
| NEEDS_INFO                 | 4      | 15%   | ~15%   |
| **Total**                  | **26** |       | 20–30  |

Category definitions used:

- **CONFIRMED_BUG** — a real, reproducible defect. Usually fixed and linked to a
  merging PR (the run checks out the pre-fix commit); #1193 is confirmed but
  still unfixed, so it runs at `main`. A correct investigation reproduces it
  and lands (or points at) the fault.
- **NOT_REPRODUCIBLE** — closed as cannot-reproduce, already-resolved on main, or
  not-a-code-bug. A correct investigation says "could not reproduce" instead of
  hallucinating a repro/patch.
- **NEEDS_INFO** — body lacks the specifics to attempt a repro; correct first move
  is to ask the reporter (version, config, minimal repro) rather than dig in.

## Area / repro-path coverage (confirmed bugs)

Deliberately spread across subsystems and both DB dialects:

- **admin UI:** 2344 (editor), 1671 (auth link), 1607 (Kumo/Tailwind build), 895 (dashboard)
- **rendering / portable-text:** 1884 (blockquote), 696 (media value)
- **api / core:** 2330, 2034, 1551, 1193 (publishing timestamps)
- **search:** 2245 (FTS5 tokenizer)
- **caching / perf:** 2210
- **routing / redirects:** 1986, 808
- **i18n / locale:** 1551, 1421, 1080
- **DB dialect (D1/SQLite specific):** 1021, 917, 895, 2330
- **build / CLI / import:** 1421, 1080, 1021
- **media:** 696

Repro paths: public site (696, 917, 1986, 808, 2210), api (2330, 2034, 2245, 1551,
1193), admin (2344, 1671, 1607, 1884, 895), build (1421, 1080, 1021).

Difficulty spread: easy 3, medium 9, hard 7 (confirmed); the not-repro/needs-info
buckets add the "don't overreach" pressure.

## Full case list

### CONFIRMED_BUG (19)

| #    | Title (short)                                     | PR   | Diff | Path   |
| ---- | ------------------------------------------------- | ---- | ---- | ------ |
| 2344 | Ordered-list numbering resets to 1.               | 2348 | easy | admin  |
| 2330 | Taxonomy terms 500 (compound-SELECT on D1)        | 2331 | med  | api    |
| 2245 | FTS5 tokenizer breaks CJK/Thai search             | 2257 | hard | api    |
| 2210 | Term-count prefetch full-scans D1 per render      | 2219 | hard | public |
| 2034 | Publish opaque D1 UNIQUE on slug collision        | 2036 | med  | api    |
| 1986 | Slug rename+revert circular redirect              | 1992 | med  | public |
| 1884 | Blockquote splits on reload                       | 1905 | med  | admin  |
| 1671 | Google OAuth doubled `_emdash` URL 404            | 1720 | easy | admin  |
| 1607 | Primary button invisible (Tailwind v4 miss)       | 1630 | med  | admin  |
| 1551 | localeCode lowercases uppercase subtags           | 1552 | med  | api    |
| 1421 | CLI seed round-trip rewrites default locale to en | 1426 | hard | build  |
| 1080 | WXR import drops WPML translations                | 1087 | hard | build  |
| 1021 | Migration 036 wipes content_taxonomies on D1      | 1086 | hard | build  |
| 917  | Scheduled posts never publish on SQLite/D1        | 1157 | med  | public |
| 895  | Dashboard 500 (UNION ALL on D1)                   | 896  | med  | admin  |
| 808  | Redirects skipped for anonymous visitors          | 817  | med  | public |
| 696  | MediaValue.src holds bare id, not URL             | 701  | easy | public |
| 1193 | update() overwrites published_at via API          | none | med  | api    |
| 1022 | Legacy seo data rejected as unknown field         | none | hard | admin  |

### NOT_REPRODUCIBLE / INVALID (3)

| #    | Title (short)                       | Why                                                              | Diff | Path   |
| ---- | ----------------------------------- | ---------------------------------------------------------------- | ---- | ------ |
| 1413 | 9 MB admin bundle on public islands | React already own chunk; ~27 KB actual; unreachable admin chunks | hard | build  |
| 1190 | Admin list stops at 50              | current admin sends limit=100 + nextCursor; older build symptom  | med  | admin  |
| 914  | emdashcms.com SSL error             | transient infra/TLS, not a codebase bug                          | easy | public |

### NEEDS_INFO (4)

| #    | Title (short)                  | Why                                                    | Diff | Path   |
| ---- | ------------------------------ | ------------------------------------------------------ | ---- | ------ |
| 959  | HTTP 500 on front end          | one-line trace, v0.0.3, no repro; dup of #945          | easy | public |
| 1113 | "Astro is not defined"         | usage error (ran dev, needed build+preview)            | easy | build  |
| 1272 | Media library capped at 100    | thin report; needs version; resolved on 0.16.1 upgrade | med  | admin  |
| 1124 | Repeater-only edits don't save | screenshots only, no versions/schema/config            | med  | admin  |

## Top 5 cases (strongest evals)

1. **#917 — scheduled posts never publish on SQLite/D1.** Textbook dialect bug: a
   lexicographic text compare of ISO `T…Z` vs space-separated `CURRENT_TIMESTAMP`
   that is _always false_. Body has a full `npm create emdash` repro, exact file/line,
   and the correct `datetime()` fix. Tests dialect awareness and read-path reasoning.

2. **#1021 — migration 036 wipes content_taxonomies on D1.** Silent data loss from
   `PRAGMA foreign_keys=OFF` being ignored on D1 while an ON DELETE CASCADE fires.
   Rewards understanding that D1 != local SQLite; punishes a naive local-only repro
   that would show green.

3. **#2245 — FTS5 tokenizer kills non-spacing-language search.** Subtle "search
   works for the first word, silently empty otherwise" failure with a crisp
   `LIKE`-finds-11 / `MATCH`-finds-0 discriminator. Exercises search internals and
   i18n awareness; hard to fake a conclusion.

4. **#1413 — 9 MB admin bundle (NOT reproducible).** The gold-standard negative case:
   plausible, detailed, version-pinned — and wrong on current main. The reference
   investigation actually built the demo and measured ~27 KB. A bot that "confirms"
   this by pattern-matching the description fails; a good one measures and declines.

5. **#808 — redirects skipped for anonymous visitors.** High-value correctness bug
   invisible to logged-in testing (only fires for real public traffic). The body even
   lays out the middleware branch and two candidate fixes, so it tests whether the bot
   reproduces on the _anonymous_ path rather than the admin one.

## Notes / gaps

- **NEEDS_INFO was the hardest bucket to fill well.** Genuinely underspecified emdash
  issues tend to resolve one of two ways that pull them out of the category: either a
  maintainer/bot reproduced them anyway and merged a fix (→ confirmed), or they were
  duplicates. The four kept (959, 1113, 1272, 1124) are the cleanest "ask first" cases;
  959 and 1124 double as duplicate/insufficient-repro respectively.
- **Watch stale triage labels.** Several `triage/awaiting-reporter` /
  `triage/not-reproduced` issues were later reproduced and fixed (e.g. 1046→#1662,
  1042→#1345, 1191 reproduced+fixed, 1201→#1396). Category was assigned from the
  _closing rationale_ (comments + linked PR + stateReason), not the label.
- **Some NOT_REPRODUCIBLE cases have no single fixing PR** because the underlying fix
  predated the report or landed diffusely; ground truth for those is explicitly
  "cannot reproduce on current main," which is the behavior the bot should emit.
- Media coverage is lighter than the others (696 confirmed, 1272/1124 needs-info,
  2231 available as a spare); DB-dialect and i18n are the deepest seams if more cases
  are wanted later.
