/** Validate declarative package details without executing code or resolving remote resources. */

import type { LocalizedText, PluginPackageDetails, PluginUpstream } from '@deepseek-ai/dsh-package-manifest'

// Discovery metadata is a small protocol record, not a document transport. These fixed limits bound
// inventory payloads while allowing multilingual summaries and several independently declared upstreams.
const MAX_DETAILS_BYTES = 64 * 1024
const MAX_TEXT_BYTES = 8 * 1024
const MAX_URL_BYTES = 2 * 1024
const MAX_UPSTREAMS = 32
const MAX_MAINTAINERS = 64
const MAX_LOCALES = 32
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}

function textOf(value: unknown, path: string, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${path} exceeds ${maxBytes} UTF-8 bytes`)
  return value.trim()
}

function webUrl(value: unknown, path: string, git = false): string {
  const text = textOf(value, path, MAX_URL_BYTES)
  const link = git ? text.replace(/^git\+(?=https?:)/iu, '') : text
  if (!/^https?:\/\//iu.test(link) || /[\s\\]/u.test(link) || /%(?![\da-f]{2})/iu.test(link)) {
    throw new Error(`${path} must be a public HTTP(S) URL without credentials`)
  }
  let url: URL
  try { url = new URL(link) }
  catch (error) { throw new Error(`${path} must be a public HTTP(S) URL`, { cause: error }) }
  if (url.username !== '' || url.password !== '' || url.hostname === '' || (git && url.search !== '')) {
    throw new Error(`${path} must be a public HTTP(S) URL without credentials`)
  }
  return textOf(url.href, path, MAX_URL_BYTES)
}

function localized(value: unknown, path: string, links = false): LocalizedText {
  const parse = (value: unknown, label: string): string => links ? webUrl(value, label) : textOf(value, label)
  if (typeof value === 'string') return parse(value, path)
  const source = objectOf(value, path)
  const entries = Object.entries(source)
  if (entries.length > MAX_LOCALES) throw new Error(`${path} exceeds ${MAX_LOCALES} locales`)
  const en = parse(source.en, `${path}.en`)
  for (const [locale] of entries) {
    if (!LANGUAGE_ID.test(locale)) throw new Error(`${path}.${locale} must use a lowercase language id`)
  }
  return { ...Object.fromEntries(entries.map(([locale, text]) => [locale, parse(text, `${path}.${locale}`)])), en }
}

function repositoryOf(value: unknown, path: string): NonNullable<PluginPackageDetails['repository']> {
  if (typeof value === 'string') return { url: webUrl(value, path, true) }
  const source = objectOf(value, path)
  const url = webUrl(source.url, `${path}.url`, true)
  if (source.directory === undefined) return { url }
  const directory = textOf(source.directory, `${path}.directory`)
  if (/[\\%:?#\u0000-\u001f\u007f]/u.test(directory)
    || directory.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${path}.directory must be a package-relative path without traversal`)
  }
  return { url, directory }
}

function person(value: unknown, path: string): string {
  return textOf(typeof value === 'string' ? value : objectOf(value, path).name, path)
}

function arrayOf(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  if (value.length > max) throw new Error(`${path} exceeds ${max} entries`)
  return value
}

function upstreamOf(value: unknown, path: string): PluginUpstream {
  const source = objectOf(value, path)
  const name = textOf(source.name, `${path}.name`)
  const repository = webUrl(source.repository, `${path}.repository`, true)
  const relation = source.relation
  if (relation !== 'copied' && relation !== 'adapted' && relation !== 'patched'
    && relation !== 'integration' && relation !== 'reference') {
    throw new Error(`${path}.relation must be copied, adapted, patched, integration, or reference`)
  }
  const reused = relation === 'copied' || relation === 'adapted' || relation === 'patched'
  return {
    name, repository, relation,
    ...source.ref === undefined ? {} : { ref: textOf(source.ref, `${path}.ref`) },
    ...source.license === undefined && !reused ? {} : { license: textOf(source.license, `${path}.license`) },
    ...source.changes === undefined && !reused ? {} : { changes: localized(source.changes, `${path}.changes`) },
    ...source.record === undefined ? {} : { record: webUrl(source.record, `${path}.record`) },
  }
}

/**
 * Validate this root manifest's package declarations atomically; no values are inferred.
 * @param manifest - Parsed JSON object from the plugin's own exported package.json.
 * @param path - Manifest filename for actionable diagnostics.
 * @returns Declared details, or undefined when all supported declarations are absent.
 * @throws When a declaration is malformed or the complete details exceed protocol limits; callers retain display metadata.
 */
export function readPackageDetails(manifest: Record<string, unknown>, path: string): PluginPackageDetails | undefined {
  const dsh = manifest.dsh === undefined ? undefined : objectOf(manifest.dsh, `${path}: dsh`)
  const declared = {
    repository: manifest.repository, homepage: manifest.homepage, license: manifest.license,
    author: manifest.author, maintainers: manifest.maintainers,
    documentation: dsh?.documentation, upstreams: dsh?.upstreams,
  }
  if (Buffer.byteLength(JSON.stringify(declared), 'utf8') > MAX_DETAILS_BYTES) {
    throw new Error(`${path}: package details exceed 64 KiB`)
  }
  const details: PluginPackageDetails = {
    ...declared.repository === undefined ? {} : { repository: repositoryOf(declared.repository, `${path}: repository`) },
    ...declared.homepage === undefined ? {} : { homepage: webUrl(declared.homepage, `${path}: homepage`) },
    ...declared.license === undefined ? {} : { license: textOf(declared.license, `${path}: license`) },
    ...declared.author === undefined ? {} : { author: person(declared.author, `${path}: author`) },
    ...declared.maintainers === undefined ? {} : { maintainers: arrayOf(declared.maintainers, `${path}: maintainers`, MAX_MAINTAINERS)
      .map((value, index) => person(value, `${path}: maintainers[${index}]`)) },
    ...declared.documentation === undefined ? {} : { documentation: localized(declared.documentation, `${path}: dsh.documentation`, true) },
    ...declared.upstreams === undefined ? {} : { upstreams: arrayOf(declared.upstreams, `${path}: dsh.upstreams`, MAX_UPSTREAMS)
      .map((value, index) => upstreamOf(value, `${path}: dsh.upstreams[${index}]`)) },
  }
  // URL normalization and projected field names can expand the complete serialized result.
  if (Buffer.byteLength(JSON.stringify(details), 'utf8') > MAX_DETAILS_BYTES) {
    throw new Error(`${path}: package details exceed 64 KiB`)
  }
  return Object.keys(details).length === 0 ? undefined : details
}
