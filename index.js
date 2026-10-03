/**
 * Host half of `@fufu1437/dsh-delete-chat`.
 *
 * One operation — *thoroughly delete one conversation* — behind two
 * connection-fenced HTTP routes the browser half calls:
 *
 * - `POST /dsh-delete-chat/inspect` reports exactly what a deletion would
 *   remove, and why it is blocked when it is.
 * - `POST /dsh-delete-chat/delete` performs the deletion and returns a
 *   per-artifact report.
 *
 * "Thorough" is a fixed superset of the durable footprints a DSH conversation
 * leaves on this machine:
 *
 * 1. the session-log directory (`~/.dsh/sessions/<project>/<id>/`), which
 *    holds every on-disk format generation plus the write lease;
 * 2. the projection-cache record (`~/.dsh/storages/session_projcache/sessions/<id>.json`),
 *    which duplicates the conversation title and its first-prompt text;
 * 3. the legacy `message_feedback` sidecar record, when one exists;
 * 4. the workspace registry's account, archive, and pin entries, through the
 *    registry's own durable API;
 * 5. the session's spill directory under every local spill root;
 * 6. attachments (image/file uploads) that no *other* surviving session
 *    references, plus their request-image and DeepSeek upload-cache entries;
 * 7. the durable subagent descendants the conversation spawned.
 *
 * Two invariants shape the implementation:
 *
 * - **A live conversation is never deleted.** The Host keeps an Agent (and an
 *   open write handle on the log) for every conversation opened in this
 *   process, and DSH exposes no public "release this session" API. Removing
 *   files under an open writer would leave the bytes in an unlinked inode
 *   (not actually erased) and let the writer recreate state, so a session that
 *   is live is refused with an actionable reason instead.
 * - **Nothing is deleted unless its absence is proven safe.** Attachment bytes
 *   are content-addressed and shared, so they are removed only after every
 *   other session has been read and none of them references the id. When that
 *   proof cannot be completed, the attachment is kept and reported.
 *
 * This module imports nothing outside `node:` builtins, so the published
 * package carries no dependency on unpublished `@deepseek-ai/*` packages.
 *
 * @module @fufu1437/dsh-delete-chat
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

/** Cordis function-plugin name. */
export const name = 'dsh-delete-chat'

/** The route carrier and the trust fence that guards every route. */
export const inject = ['webServer', 'connection']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-delete-chat'
/** Preview route: what a deletion would remove, and whether it is blocked. */
export const INSPECT_PATH = `${ROUTE_PREFIX}/inspect`
/** Destructive route: performs the deletion. */
export const DELETE_PATH = `${ROUTE_PREFIX}/delete`

/** Both bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024
/** Session ids are opaque strings; this bounds a hostile id before it reaches a path. */
const SESSION_ID_MAX_LENGTH = 200
/** Default ceiling on how many sibling session logs the attachment proof reads. */
const DEFAULT_SCAN_LIMIT = 500
/** Default ceiling on decompressed bytes the attachment proof reads, in bytes. */
const DEFAULT_SCAN_BYTE_LIMIT = 2 * 1024 * 1024 * 1024
/** Durable normalized attachment references are `sha256:<64 lowercase hex>`. */
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/
/** The same reference shape, matched anywhere inside a log's byte stream. */
const ATTACHMENT_ID_PATTERN_GLOBAL = /sha256:[0-9a-f]{64}/g
/** The session-log root name under the harness home. */
const SESSIONS_DIRNAME = 'sessions'
/** The storage-json root name under the harness home. */
const STORAGES_DIRNAME = 'storages'

/* -------------------------------------------------------------------------- */
/* Path encoding (mirrors the shipped JSONL backend's on-disk naming)          */
/* -------------------------------------------------------------------------- */

