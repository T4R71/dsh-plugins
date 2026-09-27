/**
 * Permission preference row: the default preset for subsequently created
 * sessions. Current-session switches remain on the composer's read/write
 * axis dropdowns.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutlineMedium, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PermissionSettingsState } from './settings-store.ts'
import type { PermissionSettingsKey } from './locales.ts'
import { displayPermissionPreset } from './presentation.ts'
import css from './PermissionRow.module.css'

/** Registration-side business face for the host-backed preference. */
export interface PermissionRowInjected {
  hooks: {
    /** Permission settings snapshot bound by the renderer as usePermission. */
    permission: SnapshotStore<PermissionSettingsState>
  }
  /** Load the descriptor when the row first renders. */
  load: () => Promise<void>
  /** Persist one advertised preset. */
  select: (preset: string) => Promise<void>
}

/** Full component props. */
export type PermissionRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.permission'>
  & InjectFace<PermissionRowInjected>

/**
 * Render the new-session Permission default selector. The row keeps the host's
 * single preset enum on purpose: its options come from the Host settings
 * schema (which still publishes one bundled preset per mode), not from the
 * current-session two-axis catalog, so splitting it here would invent a second
 * source of truth for the same durable value. A visible pick applies directly —
 * the full-access acknowledgement step was removed with the composer's.
 * @param props - composed slot props.
 * @returns the row, or null when the host does not expose permission settings.
 */
export function PermissionRow({ load, select, usePermission, t }: PermissionRowProps) {
  const state = usePermission(snapshot => snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.writable && state.status !== 'unavailable') return
    setOpen(false)
  }, [state.status, state.writable])

  if (state.status === 'unavailable') return null
  const selected = state.options.find(option => option.id === state.currentValue)
  const busy = state.status === 'loading' || state.status === 'saving'
  const optionLabel = (option: PermissionSettingsState['options'][number]): string =>
    displayPermissionPreset(option.id, option.label, t)
  const label = selected !== undefined ? optionLabel(selected) : (busy ? t('loading') : t('unavailable'))
  const description: string = state.error ?? t('description')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.desc} role={state.error === null ? undefined : 'alert'}>{description}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={state.options.map(option => ({ id: option.id, label: optionLabel(option) }))}
        selectedId={state.currentValue}
        onSelect={(id) => {
          setOpen(false)
          if (id === state.currentValue) return
          void select(id)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy || !state.writable || state.options.length === 0}
            onClick={() => { setOpen(value => !value) }}
          >
            {label}
            <IconChevronDownOutlineMedium className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Permission row copy. */
    'settings.permission': PermissionSettingsKey
  }
}
