---
"emdash": minor
---

Adds a `fields` option to `getEmDashCollection`, selecting only the named content columns instead of every column on the collection table.

List queries previously read each entry's whole body to render a card or an archive row. On a content site the body is most of the database, so naming the fields a template uses bounds what a list costs: on a 1,891-entry collection averaging 8.8 KB of body, a page reading 93 rows to draw 26 cards moved about 800 KB to render about 40 KB of markup.

System columns, taxonomy, byline, SEO and boolean-field hydration are unaffected, and omitting the option keeps today's behaviour. A projected entry is a partial entry: a field that was not requested is absent from `entry.data`, so anything deriving a value from it sees nothing rather than falling back. An unknown field name throws rather than being dropped.
