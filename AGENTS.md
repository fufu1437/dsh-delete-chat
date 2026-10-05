# AGENTS.md

`@fufu1437/dsh-delete-chat` is a DeepSeek Harness (DSH) plugin bundle that
permanently deletes one conversation and every local copy of its data. It is a
standalone, dependency-free npm package: a Host half (`index.js`) behind a
connection-fenced HTTP route, and a browser half (`client.js`) that adds one
row to the sidebar Session menu.

Read [README.md](README.md) for behavior and [README.zh.md](README.zh.md) for
the Chinese page; both describe the same product and must move together.

## Commands

```bash
pnpm run check                  # node --check on both halves
pnpm test                       # fixture suite; touches no real harness data
pnpm pack                       # inspect the published file list
pnpm publish --dry-run          # packaging + lifecycle + registry, no upload
node .tmp/e2e.mjs               # end-to-end against a running Host (scratch tool)
node .tmp/proof-scan.mjs        # read-only attachment proof over the real corpus
```

`.tmp/` holds scratch tooling. It is gitignored, never published, and never
imported by the plugin.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host half: target resolution, in-place erasure, the `POST /dsh-delete-chat/delete` route |
| `client.js` | Browser half: the menu row, the confirmation dialog, the failure notice |
| `cordis.patch.yml` | Bundle patch that inserts the one Host row |
| `locale/en.json`, `locale/zh.json` | Plugin display metadata read by the Plugin Manager (`meta.title`, `meta.description`) |
| `icon.svg` | Plugin icon, declared as a top-level `icon` in the manifest |
| `scripts/selftest.mjs` | Fixture suite: builds a throwaway harness home and asserts what survived |
| `.tmp/*.mjs` | Scratch verification scripts (never shipped) |

## Invariants

**Deletion semantics — do not weaken these.**

- **No pre-delete statistics.** There is no preview route, no artifact
  inventory, and no byte measurement before removal; the confirmation dialog
  shows no counts or sizes. Re-adding any of these is a regression, not a
  feature.
- **A conversation that is generating a response is refused**
  (`409 session-running`). Interrupting a turn is the user's decision.
- **A conversation that is merely open is forceable.** The Host reports
  `409 session-live` with `forceable: true`; the client answers with a second,
  explicit confirmation. A forced run must **overwrite every artifact with
  zeros and flush before unlinking** (`wipeFileContent` / `wipePath`). A bare
  `rm` is a fake deletion here: the live writer still holds a descriptor, so
  the bytes stay readable in the orphaned inode.
- **Attachment bytes are shared.** Attachment objects are content-addressed and
  may be referenced by other Sessions. Erase them only after the global proof
  over every *surviving* Session's log has completed; an incomplete proof
  (session ceiling, decompressed-byte budget, unreadable log) keeps the bytes
  and reports a warning. Never delete on a partial proof.
- **Paths come from `encodeSegment` / `projectKey` only**, byte-for-byte
  identical to the JSONL backend's naming. Never interpolate a session id into
  a path directly.
- **Every route calls `connection.requestRejection(req)` before anything else.**
  The fence plus the browser-session cookie is what makes these routes
  user-only.

**Packaging — the npm artifact is the product.**

- Import `node:` builtins only. Never import `@deepseek-ai/*`: those packages
  are not published, and the published bundle must stay installable and
  loadable with zero dependencies.
- Keep `dsh.bundle.patch`, `dsh.client`, `exports`, `icon`, `files`, and
  `publishConfig` working. If the runtime needs a new file, add it to `files`.
- Plain ESM JavaScript, no build step, no TypeScript.

**Client half.**

- Do not import `@deepseek-ai/dsh-client-ui-primitives` or any other Harness
  Client package. Copy the markup or CSS you need and rename its classes.
- Style with theme tokens only (`--dsw-alias-*` and the host's own documented
  variables), each with a literal fallback so a renamed token degrades instead
  of breaking. Own any injected stylesheet through a plugin effect.
- Every visible string exists in both the `zh` and `en` dictionaries. Refusal
  codes from the Host are mapped through `error.<code>`.
- Do not write DOM outside your own component, and do not append to
  `document.body`.

**Docs change with behavior.** Host JSDoc, `client.js` header, `README.md`,
`README.zh.md`, and the `scripts/selftest.mjs` assertions are part of the
change, not follow-up work.

## Verification

- `pnpm run check && pnpm test` must pass before any commit that touches
  `index.js`, `client.js`, or the suite. New behavior needs new assertions.
- Keep the erasure proof: the suite holds an open descriptor on the log
  (standing in for the live writer), deletes, and reads zeros back. It is the
  only evidence that a forced deletion really erased the bytes.
- A Host-half change is **not live** in a running Harness until it restarts
  (see below). Verify it with `node .tmp/e2e.mjs` against the running Host
  after a restart, and check the served browser bundle when the client half
  changed.
- Never verify by deleting a real conversation. `.tmp/e2e.mjs` creates a
  synthetic Session in the real harness home, exercises the routes, and removes
  its fixture afterwards.

## Releasing

```bash
pnpm version patch                 # commit + tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
pnpm publish                       # publishConfig pins access=public + registry.npmjs.org
```

- Publishing is the maintainer's call. Do not publish, and do not push a
  release, without an explicit instruction.
- npm briefly publishes a `0.0.0-stage` placeholder while a new version is
  staged; `latest` points at it for under a minute. That is normal, not a
  failure.
- The auth token must sit under the correctly spelled
  `//registry.npmjs.org/:_authToken` key. A token stored as
  `//registry.npmjs.org:_authToken` (no slash before the colon) is never read,
  and publishing then fails with a misleading 2FA error.

## Sharp edges in DSH

- **Plugin modules are not watched here.** The profile's `hmr` row is
  configured with `root: []`, so the Host keeps the module generation it loaded
  first; a Host-half change needs a Harness restart. The browser half is served
  from disk per page load, so a refresh is enough for `client.js`.
- **Every conversation opened in a `dsh web` process stays live.** The Host
  keeps an Agent and a write lease for it, `session-controller` discards the
  `AgentHandle` whose `dispose()` is the only release path, and DSH exposes no
  close/dispose API or idle eviction. That is why a forced deletion overwrites
  before unlinking, and why such a conversation leaves the session list only
  after a restart.
- **Removals reach clients as the forwarded event `api-session/removed`.**
- Use `cordis_inspect_query` (`Service`, `Event`, `Config`, `Slots`, `Theme`)
  before relying on a Harness API; the installed Harness is the authority.
