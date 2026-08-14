---
"emdash": minor
---

Adds `GET`, `PUT`, and `DELETE` on `/_emdash/api/taxonomies/{name}` plus `GET /_emdash/api/taxonomies/{name}/translations`, so a taxonomy definition can be read, edited, and removed rather than only listed and created. `GET` and `PUT` address one locale's definition via `?locale=`; `DELETE` takes no locale and removes the taxonomy outright — every locale's definition, every term under that name, and those terms' content assignments.
