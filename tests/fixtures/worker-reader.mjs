export async function* readSessionBatches(options, request) {
  const events = JSON.parse(options?.events ?? '[]')
  yield {
    meta: { id: request.session.id },
    inheritedEventCount: 0,
    events: events.filter(event => event.seq >= request.fromSeq),
  }
}

export async function* listSessionHeaders(options, request) {
  const sessions = JSON.parse(options?.sessions ?? '[]')
  for (const session of sessions) {
    if (request.createdAtAfter !== undefined && session.createdAt < request.createdAtAfter) continue
    if (request.createdAtBefore !== undefined && session.createdAt >= request.createdAtBefore) continue
    yield session
  }
}
