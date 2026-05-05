# Refactor Steps — Chat Streaming Performance Fixes

## Summary of latest (uncommitted) changes

All four code edits are **streaming-render performance fixes** for the chat UI. Symptoms before: when a model fans out many parallel tool calls or streams tokens fast, every chunk re-rendered the entire transcript and every tool row, causing jank and dropped frames.

| File | Change | Why |
|---|---|---|
| `src/hooks/use-chat.ts` | Coalesce stream patches via `requestAnimationFrame`; add `flushPending()`; shallow-copy tool-call snapshot instead of cloning each record | Collapse 100+ token chunks/sec into 1 React update per frame; preserve object identity so memoized children skip |
| `src/features/chat/transcript.tsx` | `memo()` `ToolRow`; rewrite `showStatusLine` predicate | Stop sibling tool rows re-rendering when one settles; keep "Churning…" cursor visible during tool calls |
| `src/features/chat/index.ts` | Re-export `PendingContextEntry` type | Lets `App.tsx` type its callback without a deep import |
| `src/App.tsx` | Wrap `onPendingContextChange` in `useCallback`; import `PendingContextEntry` type | Stable identity needed because `Composer` subscribes via a `useEffect` dep — fresh arrow each render caused re-render loop |
| `tode.md` | Deleted | Stale scratch note |

---

## Implementation instructions for another LLM agent

> Goal: Apply five edits to a clean `main` checkout of the `helix` repo. All changes are performance-oriented and the diffs must match exactly — these are subtle correctness-adjacent changes (rAF coalescing, identity preservation, callback stability) where deviation causes regressions.
>
> Repo: `/Users/sercan/codebase/ai-works/helix`. Stack: Vite + React 18/19 + TypeScript + Tauri. The chat feature lives at `src/features/chat/` and `src/hooks/use-chat.ts`.
>
> Do NOT add comments, refactors, or "improvements" beyond what's specified. Each comment block in the instructions below is part of the code to write — preserve wording exactly; it documents *why* the code looks the way it does and is load-bearing for future maintainers.

### Step 0 — Preflight

1. `git status` should show a clean tree on `main`. If not, stop and ask the user.
2. Read these files into context before editing — you must match existing style and surrounding code exactly:
   - `src/hooks/use-chat.ts`
   - `src/features/chat/transcript.tsx`
   - `src/features/chat/index.ts`
   - `src/App.tsx`
3. Confirm that `src/features/chat/composer/pending-context.ts` exists and exports `PendingContextEntry`. If the path differs, stop — the rest of these instructions assume that path.

### Step 1 — Delete `tode.md`

```
rm tode.md
```

It's a stale scratch note. Don't read it; don't preserve it.

### Step 2 — Edit `src/features/chat/index.ts`

Add a type re-export so consumers don't need to deep-import from the composer subdirectory.

**Before:**
```ts
export { Composer } from "./composer";
export type { ComposerHandle } from "./composer";
export { Transcript } from "./transcript";
```

**After:**
```ts
export { Composer } from "./composer";
export type { ComposerHandle } from "./composer";
export type { PendingContextEntry } from "./composer/pending-context";
export { Transcript } from "./transcript";
```

The new line goes **between** the `ComposerHandle` export and the `Transcript` export. Order matters for readability — group composer-related exports together.

### Step 3 — Edit `src/features/chat/transcript.tsx`

Two distinct edits in this file. `memo` is already imported at line 1 (verify), so no import change is needed.

#### 3a — Rewrite the `showStatusLine` predicate inside `MessageViewImpl`

Find the existing block (around line 96–98). It currently reads:

```tsx
const showStatusLine =
  isAssistant && streaming && !reasoning && toolCalls.length === 0;
```

Replace **only that assignment** with this expanded version, including the comment:

