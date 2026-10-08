/** Observe provider construction and logical log opens while delegating to the real provider. */
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const NEWLINE = String.fromCharCode(10)

export default class ObservedJsonlPersistence extends JsonlPersistence {
  constructor(...args) {
    super(...args)
    // The released provider caches its root-encoding directory walk on the instance, so every
    // construction is one whole-tree walk; the count is the observable cost of a replay pass.
    void appendFile(this.probe(), JSON.stringify({kind:'construct'})+NEWLINE).catch(()=>{})
  }

  probe() {
    return join(dirname(this.config.root), 'log-opens.ndjson')
  }

  async open(id, access, options) {
    await appendFile(this.probe(), JSON.stringify({kind:'open',id,access})+NEWLINE)
    return super.open(id,access,options)
  }
}
