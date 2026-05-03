import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { STREAMDOWN_PLUGINS } from "../lib/markdown/plugins";
import { normalizeLatexDelimiters } from "../lib/markdown/normalize-latex";
import { normalizeCodePrefixes } from "../lib/markdown/normalize-code-prefixes";

interface MarkdownProps {
  readonly content: string;
  readonly streaming?: boolean;
  readonly className?: string;
}

export function Markdown({ content, streaming = false, className }: MarkdownProps) {
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
    >
      {normalized}
    </Streamdown>
  );
}
