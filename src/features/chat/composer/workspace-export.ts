import type { TranscriptMessage } from "../../../app/types";

/** Write the most recent assistant message to the workspace as a markdown
 * file. Surfaces success / failure / no-op states through the supplied
 * `setNotice` callback so the composer can show a transient inline status.
 * The file body is the assistant's content verbatim — already markdown, so
 * tables / code fences / vega-lite blocks survive the round-trip — preceded
 * by a single-line header (title + timestamp). */
export async function writeLatestAssistantToWorkspace(
  messages: readonly TranscriptMessage[] | undefined,
  workspacePath: string | undefined,
  setNotice: (text: string | undefined) => void,
): Promise<void> {
  if (!workspacePath) {
    setNotice("/write-to-workspace: attach a workspace folder first.");
    return;
  }
  const list = messages ?? [];
  let last: TranscriptMessage | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === "assistant" && m.content.trim().length > 0) {
      last = m;
      break;
    }
  }
  if (!last) {
    setNotice("/write-to-workspace: no assistant response to save yet.");
    return;
  }

  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const fileName = `chat-export-${stamp}.md`;
  const sep = /[\\/]$/.test(workspacePath) ? "" : "/";
  const path = `${workspacePath}${sep}${fileName}`;
  const header = `# Chat export — ${ts.toLocaleString()}\n\n`;
  const content = `${header}${last.content}\n`;

  try {
    const result = await window.helixApi.writeFile(path, content);
    setNotice(`Saved to ${result.path}`);
  } catch (err) {
    setNotice(
      `/write-to-workspace failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