```tsx
// Show the "Churning…▎" line whenever the assistant is working but the
// user can't otherwise tell — i.e. no live text yet AND reasoning isn't
// animating its own cursor. Tool calls in flight count as "working with
// nothing to type yet", so we keep the cursor visible across them; once
// post-tool content starts streaming, the typed text itself is the live
// edge and the status line steps out of the way.
const showStatusLine =
  isAssistant &&
  streaming &&
  !reasoningStreaming &&
  !message.content;
```

Critical semantic change: the old predicate hid the status line as soon as a tool call appeared. The new predicate keeps it visible during tool calls and only hides it once `message.content` becomes truthy (post-tool text starts streaming) or `reasoningStreaming` takes over the live edge. Do NOT replace `!message.content` with `!message.content?.length` or similar — empty string is falsy and that's the intended check.

#### 3b — Memoize `ToolRow`

Find the function declaration (around line 531):

```tsx
function ToolRow({ call }: { readonly call: ToolCallRecord }) {
```

Replace it with a `memo`-wrapped form, **and** add the leading comment:

```tsx
// Memoized: rows re-render only when the specific call object identity
// changes. `patchCallRecords` upstream preserves identity for unchanged
// calls, so a settling tool doesn't drag every sibling row through a
// re-render — important when the model fans out 8+ parallel tool calls.
const ToolRow = memo(function ToolRow({ call }: { readonly call: ToolCallRecord }) {
```

Then find the closing brace of that function (it currently ends with a single `}` on its own line, around line 585). Change it to:

```tsx
});
```

The closing must become `});` — one bracket for the function body, one paren-semi for the `memo()` call. Don't change anything between the opening and closing of the function body. This memo only works because of the upstream identity-preservation change in Step 4 (patchCallRecords); the two edits are coupled.

### Step 4 — Edit `src/hooks/use-chat.ts`

Four distinct edits. Read the file first to find the right anchor lines — they may have drifted since these instructions were written.

#### 4a — Add `pendingFrameRef`

Find this block (around line 325):

```ts
// The AbortController controlling the active stream. Lives in a ref so the
// stable `stop` callback can reach it without reattaching to every chunk.
const abortRef = useRef<AbortController | null>(null);
useEffect(() => {
  messagesRef.current = messages;
}, [messages]);
```

Insert the new ref **between** `abortRef` and the `useEffect`:

```ts
const abortRef = useRef<AbortController | null>(null);
// Pending rAF handle for coalescing streaming patches. Tokens often arrive
// faster than React can paint (100+/sec for some providers); without this
// every chunk would trigger a transcript re-render plus a layout pass for
// auto-scroll, and the in-flight tool/reasoning rows would re-render on
// every keystroke of the model.
const pendingFrameRef = useRef<number | null>(null);
useEffect(() => {
```

#### 4b — Add an unmount cleanup effect

Find the `contextResetAt` effect (a few lines below 4a):

```ts
useEffect(() => {
  contextResetAtRef.current = contextResetAt;
}, [contextResetAt]);
```

Immediately after it, add:

```ts
useEffect(() => {
  return () => {
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  };
}, []);
```

This cancels any in-flight frame if the hook unmounts mid-stream. Empty deps array — runs once.

#### 4c — Add `flushPending` and rewrite `patch`

Find the existing `stop` callback and the `patch` callback below it. The current `patch` looks like:

```ts
const patch = useCallback(
  (
    mutator: (prev: readonly TranscriptMessage[]) => readonly TranscriptMessage[],
  ) => {
    const next = mutator(messagesRef.current);
    messagesRef.current = next;
    onChangeRef.current(next);
  },
  [],
);
```

Insert `flushPending` **between** `stop` and `patch`, then rewrite `patch`'s body. Final shape:

