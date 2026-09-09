# Moult guarantees

These are the user-visible lifecycle guarantees of Moult. They are the public
contract behind the runtime, its tests, and its issue reports. The design notes
linked in the last column provide the rationale and boundaries.

| ID     | Guarantee                                                                                                                                    | Source                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| INV-01 | An activation failure disposes every resource acquired by that activation attempt.                                                           | [Thesis and boundaries](./notes/01-thesis-and-boundaries.md)                   |
| INV-02 | Disposal runs in reverse acquisition order (LIFO) within one scope.                                                                          | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-03 | Disposal continues after an individual disposer fails; every failure is collected.                                                           | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-04 | A scope commits at most once, and an aborted scope can never commit.                                                                         | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-05 | A committed generation is disposed at most once; `dispose` is idempotent.                                                                    | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-06 | Staged capabilities and contributions are invisible to observers before commit.                                                              | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-07 | A failed replacement leaves the previous generation active and usable.                                                                       | [Validation and release gates](./notes/06-validation-and-release-gates.md)     |
| INV-08 | After a replacement commits, the old generation is never restored, even if its disposal fails.                                               | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-09 | A plugin can resolve only capabilities its declared requirements permit.                                                                     | [Capabilities and dependencies](./notes/04-capabilities-and-dependencies.md)   |
| INV-10 | Ambiguity, missing requirements, version conflicts, and cycles are structured errors, never warnings.                                        | [Thesis and boundaries](./notes/01-thesis-and-boundaries.md)                   |
| INV-11 | Stopping a provider with active dependents is rejected by default; cascade is explicit, ordered, and recorded.                               | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-12 | Every runtime-managed resource has an owner; a disposed generation owns zero live runtime resources.                                         | [Validation and release gates](./notes/06-validation-and-release-gates.md)     |
| INV-13 | Runtime instances share no mutable state; no global registry exists.                                                                         | [Core model and API](./notes/02-core-model-and-api.md)                         |
| INV-14 | If old-generation disposal fails after commit, the replacement still succeeds and the failure is inspectable.                                | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |
| INV-15 | Replacing a provider with active dependents either replaces the dependent closure atomically or is rejected; silent rebinding never happens. | [Lifecycle and transactionality](./notes/03-lifecycle-and-transactionality.md) |

Every behavioral change must preserve the applicable guarantees. The
repository's test and CI suites are the executable proof; implementation plans
and release ledgers are maintained separately by the project maintainers.
