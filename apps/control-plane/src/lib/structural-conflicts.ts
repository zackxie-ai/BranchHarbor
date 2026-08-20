import path from "node:path";

import type {
  ChangedFile,
  WorkspaceStructuralConflict,
} from "./types";

export interface FileImportRelationship {
  importerPath: string;
  importedPath: string;
}

function allChangedPaths(files: ChangedFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => [file.path, file.previousPath].filter(Boolean) as string[]),
    ),
  ].sort();
}

function isRename(file: ChangedFile): boolean {
  return /^[RC]/.test(file.status) && Boolean(file.previousPath);
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

function meaningfulDirectory(filePath: string): string | null {
  const directory = path.posix.dirname(filePath);
  if (directory === "." || directory.split("/").length < 2) return null;
  return directory;
}

function semanticKey(filePath: string): string | null {
  const parsed = path.posix.parse(filePath.toLowerCase());
  let name = parsed.name;
  if (name === "index") name = path.posix.basename(parsed.dir);
  name = name.replace(
    /(?:[._-](?:test|spec|schema|types?|client|service|controller|model|repository|generated|migration))+$/,
    "",
  );
  const normalized = name.replace(/[^a-z0-9]+/g, "");
  return normalized.length >= 3 ? normalized : null;
}

function addConflict(
  conflicts: Map<string, WorkspaceStructuralConflict>,
  conflict: WorkspaceStructuralConflict,
): void {
  const key = `${conflict.kind}:${conflict.taskPath}:${conflict.mainPath}`;
  const previous = conflicts.get(key);
  if (!previous || (previous.severity === "warning" && conflict.severity === "danger")) {
    conflicts.set(key, conflict);
  }
}

function directoryMoveGroups(files: ChangedFile[]): Array<{
  sourceDirectory: string;
  targetDirectory: string;
  representativePath: string;
}> {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files.filter(isRename)) {
    const sourceDirectory = path.posix.dirname(file.previousPath!);
    const targetDirectory = path.posix.dirname(file.path);
    if (sourceDirectory === targetDirectory) continue;
    const key = `${sourceDirectory}\0${targetDirectory}`;
    const entries = groups.get(key) ?? [];
    entries.push(file);
    groups.set(key, entries);
  }
  return [...groups.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .map(([key, entries]) => {
      const [sourceDirectory, targetDirectory] = key.split("\0");
      return {
        sourceDirectory: sourceDirectory!,
        targetDirectory: targetDirectory!,
        representativePath: entries[0]!.path,
      };
    });
}

export function detectWorkspaceStructuralConflicts(input: {
  taskFiles: ChangedFile[];
  mainFiles: ChangedFile[];
  taskImports?: FileImportRelationship[];
  mainImports?: FileImportRelationship[];
}): WorkspaceStructuralConflict[] {
  const conflicts = new Map<string, WorkspaceStructuralConflict>();
  const taskPaths = allChangedPaths(input.taskFiles);
  const mainPaths = allChangedPaths(input.mainFiles);
  const taskPathSet = new Set(taskPaths);
  const mainPathSet = new Set(mainPaths);

  for (const rename of input.taskFiles.filter(isRename)) {
    for (const candidate of [rename.previousPath!, rename.path]) {
      if (!mainPathSet.has(candidate)) continue;
      addConflict(conflicts, {
        kind: "rename_collision",
        severity: "danger",
        taskPath: rename.path,
        mainPath: candidate,
        message: `The task renamed ${rename.previousPath} to ${rename.path}, while main also changed the related path ${candidate}`,
      });
    }
  }
  for (const rename of input.mainFiles.filter(isRename)) {
    for (const candidate of [rename.previousPath!, rename.path]) {
      if (!taskPathSet.has(candidate)) continue;
      addConflict(conflicts, {
        kind: "rename_collision",
        severity: "danger",
        taskPath: candidate,
        mainPath: rename.path,
        message: `main renamed ${rename.previousPath} to ${rename.path}, while the task still changed the related path ${candidate}`,
      });
    }
  }

  for (const move of directoryMoveGroups(input.taskFiles)) {
    for (const mainPath of mainPaths) {
      if (
        !isInsideDirectory(mainPath, move.sourceDirectory) &&
        !isInsideDirectory(mainPath, move.targetDirectory)
      ) continue;
      addConflict(conflicts, {
        kind: "directory_overlap",
        severity: "danger",
        taskPath: move.representativePath,
        mainPath,
        message: `The task is moving directory ${move.sourceDirectory} to ${move.targetDirectory}, while main also changed ${mainPath} within that directory scope`,
      });
    }
  }
  for (const move of directoryMoveGroups(input.mainFiles)) {
    for (const taskPath of taskPaths) {
      if (
        !isInsideDirectory(taskPath, move.sourceDirectory) &&
        !isInsideDirectory(taskPath, move.targetDirectory)
      ) continue;
      addConflict(conflicts, {
        kind: "directory_overlap",
        severity: "danger",
        taskPath,
        mainPath: move.representativePath,
        message: `main is moving directory ${move.sourceDirectory} to ${move.targetDirectory}, while the task also changed ${taskPath} within that directory scope`,
      });
    }
  }

  for (const taskPath of taskPaths) {
    for (const mainPath of mainPaths) {
      if (taskPath === mainPath) continue;
      const taskDirectory = meaningfulDirectory(taskPath);
      const mainDirectory = meaningfulDirectory(mainPath);
      if (taskDirectory && taskDirectory === mainDirectory) {
        addConflict(conflicts, {
          kind: "directory_overlap",
          severity: "warning",
          taskPath,
          mainPath,
          message: `The task and main changed different files in the same feature directory ${taskDirectory}; joint verification is required`,
        });
      }
      const taskKey = semanticKey(taskPath);
      if (taskKey && taskKey === semanticKey(mainPath)) {
        addConflict(conflicts, {
          kind: "semantic_pair",
          severity: "warning",
          taskPath,
          mainPath,
          message: `Task file ${taskPath} and main file ${mainPath} belong to the same semantic file group ${taskKey}`,
        });
      }
    }
  }

  for (const relationship of input.taskImports ?? []) {
    if (!mainPathSet.has(relationship.importedPath)) continue;
    addConflict(conflicts, {
      kind: "import_dependency",
      severity: "warning",
      taskPath: relationship.importerPath,
      mainPath: relationship.importedPath,
      message: `Task-changed ${relationship.importerPath} directly depends on main-changed ${relationship.importedPath}`,
    });
  }
  for (const relationship of input.mainImports ?? []) {
    if (!taskPathSet.has(relationship.importedPath)) continue;
    addConflict(conflicts, {
      kind: "import_dependency",
      severity: "warning",
      taskPath: relationship.importedPath,
      mainPath: relationship.importerPath,
      message: `Main-changed ${relationship.importerPath} directly depends on task-changed ${relationship.importedPath}`,
    });
  }

  return [...conflicts.values()].sort(
    (left, right) =>
      Number(right.severity === "danger") - Number(left.severity === "danger") ||
      left.kind.localeCompare(right.kind) ||
      left.taskPath.localeCompare(right.taskPath) ||
      left.mainPath.localeCompare(right.mainPath),
  );
}