```ts
const stop = useCallback(() => {
  abortRef.current?.abort();
}, []);

// Synchronously deliver the latest transcript and cancel any deferred
// frame. Call before terminal state changes (stream end / abort / error)
// so the user doesn't see `isStreaming: false` over a stale transcript.
const flushPending = useCallback(() => {
  if (pendingFrameRef.current !== null) {
    cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }
  onChangeRef.current(messagesRef.current);
}, []);

const patch = useCallback(
  (
    mutator: (prev: readonly TranscriptMessage[]) => readonly TranscriptMessage[],
  ) => {
    const next = mutator(messagesRef.current);
    messagesRef.current = next;
    // Update the ref synchronously so the next mutator sees the latest
    // state, but defer the React notification to the next frame to
    // collapse many chunks into a single render.
    if (pendingFrameRef.current !== null) return;
    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      onChangeRef.current(messagesRef.current);
    });
  },
  [],
);
```

Three subtle invariants — do not break any of them:
- `messagesRef.current = next` stays **synchronous and unconditional**. Successive mutators within the same frame must observe the latest state. Only the React notification is deferred.
- The early `return` when `pendingFrameRef.current !== null` is the coalescing mechanism — multiple `patch()` calls in one frame share a single rAF. Don't replace with `clearTimeout`/`setTimeout`.
- Inside the rAF callback, read `messagesRef.current` again rather than capturing `next` from the outer scope — by the time the frame fires, `next` may be stale.

#### 4d — Preserve identity in `patchCallRecords`

Find the inner function (around line 478):

```ts
const patchCallRecords = () => {
  const snapshot = callRecords.map((r) => ({ ...r }));
  patch((prev) =>
```

Change the `snapshot` line and add the leading comment:

```ts
const patchCallRecords = () => {
  // Shallow copy preserves per-record identity for unchanged calls
  // (records are replaced in place at the index that mutated), so
  // memoized ToolRow children skip re-rendering when only one of
  // many calls transitions running → complete.
  const snapshot = [...callRecords];
  patch((prev) =>
```

`callRecords.map((r) => ({ ...r }))` was creating fresh objects every patch, defeating React's referential-equality bailout in the memoized `ToolRow`. The new `[...callRecords]` clones the array but keeps each record's identity stable — and the upstream code already replaces records in-place at the mutated index, so unchanged records stay `===` between snapshots. This is the upstream half of Step 3b's memo; ship them together.

#### 4e — Flush before terminal state in `finally`

Find the `finally` block at the end of `send` (around line 887):

```ts
} finally {
  if (abortRef.current === ac) abortRef.current = null;
  setIsStreaming(false);
}
```

Add a `flushPending()` call as the first statement, with a comment:

```ts
} finally {
  // Drain any rAF-deferred patch before flipping isStreaming so the
  // user sees the final transcript synchronously, not "done" over a
  // one-frame-stale view.
  flushPending();
  if (abortRef.current === ac) abortRef.current = null;
  setIsStreaming(false);
}
```

Then update the `useCallback` deps array of the surrounding `send` callback. It currently ends `[provider, isStreaming, patch],`. Change to:

```ts
[provider, isStreaming, patch, flushPending],
```

