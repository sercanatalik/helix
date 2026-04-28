import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { STREAMDOWN_PLUGINS } from "../lib/markdown/plugins";
import { normalizeLatexDelimiters } from "../lib/markdown/normalize-latex";

interface MarkdownProps {
  readonly content: string;
  readonly streaming?: boolean;
  readonly className?: string;
}

export function Markdown({ content, streaming = false, className }: MarkdownProps) {
  const normalized = useMemo(() => normalizeLatexDelimiters(content), [content]);
  return (
    <Streamdown
      className={className ?? "streamdown-content"}
      parseIncompleteMarkdown={streaming}
      mode={streaming ? "streaming" : "static"}
      plugins={STREAMDOWN_PLUGINS}
    >
      {normalized}
    </Streamdown>
  );
}
