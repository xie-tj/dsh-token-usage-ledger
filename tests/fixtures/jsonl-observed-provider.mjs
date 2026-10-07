/** Observe expensive logical log opens while delegating to the actual released provider. */
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

export default class ObservedJsonlPersistence extends JsonlPersistence {
  async open(id, access, options) {
    await appendFile(join(dirname(this.config.root), 'log-opens.ndjson'), JSON.stringify({id,access})+'\n')
    return super.open(id,access,options)
  }
}
