/** Package-declared repository, documentation, license and upstream attribution. */
import type { ReactNode } from 'react'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import type { Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/**
 * Render the validated declarations the plugin's own manifest supplied.
 * @param props - Host-delivered metadata and localized copy.
 * @returns the package section, or nothing when the Host has no package declarations.
 */
export function PackageInformation({ meta, t }: {
  readonly meta: PluginLocalizedMeta | undefined
  readonly t: Translate
}): ReactNode {
  const info = meta?.package
  if (info === undefined) return null
  const documentation = typeof info.documentation === 'string' ? info.documentation : undefined
  const upstreams = info.upstreams ?? []
  const missing = t('packageUndeclared')
  return (
    <section className={css.detailSection} data-plugin-package-info>
      <h4 className={css.sectionTitle}>{t('packageInfoTitle')}</h4>
      {meta?.packageSource === 'catalog' ? <p>{t('packageCatalogNotice')}</p> : null}
      <dl className={css.facts}>
        <div>
          <dt>{t('packageRepository')}</dt>
          <dd>{info.repository === undefined ? missing : (
            <a href={info.repository.url} target="_blank" rel="noopener noreferrer">
              {info.repository.directory === undefined ? info.repository.url : `${info.repository.url}/${info.repository.directory}`}
            </a>
          )}</dd>
        </div>
        {documentation === undefined ? null : (
          <div>
            <dt>{t('packageDocumentation')}</dt>
            <dd><a href={documentation} target="_blank" rel="noopener noreferrer">{documentation}</a></dd>
          </div>
        )}
        {info.license === undefined ? null : (
          <div>
            <dt>{t('packageLicense')}</dt>
            <dd>{info.license}</dd>
          </div>
        )}
        {upstreams.length === 0 ? null : (
          <div>
            <dt>{t('packageUpstreams')}</dt>
            <dd>
              <ul>
                {upstreams.map(upstream => (
                  <li key={`${upstream.name}:${upstream.repository}`}>
                    <a href={upstream.repository} target="_blank" rel="noopener noreferrer">{upstream.name}</a>
                    {` (${upstream.relation}${upstream.ref === undefined ? '' : ` @ ${upstream.ref}`})`}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
