---
description: "The right Sidebar's plan-tree tab type for the dsh web client: the session's planTree projection drawn as a nested step tree with a status glyph per row."
kind: "package-reference"
---

# @t4r71/dsh-ui-plan-tree

English | [中文](README.zh.md)

## Summary

The right Sidebar's plan tab type: the session's declared plan as a nested tree of steps, one row per node, each with its status glyph. It is a page type reached from the guide and claims no address; it reads the `planTree` projection the host already folded and writes nothing — the plan belongs to the model's `plan_write` and `plan_step` calls.

## Table of Contents

- [What it registers](#what-it-registers)
- [The panel](#the-panel)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `plan-tree`, id `@t4r71/dsh-ui-plan-tree`, band `builtin`, no patterns, and one guide entry (order 20, its title and description from the `planTree` namespace, its glyph the shared plan icon) that opens the type.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: a summary row naming the type and its progress, then the tree. The summary counts every node in the tree, so a parent's own status and its children's are both counted.
- **The chip title** — the keyed `sidebar.right.pane.tab.title` seat under that id: the shared plan glyph at 14px before the type's label.

Six source files under `src/client/`: `definition.tsx` (the type), `PlanTreePanel.tsx` (what it draws, with its four status glyphs and the counting helpers), `PlanTreePanel.module.css` (how it looks), `locales.ts` (what it says), and `index.ts` (the wiring), plus the shared `css-modules.d.ts` declarations.

<a id="the-panel"></a>
## The panel

Everything on screen arrives through `useProjection('planTree')` on the session standard kit; the panel folds nothing itself and owns no state beyond which nodes the reader has opened.

| Projection value | Panel |
|---|---|
| `undefined` | Nothing — the host half is not loaded, so the capability does not exist here. |
| `null` | Nothing — no plan has been declared on this session. |
| `[]` | Nothing — a declared plan with no steps. |
| `PlanNode[]` | The summary row and the tree. |

A node with children renders as a disclosure button carrying `aria-expanded`, closed to begin with, so a deep plan opens at its top level; a leaf renders as plain markup. Each row's data attribute carries its status, and the glyph says the same thing in shape: a dashed ring for `pending`, a spinning gradient ring for `in_progress`, a filled disc with a knocked-out check for `completed`, and a ring with a cross for `blocked`.

The summary joins only the non-zero counts — done (shown whenever any node exists), active, blocked, then pending — so a plan with no finished step still reports its progress as one segment rather than staying silent. Four status glyphs are inline SVG: the shared icon set has no matching outline for a status scale, and each carries its own ink token.

<a id="model-experience"></a>
## Model Experience

### Plan state rendered in the browser

#### What the model sees

Nothing. This package registers no tool, no prompt section, and no session event; it reads the `planTree` projection the host's `plan_write` and `plan_step` tools already folded. Nothing the panel computes — the expanded set, the counts, the glyph a status draws — travels back to a request.

#### Token effect

None. The panel is a browser artifact, and the projection it consumes never enters a model request; the only tokens a plan costs are the tool calls that declared and stepped it, charged by the host package.

#### KV Cache effect

None. Because nothing here is assembled into a request, opening the tab, expanding a node, or switching sessions leaves the request prefix byte-identical.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Read-only.** The panel draws the plan and never edits it: no status toggle, no rename, no add or remove. Changing a step means asking the model, whose tool call is the only writer.
- **Expansion is per mount.** The open-node set is component state, so switching to another Sidebar tab and back reopens the tree at its top level; nothing is persisted or restored.
- **One panel per session.** The panel follows the session it was opened for; there is no cross-session or multi-plan view, and no way to pin one plan beside another.
- **No search or filter.** Every declared node is drawn, whatever its status; a large plan is navigated by scrolling and expanding.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The panel's only state is the expanded-node set held by the component that draws it, discarded when it unmounts; there is no second observation of it to compare against.