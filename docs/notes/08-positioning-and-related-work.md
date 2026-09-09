# 8. Positioning and Related Work

This document records how Moult relates to existing systems and why the niche is worth building. It must be revised whenever a competitor closes the gap. Last reviewed: 2026-09-09.

## The claim Moult makes

Installation is easy in most plugin systems; removal and replacement are vague. The specific claim is narrower:

> A failed candidate replacement leaves the previous generation active, usable, and serving, and a successful replacement leaks nothing.

This claim is falsifiable. It is demonstrated by the transaction tests and the comparison demo in [6](./06-validation-and-release-gates.md), not by assertion.

## Existing systems

| System                                                                                                                         | What it provides                                                                                       | What it does not provide                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cordis](https://github.com/cordiverse/cordis) (Koishi ecosystem)                                                              | context-scoped plugins, service injection, lifecycle events, disposal propagation                      | a different lifecycle/reload model; this document makes no claim that its failed-reload behavior is equivalent to Moult's candidate/commit guarantee |
| [Effect `Layer` / `Scope`](https://effect.website/docs/v3/requirements-management/layers)                                      | transactional resource graphs, reverse-order release, release on failure or interruption               | requires adopting the Effect paradigm; no plugin generations, staged contributions, or host-neutral registry                                         |
| [TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) (`using`, `Symbol.dispose`) | language-native deterministic disposal; a finished Stage 4 proposal, with TypeScript support since 5.2 | disposal only: no ownership graph, staged publication, or replacement protocol                                                                       |
| [Avvio](https://github.com/fastify/avvio) (Fastify)                                                                            | async boot ordering, close handlers                                                                    | boot-time only; no replacement at all                                                                                                                |
| NestJS lifecycle, `@loopback/context`, Gasket                                                                                  | framework lifecycle hooks, dependency injection, plugin orchestration                                  | framework-tied; no candidate/commit protocol                                                                                                         |
| [Asqium](https://scispace.com/pdf/asqium-a-javascript-plugin-framework-for-extensible-client-57qak5g21f.pdf)                   | academic plugin framework with hot-swap                                                                | research prototype; not maintained for production                                                                                                    |
| Host-specific plugin systems (Koishi plugins, Pi coding-agent extensions, Obsidian, Homebridge)                                | proven ecosystems                                                                                      | bound to one host; the lifecycle is not reusable                                                                                                     |

## Why the niche is still open

As of this review, the repository's comparison scope has not identified a
maintained npm library that demonstrates the same candidate-replacement claim
under the documented scenario. This is a bounded positioning observation, not
an exclusivity claim; it must be rechecked before each release. The combination
is the point of comparison, while each part alone is not:

- disposal alone is becoming language-native;
- resource graphs alone exist in Effect;
- plugin lifecycle alone exists in Cordis.

If any of these systems ships the missing guarantee, this project loses its reason to exist and must be re-evaluated.

## Obligations that follow

- The comparison demo in [6](./06-validation-and-release-gates.md) must include a pinned Cordis version and state the exact scenario being compared. Any claim about Cordis's behavior on failed reload must be demonstrated there, not assumed from a general description.
- `Scope` currently supports `Symbol.asyncDispose`, while `DisposableLike` uses `.dispose()`. Synchronous `Symbol.dispose` interoperability is not part of the current public contract and must not be advertised as implemented.
- Documentation must answer "why not Effect" and "why not `using`" in the first screen of the README.

## Naming record

**Moult** is the name. The metaphor is biologically exact: a crab grows a new exoskeleton beneath the old one and sheds the old shell only after the new one is complete; a failed moult leaves the old shell intact. That is the replacement protocol.

Alternatives considered and rejected:

- **Escrow** — exact for the commit protocol but dry, and crowded by fintech and blockchain usage.
- **Chrysalis** — implies dormancy; the interesting phase here is the transition.
- **Baton** — captures handover but not preparation or failure.
- **Lineage** — captures generations but collides with LineageOS in search.

Publication naming must be rechecked immediately before every release because
npm package availability, GitHub ownership, and search results are mutable
external facts. The repository publishes under the scoped `@moult` namespace;
the current repository identity and package metadata are the local source of
truth for this checkout. This note does not claim ownership of unscoped names
or unrelated projects using the Moult metaphor.

2026-09-09: scope `@moult` adopted. The two unscoped spellings were already registered, so the scoped project namespace was selected; organization creation remains an owner action. Project spelling is standardized to Moult; `MoltError` identifiers stay frozen as public API.
