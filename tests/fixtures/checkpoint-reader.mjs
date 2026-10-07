import { appendFile } from 'node:fs/promises'
import { workerSourceIdentity,workerSourceFingerprint } from '../../lib/types/host/worker-protocol.js'

export async function getSourceStamp(options,request) {
  return {source:workerSourceIdentity('checkpoint-fixture'),fingerprint:workerSourceFingerprint(request.phase==='verify'&&options.drift?'after':options.fingerprint)}
}
export async function* readSessionBatches(options,request) {
  await appendFile(options.probe,JSON.stringify({fromSeq:request.fromSeq})+'\n')
  yield {meta:{id:request.session.id},inheritedEventCount:0,events:JSON.parse(options.events).filter(event=>event.seq>=request.fromSeq)}
  if(options.interrupt)throw new Error('fixture replay interrupted before EOF')
}
