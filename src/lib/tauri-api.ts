import type { McpServerConfig } from "../app/types";
import { coreApi } from "./api/core";
import { mcpApi } from "./api/mcp";
import { skillsApi } from "./api/skills";
import { builtinToolsApi } from "./api/builtin-tools";
import { notesApi } from "./api/notes";
import { workspaceApi } from "./api/workspace";

// Aggregate the per-domain api objects into the single `helixApi` surface
// the renderer installs on `window`. Splitting the methods into
// `lib/api/<domain>.ts` keeps each file under a few hundred lines and
// makes the contract per Tauri command group explicit. Callers can keep
// importing `helixApi` from this module — or pull in the specific domain
// object directly when they only touch one slice.

export const helixApi = {
  ...coreApi,
  ...mcpApi,
  ...skillsApi,
  ...builtinToolsApi,
  ...notesApi,
  ...workspaceApi,
};

export type HelixApi = typeof helixApi;

export type { TreeEntry } from "./api/core";
export type {
  AggSpec,
  AnalyseOp,
  AnalyseResult,
  DataColumnInfo,
  DataPreviewRow,
  EditFileOptions,
  EditFileResult,
  GlobMatch,
  GrepArgs,
  GrepContentMatch,
  GrepCountMatch,
  GrepFileMatch,
  GrepLineHit,
  GrepMode,
  GrepResult,
  ReadExcelOptions,
  ReadExcelResult,
  ReadFileKind,
  ReadFileOptions,
  ReadFileResult,
  ReadPdfResult,
  SearchContentFile,
  SearchContentLine,
  SearchCountMatch,
  SearchFilesArgs,
  SearchFilesResult,
  WriteFileResult,
} from "./api/builtin-tools";
export type { WriteNoteResult } from "./api/notes";

// Re-export the McpServerConfig type for callers that import the API module
// — saves a second import of `../app/types` for UI components that operate
// on a server record returned by these methods.
export type { McpServerConfig };
