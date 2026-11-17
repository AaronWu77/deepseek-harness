/**
 * The session header's agent-preset label.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, and a header is only worth reading after that. Offering
 * a control here would promise a switch the host refuses; naming what the
 * session runs is the honest affordance, and the choice itself lives on the
 * new-session screen ({@link AgentPresetSeat}).
 */

import { useEffect } from 'react'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { displayPreset, type PresetDisplayContribution } from './preset-display.ts'
import css from './AgentPresetLabel.module.css'

/** Registration-side business face for the header label. */
export interface AgentPresetLabelInjected {
  /** Resolve translations with the current Client locale. */
  resolvePresetDescription: (text: PresetDisplayContribution['description']) => string
  hooks: {
    /** Registered descriptions; renderer subscribes to changes. */
    presetDisplay: ObservableSnapshot<readonly PresetDisplayContribution[]>
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** Read the roster, so the label can show a name rather than an id. */
  load: () => Promise<void>
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset name beside its title.
 * @param props - composed slot props.
 * @returns the label, or null when the session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, usePresetDisplay, resolvePresetDescription, load, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const options = useAgentPresets(state => state.options)
  const descriptions = usePresetDisplay(value => value)

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const option = options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : displayPreset(option, t, descriptions, resolvePresetDescription)
  return (
    <span className={css.label} title={text?.description ?? t('headerHint')}>
      <IconAgentPresetOutlineRegular size={14} className={css.icon} />
      {text?.name ?? preset}
    </span>
  )
}
