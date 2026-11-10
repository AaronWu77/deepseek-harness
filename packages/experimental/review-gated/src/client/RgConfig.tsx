/** Role model pools and attempt budgets in the RG settings section. */
import { useId, useState } from 'react'
import { Menu, SettingsForm, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RgConfigFace, RgConfigState } from './config-controller.ts'
import type { LimitField, ModelRow, PoolRole } from './model-pools.ts'
import type {} from './index.ts'
import css from './rg.module.css'

/** Framework-derived settings section props. */
export type RgConfigProps = Pick<PropsRuntime<'settings.section'>, 'close'> & PropsLocale<'review-gated'> & InjectFace<RgConfigFace>
type PoolProps = PropsLocale<'review-gated'> & Pick<RgConfigFace, 'toggleModel' | 'selectDefault' | 'selectEffort'>
  & { role: PoolRole; state: RgConfigState }

function EffortChoice({ row, disabled, onChange, t }: PropsLocale<'review-gated'> & {
  row: ModelRow
  disabled: boolean
  onChange: (effort: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const value = row.reasoningEffort
  const label = value === undefined ? t('providerDefault') : row.efforts.find(effort => effort.id === value)?.name ?? value
  return <Menu open={open && !disabled} portal compact
    anchor={<button type="button" className={css.choice} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open && !disabled} aria-label={t('reasoning') + ' ' + row.provider + '/' + row.model}
      onClick={() => { setOpen(previous => !previous) }}>{label}</button>}
    items={[{ id: '', label: t('providerDefault') }, ...row.efforts.map(effort => ({ id: effort.id, label: effort.name }))]}
    selectedId={value ?? ''} onClose={() => { setOpen(false) }}
    onSelect={(id) => { onChange(id === '' ? undefined : id); setOpen(false) }} />
}

function ModelPoolFields({ role, state, t, ...actions }: PoolProps) {
  const groupId = useId()
  const blocked = !state.writable || state.saving || state.conflicted
  const groups = new Map<string, { title: string; rows: ModelRow[] }>()
  for (const row of state.rows[role]) {
    const key = row.available ? 'provider:' + row.provider : 'unavailable'
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { title: row.available ? row.providerName : t('savedUnavailable'), rows: [row] })
    else group.rows.push(row)
  }
  return <section className={css.section} aria-labelledby={groupId}>
    <h3 className={css.heading} id={groupId}>{t(role)}</h3>
    <div className={css.models}>
      {[...groups].map(([key, group]) => <fieldset key={key} className={css.modelGroup}>
        <legend className={css.provider}>{group.title}</legend>
        {group.rows.map(row => <div key={row.key} className={css.model}>
          <label className={css.candidate}>
            <input type="checkbox" checked={row.selected} disabled={blocked || (!row.available && !row.selected)}
              aria-label={t('selectModel') + ' ' + row.provider + '/' + row.model}
              onChange={() => { actions.toggleModel(role, row.key) }} />
            <span className={css.modelName}>{row.modelName}<span className={css.route}>{row.provider + '/' + row.model}</span></span>
          </label>
          {row.selected ? <div className={css.modelOptions}>
            <label className={css.defaultChoice}>
              <input type="radio" name={groupId} checked={row.isDefault} disabled={blocked}
                aria-label={t('defaultModel') + ' ' + row.provider + '/' + row.model}
                onChange={() => { actions.selectDefault(role, row.key) }} />
              {t('defaultModel')}
            </label>
            <span className={css.effortLabel}>{t('reasoning')}</span>
            <EffortChoice row={row} t={t} disabled={blocked || !row.available}
              onChange={(effort) => { actions.selectEffort(role, row.key, effort) }} />
          </div> : null}
        </div>)}
      </fieldset>)}
    </div>
    {state.errors[role] === null ? null : <p className={css.error} role="status">{t(state.errors[role])}</p>}
  </section>
}

/**
 * Render RG's atomically saved role pools, inheritance, and budgets.
 * @param props - renderer-bound draft source, localized copy and edit actions.
 * @returns the bundle-owned configuration form.
 */
