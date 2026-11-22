/**
 * Append-only journal for one durable bridge request.
 *
 * A request record in requests.json carries the terminal body and the last
 * known phase. This journal adds the ordered, resumable stream a coordinator
 * needs: every phase change gets the next integer seq, and an SSE client can
 * reconnect with Last-Event-ID/after_seq without replaying an old terminal
 * state as a new one.
 *
 * It is deliberately small and bounded: the file stays operator-local, keeps
 * no credential, and every entry is derived from state the record already
 * holds. Rebuilding a request's history is not a goal; seeing every transition
 * of a live request is.
 */

export const MAX_JOURNAL_EVENTS = 200

function isoNow(clock) {
  return new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString()
}

/**
 * Build the patch that appends one event to a request record.
 * @param record - current durable record (or null).
 * @param kind - short machine name such as `recorded`, `accepted`, `terminal`.
 * @param extra - flattened fields for the payload (kept small).
 */
export function journalPatch(record, kind, extra = {}, clock) {
  const seq = Number(record && record.event_seq ? record.event_seq : 0) + 1
  const event = { seq, at: isoNow(clock), kind, ...extra }
  const kept = [...((record && Array.isArray(record.events)) ? record.events : []), event].slice(-MAX_JOURNAL_EVENTS)
  return { event_seq: seq, events: kept }
}

/** Events strictly after one seq, in order. */
export function eventsSince(record, afterSeq) {
  const from = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0
  return ((record && Array.isArray(record.events)) ? record.events : []).filter((event) => Number(event.seq) > from)
}

/** Lowest retained seq, so a client can tell that older events are no longer in the journal. */
export function journalStart(record) {
  const events = (record && Array.isArray(record.events)) ? record.events : []
  return events.length > 0 ? Number(events[0].seq) : 0
}
