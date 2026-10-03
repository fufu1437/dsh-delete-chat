# Conversation Deletion (@fufu1437/dsh-delete-chat)

A DeepSeek Harness (DSH) plugin that **permanently deletes one conversation**
together with every local copy of its data.

Every Session row in the sidebar gains a "Delete conversation…" entry in its
`…` menu. It opens a confirmation dialog that first lists what
would be removed and how much space it occupies; nothing happens until you
confirm.

> 中文文档：[README.zh.md](README.zh.md)

## What gets deleted

A conversation leaves more on disk than most people expect. This plugin clears
each of these:

| # | Artifact | Location | Notes |
|---|---|---|---|
| 1 | Session log directory | `~/.dsh/sessions/<project-key>/<session-id>/` | Every on-disk format generation (`session.v3.jsonl.zstd`, `session.v4.jsonl.zstd`, …) plus the write lease `session.lock` |
| 2 | Projection cache record | `~/.dsh/storages/session_projcache/sessions/<id>.json` | The cached **title** and **first-prompt text**, including `.json.bak.*` copies |
| 3 | Legacy feedback sidecar | `~/.dsh/storages/message_feedback.json` | A pre-release format the current service no longer reads; it can hold user-written notes |
| 4 | Workspace index | `~/.dsh/storages/workspace.json` | Account order, archive set, and pin set, written through the workspace registry's own API |
| 5 | Spilled tool output | `<spill root>/session-<first 12 hex of sha256(id)>/` | Every local spill root, including `$TMPDIR/dsh-spill-*` |
| 6 | Attachments | `~/.dsh/attachments/v1/{objects,files,file-objects,request-images}` | Removed **only** after proving no surviving session references them |
| 7 | Subagent sessions | As 1–5 | Every durable subagent session the conversation spawned, recursively |
| 8 | DeepSeek upload cache | `~/.dsh/llm-deepseek/files-v3.json` | Records of deleted attachments plus the request-image derivatives their `variantId`s name |

Afterwards the plugin broadcasts `api-session/removed` to every connected
client, so the sidebar row disappears immediately instead of waiting for the
next list refresh.

## Safety model

Deletion is irreversible, so the implementation follows two hard rules.

**1. A live conversation is never touched.** The Host keeps an Agent and an
open log write handle for every conversation opened in this process, and DSH
exposes no public "release this session" API. Removing files under an open
writer would leave the bytes in an unlinked inode — not actually erased — and
the writer could recreate state. Therefore:

- the conversation is open in the current process → refused with `409 session-live`;
- it is running a turn → refused with `409 session-running`;
- one of its subagent sessions is still live → refused with `409 descendant-live`.

The dialog shows the refusal verbatim. Restart the Harness (or wait until the
conversation is no longer active) and delete it then.

**2. Nothing is deleted unless its absence is proven safe.** Attachment objects
are content-addressed and may be shared between sessions, so an id is dropped
only after **every surviving session's** log has been scanned and none of them
mentions it. The scan streams and decompresses without materializing events and
is bounded by a session ceiling and a decompressed-byte budget; when either is
exceeded, or a log cannot be read, the bytes are **kept** and a warning is
reported.

Other engineering constraints:

- Session ids are escaped with an `encodeSegment` byte-for-byte identical to the
  JSONL backend's before touching a path, so `../`, absolute paths, and NUL
  cannot escape the roots;
- The package imports only `node:` builtins and **no private `@deepseek-ai/*`
  package**, so it publishes as an ordinary npm package;
- Both HTTP routes pass the composition's `connection.requestRejection` trust
  fence first (Host/Origin checks plus the browser session cookie);
  unauthenticated requests get 401/403.

## Install

pnpm is assumed (DSH profiles are pnpm-managed).

From npm, once published:

```bash
dsh plugin install @fufu1437/dsh-delete-chat
```

From a local checkout:

```bash
pnpm add @fufu1437/dsh-delete-chat     # or as a local link dependency
dsh plugin install /absolute/path/to/dsh-delete-chat
```

