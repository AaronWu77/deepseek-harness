import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as ReviewGated from '../src/index.ts'

describe('RG coordination guidance', () => {
  it('adds scoped guidance without replacing Persona or first-party instructions', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment identity.' })
    ctx.systemPrompt.section({ name: 'fixture:guidance', order: 100, text: 'Existing tool guidance.' })
    const key = { agent: 'rg-guidance' }
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(Persona, { prefix: 'Selected PTC persona.' })
    await scope.ctx.plugin(ReviewGated, { maxReviewRounds: 3 })

    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain('Selected PTC persona.')
    expect(prompt).toContain('Existing tool guidance.')
    expect(prompt).toContain('# RG: work and independent review')
    expect(prompt).toContain('Use at most 3 independent review attempts')
    expect(prompt).toContain('not a permission system or an enforced completion check')
    expect(assembly.sections.filter(section => section.name === 'review-gated:coordination')).toHaveLength(1)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Deployment identity.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('# RG:')
    const otherKey = { agent: 'rg-other' }
    createScope(ctx, otherKey)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: otherKey }))).not.toContain('# RG:')
  })

  it('removes guidance on fiber disposal and permits a fresh mount with a new budget', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Selected persona.' })
    const key = { agent: 'rg-disposal' }
    const scope = createScope(ctx, key)
    const fiber = await scope.ctx.plugin(ReviewGated, { maxReviewRounds: 2 })
    const prompt = async () => renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(await prompt()).toContain('Use at most 2 independent review attempts')
    await fiber.dispose()
    expect(await prompt()).toContain('Selected persona.')
    expect(await prompt()).not.toContain('# RG:')
    await scope.ctx.plugin(ReviewGated, { maxReviewRounds: 5 })
    expect(await prompt()).toContain('Use at most 5 independent review attempts')
    expect(await prompt()).not.toContain('Use at most 2 independent review attempts')
    await scope.dispose()
    expect(await prompt()).not.toContain('# RG:')
  })

  it.each([1, 2, Number.MAX_SAFE_INTEGER])('accepts a positive safe integer budget: %s', (maxReviewRounds) => {
    expect(ReviewGated.Config({ maxReviewRounds })).toEqual({ maxReviewRounds })
  })

  it.each<unknown>([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects an invalid review budget: %s', (maxReviewRounds) => {
    // @ts-expect-error -- runtime validation boundary under test
    expect(() => ReviewGated.Config({ maxReviewRounds })).toThrow()
  })
})