The deps update is mandatory — `flushPending` is now referenced inside `send`. Skipping this triggers the `react-hooks/exhaustive-deps` lint and (more importantly) closes over a stale `flushPending` if its identity ever changes. (It won't here because its deps array is `[]`, but the lint rule is non-negotiable in this codebase.)

### Step 5 — Edit `src/App.tsx`

Two edits: extend the type import and stabilize the callback identity.

#### 5a — Extend the type import from `./features/chat`

Find:

```tsx
import { Composer, Transcript } from "./features/chat";
import type { ComposerHandle } from "./features/chat";
```

Replace the type import with the multi-line form:

```tsx
import { Composer, Transcript } from "./features/chat";
import type {
  ComposerHandle,
  PendingContextEntry,
} from "./features/chat";
```

The runtime import line is unchanged. Only the type import is reformatted to add `PendingContextEntry`.

#### 5b — Hoist `onPendingContextChange` into a `useCallback`

In `ChatView`, find the `useChat({...})` call. Just above it, after the `onResetContext`/`onClearTranscript` definitions, the current code passes an inline arrow to `<Composer onPendingContextChange={(entries) => { ... }}>`.

Two changes:

**(i)** Add a new `useCallback` declaration above the `useChat` call. The exact insertion point: after `onResetContext` is defined (it ends with `setContextResetAt(id, undefined);` then `}, [setMessages, setContextResetAt]);`), before `const { isStreaming, error, send, stop } = useChat(...)`. Add:

```tsx
// Stable callback identity matters: the Composer subscribes via a
// useEffect that lists this in its deps, so a fresh arrow every render
// would refire the effect, refire setAttachedFilePaths with a new Set,
// and pin React in a re-render loop.
const onPendingContextChange = useCallback(
  (entries: readonly PendingContextEntry[]) => {
    const paths = new Set<string>();
    for (const e of entries) {
      if (e.kind === "file" && e.id.startsWith("file:")) {
        paths.add(e.id.slice("file:".length));
      }
    }
    onAttachedFilePathsChange?.(paths);
  },
  [onAttachedFilePathsChange],
);
```

**(ii)** In the `<Composer ...>` JSX, find the prop:

```tsx
onPendingContextChange={(entries) => {
  // Project to absolute file paths only — that's all the workspace
  // pane needs to highlight rows. File entry ids are `file:${absPath}`
  // (set in the Composer's attachWorkspaceFile imperative handle).
  const paths = new Set<string>();
  for (const e of entries) {
    if (e.kind === "file" && e.id.startsWith("file:")) {
      paths.add(e.id.slice("file:".length));
    }
  }
  onAttachedFilePathsChange?.(paths);
}}
```

Replace the entire prop assignment with:

```tsx
onPendingContextChange={onPendingContextChange}
```

Verify `useCallback` is already in the React imports at the top of `App.tsx` (it almost certainly is — `onResetContext` and `onClearTranscript` use it). If not, add it.

### Step 6 — Verify

Run, in this order, and stop at the first failure:

```bash
pnpm tsc --noEmit       # or: npx tsc --noEmit  (use whichever the repo uses)
pnpm lint               # if a lint script exists
```

Then check the diff matches the spec:

```bash
git diff --stat
```

Expected (approximate):

```
 src/App.tsx                      | 35 ++++++++++++++++++------------
 src/features/chat/index.ts       |  1 +
 src/features/chat/transcript.tsx | 19 ++++++++++++++---
 src/hooks/use-chat.ts            | 46 +++++++++++++++++++++++++++++++++++++---
 tode.md                          |  9 --------
 5 files changed, 82 insertions(+), 28 deletions(-)
```

If counts are off by more than a couple of lines, re-read the diff against this spec — you've added or omitted something.

### Step 7 — Manual smoke test (cannot be automated)

Frontend changes; type-checking proves correctness, not feature behavior. Tell the user:

> Type-check passes. Please verify in the running app: (1) start a chat that fans out parallel tool calls — sibling rows should not flicker when one settles; (2) the "Churning…▎" cursor should stay visible during tool calls and only disappear once post-tool text streams; (3) the workspace rail should still highlight attached files. I cannot test these in the harness.

### Do NOT

- Bundle these into "cleanup" passes, rename variables, or reformat surrounding code.
- Replace `requestAnimationFrame` with `setTimeout(..., 16)` or `queueMicrotask` — they have different semantics. rAF is correct here because it aligns with the paint cycle and auto-pauses in background tabs.
- Remove the load-bearing comments. They explain non-obvious *why*s (callback stability, identity preservation, terminal-state flush ordering) that future maintainers will otherwise undo.
- Commit unless the user asks. If asked, follow the repo's existing commit-message style (`feat:` / `perf:` / `refactor:` prefixes — `git log --oneline -10` shows the convention).
