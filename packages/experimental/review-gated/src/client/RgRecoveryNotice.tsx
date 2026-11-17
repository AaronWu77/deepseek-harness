/** User-facing RG processing and input-recovery state, without mutation controls. */
import { useId, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RgView } from './view.ts'
import type {} from './index.ts'
import css from './rg.module.css'

type RecoveryProps = PropsLocale<'review-gated'> & {
  readonly status: RgView['status']
  readonly claim: RgView['claim']
}

/**
 * Keep processing compact and make uncertain input inspectable without implying a safe retry.
 * @param props - Host-confirmed lifecycle status and the retained input preview.
 * @returns A grouped status with an optional, explicitly opened input preview.
 */
export function RgRecoveryNotice({ status, claim, t }: RecoveryProps) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const notEntered = claim?.phase === 'rejected' || claim?.phase === 'empty'
  const processing = status === 'saving' && !notEntered
  const titleKey = processing ? 'recoveryProcessing' : notEntered ? 'recoveryNotEntered'
    : claim !== null ? 'recoveryUnconfirmed' : 'recoveryUnavailable'
  return <section className={css.recovery} data-rg-status>
    <div className={css.recoverySummary}>
      <div className={css.recoveryMessage} role="status">
        <div className={css.recoveryLabel}>
          <StateDot state={processing ? 'ongoing' : 'warning'} />
          <span className={css.recoveryTitle}>{t(titleKey)}</span>
        </div>
        {processing ? null : <p className={css.recoveryHint}>
          {t(notEntered ? 'recoveryNotEnteredHint' : 'recoveryCheckHint')}
        </p>}
      </div>
      {claim === null ? null : <Button variant="outline" size="sm" className={css.recoveryButton}
        aria-expanded={expanded} aria-controls={detailsId} onClick={() => { setExpanded(value => !value) }}>
        {t(expanded ? 'hideInputDetails' : 'showInputDetails')}
      </Button>}
    </div>
    {claim === null ? null : <div id={detailsId} hidden={!expanded} className={css.recoveryDetails}
      role="region" aria-label={t('inputDetails')} tabIndex={0}>
      <h4 className={css.heading}>{t('inputDetails')}</h4>
      <pre className={css.report}>{claim.text}</pre>
      <p className={css.notice}>{t(notEntered ? 'recoveryRetryHint' : 'recoveryInspectHint')}</p>
      {claim.otherContent ? <p className={css.notice}>{t('recoveryAttachmentsHint')}</p> : null}
      {claim.truncated ? <p className={css.notice}>{t('claimTruncated')}</p> : null}
    </div>}
  </section>
}
