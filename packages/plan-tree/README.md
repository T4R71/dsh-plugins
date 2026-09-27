---
description: "The model-facing plan-tree tools and their session projection for the DeepSeek Harness: one whole-tree declaration, per-node status steps, and the planTree value the right Sidebar draws."
kind: "package-reference"
---

# @t4r71/dsh-plan-tree

English | [中文](README.zh.md)

## Summary

`dsh-plan-tree` gives the agent a plan a human can watch: one call declares the whole tree of steps, then one small call moves a single node through `pending`, `in_progress`, `completed`, or `blocked`. The tree lives on the session log and folds into a `planTree` projection, so the right Sidebar draws the live plan — nesting included — while every update stays a single small logged step. Mount it when work has enough structure that the shape of it should be visible; a one-step task does not need it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mounting the package adds two tools and one projection unit, with no configuration to write. The model declares and walks the plan; the projection is what a client reads to draw it.

### When to choose it

Choose it when a piece of work has several steps and the user should be able to see which one is running. The tree is per agent session, exactly like a task list: a subagent declaring its own plan writes its own tree, and there is no shared or cross-agent scope. Avoid it when the model cannot know the steps up front — a plan that is rewritten on every step reduces to a restated task list, which the whole-tree declaration then pays for on every rewrite.

### The two calls

`plan_write` takes the complete tree and replaces whatever was there: no partial writes and no per-node edits. Every node carries a tree-unique `id`, a short imperative `title`, and a `status`; `detail` and nested `children` are optional. `plan_step` then takes one `id` and one `status`, so a status change costs one small call instead of the whole tree. Both tools are dispatched in parallel with `subagent`, and the model is expected to call `plan_write` once and `plan_step` per transition.

Each call answers with counts, so the model can see the shape of the remaining work without reading anything back. Both tools reject the cases that would leave the logged tree untrue: a blank or duplicated `id`, a blank `title`, an unknown `status`, a `plan_step` naming an id the current tree does not carry, a `plan_step` before any declaration was logged, and either call made without an owning agent session.

### The projection

The fold is published under one key, and a client reads it through the ordinary session-projection path.

| Key | Value | Meaning |
|---|---|---|
| `planTree` | `PlanNode[] \| null` | The declared tree with every accepted step applied, or `null` before the first declaration |

The key is served on the history tail page and on the `session/projection` push frame, so a browser that opens or reopens a session receives the current plan without replaying the log itself.

### Mounting

There is no config, so a composition row is the whole setup; the plugin `inject`s `tools` and `sessionProjections`, and a composition that mounts neither leaves the row pending.

```yaml
- name: '@t4r71/dsh-plan-tree'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the two tools and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

Three commitments shape the package:

- **Declare once, then step.** The expensive, high-information call is the declaration; the frequent one is a two-field status update. Splitting them keeps the common operation cheap in tokens and in log size.
- **Log-only state, pure fold.** Nothing is cached in a service. The tree is reconstructed by folding the log, so resume, fork, and compaction recover the plan from the same events that produced it the first time.
- **The fold is the contract.** `apply` returns the incoming state reference for any event it does not own, which is the framework's zero-work signal: an unrelated event in a long session costs no allocation and provokes no downstream repaint.

### The log events

Two events carry everything. `plan/declared` is a whole-tree snapshot that is last-write-wins on replay, so a second declaration supersedes the first rather than accumulating. `plan/step` carries one node's tree-unique `id` and its new `status`. Both are log-only: they are durable and replayable, and neither is ever assembled into a model request.

### The projection unit

The unit registers with `init: () => null` — the plan is absent, not empty, until something is declared. `apply` replaces the state on `plan/declared`, and on `plan/step` rebuilds only the spine from the root to the addressed node, returning the original reference when no node carries that id. `stateVersion` is `1`, and the wire view is the state itself, so a client receives the same tree the fold holds.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the projection unit and both tool registrations |
| [`src/types.ts`](src/types.ts) | The one home of the `planTree` key declaration, `PlanNode`, `PlanStatus`, and both event declarations |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [plan/ package group](../README.md#packages) — the group this package belongs to and its neighboring plan-mode feature.
- [Plan mode](../plan-mode/README.md) — the design-first companion package: plan mode guides the model while it works out a plan, then this package records the plan it settled on.
- [Plan subsystem reference](../../../docs/subsystems/plan.md) — the shared vocabulary for plan state, its configuration, and its recovery.
- [`plan/declared` in the persistence catalog](../../../docs/persistence-catalog.md#persistence-type-eventplandeclared) — the exact durable shape of a declaration.
- [`plan/step` in the persistence catalog](../../../docs/persistence-catalog.md#persistence-type-eventplanstep) — the exact durable shape of a status update.

-----

<a id="model-experience"></a>
## Model Experience

### Plan declaration and step tools

#### What the model sees

Both tools stay registered in every request, whatever the plan state: `plan_write` takes the whole `nodes` tree — each node with a required tree-unique `id`, a required `title`, and a required `status` of `pending`, `in_progress`, `completed`, or `blocked`, plus optional `detail` and `children` — while `plan_step` takes one `id` and one `status`. A successful declaration returns `total` with per-status counts; a successful step returns the node's `id`, its new `status`, and the same counts. Rejections arrive as failed calls naming the offending field, so the model corrects itself rather than silently diverging from the logged tree.

#### Token effect

Fixed while the package is loaded: two tool definitions in the request's tool catalog, plus each call's arguments and result in conversation history. A declaration is paid in full only when the model genuinely rewrites the tree; a status change pays two short fields, which is what makes a long plan affordable to keep current.

#### KV Cache effect

None: the tool definitions never change with plan state, so the catalog prefix stays stable, and a status change appends one small event without rewriting earlier context. The folded tree itself never enters a request — the projection is wire-only — so no step can invalidate a reusable prefix.

### Plan state in the session log

#### What the model sees

Nothing directly. `plan/declared` and `plan/step` are log-only events, and the folded `planTree` value travels to browser carriers rather than into a request. The model learns a step's outcome from the result of the `plan_step` call it just made, never by reading the tree back.

#### Token effect

None beyond the calls that write the events. There is no prompt section, no tool-guidance text, and no read-back tool, so a session that declares a plan and walks it pays only for the declarations and steps themselves.

#### KV Cache effect

None. Because the state is never assembled into a request, declaring a plan, changing a status, or resuming a session with a plan already in the log leaves the request prefix byte-identical.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Whole-tree declaration only** — the tree is declared in one piece; there is no way to add, remove, or re-order a single node without restating the tree, and no read-back tool.
- **No execution coupling** — a node's `status` is what the model says it is. Nothing verifies that an `in_progress` step is still running, and a plan left behind by an abandoned turn keeps its last recorded statuses.
- **UUID-free ids are the model's problem** — ids are validated for uniqueness across the tree but not for stability across rewrites, so a redeclared tree must repeat them for a step to keep addressing the same node.
- **Renderer-side depth** — nesting is folded and transported without limit, while the Sidebar panel draws it; a pathologically deep tree is a presentation question this package does not bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published because the package's only durable rule is the shape of the two events it appends, and that shape is owned by `planTreeSchema` and the shared node canonicalization in `src/index.ts`; a second validator would be a copy of the same declarations rather than an independent observation.
