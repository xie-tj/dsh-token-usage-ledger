# Incremental session queue

Completed-source proofs live in the existing SQLite source_checkpoints table. Replay discovery compares fresh provider metadata and the cursor currently on disk before constructing tasks. Unchanged completed lifecycles are excluded from totalSessions and processedSessions, and reusedSessions reports that separate durable reuse count. A successful zero-task discovery is an explicitly complete pass, not an unstarted ledger.

Discovery still enumerates selected headers once: source files can be appended or added while the plugin is offline, so restoring a saved remaining-count integer alone would lose updates. Metadata-only source inspection is not token accounting or replay; reducers and body decoders run only for new, changed, unverified, or failed sources.

Completion belongs to the selected lifecycle rather than the transient queue task kind. Live notifications cannot complete historical EOF work, and a later successful rescan repairs its count once.

Verification uses the real released raw and Zstandard provider: unchanged restart queues zero work; one appended source queues one lifecycle; one new source queues one lifecycle. Call totals remain stable, cursor drift invalidates proofs, and source changes during replay or failed partial reads cannot authorize reuse.
