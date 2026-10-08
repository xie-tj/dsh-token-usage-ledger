export async function* readSessionBatches(options,request) {
  if(request.session.id==='unreadable')throw new Error('fixture stored log cannot be read')
  yield {meta:{id:request.session.id},inheritedEventCount:0,events:JSON.parse(options.events).filter(event=>event.seq>=request.fromSeq)}
}
export async function* listSessionHeaders(options,request) {
  for(const session of JSON.parse(options.sessions)) {
    if(request.createdAtAfter!==undefined&&session.createdAt<request.createdAtAfter)continue
    if(request.createdAtBefore!==undefined&&session.createdAt>=request.createdAtBefore)continue
    yield session
  }
}
