/** The public source face links against virtual factories without resolving generated lib artifacts. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const run = promisify(execFile)

it('loads and disposes the source client face with no generated Remote artifact supplier', async () => {
  const program = String.raw`
    import { readFile } from 'node:fs/promises'
    import { stripTypeScriptTypes } from 'node:module'
    import { strictEqual, deepStrictEqual } from 'node:assert'
    import { SourceTextModule, SyntheticModule } from 'node:vm'
    const source = await readFile(process.argv[1], 'utf8')
    const imports = []
    const context = { owner: 'source-plane test' }
    const contribution = { package: '@deepseek-ai/dsh-experimental-review-gated', descriptors: [] }
    const inject = ['remote']
    let mounts = 0
    let disposals = 0
    const remote = new SyntheticModule(['default'], function () { this.setExport('default', contribution) })
    const mount = new SyntheticModule(['inject', 'mountRg'], function () {
      this.setExport('inject', inject)
      this.setExport('mountRg', async (ctx, selected) => {
        strictEqual(ctx, context)
        strictEqual(selected, contribution)
        mounts++
        return async () => { disposals++ }
      })
    })
    const face = new SourceTextModule(stripTypeScriptTypes(source), { identifier: 'rg-client-source.ts' })
    await face.link((specifier) => {
      imports.push(specifier)
      if (specifier === '@deepseek-ai/dsh-experimental-review-gated/remote') return remote
      if (specifier === './mount.ts') return mount
      throw new Error('Source face requested an undeclared runtime supplier: ' + specifier)
    })
    await face.evaluate()
    strictEqual(face.namespace.inject, inject)
    deepStrictEqual(Object.keys(face.namespace).sort(), ['apply', 'inject'])
    const dispose = await face.namespace.apply(context)
    await dispose()
    process.stdout.write(JSON.stringify({ imports: imports.sort(), mounts, disposals }))
  `
  const control = new AbortController()
  const child = run(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', program,
    fileURLToPath(new URL('../src/client/index.ts', import.meta.url))], { timeout: 10000, signal: control.signal })
  onTestFinished(async () => { control.abort(); await Promise.allSettled([child]) })
  const result = await child
  const summary: unknown = JSON.parse(result.stdout)
  expect(summary).toEqual({ imports: ['./mount.ts', '@deepseek-ai/dsh-experimental-review-gated/remote'], mounts: 1, disposals: 1 })
})
