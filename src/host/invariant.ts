/** Package-owned provider-attempt stream invariant. @module dsh-plugin-usage-ledger/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UsageAttemptId, UsageSessionEvent } from './event-types.ts'

const PACKAGE_NAME = 'dsh-plugin-usage-ledger'

/** Cordis companion plugin name. */
export const name = 'usage-ledger-invariant'
/** Services required to inspect complete session streams. */
export const inject = ['invariants']

/** Fields copied from a request-attempt start while its terminal record is pending. */
type OpenAttempt = { turn: number; step: number; provider: string; model: string }

/** Validate identity and route fields for one durable request-attempt pair. */
function applyAttempt(open: Map<UsageAttemptId, OpenAttempt>, event: UsageSessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'llm/request-attempt') return
  const id = event.data.attemptId
  if (event.data.phase === 'start') {
    if (open.has(id)) fail(`request attempt '${id}' starts twice`)
    open.set(id, {
      turn: event.data.turn,
      step: event.data.step,
      provider: event.data.provider,
      model: event.data.model,
    })
    return
  }
  const start = open.get(id)
  if (start === undefined) {
    fail(`request attempt '${id}' ends without a matching start`)
    return
  }
  if (start.turn !== event.data.turn || start.step !== event.data.step
    || start.provider !== event.data.provider || start.model !== event.data.model) {
    fail(`request attempt '${id}' ends with fields different from its start`)
  }
  open.delete(id)
}

/** Install independent per-session attempt identity checks. Open attempts remain valid crash evidence. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, Map<UsageAttemptId, OpenAttempt>>()
  const seed = (session: Session): Map<UsageAttemptId, OpenAttempt> => {
    const open = new Map<UsageAttemptId, OpenAttempt>()
    for (const event of session.events) applyAttempt(open, event, fail)
    states.set(session, open)
    return open
  }
  const stateFor = (session: Session): Map<UsageAttemptId, OpenAttempt> => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => { applyAttempt(stateFor(session), event, fail) }, { global: true })
}, { inject: ['sessions'] })

/** Register the request-attempt invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
