# Refactor Steps — Memoize Palette Rows & Tag Groups

## Summary of latest (uncommitted) changes

Targeted React render-cost reduction for the **MCP** and **Helix Core** capability popovers. Both palettes render row lists inside `.map()` calls; previously every parent re-render walked every child even though their props were unchanged. Three components are now wrapped in `React.memo`, and the parent stops recreating the per-tag `onToggle` thunk on each render so memo equality actually holds.

| File | Change | Why |
|---|---|---|
| `src/features/chat/mcp-palette.tsx` | Add `memo` + `useCallback` imports; pass `toggleTag` directly to `PaletteTagGroup` instead of `() => toggleTag(tag)`; widen `PaletteTagGroup`'s `onToggle` signature to `(tag: string) => void` and re-create a stable per-group click handler with `useCallback`; wrap `PaletteTagGroup` and `PaletteRowView` in `React.memo`; extract the disclosure toggle into a `useCallback` | The previous `() => toggleTag(tag)` was a fresh function every render, so a memoised `PaletteTagGroup` would still see a new `onToggle` prop and re-render. Pushing the per-tag binding into the child (where it's keyed by stable `tag` + stable `toggleTag`) makes memo equality real. `PaletteRowView` lives in nested `.map()`s — when `itemState` is unchanged (the common case while users browse the popover), every row now skips re-render. |
| `src/features/chat/builtin-palette.tsx` | Add `memo` import; wrap `BuiltinRow` in `React.memo` | `BuiltinRow` only takes `tool` (referentially stable from `groupByGroup`'s memoised result) and `enabled` (boolean primitive). It renders inside a `.map()` over each group's tools; memoising it skips the per-row work whenever the parent re-renders for unrelated reasons (e.g. another group's enabled/disabled state changed). |

**Not changed** (deliberately):
- The inline `onClick={() => setX(id)}` handlers in `src/features/settings/settings.tsx`, `mcp-pane.tsx`, and `mcp-form.tsx`. The buttons receiving those handlers are not themselves memoised, so wrapping the handlers in `useCallback` accomplishes nothing — they re-render with their parent regardless. Memoising those buttons would be cargo-culting; the rendering cost there is trivial.
- `BuiltinGroup` memoisation. Its `isEnabled` and `onToggle` props come from outside the file (the composer); making memo bite would require stabilising those upstream, which is more invasive than the win warrants given there are only a handful of groups.

---

## Implementation instructions for another LLM agent

> Goal: Apply the memoisation changes to a clean checkout of the `helix` repo that already has the prior refactors (`refactor-steps1.md`, `refactor-steps2.md`) applied. The end state is that the MCP popover and the Helix Core popover skip rendering rows whose props haven't actually changed, with no behaviour change.
>
> Repo: `/Users/sercan/codebase/ai-works/helix`. Stack: Vite + React 18/19 + TypeScript + Tauri.
>
> Do NOT introduce additional memo wrappers, refactors, or "improvements" beyond what's specified. Don't touch the settings panes' inline handlers — they are intentionally untouched (see "Not changed" above).

### Step 0 — Preflight

1. `git status` should be clean. If not, stop and ask the user.
2. Read these files into context before editing — match existing style and surrounding code exactly:
   - `src/features/chat/mcp-palette.tsx`
   - `src/features/chat/builtin-palette.tsx`
   - `src/hooks/use-mcp-enabled-tags.ts` (so you can confirm `toggleTag` has empty deps and is stable across renders — the whole point of edit 1c depends on this)
3. Confirm `useMcpEnabledTags` returns `toggleTag` with `useCallback(..., [])` — i.e. stable. If a future refactor breaks that, this whole change degrades to a no-op (memo will still re-render). It currently is stable.

---

### Step 1 — Edit `src/features/chat/mcp-palette.tsx`

Four distinct edits in this file.

#### 1a — Extend the React imports

Find the existing first line:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
```

Replace with:

```ts
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
```

#### 1b — Pass `toggleTag` directly to the child instead of recreating a thunk

Find the existing block inside `McpPalette`'s render where the tag groups are listed:

```tsx
            {visibleGroups.map(({ tag, items: groupItems }) => (
              <PaletteTagGroup
                key={tag}
                tag={tag}
                items={groupItems}
                enabled={isTagEnabled(tag)}
                onToggle={() => toggleTag(tag)}
                itemState={itemState}
                onReadResource={onReadResource}
              />
            ))}
```

Replace with:

```tsx
            {visibleGroups.map(({ tag, items: groupItems }) => (
              <PaletteTagGroup
                key={tag}
                tag={tag}
                items={groupItems}
                enabled={isTagEnabled(tag)}
                onToggle={toggleTag}
                itemState={itemState}
                onReadResource={onReadResource}
              />
            ))}
```

The only line changed is `onToggle={() => toggleTag(tag)}` → `onToggle={toggleTag}`. `toggleTag` is referentially stable (empty deps in `useMcpEnabledTags`), so memoised children no longer see a new function each render.

#### 1c — Convert `PaletteTagGroup` to a memoised component, widen `onToggle` signature, and add `useCallback`s

Find the existing function declaration plus body:

```tsx
function PaletteTagGroup({
  tag,
  items,
  enabled,
  onToggle,
  itemState,
  onReadResource,
}: {
  readonly tag: string;
  readonly items: readonly PaletteItem[];
  readonly enabled: boolean;
  readonly onToggle: () => void;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
  const [open, setOpen] = useState(true);
  const isUntagged = tag === UNTAGGED_TAG;
  const label = isUntagged ? "untagged" : `#${tag}`;

  // Inside each tag group, items further bucket by kind. Empty kinds drop
  // out so a tag covering only tools doesn't render bare Prompts /
  // Resources headers.
  const byKind = useMemo(() => {
    const map: Record<Kind, PaletteItem[]> = {
      tool: [],
      prompt: [],
      resource: [],
    };
    for (const item of items) map[item.kind].push(item);
    return map;
  }, [items]);

  return (
    <section className="mcp-palette-group">
      <header className="mcp-palette-group-head">
        <button
          type="button"
          className="mcp-palette-group-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse tag" : "Expand tag"}
        >
          <span
            className="mcp-palette-group-chev"
            data-open={open || undefined}
          >
            ▸
          </span>
        </button>
        <button
          type="button"
          className="mcp-palette-tag-pill"
          data-active={enabled || undefined}
          data-untagged={isUntagged || undefined}
          onClick={onToggle}
          aria-pressed={enabled}
          title={enabled ? `Disable ${label}` : `Enable ${label}`}
        >
          {label}
        </button>
        <span className="mcp-palette-group-meta">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <span
          className="mcp-palette-group-marker"
          data-state={enabled ? "on" : "off"}
        >
          {enabled ? "on" : "off"}
        </span>
        <Switch
          checked={enabled}
          onChange={onToggle}
          ariaLabel={`Toggle ${label}`}
        />
      </header>
      {open ? (
        <div className="mcp-palette-rows">
          {(["tool", "prompt", "resource"] as const).map((kind) => {
            const rows = byKind[kind];
            if (rows.length === 0) return null;
            return (
              <div key={kind} className="mcp-palette-kind">
                <div className="mcp-palette-kind-head" data-kind={kind}>
                  <span
                    className="mcp-palette-kind-dot"
                    aria-hidden
                  />
                  <span className="mcp-palette-kind-label">
                    {kindLabel(kind)}
                  </span>
                  <span className="mcp-palette-kind-count">
                    · {rows.length}
                  </span>
                </div>
                <ul className="mcp-palette-row-list" role="list">
                  {rows.map((row, idx) => (
                    <PaletteRowView
                      key={`${tag}::${row.id}::${idx}`}
                      row={row}
                      enabled={enabled}
                      itemState={itemState}
                      onReadResource={onReadResource}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
```

Replace with:

```tsx
const PaletteTagGroup = memo(function PaletteTagGroup({
  tag,
  items,
  enabled,
  onToggle,
  itemState,
  onReadResource,
}: {
  readonly tag: string;
  readonly items: readonly PaletteItem[];
  readonly enabled: boolean;
  readonly onToggle: (tag: string) => void;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
  const [open, setOpen] = useState(true);
  const isUntagged = tag === UNTAGGED_TAG;
  const label = isUntagged ? "untagged" : `#${tag}`;

  // Inside each tag group, items further bucket by kind. Empty kinds drop
  // out so a tag covering only tools doesn't render bare Prompts /
  // Resources headers.
  const byKind = useMemo(() => {
    const map: Record<Kind, PaletteItem[]> = {
      tool: [],
      prompt: [],
      resource: [],
    };
    for (const item of items) map[item.kind].push(item);
    return map;
  }, [items]);

  const handleToggle = useCallback(() => onToggle(tag), [onToggle, tag]);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

  return (
    <section className="mcp-palette-group">
      <header className="mcp-palette-group-head">
        <button
          type="button"
          className="mcp-palette-group-toggle"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={open ? "Collapse tag" : "Expand tag"}
        >
          <span
            className="mcp-palette-group-chev"
            data-open={open || undefined}
          >
            ▸
          </span>
        </button>
        <button
          type="button"
          className="mcp-palette-tag-pill"
          data-active={enabled || undefined}
          data-untagged={isUntagged || undefined}
          onClick={handleToggle}
          aria-pressed={enabled}
          title={enabled ? `Disable ${label}` : `Enable ${label}`}
        >
          {label}
        </button>
        <span className="mcp-palette-group-meta">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <span
          className="mcp-palette-group-marker"
          data-state={enabled ? "on" : "off"}
        >
          {enabled ? "on" : "off"}
        </span>
        <Switch
          checked={enabled}
          onChange={handleToggle}
          ariaLabel={`Toggle ${label}`}
        />
      </header>
      {open ? (
        <div className="mcp-palette-rows">
          {(["tool", "prompt", "resource"] as const).map((kind) => {
            const rows = byKind[kind];
            if (rows.length === 0) return null;
            return (
              <div key={kind} className="mcp-palette-kind">
                <div className="mcp-palette-kind-head" data-kind={kind}>
                  <span
                    className="mcp-palette-kind-dot"
                    aria-hidden
                  />
                  <span className="mcp-palette-kind-label">
                    {kindLabel(kind)}
                  </span>
                  <span className="mcp-palette-kind-count">
                    · {rows.length}
                  </span>
                </div>
                <ul className="mcp-palette-row-list" role="list">
                  {rows.map((row, idx) => (
                    <PaletteRowView
                      key={`${tag}::${row.id}::${idx}`}
                      row={row}
                      enabled={enabled}
                      itemState={itemState}
                      onReadResource={onReadResource}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
});
```

Notes on the diff:

- `function PaletteTagGroup(...) { ... }` becomes `const PaletteTagGroup = memo(function PaletteTagGroup(...) { ... });` — closing `}` on the original is replaced by `});`.
- `onToggle: () => void` becomes `onToggle: (tag: string) => void`. The widened signature lets the parent pass a single stable `toggleTag` for every group.
- Two new `useCallback`s are added just before the `return`:
  - `handleToggle` — used by the tag pill `onClick` and the `Switch`'s `onChange`. The Switch's prop type is `(next: boolean) => void`; a `() => void` is assignable in TypeScript (fewer-args contravariance), and the Switch itself ignores the boolean it would have passed because `toggleTag` flips state internally.
  - `toggleOpen` — used by the chevron button.
- The two `onClick` sites that previously inlined arrow functions (`onClick={onToggle}` for the pill, `onClick={() => setOpen((v) => !v)}` for the chevron) now reference `handleToggle` and `toggleOpen` respectively.

#### 1d — Convert `PaletteRowView` to a memoised component

Find the existing function declaration:

```tsx
function PaletteRowView({
  row,
  enabled,
  itemState,
  onReadResource,
}: {
  readonly row: PaletteItem;
  readonly enabled: boolean;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
```

Replace with:

```tsx
const PaletteRowView = memo(function PaletteRowView({
  row,
  enabled,
  itemState,
  onReadResource,
}: {
  readonly row: PaletteItem;
  readonly enabled: boolean;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
```

Then find the closing of `PaletteRowView` (the `</li>` followed by the function's terminator, just before `function Switch({`):

```tsx
        ) : (
          <span className="mcp-palette-row-kind">{row.kind}</span>
        )}
      </div>
    </li>
  );
}

function Switch({
```

Replace with:

```tsx
        ) : (
          <span className="mcp-palette-row-kind">{row.kind}</span>
        )}
      </div>
    </li>
  );
});

function Switch({
```

(Only the `}` immediately after `);` becomes `});` — closing the `memo(...)` wrapper.)

---

### Step 2 — Edit `src/features/chat/builtin-palette.tsx`

Two distinct edits.

#### 2a — Extend the React imports

Find the existing first line:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
```

Replace with:

```ts
import { memo, useEffect, useMemo, useRef, useState } from "react";
```

#### 2b — Convert `BuiltinRow` to a memoised component

Find the existing function declaration plus full body at the bottom of the file:

```tsx
function BuiltinRow({
  tool,
  enabled,
}: {
  readonly tool: BuiltinToolDef;
  readonly enabled: boolean;
}) {
  return (
    <li className="mcp-palette-row-li">
      <div
        className="mcp-palette-row"
        data-kind="tool"
        data-enabled={enabled || undefined}
        title={tool.description}
      >
        <span className="mcp-palette-row-dot" aria-hidden />
        <code className="mcp-palette-row-name">{tool.label}</code>
        <span className="mcp-palette-row-desc">{tool.description}</span>
        <span className="mcp-palette-row-server">helix-core</span>
        <span className="mcp-palette-row-kind">tool</span>
      </div>
    </li>
  );
}
```

Replace with:

```tsx
const BuiltinRow = memo(function BuiltinRow({
  tool,
  enabled,
}: {
  readonly tool: BuiltinToolDef;
  readonly enabled: boolean;
}) {
  return (
    <li className="mcp-palette-row-li">
      <div
        className="mcp-palette-row"
        data-kind="tool"
        data-enabled={enabled || undefined}
        title={tool.description}
      >
        <span className="mcp-palette-row-dot" aria-hidden />
        <code className="mcp-palette-row-name">{tool.label}</code>
        <span className="mcp-palette-row-desc">{tool.description}</span>
        <span className="mcp-palette-row-server">helix-core</span>
        <span className="mcp-palette-row-kind">tool</span>
      </div>
    </li>
  );
});
```

The only changes are the first line (`function BuiltinRow(` → `const BuiltinRow = memo(function BuiltinRow(`) and the closing `}` → `});`.

`BuiltinRow`'s props are `tool` (referentially stable — same object across renders, sourced from the memoised `groupByGroup` result) and `enabled` (a boolean primitive). Both compare cleanly under React's default shallow `Object.is` check, so `memo` is sufficient — no custom comparator needed.

---

### Step 3 — Verify

Run, in order:

```bash
pnpm typecheck
pnpm build
```

Both must complete with **no errors**. Expected output for `typecheck`: a single line `> tsc --noEmit` and nothing else (no diagnostics). The build emits the usual chunked output ending with `✓ built in <time>`.

There is no test suite — manual verification in the dev server is the next step.

---

## Manual smoke test (post-merge)

1. `pnpm tauri:dev` (or `pnpm dev` for browser-only testing).
2. Open the chat composer.
3. Click the **MCP toolbox** button to open the MCP popover. Search, filter, and toggle a few tags.
   - Expected: behaviour identical to before the refactor — searching, filtering, and toggling all still work, the cost footer updates, and the iOS-switch / pill on each group reflect enabled state correctly.
   - Optional perf check: open React DevTools' Profiler, record a session of typing in the search box. Tag groups whose visible items did not change should now show as "Did not render" under the profiled commit. Before this change every group rendered on every keystroke.
4. Click the **Helix Core** button to open the built-in tools popover. Toggle a few group switches.
   - Expected: identical behaviour. The `BuiltinRow` memoisation only takes effect on parent-driven re-renders that don't change the row's `tool` or `enabled` — typically when a sibling group flips. The Profiler should show only the affected group's rows actually rendering.
5. Sanity-check the disclosure chevrons in the MCP popover: expand/collapse a tag group, verify the chevron rotates and the rows show/hide as before. (This exercises the `toggleOpen` `useCallback` introduced in 1c.)

---

## Behavioural notes for future reviewers

- **Why the `onToggle` signature widened.** The old signature (`() => void`) forced the parent to bind `tag` at the call site (`() => toggleTag(tag)`), creating a fresh function each render and defeating any memo on the child. Pushing the binding into the child via `useCallback(() => onToggle(tag), [onToggle, tag])` keeps the memo equality intact: as long as `onToggle` (now `toggleTag` from the hook) and `tag` are stable, `handleToggle` is stable.
- **Why `Switch.onChange` works with a `() => void` handler.** The Switch's `onChange` is typed `(next: boolean) => void`, but TypeScript permits assigning a function that ignores arguments to that position (parameter contravariance). The Switch internally computes `!checked` and calls `onChange(!checked)`; the handler ignores that boolean and calls `toggleTag(tag)` instead, which is the desired behaviour because `toggleTag` flips internal state regardless of what the caller "thinks" the new value should be.
- **Why `itemState` is still passed through every row.** When a resource is read, `itemState` gets a new identity and every `PaletteRowView` will re-render — that's expected. The memoisation pays off in the more common case: parent re-renders driven by unrelated state (search input keystrokes, filter chip clicks) where `itemState` identity is preserved by `useState`. Splitting `itemState` per-row to avoid the cascade is an option for a later pass, but it complicates the parent's update path and the current cascade is rare.
- **Why `BuiltinGroup` was not memoised.** Its `isEnabled` and `onToggle` props originate in the composer (`features/chat/composer/index.tsx`) and are not currently stabilised there. A drive-by `useCallback` in the composer would touch a hot path with broader implications; the audit identified this as out-of-scope for a targeted memo pass. Worth revisiting if profiling shows the Helix Core popover is a hotspot — usually it isn't, since groups are small (3–5 entries).
- **Inline handlers in settings panes.** The audit also flagged inline `() => setActiveId(id)` etc. in `settings.tsx`, `mcp-pane.tsx`, and `mcp-form.tsx`. They are intentionally untouched. Adding `useCallback` around handlers passed to non-memoised components is a no-op for performance and adds ceremony. Memoising those buttons would be cargo-culting — they re-render with their parent regardless.
