import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const marker = join(tmpdir(), 'dsh-usage-ledger-restart-fixture.marker')
if (!existsSync(marker)) {
  writeFileSync(marker, 'crashed once\n')
  process.exit(17)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type !== 'init') return
  process.stdout.write(JSON.stringify({
    type: 'progress',
    status: 'idle',
    totalSessions: frame.sessions.length,
    processedSessions: frame.sessions.length,
    processedEvents: 0,
    backfillDays: frame.config.backfillDays,
  }) + '\n')
})