export function RgConfig(props: RgConfigProps) {
  const { t } = props
  const state = props.useRgConfig(snapshot => snapshot)
  const settings = state.settings
  const blocked = !state.writable || state.saving || state.conflicted
  const numberField = (field: LimitField) => <label key={field} className={css.numberField}>
    <span>{t(field)}</span>
    <input type="number" min={1} step={1} value={state.limits[field]} disabled={blocked}
      aria-invalid={state.invalidLimits.includes(field)}
      onChange={(event) => { props.editLimit(field, event.target.value) }} />
    {state.invalidLimits.includes(field) ? <span className={css.error}>{t('integerRequired')}</span> : null}
  </label>
  return <><h2 className={css.heading}>{t('roleModels')}</h2>
    {state.uncertain ? <div className={css.error} role="alert">{t('uncertain')}
      {state.available ? <button type="button" className={css.textButton} onClick={props.acknowledgeUncertain}>{t('acknowledgeUncertain')}</button> : null}
    </div> : null}
    <SettingsForm state={state} labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'),
      saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
    onSave={props.save} onDiscard={props.discard} discardOnUnmount={false}>
      <p className={css.notice}>{t('poolHint')}</p>
      <p className={css.notice}>{t('effectiveHint')}</p>
      {settings !== null && !state.configured ? <p className={css.notice}>{t('notConfigured')}</p> : null}
      {state.catalogStatus === 'loading' ? <p className={css.notice} role="status">{t('catalogLoading')}</p> : null}
      {state.catalogStatus === 'error' || state.partialCatalog ? <div className={css.notice} role="status">
        {t(state.catalogStatus === 'error' ? 'catalogFailed' : 'catalogPartial')}
        <button type="button" className={css.textButton} onClick={props.retryCatalog}>{t('retry')}</button>
      </div> : null}
      {state.catalogStatus === 'ready' && state.rows.main.length === 0 ? <p className={css.notice}>{t('catalogEmpty')}</p> : null}
      {settings !== null ? <>
        <ModelPoolFields {...props} role="main" state={state} />
        <ModelPoolFields {...props} role="worker" state={state} />
        <section className={css.section}>
          <h3 className={css.heading}>{t('reviewer')}</h3>
          <label className={css.defaultChoice}><input type="radio" name="rg-reviewer-mode"
            checked={settings.reviewer.mode === 'inherit-main'} disabled={blocked}
            onChange={() => { props.setReviewerMode('inherit-main') }} />{t('inherit')}</label>
          <label className={css.defaultChoice}><input type="radio" name="rg-reviewer-mode"
            checked={settings.reviewer.mode === 'custom'} disabled={blocked}
            onChange={() => { props.setReviewerMode('custom') }} />{t('custom')}</label>
          <p className={css.notice}>{t('inheritHint')}</p>
        </section>
        {settings.reviewer.mode === 'custom' ? <ModelPoolFields {...props} role="reviewer" state={state} /> : null}
        <section className={css.section}>
          <h3 className={css.heading}>{t('budget')}</h3>
          <div className={css.numbers}>{numberField('maxWorkerAttempts')}{numberField('maxReviewAttempts')}</div>
          <p className={css.notice}>{t('budgetHint')}</p>
        </section>
        <details className={css.section}><summary>{t('advanced')}</summary><div className={css.numbers}>
          {numberField('maxHandoffChars')}{numberField('maxReportChars')}{numberField('maxScopeFiles')}{numberField('maxScopeBytes')}
        </div></details>
      </> : null}
      {state.conflicted ? <p className={css.error} role="alert">{t('conflict')}</p> : null}
      {state.dirty || state.conflicted ? <button type="button" className={css.textButton} disabled={state.saving}
        onClick={props.discard}>{t('discard')}</button> : null}
      {state.savedNotice === null ? null : <Toast key={state.savedNotice} tone="success" text={t('saved')} onDone={props.dismissSaved} />}
    </SettingsForm></>
}