/**
 * Encode an arbitrary string as a single safe path segment, injectively.
 * A byte-for-byte copy of the session persistence backend's `encodeSegment`
 * so this plugin addresses the same directories the writer created.
 * @param raw - the string to encode.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project-directory key for one project path. Mirrors the
 * shipped backend's `projectKey`, so a deletion can address a project
 * directory without reading the session back first.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** @param value - any string. @returns its lowercase SHA-256 hex digest. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/** @param value - candidate. @returns the value when it is a non-empty string. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the effective configuration: explicit row config first, then the
 * harness home the running process uses.
 * @param config - the Loader row's config (may be undefined).
 * @returns absolute roots and deletion policy.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const dshHome = nonEmptyString(raw.dshHome)
    ?? nonEmptyString(process.env.DSH_HOME)
    ?? join(homedir(), '.dsh')
  const spillRoots = Array.isArray(raw.spillRoots)
    ? raw.spillRoots.filter(root => nonEmptyString(root) !== undefined)
    : undefined
  const scanLimit = Number.isSafeInteger(raw.scanLimit) && raw.scanLimit > 0
    ? raw.scanLimit
    : DEFAULT_SCAN_LIMIT
  const scanByteLimit = Number.isSafeInteger(raw.scanByteLimit) && raw.scanByteLimit > 0
    ? raw.scanByteLimit
    : DEFAULT_SCAN_BYTE_LIMIT
  return {
    dshHome,
    sessionsRoot: nonEmptyString(raw.sessionsRoot) ?? join(dshHome, SESSIONS_DIRNAME),
    storagesRoot: nonEmptyString(raw.storagesRoot) ?? join(dshHome, STORAGES_DIRNAME),
    attachmentsRoot: nonEmptyString(raw.attachmentsRoot) ?? join(dshHome, 'attachments', 'v1'),
    llmFilesRoot: nonEmptyString(raw.llmFilesRoot) ?? join(dshHome, 'llm-deepseek'),
    spillRoots,
    scanLimit,
    scanByteLimit,
    deleteAttachments: raw.deleteAttachments !== false,
    deleteDescendants: raw.deleteDescendants !== false,
  }
}

/* -------------------------------------------------------------------------- */
/* Small filesystem helpers                                                    */
/* -------------------------------------------------------------------------- */

/** @param path - candidate. @returns its stats, or undefined on any failure. */
async function statSafe(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** @param path - candidate. @returns whether it is a directory. */
async function isDirectory(path) {
  return (await statSafe(path))?.isDirectory() === true
}

/**
 * @param path - directory to read.
 * @param options - `readdir` options.
 * @returns entries, or an empty list when the directory is absent or unreadable.
 */
async function readdirSafe(path, options) {
  try {
    return await readdir(path, options)
  } catch {
    return []
  }
}

/**
 * Recursively measure one path without following failures.
 * @param path - file or directory.
 * @returns `{ bytes, files }`, or undefined when the path does not exist.
 */
async function measure(path) {
  const info = await statSafe(path)
  if (info === undefined) return undefined
  if (info.isFile()) return { bytes: info.size, files: 1 }
  if (!info.isDirectory()) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  for (const entry of await readdirSafe(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      const nested = await measure(child)
      if (nested !== undefined) {
        bytes += nested.bytes
        files += nested.files
      }
    } else if (entry.isFile()) {
      const fileInfo = await statSafe(child)
      if (fileInfo !== undefined) {
        bytes += fileInfo.size
        files += 1
      }
    }
  }
  return { bytes, files }
}

/** @param values - candidates. @returns them in insertion order without duplicates. */
function unique(values) {
  return [...new Set(values)]
}

/**
 * Rewrite one JSON document atomically inside its own directory.
 * @param file - destination path.
 * @param value - JSON-serializable document.
 */
async function writeJsonAtomic(file, value) {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Remove keys from one table of a storage-json KV document, preserving every
 * other field. The document is a shared sidecar, so unknown shapes are left
 * untouched rather than guessed at.
 * @param file - the unit JSON file.
 * @param table - the table name.
 * @param keys - keys to drop.
 * @returns the number of dropped keys.
 */
async function removeUnitKeys(file, table, keys) {
  const text = await readFile(file, 'utf8')
  const doc = JSON.parse(text)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 0
  const tables = doc.tables
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return 0
  const bucket = tables[table]
  if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) return 0
  let dropped = 0
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(bucket, key)) {
      delete bucket[key]
      dropped += 1
    }
  }
  if (dropped > 0) await writeJsonAtomic(file, doc)
  return dropped
}

/* -------------------------------------------------------------------------- */
/* Artifact discovery                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Locate every on-disk session directory and file that belongs to one
 * conversation. The header's `cwd` names the expected project directory, but
 * the whole root is also scanned, because a session whose header is gone must
 * still be deletable.
 * @param config - resolved configuration.
 * @param id - the session id.
 * @param cwd - the stored header's project directory, when known.
 * @returns existing directories and files to remove.
 */
