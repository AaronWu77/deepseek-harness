/** Package-declared repository, documentation and upstream attribution, separate from installation state. */

import type { ReactNode } from 'react'
import type { LocalizedText, PluginLocalizedMeta, PluginUpstream } from '@deepseek-ai/dsh-package-manifest'
import type { PluginManagerLocaleKey } from './locales.ts'
import type { Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

const RELATIONS = {
  copied: 'upstreamCopied', adapted: 'upstreamAdapted', patched: 'upstreamPatched',
  integration: 'upstreamIntegration', reference: 'upstreamReference',
} satisfies Record<PluginUpstream['relation'], PluginManagerLocaleKey>

/** Render validated Host metadata without fetching links or inheriting a bundle's attribution for its rows. */
export function PackageInformation({ meta, t, resolveText }: {
  readonly meta: PluginLocalizedMeta | undefined
  readonly t: Translate
  readonly resolveText: (text: LocalizedText) => string
}): ReactNode {
  const info = meta?.package
  const documentation = info?.documentation === undefined ? undefined : resolveText(info.documentation)
  const repository = info?.repository
  const unknown = t('packageUndeclared')
  return (
    <>
      <section className={css.detailSection} data-plugin-package-info>
        <h4 className={css.sectionTitle}>{t('packageInfoTitle')}</h4>
        {meta?.packageSource === 'catalog' ? <p className={css.packageNote}>{t('packageCatalogNotice')}</p> : null}
        <dl className={css.facts}>
          <div><dt>{t('packageRepository')}</dt><dd>{repository === undefined ? unknown : <a href={repository.url} target="_blank" rel="noopener noreferrer">{repository.url}</a>}</dd></div>
          {repository?.directory === undefined ? null : <div><dt>{t('packageDirectory')}</dt><dd><code>{repository.directory}</code></dd></div>}
          <div><dt>{t('packageLicense')}</dt><dd>{info?.license ?? unknown}</dd></div>
          {info?.author === undefined ? null : <div><dt>{t('packageAuthor')}</dt><dd>{info.author}</dd></div>}
          {info?.maintainers === undefined ? null : <div><dt>{t('packageMaintainers')}</dt><dd>{info.maintainers.join(' · ')}</dd></div>}
          {documentation === undefined ? null : <div><dt>{t('packageDocumentation')}</dt><dd><a href={documentation} target="_blank" rel="noopener noreferrer">{t('packageDocumentation')}</a></dd></div>}
          {info?.homepage === undefined ? null : <div><dt>{t('packageHomepage')}</dt><dd><a href={info.homepage} target="_blank" rel="noopener noreferrer">{info.homepage}</a></dd></div>}
        </dl>
      </section>
      <section className={css.detailSection} data-plugin-upstreams>
        <h4 className={css.sectionTitle}>{t('upstreamsTitle')}</h4>
        {info?.upstreams === undefined || info.upstreams.length === 0
          ? <p className={css.packageNote}>{t(info === undefined && meta?.error !== undefined ? 'packageDetailsUnavailable' : 'upstreamsMissing')}</p>
          : <>
            <p className={css.packageNote}>{t('upstreamsNotice')}</p>
            <ul className={css.upstreams}>
              {info.upstreams.map(upstream => <li key={`${upstream.repository}:${upstream.relation}:${upstream.name}:${upstream.ref ?? ''}`} className={css.upstream}>
                <h5 className={css.upstreamTitle}><a href={upstream.repository} target="_blank" rel="noopener noreferrer">{upstream.name}</a></h5>
                <p className={css.packageNote}>{t(RELATIONS[upstream.relation])}</p>
                <dl className={css.facts}>
                  <div><dt>{t('upstreamRef')}</dt><dd>{upstream.ref ?? t('upstreamRefUnknown')}</dd></div>
                  <div><dt>{t('packageLicense')}</dt><dd>{upstream.license ?? unknown}</dd></div>
                </dl>
                {upstream.changes === undefined ? null : <p className={css.packageNote}>{resolveText(upstream.changes)}</p>}
                {upstream.record === undefined ? null : <a className={css.sourceRecord} href={upstream.record} target="_blank" rel="noopener noreferrer">{t('upstreamRecord')}</a>}
              </li>)}
            </ul>
          </>}
      </section>
    </>
  )
}
