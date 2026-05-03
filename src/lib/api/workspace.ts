import { invoke } from "@tauri-apps/api/core";
import type { NoteRecord } from "../../app/types";

// Workspace-folder filesystem operations: reveal/delete/rename/create.
// All of these refuse paths outside the workspace as a guardrail.

export const workspaceApi = {
  /** Reveal a file in the OS file manager (Finder on macOS, Explorer on
   * Windows). Linux falls back to opening the parent directory because no
   * widely-supported "select file" flag exists across desktop environments. */
  revealInFolder: (path: string): Promise<void> =>
    invoke<void>("reveal_in_folder", { path }),

  /** Permanently delete a file under the active workspace. Refuses paths
   * outside the workspace folder. No trash bin — the unlink is direct. */
  deleteWorkspaceFile: (
    workspacePath: string,
    path: string,
  ): Promise<void> =>
    invoke<void>("delete_workspace_file", { workspacePath, path }),

  /** Create a new `untitled-N.md` file inside `parentDir` (which must lie
   * inside the workspace folder) and return its record. Used by the
   * right-click context menu's "New markdown file" action. */
  createMarkdownFile: (
    workspaceId: string,
    workspacePath: string,
    parentDir: string,
  ): Promise<NoteRecord> =>
    invoke<NoteRecord>("create_markdown_file", {
      workspaceId,
      workspacePath,
      parentDir,
    }),

  /** Delete any path under the workspace — file or folder (recursive).
   * Refuses to delete the workspace root itself. Use this for the
   * right-click "Delete folder" action; `deleteWorkspaceFile` stays for
   * the file-only call site that needs to reject directories. */
  deleteWorkspacePath: (
    workspacePath: string,
    path: string,
  ): Promise<void> =>
    invoke<void>("delete_workspace_path", { workspacePath, path }),

  /** Rename a file or folder in place. `newName` is just the leaf name —
   * the backend joins it with the existing parent. Returns the new
   * absolute path. Refuses path separators and `..` in the name. */
  renameWorkspacePath: (
    workspacePath: string,
    oldPath: string,
    newName: string,
  ): Promise<string> =>
    invoke<string>("rename_workspace_path", {
      workspacePath,
      oldPath,
      newName,
    }),

  /** Create a new file or folder under the workspace with a user-supplied
   * name. Returns the new absolute path. `.md` files are seeded with a
   * `# <stem>\n\n` heading; other files are created empty. Folders are
   * non-recursive — the parent must already exist. */
  createWorkspaceEntry: (
    workspacePath: string,
    parentDir: string,
    name: string,
    kind: "file" | "folder",
  ): Promise<string> =>
    invoke<string>("create_workspace_entry", {
      workspacePath,
      parentDir,
      name,
      kind,
    }),
};
