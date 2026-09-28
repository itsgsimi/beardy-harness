# Agent Note: Camera frames leave with their expired history records

Status: implemented

English | [中文](2026-09-27-camera-frame-retention.zh.md)

## Problem

The [camera watch](2026-09-27-ring-camera-events.md) stores up to three JPEG frames per event in the attachment store and opens one classification Session per event. `retentionDays` pruned history records only, so a driveway camera grew storage by tens of megabytes a day without bound. Goran wants camera storage bounded.

## Decision

The attachment Service Definition gains `deleteImage(ref)`: it removes one normalized image and every request version derived from it, and reports whether this call removed the object. The store counts no references, so the contract assigns ownership to the caller: it must own every holder of the reference and skip a reference that a retained holder still cites. The base class rejects with `ATTACHMENT_DELETE_UNSUPPORTED`, so other providers and test doubles keep their behavior. The local provider validates the `sha256:` id, refuses an object whose resolved path is not the expected path inside the resolved root, clears the read-only mode, unlinks the object, syncs its shard directory, and removes the attachment's request-version directory. Request versions are grouped under a directory named by their attachment digest, so deletion finds them without an index; variant identities are unchanged.

The watch's retention sweep runs at startup and again `sweepIntervalMs` after the previous sweep ends; the interval is bounded to one day. For each record expired by age or count, the sweep deletes the frames that no kept record and no unfinished event cites, then deletes the record. A failed frame deletion keeps its record for the next sweep, and a frame that is already gone counts as deleted, so repeated sweeps are idempotent. A sweep that removes anything logs event and frame counts at info level. The Discord outbox reads a frame when it posts and already posts the text alone when the frame is unreadable.

Classification Sessions stay in the session log. `SessionPersistence` offers `create`, `open`, `flush`, `stat`, and `list`, and its README assigns deletion to out-of-band backend maintenance. The watch deletes no session file behind the persistence layer.

## What Session retention still needs

Deleting classification Sessions needs a supported path in session persistence, which does not exist:

- an operation such as `SessionPersistence.delete(id)` that refuses a Session with a live write owner (the in-process claim and, for JSONL, the kernel lease), removes every stored artifact of the Session in one step that readers cannot observe half-done, and defines what `stat`, `list`, and `open` return afterwards;
- removal or invalidation of state keyed by the Session id, such as the workspace registry's header index and archive and pin sets, the session projection cache, and live Web clients through `api-session/removed`;
- a rule for records that name a deleted Session, such as a subagent child in its parent's catalog.

Workspace archiving hides a Session from grouping views without freeing storage, so the watch does not use it as retention.

## Alternatives considered

**Delete classification Session files from the watch.** This bypasses the write lease, leaves in-process `stat` and `list` results and derived indexes stale, and ties a consumer to one backend's file layout.

**Reference-aware garbage collection in the attachment store.** Proving an object unreferenced means scanning every Session log, including forks and resumed Sessions, and the attachment seam defers that design. Owner deletion needs no scan because the watch owns every holder of its frames.

**Keep each frame until its classification Session is deleted.** Sessions have no deletion, so the frames would never go.

**Take an `AttachmentId` instead of an image reference.** `readImage` and `imageHostPath` take the image reference, and the reference type keeps the image namespace apart from verbatim files.

**Index cached request versions per attachment.** An index is more durable state to keep consistent; grouping the cache by attachment digest gives the same lookup without extra writes.

## Consequences

Frames and history records are bounded by `retentionDays` and `maxHistory`. Classification Session logs still grow by one small log per classified event until session persistence offers deletion. After retention deletes its frames, reads of a classification Session's images fail with `ATTACHMENT_NOT_FOUND`, so its model input is reconstructable from the log only within retention. A notice still pending in the Discord outbox posts its text alone.

The watch owns the frames of every event it records; another `camera/event` listener that keeps frame references past retention finds them missing. The sweep finds frames only through history records, so a frame whose record is gone keeps its object, as do the frames of an event dropped from the queue at shutdown, repeating a recorded id, or naming an unknown device. The sweep also cannot see frames the provider stored for an event it has not yet published; when such a frame has the same bytes as an expired frame, the shared object is deleted and that event's classification reads the frame as missing. Request versions cached before the attachment-digest grouping stay until the cache directory is cleared, which is always safe.

The attachment tests pin removal of the object and its request versions, absent objects, invalid ids, refusal of an object reached through a link that leaves the store, removal failures, and reads racing a removal. The watch tests pin the exact age boundary, count pruning, frames shared with kept records or unfinished events, failure retry, already-deleted frames, startup catch-up, and disposal during a sweep. A Discord gateway test posts text alone when retention deletes the frame between outbox acceptance and the post.
