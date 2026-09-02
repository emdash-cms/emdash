---
id: publish-first-update
site: editorial-small
target: node
status: ready
requires: []
---

# Publish the first update

This calibration journey confirms that the tester can complete the main publishing workflow using the existing scaffold.

## Bootstrap requirements

Use the seeded `editorial-small` profile and its authenticated Admin. Start from the admin dashboard with the first-login welcome experience intact.

## Tester brief

### Persona

You own a small publication and are using EmDash for the first time. You need to publish a short studio announcement.

### Goal

Publish a new post titled **September studio update**. Confirm that visitors can read it when you are finished.

### Starting knowledge

You know the announcement belongs with the site's posts. You have not been shown where posts are created or how EmDash distinguishes saved work from published work.

### Supplied material

Use this summary:

> A short update on what the studio is building this autumn.

Use this body:

> We are opening the workshop for community projects throughout September.

## Coordinator checks

- Exactly one post has the title `September studio update`.
- The post is published.
- Its excerpt and body match the supplied text.
- It has a non-empty slug.
- Its public URL returns a successful response containing the supplied body.

## Areas to observe

- Does the welcome experience help the tester begin or obstruct the task?
- Can the tester discover where to create a post?
- Can the tester distinguish saving from publishing?
- Does the interface communicate when the post becomes public?
- Can the tester find a way to confirm what visitors see?
