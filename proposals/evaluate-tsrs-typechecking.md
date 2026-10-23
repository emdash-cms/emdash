---
title: Evaluate tsrs for EmDash typechecking
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-10-21
---

# Evaluate tsrs for EmDash typechecking

## Problem and user case

EmDash has many package-level typechecks, and faster checks could shorten developer feedback and CI. A local benchmark on commit `e077be35500fdbdd74f4021b213f7071a6c1aec1` found that the sum of sequential package medians fell from 11.387 seconds with `tsgo` to 5.097 seconds with `tsrs`. The `core` package measured 3.122 versus 0.421 seconds, and `admin` measured 1.298 versus 0.435 seconds. These figures are local package-process timings, not workspace wall-clock or CI measurements.

The benchmark does not justify replacing the required checker. It compared different TypeScript revisions: `tsgo` used TypeScript `7.0.0-dev.20260421.2`; `tsrs` used TypeScript `7.1.0-dev.20260930.4`. Of 32 package checks, 31 produced identical diagnostics. The Cloudflare package produced `TS5115` only under `tsrs` at `packages/cloudflare/src/plugins/ai-search.ts:295`, on the dynamic import of `cloudflare:workers`. Seven intentional-error checks matched, but they cover only those cases.

Contributors benefit from faster checks only if they preserve type-error detection, work in supported CI environments, and leave editor diagnostics usable.

## Proposed behavior

During the evaluation, contributors continue to run `pnpm typecheck`, and its current `tsgo` implementation remains authoritative. A local command and a non-blocking CI shadow job run a pinned `tsrs` build across the typecheck matrix and report diagnostic differences, exit status, runtime, and memory. The shadow job cannot make a pull request pass or fail. The evaluation makes no change to application builds, emitted JavaScript, deployed Workers, package APIs, stored data, or public EmDash behavior.

The evaluation informs a separate decision about whether changing the required typechecker is worthwhile. Any such change would require a separate implementation review and preserve a straightforward fallback to `tsgo`.

## Goals

- Determine diagnostic parity against a TypeScript-matched reference, not only across different compiler revisions.
- Measure end-to-end typecheck time and memory in Linux CI, as well as local package timings.
- Check every typecheck configuration used by CI, including packages, demos, templates, public-source checks, and Astro checks where applicable.
- Confirm that representative intentional type errors, syntax errors, and EmDash-specific types are rejected consistently.
- Document the effect on editor and language-server workflows before recommending adoption.

## Non-goals

- Change the application build, declaration generation, bundler, lint rules, runtime code, or deployed Worker.
- Adopt Cloudflare Void or change EmDash deployment workflows.
- Relax or suppress a type diagnostic solely to make `tsrs` pass.
- Claim that faster typechecking improves Worker execution, response latency, or public page delivery.
- Replace TypeScript services used by editors.

## Interfaces and compatibility

The evaluation adds no package API, data format, generated output, or runtime behavior. It leaves existing scripts and required CI checks unchanged. Any later change to CI, dependency policy, package scripts, or the authoritative typechecker is out of scope and requires separate review.

## Errors and edge cases

The existing Cloudflare diagnostic is a compatibility mismatch to investigate, not a proposed source workaround. The `TS5115` error reproduces under `tsrs` 0.18.0 on both the historical benchmark commit and current `upstream/main`; the pinned `tsgo` and standard `tsc` do not report it on the same EmDash source. The minimal reproduction combines a dynamic import with `.catch(...)` that rethrows the error; import typing, a promise-returning import, the global cache alone, and the Cloudflare RPC `Provider` mapped type do not trigger the diagnostic on their own. The error points into recursive `MethodOrProperty` and `MaybeCallableProvider` types in `@cloudflare/workers-types`.

This narrows the discrepancy but does not establish whether it comes from `tsrs` or a TypeScript source-revision difference. Obtain or build `tsgo` from the `microsoft/TypeScript` revision used by `tsrs` and compare the standalone reproduction before filing an upstream issue. Do not change application types or suppress the diagnostic without Maintainer agreement and evidence of a source-level correctness issue.

The evaluation must also establish whether installing or selecting `tsrs` affects the TypeScript language service used by contributors' editors. The `tsrs` tracker has an open report about the TypeScript 7 VS Code extension being unable to run a project's installed `tsrs` binary: https://github.com/oxc-project/tsrs/issues/661. Consider CLI checking independently only if contributors retain usable editor diagnostics and the setup is clear.

## Verification

The compatibility matrix must include:

- All package typecheck scripts run by `pnpm typecheck`.
- CI's additional demo, template, public-source, Astro, and application typechecks.
- The additional component configuration in `packages/core`, where used.
- The original benchmark commit and current `upstream/main`, so source and dependency changes can be distinguished from compiler differences.
- Positive checks and maintained negative checks for assignment incompatibility, missing properties, unchecked indexed access, nullability, function arguments, exhaustive unions, and syntax errors.
- A recorded comparison of diagnostics, exit codes, runtime, and memory. Classify each diagnostic mismatch as a `tsrs` defect, TypeScript-revision difference, existing source issue, or unresolved discrepancy. Unresolved discrepancies mean the evaluation cannot recommend replacing the required checker.
- Repeated Linux CI measurements on the same runner class, checkout, dependencies, build artifacts, and typecheck matrix. Record compiler versions and source revision, commands, configuration, OS/runtime, warmup, run count, timing distribution, memory method, and exit status. Report whole-job wall time as well as package timings, and compare cold and warm cache conditions separately. Do not use the sum of sequential package medians as a substitute for parallel CI wall time.
- Confirmation that the existing required `tsgo` check remains unchanged and the normal contributor editor workflow remains usable.

## Rollout

1. Run the `tsrs` checks locally or in a non-blocking shadow job with an exact pinned version; do not change required CI behavior.
2. Align TypeScript source revisions and investigate `TS5115`.
3. Complete the compatibility matrix and publish reproducible Linux measurements.
4. If parity, editor usability, and material CI savings are demonstrated, propose a separate implementation change. Otherwise retain `tsgo` as authoritative and record the remaining incompatibilities.

## Open questions

- Should the comparison build `tsgo` from the TypeScript revision used by `tsrs`, or use another documented alignment method?
- What minimum CI wall-time improvement justifies maintaining a second checker?
- What editor support must be available before a checker could change in CI?
- If a separate checker-adoption proposal proceeds, what fallback duration and checks should it require?
