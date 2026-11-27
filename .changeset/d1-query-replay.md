---
"@emdash-cms/cloudflare": minor
---

Adds experimental `d1({ replay: true })`, which cuts D1 round trips on anonymous page renders by sending each page's predicted queries to D1 as one batch when the request starts.

```js
database: d1({ binding: "DB", session: "auto", coalesce: true, replay: true }),
```

EmDash records which `SELECT` statements an anonymous HTML render of a path ran and replays that list on the next render of the same path. Only the list of queries is stored, in the isolate and the Workers Cache API, keyed by build, host, and path; results are always read fresh. Queries the list did not predict run as usual, and the list updates in the background when a page's queries change. Replay requires `session` and `coalesce` and is off by default.

Replay helps most on Workers that run far from their D1 primary. A Worker using targeted placement next to its database gains little.
