# @t4r71/dsh-dual-axis-ui

The browser half of the dual-axis access-mode bundle: the General-settings row
that edits the two axis seeds, and the two read/write axis dropdowns above the
composer.

## Install this together with the host half

This package is **half** of the bundle. It renders and submits axis values; it
enforces nothing and stores nothing. The host half
(`@t4r71/dsh-dual-axis`) owns the per-session axis pair, the read fence, the
`/axis` command and the model-facing range paragraph. Installing this package
alone produces a page that writes settings nothing reads: the dropdowns appear
and save, and no access decision changes.

Install the host half, and add it to the profile's `dsh.profile.bundles`:

```json
{
  "dependencies": {
    "@t4r71/dsh-dual-axis": "file:.../t4r71-dsh-dual-axis.tgz",
    "@t4r71/dsh-dual-axis-ui": "file:.../t4r71-dsh-dual-axis-ui.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@t4r71/dsh-dual-axis"
      ]
    }
  }
}
```

Only the host half is listed under `dsh.profile.bundles`: it is the bundle, and
its `cordis.patch.yml` carries the row that mounts this client half. This
package ships no bundle patch of its own.

## ⚠ This bundle disables an official UI row

Installing the bundle turns OFF the upstream row `ui-permission`
(`@deepseek-ai/dsh-client-ui-permission-presets`, declared in
`@deepseek-ai/dsh-web-app`'s `cordis.patch.yml`). That is a deliberate
replacement: this bundle's client half registers the same
`conversation.input.permission` slot, so the two cannot both be active, and
leaving both registered makes the client hang on "Loading plugins".

**The full statement — what is replaced, which two mechanisms collide, what
behaviour changes, and how to get the official UI back — lives in the host
package's README**, section "This bundle disables an official UI row". It is
not repeated here, so the two copies cannot drift.

If you installed only this package, you have that disable applied by nothing and
the upstream row still active; both are covered by the section above.

## Layout

| Path | Role |
| --- | --- |
| `src/client/index.ts` | The client entry: mounts both registered surfaces |
| `src/client/row/index.ts` | The `plugins.row.config` row: both axes, the rule-group library, one atomic save |
| `src/client/row/axes.ts` | The axis draft/value conversion and label text, shared by every surface |
| `src/client/row/groups.ts` | The rule-group library document and its validation keys |
| `src/client/permission/session-axes.ts` | Reads the axis pair currently in force for the open session |
| `src/client/permission/session-axes-seed.ts` | Recomputes the host's seed for a session with no stored record |
| `src/client/permission/PermissionSelect.tsx` | The two composer dropdowns |
| `src/client/permission/settings-store.ts` | The settings document the dropdowns write |

`session-axes-seed.ts` deliberately shares no import with the host half, which
recomputes the same seed independently; the host's `tests/seed-parity.spec.ts`
feeds both the same rows and asserts identical bytes, key order included.

## Building

The package resolves every `@deepseek-ai/*` import from its own
`node_modules`: `pnpm install` then `tsc -b tsconfig.json && tsdown` work in a
tree containing nothing but this package.
