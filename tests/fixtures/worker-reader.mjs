export async function* readSessionBatches(options, request) {
  const events = JSON.parse(options?.events ?? '[]')
  yield {
    meta: { id: request.session.id },
    inheritedEventCount: 0,
    events: events.filter(event => event.seq >= request.fromSeq),
  }
}