export async function locateSessionArtifacts(config, id, cwd) {
  const segment = encodeSegment(id)
  const roots = new Set([config.sessionsRoot])
  if (typeof cwd === 'string' && cwd.length > 0) roots.add(join(config.sessionsRoot, projectKey(cwd)))
  roots.add(join(config.sessionsRoot, '_no-cwd'))
  for (const entry of await readdirSafe(config.sessionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.add(join(config.sessionsRoot, entry.name))
  }
  const dirs = []
  const files = []
  for (const root of roots) {
    for (const entry of await readdirSafe(root, { withFileTypes: true })) {
      if (entry.name !== segment && !entry.name.startsWith(`${segment}.`)) continue
      const path = join(root, entry.name)
      if (entry.isDirectory()) dirs.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return { dirs: unique(dirs), files: unique(files) }
}

/**
 * Every storage key one conversation may occupy across the project-cache
 * generation history: the current branded id, the id, and the pre-release
 * bare-uuid spelling.
 * @param id - the session id.
 * @returns candidate record keys.
 */
export function projectionCacheKeys(id) {
  const keys = new Set([id, encodeSegment(id)])
  if (id.startsWith('session-')) keys.add(id.slice('session-'.length))
  return [...keys]
}

/**
 * Locate the projection-cache documents (including backup-and-skip copies)
 * that belong to one conversation.
 * @param config - resolved configuration.
 * @param id - the session id.
 * @returns absolute record file paths.
 */
export async function locateProjectionCache(config, id) {
  const dir = join(config.storagesRoot, 'session_projcache', 'sessions')
  const keys = projectionCacheKeys(id)
  const found = []
  for (const entry of await readdirSafe(dir)) {
    for (const key of keys) {
      if (entry === `${key}.json` || entry.startsWith(`${key}.json.bak.`)) {
        found.push(join(dir, entry))
        break
      }
    }
  }
  return found
}

/**
 * Every local spill root to consider: configured roots plus the packaged
 * backend's discovered prior defaults under the OS temp directory.
 * @param config - resolved configuration.
 * @returns absolute spill roots that exist.
 */
export async function discoverSpillRoots(config) {
  const roots = new Set(config.spillRoots ?? [])
  const base = tmpdir()
  for (const entry of await readdirSafe(base, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('dsh-spill-')) roots.add(join(base, entry.name))
  }
  const existing = []
  for (const root of roots) if (await isDirectory(root)) existing.push(root)
  return existing
}

/**
 * The spill directory the shipped local backend derives from one session id.
 * @param root - a spill root.
 * @param id - the session id.
 * @returns the session-scoped spill directory.
 */
export function spillSessionDir(root, id) {
  return join(root, `session-${sha256Hex(id).slice(0, 12)}`)
}

/**
 * Every durable path one normalized attachment may occupy.
 * @param config - resolved configuration.
 * @param attachmentId - a `sha256:<hex>` attachment id.
 * @returns candidate paths (some may not exist).
 */
export function attachmentPaths(config, attachmentId) {
  const hex = attachmentId.slice('sha256:'.length)
  const prefix = hex.slice(0, 2)
  return [
    join(config.attachmentsRoot, 'objects', prefix, hex),
    join(config.attachmentsRoot, 'files', prefix, hex),
    join(config.attachmentsRoot, 'file-objects', prefix, hex),
  ]
}

/**
 * The request-image cache path one image variant occupies.
 * @param config - resolved configuration.
 * @param variantId - a `sha256:<hex>` variant id.
 * @returns the cache path.
 */
export function requestImagePath(config, variantId) {
  const hex = variantId.slice('sha256:'.length)
  return join(config.attachmentsRoot, 'request-images', hex.slice(0, 2), hex)
}

/** Latin-1 keeps a 1:1 byte-to-character mapping, so an ASCII id survives every chunk. */
const CHUNK_CARRY = 120

/**
 * Stream one session artifact as text, feeding each decoded chunk to a
 * visitor. Decompression is incremental, so an 80 MiB log costs no 80 MiB
 * string and the corpus scan never materializes session events.
 * @param path - the artifact file.
 * @param visit - receives each decoded text chunk; returns 'stop' to end early.
 * @param budget - shared `{ bytes, limit }` decompressed-byte budget.
 * @returns 'done', 'stopped', 'truncated' (budget exhausted), or 'error'.
 */
async function streamArtifactText(path, visit, budget) {
  const raw = createReadStream(path)
  const stream = path.endsWith('.zstd') ? raw.pipe(createZstdDecompress()) : raw
  let carry = ''
  let status = 'done'
  try {
    for await (const chunk of stream) {
      const text = carry + Buffer.from(chunk).toString('latin1')
      budget.bytes += text.length - carry.length
      if (budget.bytes > budget.limit) {
        status = 'truncated'
        break
      }
      if (visit(text) === 'stop') {
        status = 'stopped'
        break
      }
      carry = text.slice(-CHUNK_CARRY)
    }
  } catch {
    status = 'error'
  } finally {
    raw.destroy()
    if (stream !== raw) stream.destroy()
  }
  return status
}

/**
 * Enumerate every committed session artifact under the configured root,
 * pairing each with the encoded session segment that owns it.
 * @param config - resolved configuration.
 * @returns artifact paths and their encoded owner segments.
 */
async function listSessionArtifacts(config) {
  const found = []
  for (const project of await readdirSafe(config.sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(config.sessionsRoot, project.name)
    for (const entry of await readdirSafe(projectDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sessionDir = join(projectDir, entry.name)
        for (const inner of await readdirSafe(sessionDir, { withFileTypes: true })) {
          if (inner.isFile() && inner.name.includes('.jsonl')) {
            found.push({ segment: entry.name, path: join(sessionDir, inner.name) })
          }
        }
      } else if (entry.isFile() && entry.name.includes('.jsonl')) {
        found.push({ segment: entry.name.split('.')[0], path: join(projectDir, entry.name) })
      }
    }
  }
  return found
}

/**
 * Collect every attachment id the given conversations' own artifacts mention.
 * @param config - resolved configuration.
 * @param ids - session ids being deleted.
 * @returns candidate attachment ids.
 */
export async function collectCandidateAttachmentIds(config, ids) {
  const found = new Set()
  // Reading only the deleted sessions' own logs is bounded by those sessions,
  // so it is deliberately not subject to the corpus-wide proof budget.
  const budget = { bytes: 0, limit: Number.POSITIVE_INFINITY }
  for (const id of ids) {
    const artifacts = await locateSessionArtifacts(config, id)
    const files = [...artifacts.files]
    for (const dir of artifacts.dirs) {
      for (const inner of await readdirSafe(dir, { withFileTypes: true })) {
        if (inner.isFile() && inner.name.includes('.jsonl')) files.push(join(dir, inner.name))
      }
    }
    for (const file of files) {
      await streamArtifactText(file, (text) => {
        for (const match of text.matchAll(ATTACHMENT_ID_PATTERN_GLOBAL)) found.add(match[0])
        return undefined
      }, budget)
    }
  }
  return [...found]
}

/**
 * Decide which of the deleted conversations' attachments can be erased safely.
 *
 * Attachment objects are content-addressed and shared between sessions, so an
 * id may be dropped only after every *surviving* session's log has been
 * scanned and none of them mentions it; the sessions being deleted together
 * are excluded. Scanning streams and decompresses without materializing
 * events, and an incomplete proof — the session ceiling, the decompressed-byte
 * budget, or an unreadable artifact — keeps the bytes and reports them as
 * unproven.
 * @param config - resolved configuration.
 * @param ids - every session id being deleted in this operation.
 * @param knownCandidates - candidates already collected while the deleted
 *   logs still existed; omitted, they are collected now.
 * @returns candidate, deletable, referenced, and unproven attachment ids.
 */
export async function planAttachments(config, ids, knownCandidates) {
  const candidates = knownCandidates ?? await collectCandidateAttachmentIds(config, ids)
  if (candidates.length === 0) return { candidates: [], deletable: [], referenced: [], unproven: [] }

  const deleting = new Set(ids.map(id => encodeSegment(id)))
  const remaining = new Map(candidates.map(id => [id, id]))
  const referenced = new Set()
  const budget = { bytes: 0, limit: config.scanByteLimit }
  let complete = true
  let scanned = 0

  for (const artifact of await listSessionArtifacts(config)) {
    if (remaining.size === 0) break
    if (deleting.has(artifact.segment)) continue
    if (scanned >= config.scanLimit) {
      complete = false
      break
    }
    scanned += 1
    const found = []
    const status = await streamArtifactText(artifact.path, (text) => {
      for (const [attachmentId, needle] of remaining) {
        if (text.includes(needle)) found.push(attachmentId)
      }
      return found.length > 0 ? 'stop' : undefined
    }, budget)
    for (const attachmentId of found) {
      remaining.delete(attachmentId)
      referenced.add(attachmentId)
    }
    if (status === 'error' || status === 'truncated') {
      complete = false
      break
    }
  }

  const unproven = complete ? [] : [...remaining.keys()]
  return {
    candidates,
    deletable: complete ? [...remaining.keys()] : [],
    referenced: [...referenced],
    unproven,
    scanned,
    complete,
  }
}

/* -------------------------------------------------------------------------- */
/* Session facts                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read one stored header without throwing on a backend failure.
 * @param ctx - Host context.
 * @param id - the session id.
 * @returns the header and size hints, or undefined.
 */
export async function readSessionFacts(ctx, id) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  try {
    const snapshot = await persistence.stat(id)
    if (snapshot === undefined) return undefined
    return { header: snapshot.header, sizeBytes: snapshot.sizeBytes, eventCount: snapshot.eventCount }
  } catch {
    return undefined
  }
}

/**
 * Whether a conversation is currently live in this Host process. A live
 * session owns the log's write handle, which makes file-level erasure both
 * ineffective and unsafe.
 * @param ctx - Host context.
 * @param id - the session id.
 * @returns liveness plus the Agent's running state when one is attached.
 */
export function sessionLiveness(ctx, id) {
  const agent = ctx.get('agents')?.get(id)
  if (agent !== undefined) return { live: true, running: agent.status === 'running' }
  const session = ctx.get('sessions')?.get(id)
  return { live: session !== undefined, running: false }
}

/**
 * Resolve the conversation's durable subagent descendants, shallowest first.
 * @param ctx - Host context.
 * @param id - the parent session id.
 * @returns descendant session ids, or an empty list when tracing is unavailable.
 */
export async function collectDescendants(ctx, id) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  try {
    const trace = await query.traceSession(id)
    const out = []
    const walk = (nodes) => {
      for (const node of nodes) {
        out.push(node.session.header.id)
        walk(node.descendants)
      }
    }
    walk(trace.descendants ?? [])
    return unique(out).filter(candidate => candidate !== id)
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the complete deletion plan for one conversation without changing
 * anything. Every path is checked for existence so the preview the user
 * confirms is the set of artifacts the deletion actually addresses.
 * @param ctx - Host context.
 * @param config - resolved configuration.
 * @param id - the session id to delete.
 * @param options - `proveAttachments` runs the global reference proof during
 *   planning; the default counts candidates only, keeping the preview fast.
 * @returns the plan, including the blocking reason when deletion is refused.
 */
export async function planDeletion(ctx, config, id, options = {}) {
  if (typeof id !== 'string' || id.length === 0 || id.length > SESSION_ID_MAX_LENGTH) {
    return { sessionId: id, blocked: { code: 'invalid-session-id', message: 'session id must be a non-empty string of at most 200 characters' } }
  }
  const facts = await readSessionFacts(ctx, id)
  const { live, running } = sessionLiveness(ctx, id)
  const descendants = config.deleteDescendants ? await collectDescendants(ctx, id) : []
  const targetIds = [id, ...descendants]
  const liveDescendants = descendants.filter(candidate => sessionLiveness(ctx, candidate).live)

  const blocked = live
    ? {
        code: running ? 'session-running' : 'session-live',
        message: running
          ? 'this conversation is running in the current Harness process; stop it and restart the Harness before deleting it'
          : 'this conversation is open in the current Harness process, which still holds its log write handle; restart the Harness before deleting it',
      }
    : liveDescendants.length > 0
      ? {
          code: 'descendant-live',
          message: `this conversation's subagent sessions are still live in the current Harness process: ${liveDescendants.join(', ')}; restart the Harness before deleting it`,
        }
      : undefined

  const spillRoots = await discoverSpillRoots(config)
  const trees = []
  for (const targetId of targetIds) {
    const targetFacts = targetId === id ? facts : await readSessionFacts(ctx, targetId)
    const spillDirs = []
    for (const root of spillRoots) {
      const dir = spillSessionDir(root, targetId)
      if (await isDirectory(dir)) spillDirs.push(dir)
    }
    trees.push({
      id: targetId,
      isTarget: targetId === id,
      header: targetFacts?.header,
      sessionArtifacts: await locateSessionArtifacts(config, targetId, targetFacts?.header?.cwd),
      projectionCache: await locateProjectionCache(config, targetId),
      spillDirs,
    })
  }

  const inventory = []
  for (const tree of trees) {
    const suffix = tree.isTarget ? '' : ` (subagent ${tree.id})`
    const push = (kind, label, paths) => {
      for (const path of paths) inventory.push({ kind, label: `${label}${suffix}`, path })
    }
    push('session-log', 'Session log directory', tree.sessionArtifacts.dirs)
    push('session-file', 'Session log file', tree.sessionArtifacts.files)
    push('projection-cache', 'Projection cache (title and prompt cache)', tree.projectionCache)
    push('spill', 'Spilled tool output', tree.spillDirs)
  }

  const legacyFeedbackFile = join(config.storagesRoot, 'message_feedback.json')
  for (const tree of trees) {
    const keys = projectionCacheKeys(tree.id)
    if (existsSync(legacyFeedbackFile) && await hasUnitKey(legacyFeedbackFile, 'sessions', keys)) {
      inventory.push({ kind: 'legacy-feedback', label: `Legacy feedback sidecar record (${tree.id})`, path: legacyFeedbackFile })
    }
  }

  // The preview never runs the global attachment proof: reading every
  // surviving session is the deletion's expensive final step, so the plan only
  // counts candidates and the executor proves them.
  const attachmentIds = config.deleteAttachments ? await collectCandidateAttachmentIds(config, targetIds) : []
  const attachments = config.deleteAttachments
    ? (options.proveAttachments === true
        ? await planAttachments(config, targetIds, attachmentIds)
        : { candidates: attachmentIds, deletable: [], referenced: [], unproven: [] })
    : { candidates: [], deletable: [], referenced: [], unproven: [] }
  for (const attachmentId of attachments.deletable) {
    for (const path of attachmentPaths(config, attachmentId)) {
      if (await exists(path)) inventory.push({ kind: 'attachment', label: `Attachment ${attachmentId}`, path })
    }
  }

  let bytes = 0
  let files = 0
  for (const entry of inventory) {
    const size = await measure(entry.path)
    entry.bytes = size?.bytes ?? 0
    entry.files = size?.files ?? 0
    bytes += entry.bytes
    files += entry.files
  }

  return {
    sessionId: id,
    live,
    running,
    header: facts?.header,
    blocked,
    descendants,
    trees,
    inventory,
    totals: { entries: inventory.length, bytes, files },
    attachmentIds,
    attachmentCandidates: attachments.candidates.length,
    attachmentsDeletable: attachments.deletable.length,
    attachmentsReferenced: attachments.referenced.length,
    attachmentsUnproven: attachments.unproven.length,
  }
}

/**
 * @param file - a storage-json unit file.
 * @param table - table name.
 * @param keys - candidate keys.
 * @returns whether any candidate key exists in the table.
 */
async function hasUnitKey(file, table, keys) {
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    const bucket = doc?.tables?.[table]
    if (bucket === null || typeof bucket !== 'object') return false
    return keys.some(key => Object.prototype.hasOwnProperty.call(bucket, key))
  } catch {
    return false
  }
}

/** @param path - candidate. @returns whether it exists. */
async function exists(path) {
  return (await statSafe(path)) !== undefined
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Carry out one plan. Steps are independent: a failing step is recorded and
 * the remaining steps still run, so one unreadable sidecar cannot leave the
 * conversation's log behind.
 * @param ctx - Host context.
 * @param config - resolved configuration.
 * @param plan - a plan from {@link planDeletion}.
 * @returns per-artifact results, failures, freed bytes, and warnings.
 */
export async function executeDeletion(ctx, config, plan) {
  const deleted = []
  const failures = []
  const warnings = []
  const trees = plan.trees ?? []

  const removePath = async (kind, path) => {
    const size = await measure(path)
    try {
      await rm(path, { recursive: true, force: true })
      deleted.push({ kind, path, bytes: size?.bytes ?? 0, files: size?.files ?? 0 })
    } catch (error) {
      failures.push({ kind, path, message: String(error?.message ?? error) })
    }
  }

  // 1. Release the workspace registry's own durable state first, through its
  //    public API, so its in-memory snapshot and its file stay in sync. The
  //    registry prunes entries whose session no longer has a header, but doing
  //    it here keeps the file clean immediately.
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    for (const tree of trees) {
      try {
        await registry.unarchiveSession(tree.id)
        await registry.unpinSession(tree.id)
        for (const workspace of registry.list()) {
          if (!workspace.sessionIds.includes(tree.id)) continue
          try {
            await workspace.detachSession(tree.id)
            deleted.push({ kind: 'workspace-account', path: `${String(workspace.id)}:${tree.id}`, bytes: 0, files: 0 })
          } catch (error) {
            warnings.push(`workspace account entry kept for ${tree.id}: ${String(error?.message ?? error)}`)
          }
        }
      } catch (error) {
        warnings.push(`workspace registry cleanup incomplete for ${tree.id}: ${String(error?.message ?? error)}`)
      }
    }
  } else {
    // No registry service: nothing holds the workspace index open, so its
    // sidecar can be edited directly.
    await cleanWorkspaceSidecar(config, trees.map(tree => tree.id), deleted, warnings)
  }

  // 2. Every session log directory and loose generation file, for the
  //    conversation and for each durable subagent session it spawned.
  for (const tree of trees) {
    const prefix = tree.isTarget ? '' : 'subagent-'
    const artifacts = tree.sessionArtifacts ?? await locateSessionArtifacts(config, tree.id, tree.header?.cwd)
    for (const dir of artifacts.dirs) await removePath(`${prefix}session-log`, dir)
    for (const file of artifacts.files) await removePath(`${prefix}session-file`, file)

    // 3. Derived title/prompt cache records, including backup-and-skip copies.
    for (const file of tree.projectionCache ?? await locateProjectionCache(config, tree.id)) {
      await removePath(`${prefix}projection-cache`, file)
    }

    // 4. Session-scoped spill directories.
    const spillDirs = tree.spillDirs ?? []
    for (const dir of spillDirs) await removePath(`${prefix}spill`, dir)

    // 5. Legacy storage-json sidecars. The pre-release feedback sidecar is
    //    neither read nor written by the current service, so it is edited
    //    directly; the legacy whole-unit projection cache is handled the same
    //    way when the per-record tree bootstrapped away from it.
    const keys = projectionCacheKeys(tree.id)
    await editSidecar(
      join(config.storagesRoot, 'message_feedback.json'), 'sessions', keys,
      'legacy-feedback', deleted, warnings,
    )
    await editSidecar(
      join(config.storagesRoot, 'session_projcache.json'), 'sessions', keys,
      'legacy-projection-cache', deleted, warnings,
    )
  }

  // 6. Attachments proven unreferenced, plus their DeepSeek upload-cache
  //    records and request-image derivatives.
  if (config.deleteAttachments) {
    const attachments = await planAttachments(config, trees.map(tree => tree.id), plan.attachmentIds)
    for (const attachmentId of attachments.deletable) {
      for (const path of attachmentPaths(config, attachmentId)) {
        if (await exists(path)) await removePath('attachment', path)
      }
    }
    if (attachments.unproven.length > 0) {
      warnings.push(
        `${String(attachments.unproven.length)} attachment(s) were kept: their absence could not be proven by reading every surviving session`,
      )
    }
    await pruneLlmUploadCache(config, new Set(attachments.deletable), deleted, warnings)
  }

  // 7. Tell every connected client the rows are gone, so the sidebar drops
  //    them immediately instead of waiting for the next list refresh.
  for (const tree of trees) {
    try {
      ctx.emit('api-session/removed', tree.id)
    } catch (error) {
      warnings.push(`client notification failed for ${tree.id}: ${String(error?.message ?? error)}`)
    }
  }

  const removedBytes = deleted.reduce((total, entry) => total + entry.bytes, 0)
  return { deleted, failures, warnings, removedBytes }
}

/**
 * Remove deleted session ids from the workspace registry's sidecar when no
 * registry service owns it. Every other field and record is preserved.
 * @param config - resolved configuration.
 * @param ids - deleted session ids.
 * @param deleted - result accumulator.
 * @param warnings - warning accumulator.
 */
async function cleanWorkspaceSidecar(config, ids, deleted, warnings) {
  const file = join(config.storagesRoot, 'workspace.json')
  if (!(await exists(file))) return
  const removing = new Set(ids)
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    let changed = false
    const strip = (list) => {
      if (!Array.isArray(list)) return list
      const next = list.filter(value => !removing.has(value))
      if (next.length !== list.length) changed = true
      return next
    }
    const global = doc?.global
    if (global !== null && typeof global === 'object' && !Array.isArray(global)) {
      for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
        if (Array.isArray(global[key])) global[key] = strip(global[key])
      }
    }
    const workspaces = doc?.tables?.workspaces
    if (workspaces !== null && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
      for (const record of Object.values(workspaces)) {
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
        if (Array.isArray(record.sessionIds)) record.sessionIds = strip(record.sessionIds)
      }
    }
    if (changed) {
      await writeJsonAtomic(file, doc)
      deleted.push({ kind: 'workspace-index', path: file, bytes: 0, files: 1 })
    }
  } catch (error) {
    warnings.push(`${file} left untouched: ${String(error?.message ?? error)}`)
  }
}

/**
 * Drop one conversation's keys from a storage-json sidecar, recording the
 * outcome like any other artifact.
 * @param file - the sidecar file.
 * @param table - its table name.
 * @param keys - candidate keys.
 * @param kind - result kind for the report.
 * @param deleted - result accumulator.
 * @param warnings - warning accumulator.
 */
async function editSidecar(file, table, keys, kind, deleted, warnings) {
  if (!(await exists(file))) return
  try {
    const dropped = await removeUnitKeys(file, table, keys)
    if (dropped > 0) deleted.push({ kind, path: file, bytes: 0, files: 0 })
  } catch (error) {
    warnings.push(`${file} left untouched: ${String(error?.message ?? error)}`)
  }
}

/**
 * Prune deleted attachments from the DeepSeek upload cache and remove the
 * request-image derivatives their records named.
 * @param config - resolved configuration.
 * @param attachmentIds - attachment ids already erased.
 * @param deleted - result accumulator.
 * @param warnings - warning accumulator.
 */
async function pruneLlmUploadCache(config, attachmentIds, deleted, warnings) {
  if (attachmentIds.size === 0) return
  const file = join(config.llmFilesRoot, 'files-v3.json')
  if (!(await exists(file))) return
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) return
    const kept = []
    let dropped = 0
    for (const record of doc.records) {
      if (record !== null && typeof record === 'object' && attachmentIds.has(record.attachmentId)) {
        dropped += 1
        if (typeof record.variantId === 'string' && ATTACHMENT_ID_PATTERN.test(record.variantId)) {
          const path = requestImagePath(config, record.variantId)
          if (await exists(path)) {
            const size = await measure(path)
            await rm(path, { recursive: true, force: true })
            deleted.push({ kind: 'request-image', path, bytes: size?.bytes ?? 0, files: size?.files ?? 1 })
          }
        }
        continue
      }
      kept.push(record)
    }
    if (dropped > 0) {
      doc.records = kept
      await writeJsonAtomic(file, doc)
      deleted.push({ kind: 'llm-upload-cache', path: file, bytes: 0, files: dropped })
    }
  } catch (error) {
    warnings.push(`${file} left untouched: ${String(error?.message ?? error)}`)
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                                */
/* -------------------------------------------------------------------------- */

/** @param ctx - Host context. @returns the composition's connection service. */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * @param res - response.
 * @param status - HTTP status.
 * @param payload - JSON payload.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * @param req - request.
 * @param res - response.
 * @param allow - the route's one supported method.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - request.
 * @returns the body text, or null past the ceiling (stream drained).
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Parse one route body: a JSON object with a string `sessionId` and optional
 * boolean flags.
 * @param text - raw body text.
 * @returns the parsed request, or undefined when malformed.
 */
function parseBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) return undefined
  return {
    sessionId: body.sessionId,
    deleteAttachments: typeof body.deleteAttachments === 'boolean' ? body.deleteAttachments : undefined,
  }
}

