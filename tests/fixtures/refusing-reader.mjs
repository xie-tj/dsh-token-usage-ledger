import { appendFile } from 'node:fs/promises'
import { workerSourceIdentity,workerSourceFingerprint } from '../../lib/types/host/worker-protocol.js'

export async function* listSessionHeaders(options,request) {
  for(const session of JSON.parse(options.sessions)) {
    if(request.createdAtAfter!==undefined&&session.createdAt<request.createdAtAfter)continue
    if(request.createdAtBefore!==undefined&&session.createdAt>=request.createdAtBefore)continue
    yield {...session,source:workerSourceIdentity('refusing-fixture'),fingerprint:workerSourceFingerprint(String(session.createdAt)+'/'+session.id)}
  }
}

export async function getSourceStamp(options,request) {
  return {source:workerSourceIdentity('refusing-fixture'),fingerprint:workerSourceFingerprint(String(request.session.createdAt)+'/'+request.session.id)}
}

export async function* readSessionBatches(options,request) {
  await appendFile(options.probe,JSON.stringify({id:request.session.id})+'\n')
  if(request.session.id==='refused')throw unreadableSourceFailure()
  yield {meta:{id:request.session.id},inheritedEventCount:0,events:JSON.parse(options.events).filter(event=>event.seq>=request.fromSeq)}
}

// A reader raises this by property, not by class identity, so the marker survives separate bundles.
function unreadableSourceFailure() {
  const error=new Error('fixture generation is refused; source v0 artifact remains unchanged')
  error.name='UsageLedgerUnreadableSourceError'
  error.code='usage-ledger-unreadable-source'
  return error
}
