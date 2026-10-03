/**
 * Fixture self-test for @fufu1437/dsh-delete-chat.
 *
 * Builds a complete throwaway harness home — session logs, projection cache,
 * workspace index, legacy feedback sidecar, spill files, attachments, and the
 * DeepSeek upload cache — drives the Host half's plan/execute pair against a
 * scripted context, and asserts exactly what survived.
 *
 * Run with `pnpm test`. No dependencies, no real harness state touched.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { executeDeletion, planDeletion, resolveConfig, __test } from '../index.js'

const { attachmentPaths, projectKey, spillSessionDir } = __test

/* -------------------------------------------------------------------------- */
/* Tiny assertion harness                                                      */
/* -------------------------------------------------------------------------- */

let passed = 0
const failures = []

/**
 * @param name - assertion name.
 * @param condition - the asserted fact.
 */
function check(name, condition) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}`)
  }
}

/**
 * @param name - assertion name.
 * @param actual - observed value.
 * @param expected - expected value.
 */
function equal(name, actual, expected) {
  check(`${name} (${JSON.stringify(actual)} === ${JSON.stringify(expected)})`, actual === expected)
}

/** @param path - candidate. @returns whether it exists. */
function exists(path) {
  return existsSync(path)
}

/** @param path - file. @returns its parsed JSON. */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const TARGET = 'session-target-0001'
const OTHER = 'session-other-0002'
const CHILD = 'child-0003'
const CWD = '/home/test/proj'
const EXCLUSIVE = `sha256:${'aa'.repeat(32)}`
const SHARED = `sha256:${'bb'.repeat(32)}`
const EXCLUSIVE_VARIANT = `sha256:${'cc'.repeat(32)}`
const SHARED_VARIANT = `sha256:${'dd'.repeat(32)}`

const root = await mkdtemp(join(tmpdir(), 'dsh-delete-chat-'))
const home = join(root, 'home')
const spillRoot = join(root, 'spill')
const config = resolveConfig({ dshHome: home, spillRoots: [spillRoot] })

const sessionsRoot = config.sessionsRoot
const projectDir = join(sessionsRoot, projectKey(CWD))
const storages = config.storagesRoot

/** @returns the target conversation's canonical log text, containing its attachment reference. */
function targetLog() {
  return [
    JSON.stringify({ type: 'session', version: 4, id: TARGET, createdAt: 1, cwd: CWD, isSeeded: false }),
    JSON.stringify({
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { content: [{ type: 'image', attachment: { attachmentId: EXCLUSIVE } }], source: { kind: 'user' }, role: 'user', id: 'm-1' },
    }),
  ].join('\n')
}

/** @param path - file to write. @param text - content. */
async function write(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function buildFixture() {
  await mkdir(home, { recursive: true })
  // The target's current log is a real zstd artifact; its legacy generation is
  // plain text. Only the target references EXCLUSIVE; only OTHER references SHARED.
  await write(join(projectDir, TARGET, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(targetLog())))
  await write(join(projectDir, TARGET, 'session.lock'), '')
  await write(join(projectDir, `${TARGET}.v2.jsonl.zstd`), JSON.stringify({ attachmentId: EXCLUSIVE }))
  await write(join(projectDir, OTHER, 'session.v4.jsonl'), JSON.stringify({ attachmentId: SHARED }))
  await write(join(projectDir, OTHER, 'session.lock'), '')
  await write(join(projectDir, CHILD, 'session.v4.jsonl'), '{"type":"session"}')

  await write(join(storages, 'session_projcache', 'sessions', `${TARGET}.json`), '{"version":7}')
  await write(join(storages, 'session_projcache', 'sessions', `${TARGET}.json.bak.123`), '{"version":6}')
  await write(join(storages, 'session_projcache', 'sessions', `${OTHER}.json`), '{"version":7}')

  await write(join(storages, 'message_feedback.json'), JSON.stringify({
    unit: { name: 'message_feedback', version: 0 },
    global: null,
    tables: { sessions: { [TARGET]: { items: [] }, [OTHER]: { items: [] } } },
  }))

  await write(join(storages, 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [TARGET], pinnedSessionIds: [TARGET, OTHER] },
    tables: {
      workspaces: {
        'ws-1': { path: CWD, title: 'proj', sessionIds: [TARGET, OTHER], createdAt: 'x', updatedAt: 'y' },
      },
    },
  }))

  await write(join(spillSessionDir(spillRoot, TARGET), 'out-1.txt'), 'spilled tool output')
  await write(join(spillSessionDir(spillRoot, OTHER), 'out-2.txt'), 'other spill')

  const exclusivePaths = attachmentPaths(config, EXCLUSIVE)
  await write(exclusivePaths[0], 'image-bytes')
  await write(join(exclusivePaths[1], 'orig.png'), 'file-bytes')
  await write(exclusivePaths[2], 'file-object-bytes')
  const sharedPaths = attachmentPaths(config, SHARED)
  await write(sharedPaths[0], 'shared-image-bytes')

  await write(join(config.attachmentsRoot, 'request-images', EXCLUSIVE_VARIANT.slice(7, 9), EXCLUSIVE_VARIANT.slice(7)), 'exclusive-request-image')
  await write(join(config.attachmentsRoot, 'request-images', SHARED_VARIANT.slice(7, 9), SHARED_VARIANT.slice(7)), 'shared-request-image')

  await write(join(config.llmFilesRoot, 'files-v3.json'), JSON.stringify({
    formatVersion: 3,
    records: [
      { scope: 'scope-exclusive', attachmentId: EXCLUSIVE, variantId: EXCLUSIVE_VARIANT, fileId: 'file-1' },
      { scope: 'scope-shared', attachmentId: SHARED, variantId: SHARED_VARIANT, fileId: 'file-2' },
    ],
  }))
}

/**
 * A scripted Host context exposing only what the deletion engine reads.
 * @param options - liveness, descendants, unreadable sessions, and registry.
 * @returns the fake context.
 */
function makeCtx(options = {}) {
  const { liveIds = [], runningIds = [], childOfTarget = false, unreadable = [], registry } = options
  const headers = {
    [TARGET]: { version: 4, id: TARGET, createdAt: 1, cwd: CWD, isSeeded: false },
    [OTHER]: { version: 4, id: OTHER, createdAt: 2, cwd: CWD, isSeeded: false },
    [CHILD]: { version: 4, id: CHILD, createdAt: 3, cwd: CWD, isSeeded: false, origin: 'subagent', parentSession: TARGET },
  }
  const events = {
    [TARGET]: [
      { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'image', attachment: { attachmentId: EXCLUSIVE } }] } } },
      { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'file', attachment: { attachmentId: EXCLUSIVE, name: 'a.txt' } }] } } },
    ],
    [OTHER]: [
      { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'image', attachment: { attachmentId: SHARED } }] } } },
    ],
    [CHILD]: [],
  }
  const emitted = []
  return {
    logger: { info() {}, warn() {} },
    emit(event, payload) { emitted.push([event, payload]) },
    emitted,
    get(service) {
      if (service === 'sessionPersistence') {
        return { stat: async (id) => (headers[id] === undefined ? undefined : { header: headers[id], sizeBytes: 10, eventCount: 1 }) }
      }
      if (service === 'agents') {
        return { get: (id) => (liveIds.includes(id) ? { id, status: runningIds.includes(id) ? 'running' : 'idle' } : undefined) }
      }
      if (service === 'sessions') return { get: () => undefined }
      if (service === 'sessionQuery') {
        return {
          listSessions: async () => Object.keys(headers).map(id => ({ header: headers[id], live: false, persisted: true })),
          readSession: async (id) => {
            if (unreadable.includes(id)) throw new Error(`unreadable:${id}`)
            return { session: headers[id], inheritedEventCount: 0, events: events[id] ?? [] }
          },
          traceSession: async (id) => ({
            target: { header: headers[id] },
            ancestors: [],
            descendants: childOfTarget && id === TARGET ? [{ session: { header: headers[CHILD] }, descendants: [] }] : [],
            complete: true,
            root: { header: headers[id] },
          }),
        }
      }
      if (service === 'workspaceRegistry') return registry
      return undefined
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

console.log('dsh-delete-chat self-test')
console.log(`fixture: ${root}\n`)

console.log('path encoding matches the shipped backend')
equal('projectKey(/home/fufu)', projectKey('/home/fufu'), '--home-fufu--')
equal(
  'projectKey(/home/fufu/project/dsh-plugin/dsh-delete-chat)',
  projectKey('/home/fufu/project/dsh-plugin/dsh-delete-chat'),
  '--home-fufu-project-dsh-plugin-dsh-delete-chat--',
)
equal('encodeSegment keeps a plain id', __test.encodeSegment('session-abc-123'), 'session-abc-123')
equal('encodeSegment escapes a separator', __test.encodeSegment('a/b'), 'a~002Fb')
equal('encodeSegment escapes dotdot', __test.encodeSegment('..'), '~002E~002E')

await buildFixture()

console.log('\nplan: a non-live conversation is deletable')
const ctx = makeCtx()
const plan = await planDeletion(ctx, config, TARGET)
check('plan is not blocked', plan.blocked === undefined)
check('plan finds the live log directory', plan.inventory.some(entry => entry.kind === 'session-log' && entry.path === join(projectDir, TARGET)))
check('plan finds the loose generation file', plan.inventory.some(entry => entry.kind === 'session-file' && entry.path === join(projectDir, `${TARGET}.v2.jsonl.zstd`)))
check('plan finds the projection cache', plan.inventory.some(entry => entry.kind === 'projection-cache' && entry.path.endsWith(`${TARGET}.json`)))
check('plan finds the projection-cache backup', plan.inventory.some(entry => entry.path.endsWith(`${TARGET}.json.bak.123`)))
check('plan finds the spill directory', plan.inventory.some(entry => entry.kind === 'spill'))
check('plan does not touch another session', !plan.inventory.some(entry => entry.path.includes(OTHER)))
equal('preview counts one exclusive attachment candidate', plan.attachmentCandidates, 1)
equal('preview does not run the global proof', plan.attachmentsDeletable, 0)
check('plan total counts bytes', plan.totals.bytes > 0)

const provenPlan = await planDeletion(ctx, config, TARGET, { proveAttachments: true })
equal('proven plan marks the exclusive attachment deletable', provenPlan.attachmentsDeletable, 1)

console.log('\nexecute: every artifact class is erased, shared bytes survive')
const result = await executeDeletion(ctx, config, plan)
check('target log directory removed', !exists(join(projectDir, TARGET)))
check('loose generation file removed', !exists(join(projectDir, `${TARGET}.v2.jsonl.zstd`)))
check('target projection cache removed', !exists(join(storages, 'session_projcache', 'sessions', `${TARGET}.json`)))
check('target projection cache backup removed', !exists(join(storages, 'session_projcache', 'sessions', `${TARGET}.json.bak.123`)))
check('target spill directory removed', !exists(spillSessionDir(spillRoot, TARGET)))
check('other session log intact', exists(join(projectDir, OTHER, 'session.v4.jsonl')))
check('other session projection cache intact', exists(join(storages, 'session_projcache', 'sessions', `${OTHER}.json`)))
check('other session spill intact', exists(join(spillSessionDir(spillRoot, OTHER), 'out-2.txt')))

const feedback = await readJson(join(storages, 'message_feedback.json'))
check('legacy feedback record removed', feedback.tables.sessions[TARGET] === undefined)
check('other feedback record intact', feedback.tables.sessions[OTHER] !== undefined)

const workspace = await readJson(join(storages, 'workspace.json'))
check('archived set cleaned', !workspace.global.archivedSessionIds.includes(TARGET))
check('pinned set cleaned', !workspace.global.pinnedSessionIds.includes(TARGET))
check('other pin intact', workspace.global.pinnedSessionIds.includes(OTHER))
check('workspace account cleaned', !workspace.tables.workspaces['ws-1'].sessionIds.includes(TARGET))
check('other workspace account intact', workspace.tables.workspaces['ws-1'].sessionIds.includes(OTHER))

const exclusivePaths = attachmentPaths(config, EXCLUSIVE)
check('exclusive attachment object removed', !exists(exclusivePaths[0]))
check('exclusive attachment file dir removed', !exists(exclusivePaths[1]))
check('exclusive attachment file-object removed', !exists(exclusivePaths[2]))
check('exclusive request image removed', !exists(join(config.attachmentsRoot, 'request-images', EXCLUSIVE_VARIANT.slice(7, 9), EXCLUSIVE_VARIANT.slice(7))))
check('shared attachment object kept', exists(attachmentPaths(config, SHARED)[0]))
check('shared request image kept', exists(join(config.attachmentsRoot, 'request-images', SHARED_VARIANT.slice(7, 9), SHARED_VARIANT.slice(7))))

const llm = await readJson(join(config.llmFilesRoot, 'files-v3.json'))
equal('only the deleted attachment left the upload cache', llm.records.length, 1)
equal('the surviving upload record is the shared one', llm.records[0].attachmentId, SHARED)

check('no failures recorded', result.failures.length === 0)
check('removed bytes reported', result.removedBytes > 0)
check('client removal notification emitted', ctx.emitted.some(([event, id]) => event === 'api-session/removed' && id === TARGET))

console.log('\nrefusals: a live or running conversation is never touched')
const live = makeCtx({ liveIds: [TARGET] })
const livePlan = await planDeletion(live, config, TARGET)
equal('live conversation is blocked', livePlan.blocked?.code, 'session-live')
const running = makeCtx({ liveIds: [TARGET], runningIds: [TARGET] })
const runningPlan = await planDeletion(running, config, TARGET)
equal('running conversation is blocked', runningPlan.blocked?.code, 'session-running')

console.log('\nsubagent descendants are deleted with the parent')
await buildFixture()
const treeCtx = makeCtx({ childOfTarget: true })
const treePlan = await planDeletion(treeCtx, config, TARGET)
equal('plan reports one descendant', treePlan.descendants.length, 1)
check('plan covers the child log', treePlan.inventory.some(entry => entry.kind === 'session-log' && entry.path === join(projectDir, CHILD)))
const treeResult = await executeDeletion(treeCtx, config, treePlan)
check('child log removed', !exists(join(projectDir, CHILD)))
check('child removal notified', treeCtx.emitted.some(([event, id]) => event === 'api-session/removed' && id === CHILD))
check('parent removal notified', treeCtx.emitted.some(([event, id]) => event === 'api-session/removed' && id === TARGET))
check('subagent deletion recorded no failure', treeResult.failures.length === 0)

const liveChildCtx = makeCtx({ childOfTarget: true, liveIds: [CHILD] })
const liveChildPlan = await planDeletion(liveChildCtx, config, TARGET)
equal('a live descendant blocks the whole deletion', liveChildPlan.blocked?.code, 'descendant-live')

console.log('\nattachment proof: an unreadable sibling keeps the bytes')
await buildFixture()
// A sibling artifact that cannot be decompressed makes the proof incomplete.
await write(join(projectDir, OTHER, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff, 0xff]))
const unreadableCtx = makeCtx()
const unprovenPlan = await planDeletion(unreadableCtx, config, TARGET, { proveAttachments: true })
equal('no attachment is proven deletable', unprovenPlan.attachmentsDeletable, 0)
equal('the candidate is reported unproven', unprovenPlan.attachmentsUnproven, 1)
const unprovenResult = await executeDeletion(unreadableCtx, config, unprovenPlan)
check('attachment bytes kept when the proof is incomplete', exists(attachmentPaths(config, EXCLUSIVE)[0]))
check('a warning explains the kept attachment', unprovenResult.warnings.some(warning => warning.includes('could not be proven')))

console.log('\nattachment proof: an exhausted byte budget keeps the bytes')
await buildFixture()
const budgetedCtx = makeCtx()
const budgetedPlan = await planDeletion(budgetedCtx, config, TARGET, { proveAttachments: true })
equal('a truncated scan proves nothing', budgetedPlan.attachmentsDeletable, 0)
equal('the candidate is reported unproven after truncation', budgetedPlan.attachmentsUnproven, 1)
const tinyConfig = { ...config, scanByteLimit: 8 }
const tinyPlan = await planDeletion(budgetedCtx, tinyConfig, TARGET, { proveAttachments: true })
equal('a tiny byte budget truncates the proof', tinyPlan.attachmentsUnproven, 1)

console.log('\npath safety: a hostile session id cannot escape the roots')
const hostile = await planDeletion(makeCtx(), config, '../../etc/passwd')
check('hostile id produces no absolute escape', (hostile.inventory ?? []).every(entry => entry.path.startsWith(config.sessionsRoot) || entry.path.startsWith(config.storagesRoot) || entry.path.startsWith(config.attachmentsRoot)))

/* -------------------------------------------------------------------------- */

await rm(root, { recursive: true, force: true })

console.log(`\n${String(passed)} checks passed, ${String(failures.length)} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  failed: ${failure}`)
  process.exitCode = 1
}
