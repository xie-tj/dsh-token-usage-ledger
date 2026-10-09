/** Streaming reader for stored generations the released provider refuses to migrate. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { UsageSessionEvent } from './host/event-types.ts'
import type { WorkerReaderBatch } from './host/worker-protocol.ts'

/** Little-endian encoding of the Zstandard frame magic number. */
const ZSTD_FRAME_MAGIC = 0xfd2fb528

/**
 * Event types the ledger reducer reads.
 * A refused generation is replayed row by row, so the reader keeps only these and never
 * materializes the chunk rows that carry no accounting meaning.
 */
const REDUCED_EVENT_TYPES = new Set(['assistant/attempt','assistant/message','llm/request-attempt','llm/retry','llm/retry-started','request/context','request/header','step/start','turn/end'])

/** One stored record as written by the session log writer. */
interface StoredRow { readonly type: string; readonly seq: number; readonly time: number; readonly data: Record<string, unknown> }

/**
 * Read the physical raw-log path a refusal reports.
 * @param error - failure raised by the released provider while opening one stored generation.
 * @returns an absolute stored-log path, or undefined when the refusal names no artifact.
 */
export function storedLogPath(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const location = (error as { readonly location?: unknown }).location
  if (typeof location === "string") return isAbsolute(location) ? location : undefined
  if (typeof location !== "object" || location === null) return undefined
  const path = (location as { readonly path?: unknown }).path
  return typeof path === "string" && isAbsolute(path) ? path : undefined
}

/**
 * Locate the end of one Zstandard frame without decompressing it.
 * @param bytes - whole stored log.
 * @param start - offset of the frame magic.
 * @returns the offset just past the frame, or undefined when the frame is truncated or malformed.
 * Node decompresses only the first frame of a concatenated stream, so frame boundaries are found by
 * walking the frame header and block headers the format writes before each block.
 */
export function zstdFrameEnd(bytes: Uint8Array, start: number): number | undefined {
  let offset = start
  const has = (count: number): boolean => offset + count <= bytes.length
  if (!has(4)) return undefined
  const magic = (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  if (magic !== ZSTD_FRAME_MAGIC) return undefined
  offset += 4
  if (!has(1)) return undefined
  const descriptor = bytes[offset]!
  offset += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  if (!singleSegment) {
    if (!has(1)) return undefined
    offset += 1
  }
  const dictionaryBytes = dictionaryFlag === 0 ? 0 : dictionaryFlag === 3 ? 4 : dictionaryFlag
  if (!has(dictionaryBytes)) return undefined
  offset += dictionaryBytes
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
  if (!has(contentSizeBytes)) return undefined
  offset += contentSizeBytes
  for (;;) {
    if (!has(3)) return undefined
    const header = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
    offset += 3
    const lastBlock = (header & 1) !== 0
    const blockType = (header >> 1) & 3
    // 3 is reserved; only raw (0), RLE (1) and compressed (2) blocks advance the stream.
    if (blockType === 3) return undefined
    // An RLE block stores one byte and reports its expanded length in the block size.
    const body = blockType === 1 ? 1 : header >>> 3
    if (!has(body)) return undefined
    offset += body
    if (lastBlock) break
  }
  if (checksum) {
    if (!has(4)) return undefined
    offset += 4
  }
  return offset
}

/**
 * Decode every stored record of one concatenated-frame log.
 * @param bytes - whole stored log.
 * @returns records in file order.
 * Only one frame is decompressed at a time and a record split across frames is carried forward,
 * so memory stays proportional to the stored bytes rather than to the decoded session.
 */
export function* decodeStoredRows(bytes: Uint8Array): Generator<StoredRow> {
  let offset = 0
  let remainder = ""
  while (offset < bytes.length) {
    const end = zstdFrameEnd(bytes, offset)
    if (end === undefined) throw new Error("stored log has a malformed Zstandard frame at byte " + String(offset))
    const text = remainder + zstdDecompressSync(bytes.subarray(offset, end)).toString("utf8")
    const lines = text.split("\n")
    remainder = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) continue
      yield JSON.parse(line) as StoredRow
    }
    offset = end
  }
  if (remainder.length > 0) yield JSON.parse(remainder) as StoredRow
}

/**
 * Stream one refused generation as bounded reducer batches.
 * @param path - stored log reported by the refusal.
 * @param request - session identity, persisted cursor, and maximum batch length.
 * @param signal - optional cancellation.
 * @returns batches of reducible events, in stored order.
 */
export async function* readLegacyBatches(
  path: string,
  request: { readonly session: { readonly id: string }; readonly fromSeq: number; readonly batchEvents: number },
  signal?: AbortSignal,
): AsyncGenerator<WorkerReaderBatch> {
  const bytes = await readFile(path)
  let events: UsageSessionEvent[] = []
  for (const row of decodeStoredRows(bytes)) {
    signal?.throwIfAborted()
    if (!REDUCED_EVENT_TYPES.has(row.type) || !Number.isSafeInteger(row.seq) || row.seq < request.fromSeq) continue
    events.push(row as unknown as UsageSessionEvent)
    if (events.length < request.batchEvents) continue
    const batch = events
    events = []
    yield { meta: { id: request.session.id }, inheritedEventCount: 0, events: batch }
  }
  if (events.length > 0) yield { meta: { id: request.session.id }, inheritedEventCount: 0, events }
}
