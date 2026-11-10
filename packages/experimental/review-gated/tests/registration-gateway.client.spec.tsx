// @vitest-environment jsdom
/** RG and Session Remote contributions share the production Gateway lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import { apply as applyGateway, inject as gatewayInject } from '../../../api/gateway/src/client/index.ts'
import type { ConnectionHandle } from '../../../client/connection/src/client/index.ts'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { inject, mountRg } from '../src/client/mount.ts'
import { fixture } from './fixture.client.ts'

function descriptor(namespace: string, method: string): InvocationDescriptor {
  return { id: `@fixture/${namespace}#${namespace}/${method}`, service: namespace, namespace, method, invocation: { kind: 'direct' },
    parameters: [], result: { mode: 'strict', typeSymbol: '@fixture#result', create: () => z.unknown() } }
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SlotRegistry)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const f = fixture({ subscribe: false })
  const unregisterDecoder = vi.fn()
  const registerDecoder = vi.fn(() => unregisterDecoder)
  ctx.provide('configForms', { get: () => f.scope, registerDecoder } as never)
  ctx.provide('connection', {
    interactions: 'answer', isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, start: () => ({ stop: () => {} }),
    registerGenerationSource: () => () => {},
    openWebSocket: () => { throw new Error('unexpected socket') },
    rpc: { call: async () => { throw new Error('unexpected request') },
      open: async function* () { throw new Error('unexpected stream') } },
  } satisfies ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: applyGateway })
  return { ctx, locale, registerDecoder, unregisterDecoder }
}

describe('RG Gateway teardown', () => {
  it('parks only UI while Session is absent and restores it after remount', async () => {
    const { ctx, locale, registerDecoder, unregisterDecoder } = await boot()
    const feature = ctx.plugin({ inject, apply: (scope: Context) => mountRg(scope, {
      package: '@fixture/rg', descriptors: [descriptor('reviewGated', 'newTask')],
    }) })
    await feature
    expect(ctx.get('remote.reviewGated')).toBeDefined()
    expect(registerDecoder).not.toHaveBeenCalled()
    const contribution = { package: '@fixture/session', descriptors: [descriptor('session', 'modelCatalog')] }
    const unmountSession = await ctx.remote.$mount(contribution)
    await vi.waitFor(() => { expect(registerDecoder).toHaveBeenCalledTimes(1) })
    expect(locale.bind('review-gated')('effectiveHint')).not.toBe('effectiveHint')
    await unmountSession()
    expect(unregisterDecoder).toHaveBeenCalledTimes(1)
    expect(locale.bind('review-gated')('effectiveHint')).toBe('effectiveHint')
    expect(ctx.get('remote.reviewGated')).toBeDefined()
    const unmountReplacement = await ctx.remote.$mount(contribution)
    await vi.waitFor(() => { expect(registerDecoder).toHaveBeenCalledTimes(2) })
    await feature.dispose()
    expect(unregisterDecoder).toHaveBeenCalledTimes(2)
    expect(ctx.get('remote.reviewGated')).toBeUndefined()
    await unmountReplacement()
    await ctx.fiber.dispose()
  })

  it('settles Session namespace withdrawal and RG owner disposal', async () => {
    const { ctx } = await boot()
    const unmountSession = await ctx.remote.$mount({ package: '@fixture/session', descriptors: [descriptor('session', 'modelCatalog')] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const consumer = ctx.plugin({ inject: ['remote.session'], apply(scope: Context) {
      scope.effect(() => async () => { entered.resolve(undefined); await release.promise })
    } })
    await consumer
    const feature = ctx.plugin({ inject, apply: (scope: Context) => mountRg(scope, {
      package: '@fixture/rg', descriptors: [descriptor('reviewGated', 'newTask')],
    }) })
    await feature
    expect(ctx.get('remote.reviewGated')).toBeDefined()
    const sessionStopped = unmountSession()
    await entered.promise
    const featureStopped = feature.dispose()
    release.resolve(undefined)
    await Promise.all([sessionStopped, featureStopped])
    expect(ctx.get('remote.session')).toBeUndefined()
    expect(ctx.get('remote.reviewGated')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
