import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest } from './host/types.ts'

const requestSchema = z.union([
  z.undefined(),
  z.object({
    workspace: z.union([z.literal(null), z.string()]).readonly().optional(),
    days: z.number().readonly().optional(),
    timeZone: z.string().readonly().optional(),
  }),
])

const eventSchema = z.object({
  at: z.number().readonly(),
  workspace: z.union([z.literal(null), z.string()]).readonly(),
  provider: z.string().readonly(),
  model: z.string().readonly(),
  outcome: z.union([
    z.literal('success'), z.literal('started'), z.literal('failure'), z.literal('aborted'),
  ]).readonly(),
  retried: z.boolean().readonly(),
  inputTokens: z.number().readonly().optional(),
  outputTokens: z.number().readonly().optional(),
  cacheReadTokens: z.number().readonly().optional(),
  cacheWriteTokens: z.number().readonly().optional(),
})

const totalsSchema = z.object({
  inputTokens: z.number().readonly(),
  outputTokens: z.number().readonly(),
  cacheReadTokens: z.number().readonly(),
  cacheWriteTokens: z.number().readonly(),
  requests: z.number().readonly(),
  successfulRequests: z.number().readonly(),
  failedRequests: z.number().readonly(),
  retryRequests: z.number().readonly(),
  meteredRequests: z.number().readonly(),
  unmeteredRequests: z.number().readonly(),
})

const modelSchema = z.object({
  workspace: z.union([z.literal(null), z.string()]).readonly(),
  provider: z.string().readonly(),
  model: z.string().readonly(),
  ...totalsSchema.shape,
})

const dailySchema = z.object({ day: z.string().readonly(), ...totalsSchema.shape })

const snapshotSchema = z.object({
  workspace: z.union([z.literal(null), z.string()]).readonly(),
  days: z.number().readonly(),
  fromDay: z.string().readonly(),
  throughDay: z.string().readonly(),
  timeZone: z.string().readonly(),
  updatedAt: z.string().readonly(),
  events: z.array(eventSchema).readonly(),
  models: z.array(modelSchema).readonly(),
  daily: z.array(dailySchema).readonly(),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$UsageLedger {
    snapshot: (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>
  }
  interface TypertRemoteMap {
    'usageLedger/snapshot': (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>
  }
  interface TypertRemoteNamespaceMap {
    usageLedger: TypertRemoteNamespace$UsageLedger
  }
}

const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-plugin-usage-ledger',
  descriptors: [{
    id: 'dsh-plugin-usage-ledger#usageLedger/snapshot',
    service: 'usageLedger',
    namespace: 'usageLedger',
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      acceptsUndefined: true,
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-plugin-usage-ledger/types#UsageLedgerSnapshotRequest',
        schema: requestSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-usage-ledger/types#UsageLedgerSnapshot',
      schema: snapshotSchema,
    },
    sourceLocation: { file: 'src/host/index.ts', line: 276, column: 9 },
  }],
}

export { TYPERT_REMOTE }
export default TYPERT_REMOTE