/**
 * Host plugin body: register the two fenced routes.
 * @param ctx - Host context.
 * @param config - the Loader row's config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INSPECT_PATH,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      const text = await readBoundedBody(req)
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'body-too-large', message: `request body must be at most ${String(MAX_BODY_BYTES)} bytes` })
        return
      }
      const parsed = parseBody(text)
      if (parsed === undefined) {
        sendJson(res, 400, { ok: false, code: 'invalid-request', message: 'body must be a JSON object with a non-empty string sessionId' })
        return
      }
      try {
        const plan = await planDeletion(ctx, resolved, parsed.sessionId)
        const { blocked, ...rest } = plan
        sendJson(res, 200, { ok: true, ...rest, blocked })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-delete-chat: inspect failed: ${String(error?.message ?? error)}`)
        sendJson(res, 500, { ok: false, code: 'inspect-failed', message: String(error?.message ?? error) })
      }
    },
  }), `dsh-delete-chat: POST ${INSPECT_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DELETE_PATH,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      const text = await readBoundedBody(req)
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'body-too-large', message: `request body must be at most ${String(MAX_BODY_BYTES)} bytes` })
        return
      }
      const parsed = parseBody(text)
      if (parsed === undefined) {
        sendJson(res, 400, { ok: false, code: 'invalid-request', message: 'body must be a JSON object with a non-empty string sessionId' })
        return
      }
      const effective = parsed.deleteAttachments === undefined
        ? resolved
        : { ...resolved, deleteAttachments: parsed.deleteAttachments }
      let plan
      try {
        plan = await planDeletion(ctx, effective, parsed.sessionId)
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'inspect-failed', message: String(error?.message ?? error) })
        return
      }
      if (plan.blocked !== undefined) {
        sendJson(res, 409, { ok: false, ...plan.blocked, sessionId: parsed.sessionId })
        return
      }
      try {
        const result = await executeDeletion(ctx, effective, plan)
        ctx.logger?.info?.(
          `dsh-delete-chat: deleted conversation ${parsed.sessionId} (${String(result.deleted.length)} artifacts, ${String(result.removedBytes)} bytes)`,
        )
        sendJson(res, 200, {
          ok: true,
          sessionId: parsed.sessionId,
          descendants: plan.descendants ?? [],
          deleted: result.deleted,
          failures: result.failures,
          warnings: result.warnings,
          removedBytes: result.removedBytes,
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-delete-chat: delete failed for ${parsed.sessionId}: ${String(error?.message ?? error)}`)
        sendJson(res, 500, { ok: false, code: 'delete-failed', message: String(error?.message ?? error) })
      }
    },
  }), `dsh-delete-chat: POST ${DELETE_PATH}`)
}

/**
 * Internals exported for the package's own fixture tests. Not a public API:
 * the loader composes this module only through {@link apply}.
 */
export const __test = {
  encodeSegment,
  projectKey,
  resolveConfig,
  locateSessionArtifacts,
  locateProjectionCache,
  discoverSpillRoots,
  planDeletion,
  executeDeletion,
  planAttachments,
  attachmentPaths,
  requestImagePath,
  spillSessionDir,
  collectCandidateAttachmentIds,
}
