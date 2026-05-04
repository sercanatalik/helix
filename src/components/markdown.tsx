import {
  Children,
  isValidElement,
  memo,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type TableHTMLAttributes,
} from "react";
import { Streamdown, type Components } from "streamdown";
import { STREAMDOWN_PLUGINS } from "../lib/markdown/plugins";
import { normalizeLatexDelimiters } from "../lib/markdown/normalize-latex";
import { normalizeCodePrefixes } from "../lib/markdown/normalize-code-prefixes";

interface MarkdownProps {
  readonly content: string;
  readonly streaming?: boolean;
  readonly className?: string;
}

function MarkdownImpl({ content, streaming = false, className }: MarkdownProps) {
  const normalized = useMemo(
    () => normalizeCodePrefixes(normalizeLatexDelimiters(content)),
    [content],
  );
  return (
    <Streamdown
      className={className ?? "streamdown-content"}
      parseIncompleteMarkdown={streaming}
      mode={streaming ? "streaming" : "static"}
      plugins={STREAMDOWN_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {normalized}
    </Streamdown>
  );
}

// Streamed transcripts patch the active assistant message every token —
// memoizing here means every other message in the transcript skips both
// the normalization pass and the Streamdown render entirely.
export const Markdown = memo(MarkdownImpl);

/* ----- Table card renderer ------------------------------------------------
 * Wraps every markdown table in a card that adds a caption row (row count)
 * above the data, and tags numeric columns so CSS can right-align and
 * tabular-num them. We sample the first few `tbody` rows per column and
 * call the column numeric when ≥70% of the sampled cells parse as a
 * number — same heuristic Claude Code uses for chat tables.
 *
 * Detection happens at render time on the React tree, not against the
 * mounted DOM, so streaming patches don't flicker the alignment as new
 * cells arrive. The caption row appears once the table has at least one
 * data row (during streaming) so partial tables still get the affordance.
 */
const MARKDOWN_COMPONENTS: Components = {
  table: TableCard,
};

function TableCard(
  props: TableHTMLAttributes<HTMLTableElement> & { readonly node?: unknown },
) {
  // `node` is the upstream hast node — used for streaming patches but
  // not something we want to spread onto the rendered <table>.
  const { children, node: _node, ...rest } = props;
  const { rowCount, numericColumns } = useMemo(
    () => analyseTable(children),
    [children],
  );
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    idRef.current = `helix-tbl-${Math.random().toString(36).slice(2, 8)}`;
  }

  return (
    <div className="helix-table-card">
      <div className="helix-table-caption">
        <span className="helix-table-caption-rows">
          {rowCount === 0
            ? "—"
            : `${rowCount.toLocaleString()} ${
                rowCount === 1 ? "row" : "rows"
              }`}
        </span>
      </div>
      <table {...rest} data-numeric-cols={numericColumns.join(" ")}>
        {children}
      </table>
    </div>
  );
}

interface TableAnalysis {
  readonly rowCount: number;
  readonly numericColumns: readonly number[];
}

const NUMERIC_RE = /^[$€£¥]?-?[\d,]*\.?\d+(%|[a-z]{0,3})?$/i;
const SAMPLE_LIMIT = 10;

function analyseTable(children: ReactNode): TableAnalysis {
  const rows: ReactNode[] = [];
  let inTbody = false;
  Children.forEach(children, (section) => {
    if (!isValidElement(section)) return;
    const sectionType = (section as ReactElement<{ children?: ReactNode }>).type;
    const isTbody =
      typeof sectionType === "string" && sectionType.toLowerCase() === "tbody";
    if (!isTbody) return;
    inTbody = true;
    const sectionChildren = (section.props as { children?: ReactNode })
      .children;
    Children.forEach(sectionChildren, (row) => {
      if (isValidElement(row)) rows.push(row);
    });
  });
  if (!inTbody) {
    Children.forEach(children, (row) => {
      if (isValidElement(row)) rows.push(row);
    });
  }
  const sampled = rows.slice(0, SAMPLE_LIMIT);
  const colCounts = new Map<number, { numeric: number; total: number }>();
  for (const row of sampled) {
    if (!isValidElement(row)) continue;
    const cells = (row.props as { children?: ReactNode }).children;
    let col = 0;
    Children.forEach(cells, (cell) => {
      if (!isValidElement(cell)) return;
      const text = collectText(
        (cell.props as { children?: ReactNode }).children,
      ).trim();
      const c = colCounts.get(col) ?? { numeric: 0, total: 0 };
      c.total += 1;
      if (text && NUMERIC_RE.test(text)) c.numeric += 1;
      colCounts.set(col, c);
      col++;
    });
  }
  const numericColumns: number[] = [];
  for (const [col, { numeric, total }] of colCounts) {
    if (total >= 2 && numeric / total >= 0.7) numericColumns.push(col);
  }
  numericColumns.sort((a, b) => a - b);
  return { rowCount: rows.length, numericColumns };
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return "";
}