The in-Harness plugin manager works too: call `install_bundle` with the package
directory, a `.tgz`, or the npm package name.

**The Host half requires a Harness restart to take effect after an update**: in
this profile the `hmr` row is configured with `root: []` (no plugin module
roots watched), so the process caches the loaded module generation. The Client
half takes effect as the page loads.

## Usage

1. Hover a conversation row in the left sidebar and open its `…` menu;
2. choose "Delete conversation…";
3. the dialog lists artifact classes, entry counts, and total size — or the
   refusal reason when deletion is blocked (for example, a running turn);
4. press "Delete permanently", then read the freed-byte summary and any
   warnings or failures.

## Configuration

Override in the profile's `cordis.patch.yml`:

```yaml
- id: fufu-delete-chat
  name: '@fufu1437/dsh-delete-chat'
  config:
    dshHome: /home/me/.dsh
    deleteAttachments: true
    deleteDescendants: true
    scanLimit: 500
    scanByteLimit: 2147483648
```

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` → `~/.dsh` | Harness home; every other root derives from it |
| `sessionsRoot` | `<dshHome>/sessions` | Session log root |
| `storagesRoot` | `<dshHome>/storages` | storage-json root |
| `attachmentsRoot` | `<dshHome>/attachments/v1` | Attachment root |
| `llmFilesRoot` | `<dshHome>/llm-deepseek` | DeepSeek upload-cache root |
| `spillRoots` | discovered `$TMPDIR/dsh-spill-*` | Spill roots to sweep |
| `deleteAttachments` | `true` | Run the attachment proof and erase unreferenced uploads |
| `deleteDescendants` | `true` | Also delete durable subagent sessions |
| `scanLimit` | `500` | Maximum session logs the attachment proof reads |
| `scanByteLimit` | `2 GiB` | Maximum decompressed bytes the proof reads |

## Verification

```bash
pnpm test          # fixture self-test: 59 assertions, touches no real data
pnpm run check     # syntax-check both halves
```

`scripts/selftest.mjs` builds a complete throwaway harness home (session logs,
projection cache, workspace index, legacy feedback sidecar, spill files,
attachments, upload cache), drives the plan/execute pair with a scripted Host
context, and asserts **what survived**:

- every artifact class is erased while another session's data stays intact;
- live, running, and live-descendant conversations are refused;
- an attachment referenced by another session is kept; an exclusively
  referenced one is erased;
- a truncated scan or an undecompressable log keeps the bytes and warns;
- a hostile session id cannot escape the roots.

`.tmp/e2e.mjs` is an end-to-end script against the **running Host** (never
published): it mints the same browser-session cookie the page uses, creates a
synthetic session in the real DSH home (log + projection cache + spill +
attachment), calls inspect/delete through the real trust fence, asserts the
artifacts are gone, and verifies that a live conversation is refused with 409.
It needs write access and cleans up after itself.

`.tmp/proof-scan.mjs` runs the full attachment proof read-only over the real
corpus (187 session logs on this machine complete in about 1.5 s).

## Known limitations

- **A live conversation cannot be deleted** until the Harness restarts (DSH has
  no public session-release API). This is a deliberate safety trade-off.
- **Telemetry already exported cannot be recalled**: `session-telemetry-otel`
  may already have shipped a log prefix to a remote collector in
  `FEEDBACK_ONLY` mode; this plugin can only erase local data.
- **Derived-cache boundary**: removing a request-image cache entry requires the
  matching record in `files-v3.json`; other derived copies that leave no
  attachment reference in the log are out of scope.
- The legacy `message_feedback.json` sidecar is not read by the current
  service; this plugin reads and rewrites it directly.
- `workspace.json` is edited through the workspace registry API when that
  service exists, and directly only when it does not (so nothing can overwrite
  the change from memory).
- The default local spill root is a temp directory; if a Harness once used a
  different `root` that has since been cleaned up, there is nothing left to
  delete.

## Publishing

```bash
pnpm run check && pnpm test
pnpm publish --access public     # scoped packages need public access
```

`prepublishOnly` runs the syntax check and the self-test first.

## License

MIT
