/** Check an explicitly selected collection of independent local plugin repositories, without executing them. */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageDetails } from '../packages/boot/app-boot/src/package-details.ts'

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(path + ' must be an object')
  return value as Record<string, unknown>
}

function json(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(path, 'utf8')), path)
}

/**
 * Check every immediate plugin package in a developer-selected collection; never scan installed dependencies.
 * @param root - Collection directory, not an active profile or node_modules directory.
 * @returns Actionable errors; an empty or missing collection is an error, never a successful audit.
 */
export function localPluginMetadataProblems(root: string): string[] {
  const paths = globSync('*/package.json', { cwd: root, exclude: ['node_modules'] }).map(path => path.replaceAll('\\', '/')).sort()
  if (paths.length === 0) return [root + ': no local plugin package manifests']
  return paths.flatMap((path) => {
    const file = resolve(root, path)
    const dir = dirname(file)
    try {
      const manifest = json(file)
      const details = readPackageDetails(manifest, file)
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('name and version must be declared')
      if (details?.repository === undefined || details.license === undefined) throw new Error('repository and license must be declared')
      if (details.upstreams === undefined) throw new Error('dsh.upstreams must be declared; [] means no upstream statement, not original authorship')
      if (typeof details.documentation !== 'object' || typeof details.documentation.zh !== 'string') {
        throw new Error('dsh.documentation must declare explicit en and zh links')
      }
      const exports = object(manifest.exports, file + ': exports')
      if (exports['./locale/*.json'] !== './locale/*.json') throw new Error('exports must expose ./locale/*.json')
      if (!Array.isArray(manifest.files) || !manifest.files.includes('locale/*.json')) throw new Error('files must publish locale/*.json')
      for (const language of ['en', 'zh']) {
        const locale = resolve(dir, 'locale', language + '.json')
        const meta = object(json(locale).meta, locale + ': meta')
        if (typeof meta.title !== 'string' || meta.title.trim() === '' || typeof meta.description !== 'string' || meta.description.trim() === '') {
          throw new Error(locale + ': meta.title and meta.description must be nonempty strings')
        }
      }
      return []
    } catch (error) {
      return [file + ': ' + (error instanceof Error ? error.message : String(error))]
    }
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('Usage: tsx scripts/verify-local-plugin-metadata.ts <plugin-collection-directory>')
  const problems = localPluginMetadataProblems(resolve(root))
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Local plugin repository, bilingual display, documentation and upstream declarations are consistent.')
  }
}
