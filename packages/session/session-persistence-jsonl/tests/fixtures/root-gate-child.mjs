import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, mode] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(jsonl, { root, compression: 'none', maintenance: { enabled: true } })
const host = ctx.sessionPersistence
const id = SessionId(mode)
const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false }
const say = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
const settle = new Promise(resolve => process.once('disconnect', resolve))
const classify = async operation => {
  try {
    const result = await operation()
    await result?.close()
    return 'acquired'
  } catch (error) {
    return error.reason ?? error.name
  }
}
try {
  if (mode === 'shared') {
    const handle = await host.create(header)
    try {
      await say('holding-shared')
      await settle
    } finally {
      await handle.close()
    }
  } else if (mode === 'exclusive') {
    await host.withExclusiveMaintenance('child fixture', async () => {
      await say('holding-exclusive')
      await settle
    })
  } else {
    const status = await host.maintenanceGate()
    const create = await classify(() => host.create(header))
    const open = await classify(() => host.open(id, 'read'))
    const exclusive = await classify(() => host.withExclusiveMaintenance('child contender', async () => {}))
    await say({ status, create, open, exclusive })
  }
} finally {
  await ctx.fiber.dispose()
  if (process.connected) process.disconnect()
}
