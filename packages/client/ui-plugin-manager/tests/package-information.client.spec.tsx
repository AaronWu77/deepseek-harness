// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { PackageInformation } from '../src/client/PackageInformation.tsx'

const t = makeTranslate(en)

afterEach(cleanup)

describe('PackageInformation', () => {
  it('renders the declared repository, documentation, license and upstreams', () => {
    render(<PackageInformation t={t} meta={{
      package: {
        repository: { url: 'https://example.com/repo', directory: 'packages/plugin' },
        documentation: 'https://example.com/docs',
        license: 'MIT',
        upstreams: [{ name: 'upstream', repository: 'https://example.com/upstream', relation: 'adapted', ref: 'v1' }],
      },
    }} />)
    expect(screen.getByText('Package information')).toBeTruthy()
    expect(screen.getByText('https://example.com/repo/packages/plugin').getAttribute('href')).toBe('https://example.com/repo')
    expect(screen.getByText('https://example.com/docs').getAttribute('href')).toBe('https://example.com/docs')
    expect(screen.getByText('MIT')).toBeTruthy()
    expect(screen.getByText('upstream').getAttribute('href')).toBe('https://example.com/upstream')
    expect(screen.getByText('upstream').closest('li')?.textContent).toContain('adapted @ v1')
  })

  it('states the undeclared repository and marks catalog metadata', () => {
    render(<PackageInformation t={t} meta={{ packageSource: 'catalog', package: {} }} />)
    expect(screen.getByText('From the catalog, not the package manifest')).toBeTruthy()
    expect(screen.getByText('Not declared')).toBeTruthy()
  })

  it('renders nothing when the Host supplied no package declarations', () => {
    const { container } = render(<PackageInformation t={t} meta={{ title: 'Plugin' }} />)
    expect(container.firstChild).toBeNull()
  })
})
