/** Pins host-only skill visibility for recorded-session fixtures; confinement remains unchanged. */
export const name = 'snapshot-host-skill-pin'
export const inject = ['skills']

/** @param {import('@deepseek-ai/cordis').Context} ctx - fixture profile context. */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Host diagnosis is outside the replay fixture catalog.',
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: false },
    content: '',
  }), 'snapshot host-skill catalog pin')
}
