import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "./config";
import { AppError } from "./errors";
import { gitAuthenticationArguments } from "./gitea";
import {
  detectWorkspaceStructuralConflicts,
  type FileImportRelationship,
} from "./structural-conflicts";
import type { ChangedFile, TaskWorkspaceProgress, VerificationResult } from "./types";

const execFileAsync = promisify(execFile);
const repositoryFetches = new Map<string, Promise<void>>();

interface GitOutput {
  stdout: string;
  stderr: string;
}

export class GitCommandError extends AppError {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message, 409, "GIT_COMMAND_FAILED");
    this.name = "GitCommandError";
  }
}

async function execute(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> } = {},
): Promise<GitOutput> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const safeArguments = args.map((argument) =>
      argument.startsWith("http.extraHeader=Authorization:")
        ? "http.extraHeader=Authorization: <redacted>"
        : argument,
    );
    throw new GitCommandError(
      `${command} ${safeArguments.join(" ")} failed`,
      failed.stdout ?? "",
      failed.stderr ?? failed.message,
      typeof failed.code === "number" ? failed.code : 1,
    );
  }
}

export async function runGit(
  repositoryPath: string,
  args: string[],
  authenticated = false,
  options: { env?: Record<string, string | undefined>; timeout?: number } = {},
): Promise<GitOutput> {
  const finalArgs = authenticated ? [...gitAuthenticationArguments(), ...args] : args;
  return execute("git", finalArgs, { cwd: repositoryPath, ...options });
}

export interface TaskWorkspaceBackupResult {
  branchName: string;
  remoteHeadCommit: string;
  checkpointCommit: string | null;
  workingTreeClean: boolean;
  changedFiles: ChangedFile[];
}

function taskCheckpointRef(taskId: string): string {
  return `refs/cloudagent/checkpoints/${taskId}`;
}

async function remoteRefCommit(repositoryPath: string, ref: string): Promise<string | null> {
  const result = await runGit(repositoryPath, ["ls-remote", "--refs", "origin", ref], true);
  const [commit] = result.stdout.trim().split(/\s+/);
  return commit || null;
}

async function fetchRemoteBranch(repositoryPath: string, branch: string): Promise<void> {
  const previous = repositoryFetches.get(repositoryPath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => runGit(repositoryPath, ["fetch", "--prune", "origin", branch], true))
    .then(() => undefined);
  repositoryFetches.set(repositoryPath, current);
  try {
    await current;
  } finally {
    if (repositoryFetches.get(repositoryPath) === current) {
      repositoryFetches.delete(repositoryPath);
    }
  }
}

function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseNameStatus(output: string): ChangedFile[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [statusCode, ...fileParts] = line.split("\t");
      const renameOrCopy = /^[RC]/.test(statusCode ?? "") && fileParts.length >= 2;
      return {
        status: statusCode ?? "M",
        path: decodeGitPath(fileParts.at(-1) ?? ""),
        ...(renameOrCopy
          ? { previousPath: decodeGitPath(fileParts[0] ?? "") }
          : {}),
      };
    })
    .filter((file) => file.path.length > 0);
}

function parseWorktreeStatus(output: string): ChangedFile[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "M";
      const rawPath = line.slice(3);
      const renameParts = rawPath.includes(" -> ") ? rawPath.split(" -> ") : null;
      return {
        status,
        path: decodeGitPath(renameParts?.at(-1) ?? rawPath),
        ...(renameParts ? { previousPath: decodeGitPath(renameParts[0] ?? "") } : {}),
      };
    })
    .filter((file) => file.path.length > 0);
}

function uniquePaths(files: ChangedFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => [file.path, file.previousPath].filter(Boolean) as string[]),
    ),
  ].sort();
}

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

function sourceFile(filePath: string): boolean {
  return sourceExtensions.includes(path.posix.extname(filePath).toLowerCase());
}

function relativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveChangedImport(
  importerPath: string,
  specifier: string,
  targetPaths: Set<string>,
): string | null {
  const rawTarget = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier),
  );
  const extension = path.posix.extname(rawTarget);
  const withoutExtension = extension ? rawTarget.slice(0, -extension.length) : rawTarget;
  const candidates = new Set<string>([rawTarget, withoutExtension]);
  for (const sourceExtension of sourceExtensions) {
    candidates.add(`${withoutExtension}${sourceExtension}`);
    candidates.add(path.posix.join(withoutExtension, `index${sourceExtension}`));
  }
  for (const candidate of candidates) {
    if (targetPaths.has(candidate)) return candidate;
  }
  return null;
}

async function collectWorktreeImportRelationships(input: {
  worktreePath: string;
  importerFiles: ChangedFile[];
  targetPaths: string[];
}): Promise<FileImportRelationship[]> {
  const targetPaths = new Set(input.targetPaths);
  const relationships: FileImportRelationship[] = [];
  for (const file of input.importerFiles) {
    if (!sourceFile(file.path) || file.status.startsWith("D")) continue;
    const content = await readFile(path.join(input.worktreePath, file.path), "utf8").catch(
      () => null,
    );
    if (content === null) continue;
    for (const specifier of relativeImportSpecifiers(content)) {
      const importedPath = resolveChangedImport(file.path, specifier, targetPaths);
      if (importedPath) relationships.push({ importerPath: file.path, importedPath });
    }
  }
  return relationships;
}

async function collectGitImportRelationships(input: {
  repositoryPath: string;
  ref: string;
  importerFiles: ChangedFile[];
  targetPaths: string[];
}): Promise<FileImportRelationship[]> {
  const targetPaths = new Set(input.targetPaths);
  const relationships: FileImportRelationship[] = [];
  for (const file of input.importerFiles) {
    if (!sourceFile(file.path) || file.status.startsWith("D")) continue;
    const content = await runGit(input.repositoryPath, [
      "show",
      `${input.ref}:${file.path}`,
    ]).catch(() => null);
    if (!content) continue;
    for (const specifier of relativeImportSpecifiers(content.stdout)) {
      const importedPath = resolveChangedImport(file.path, specifier, targetPaths);
      if (importedPath) relationships.push({ importerPath: file.path, importedPath });
    }
  }
  return relationships;
}

export async function cloneRepository(repositoryUrl: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await execute("git", [
    ...gitAuthenticationArguments(),
    "clone",
    "--origin",
    "origin",
    repositoryUrl,
    destination,
  ]);
  await runGit(destination, ["config", "user.name", "CloudAgent Integration"]);
  await runGit(destination, ["config", "user.email", "integration@cloudagent.local"]);
}

export async function ensureRepositoryClone(input: {
  repositoryUrl: string;
  repositoryPath: string;
}): Promise<{ cloned: boolean }> {
  const healthy = await runGit(input.repositoryPath, ["rev-parse", "--git-dir"])
    .then(() => true)
    .catch(() => false);
  if (healthy) return { cloned: false };
  await rm(input.repositoryPath, { recursive: true, force: true });
  await cloneRepository(input.repositoryUrl, input.repositoryPath);
  return { cloned: true };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return slug || "task";
}

export async function createTaskWorktree(input: {
  repositoryPath: string;
  projectId: string;
  taskId: string;
  title: string;
  baseBranch: string;
}): Promise<{ baseCommit: string; branchName: string; worktreePath: string }> {
  await runGit(input.repositoryPath, ["fetch", "origin", "--prune"], true);
  const baseRef = `origin/${input.baseBranch}`;
  const { stdout } = await runGit(input.repositoryPath, ["rev-parse", baseRef]);
  const baseCommit = stdout.trim();
  const branchName = `task/${input.taskId.slice(0, 8)}-${slugify(input.title)}`;
  const worktreePath = path.join(
    config.runtimeRoot,
    "projects",
    input.projectId,
    "worktrees",
    input.taskId,
  );

  await runGit(input.repositoryPath, ["worktree", "remove", "--force", worktreePath]).catch(
    () => undefined,
  );
  await rm(worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["branch", "-D", branchName]).catch(() => undefined);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(input.repositoryPath, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
  await runGit(worktreePath, ["config", "user.name", "CloudAgent Member"]);
  await runGit(worktreePath, ["config", "user.email", "member@cloudagent.local"]);
  await runGit(
    worktreePath,
    ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branchName}`],
    true,
  );

  return { baseCommit, branchName, worktreePath };
}

export async function syncTaskWorkspaceBackup(input: {
  worktreePath: string;
  taskId: string;
  branchName: string;
}): Promise<TaskWorkspaceBackupResult> {
  const currentBranch = (
    await runGit(input.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).stdout.trim();
  if (currentBranch !== input.branchName) {
    throw new AppError(
      `Task worktree is on ${currentBranch}, expected ${input.branchName}`,
      409,
      "TASK_BRANCH_MISMATCH",
    );
  }

  const [head, status] = await Promise.all([
    runGit(input.worktreePath, ["rev-parse", "HEAD"]),
    runGit(input.worktreePath, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  ]);
  const headCommit = head.stdout.trim();
  const changedFiles = parseWorktreeStatus(status.stdout);
  await runGit(
    input.worktreePath,
    ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${input.branchName}`],
    true,
  );
  const remoteHeadCommit = await remoteRefCommit(
    input.worktreePath,
    `refs/heads/${input.branchName}`,
  );
  if (remoteHeadCommit !== headCommit) {
    throw new AppError(
      "Remote task branch does not match the local task HEAD",
      409,
      "TASK_BRANCH_SYNC_MISMATCH",
    );
  }

  const checkpointRef = taskCheckpointRef(input.taskId);
  if (changedFiles.length === 0) {
    if (await remoteRefCommit(input.worktreePath, checkpointRef)) {
      await runGit(input.worktreePath, ["push", "origin", `:${checkpointRef}`], true);
    }
    return {
      branchName: input.branchName,
      remoteHeadCommit,
      checkpointCommit: null,
      workingTreeClean: true,
      changedFiles,
    };
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cloudagent-checkpoint-"));
  const environment = { GIT_INDEX_FILE: path.join(temporaryDirectory, "index") };
  try {
    await runGit(input.worktreePath, ["read-tree", "HEAD"], false, { env: environment });
    await runGit(input.worktreePath, ["add", "-A"], false, { env: environment });
    const treeCommit = (
      await runGit(input.worktreePath, ["write-tree"], false, { env: environment })
    ).stdout.trim();
    const existingCheckpoint = await remoteRefCommit(input.worktreePath, checkpointRef);
    if (existingCheckpoint) {
      await runGit(
        input.worktreePath,
        ["fetch", "origin", `+${checkpointRef}:${checkpointRef}`],
        true,
      );
      const [existingParent, existingTree] = await Promise.all([
        runGit(input.worktreePath, ["rev-parse", `${checkpointRef}^`]),
        runGit(input.worktreePath, ["rev-parse", `${checkpointRef}^{tree}`]),
      ]);
      if (
        existingParent.stdout.trim() === headCommit &&
        existingTree.stdout.trim() === treeCommit
      ) {
        return {
          branchName: input.branchName,
          remoteHeadCommit,
          checkpointCommit: existingCheckpoint,
          workingTreeClean: false,
          changedFiles,
        };
      }
    }
    const checkpointCommit = (
      await runGit(
        input.worktreePath,
        [
          "commit-tree",
          treeCommit,
          "-p",
          headCommit,
          "-m",
          `CloudAgent WIP checkpoint for task ${input.taskId}`,
        ],
        false,
        { env: environment },
      )
    ).stdout.trim();
    await runGit(
      input.worktreePath,
      ["push", "--force", "origin", `${checkpointCommit}:${checkpointRef}`],
      true,
    );
    const remoteCheckpoint = await remoteRefCommit(input.worktreePath, checkpointRef);
    if (remoteCheckpoint !== checkpointCommit) {
      throw new AppError(
        "Remote WIP checkpoint does not match the generated checkpoint",
        409,
        "TASK_CHECKPOINT_SYNC_MISMATCH",
      );
    }
    return {
      branchName: input.branchName,
      remoteHeadCommit,
      checkpointCommit,
      workingTreeClean: false,
      changedFiles,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreTaskWorkspaceBackup(input: {
  repositoryPath: string;
  repositoryUrl: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
}): Promise<TaskWorkspaceBackupResult & { repositoryCloned: boolean; checkpointRestored: boolean }> {
  const repository = await ensureRepositoryClone({
    repositoryUrl: input.repositoryUrl,
    repositoryPath: input.repositoryPath,
  });
  const remoteBranchRef = `refs/heads/${input.branchName}`;
  const remoteHeadCommit = await remoteRefCommit(input.repositoryPath, remoteBranchRef);
  if (!remoteHeadCommit) {
    throw new AppError(
      "The remote task branch is missing and the workspace cannot be restored",
      409,
      "REMOTE_TASK_BRANCH_MISSING",
    );
  }
  await runGit(
    input.repositoryPath,
    ["fetch", "origin", `+${remoteBranchRef}:refs/remotes/origin/${input.branchName}`],
    true,
  );
  const checkpointRef = taskCheckpointRef(input.taskId);
  const checkpointCommit = await remoteRefCommit(input.repositoryPath, checkpointRef);
  if (checkpointCommit) {
    await runGit(
      input.repositoryPath,
      ["fetch", "origin", `+${checkpointRef}:${checkpointRef}`],
      true,
    );
    const checkpointParent = (
      await runGit(input.repositoryPath, ["rev-parse", `${checkpointRef}^`])
    ).stdout.trim();
    if (checkpointParent !== remoteHeadCommit) {
      throw new AppError(
        "The WIP checkpoint does not belong to the current remote task HEAD",
        409,
        "TASK_CHECKPOINT_PARENT_MISMATCH",
      );
    }
  }
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", input.worktreePath]).catch(
    () => undefined,
  );
  await rm(input.worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["worktree", "prune"]);
  await runGit(input.repositoryPath, ["branch", "-D", input.branchName]).catch(() => undefined);
  await mkdir(path.dirname(input.worktreePath), { recursive: true });
  await runGit(input.repositoryPath, [
    "worktree",
    "add",
    "-b",
    input.branchName,
    input.worktreePath,
    `origin/${input.branchName}`,
  ]);
  await runGit(input.worktreePath, ["branch", "--set-upstream-to", `origin/${input.branchName}`]);
  await runGit(input.worktreePath, ["config", "user.name", "CloudAgent Member"]);
  await runGit(input.worktreePath, ["config", "user.email", "member@cloudagent.local"]);

  if (checkpointCommit) {
    await runGit(input.worktreePath, ["read-tree", "--reset", "-u", checkpointRef]);
    await runGit(input.worktreePath, ["reset", "--mixed", "HEAD"]);
  }

  const status = await runGit(input.worktreePath, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const changedFiles = parseWorktreeStatus(status.stdout);
  return {
    branchName: input.branchName,
    remoteHeadCommit,
    checkpointCommit,
    workingTreeClean: changedFiles.length === 0,
    changedFiles,
    repositoryCloned: repository.cloned,
    checkpointRestored: checkpointCommit !== null,
  };
}

export async function removeTaskWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
}): Promise<void> {
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", input.worktreePath]).catch(
    () => undefined,
  );
  await rm(input.worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["worktree", "prune"]).catch(() => undefined);
}

export async function createProjectMergePlanWorktree(input: {
  repositoryPath: string;
  projectId: string;
  runId: string;
  baseBranch: string;
}): Promise<{ mainCommit: string; worktreePath: string }> {
  await runGit(input.repositoryPath, ["fetch", "origin", "--prune"], true);
  const baseRef = `origin/${input.baseBranch}`;
  const mainCommit = (await runGit(input.repositoryPath, ["rev-parse", baseRef])).stdout.trim();
  const worktreePath = path.join(
    config.runtimeRoot,
    "projects",
    input.projectId,
    "merge-plans",
    input.runId,
  );
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", worktreePath]).catch(
    () => undefined,
  );
  await rm(worktreePath, { recursive: true, force: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(input.repositoryPath, ["worktree", "add", "--detach", worktreePath, mainCommit]);
  return { mainCommit, worktreePath };
}

export async function removeProjectMergePlanWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
}): Promise<void> {
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", input.worktreePath]).catch(
    () => undefined,
  );
  await rm(input.worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["worktree", "prune"]).catch(() => undefined);
}

export async function createProjectValidationWorktree(input: {
  repositoryPath: string;
  projectId: string;
  runId: string;
  baseBranch: string;
}): Promise<{ mainCommit: string; worktreePath: string }> {
  await runGit(input.repositoryPath, ["fetch", "origin", "--prune"], true);
  const baseRef = `origin/${input.baseBranch}`;
  const mainCommit = (await runGit(input.repositoryPath, ["rev-parse", baseRef])).stdout.trim();
  const worktreePath = path.join(
    config.runtimeRoot,
    "projects",
    input.projectId,
    "validations",
    input.runId,
  );
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", worktreePath]).catch(
    () => undefined,
  );
  await rm(worktreePath, { recursive: true, force: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(input.repositoryPath, ["worktree", "add", "--detach", worktreePath, mainCommit]);
  return { mainCommit, worktreePath };
}

export async function removeProjectValidationWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
}): Promise<void> {
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", input.worktreePath]).catch(
    () => undefined,
  );
  await rm(input.worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["worktree", "prune"]).catch(() => undefined);
}

export async function inspectCommittedChanges(input: {
  worktreePath: string;
  baseCommit: string;
}): Promise<{
  headCommit: string;
  changedFiles: ChangedFile[];
  diffStat: string;
}> {
  const status = await runGit(input.worktreePath, ["status", "--porcelain"]);
  if (status.stdout.trim()) {
    throw new AppError(
      "The worktree has uncommitted changes. Commit them before submitting.",
      409,
      "WORKTREE_NOT_CLEAN",
    );
  }

  const head = await runGit(input.worktreePath, ["rev-parse", "HEAD"]);
  const headCommit = head.stdout.trim();
  if (headCommit === input.baseCommit) {
    throw new AppError(
      "The task has no committed changes to submit.",
      409,
      "NO_COMMITTED_CHANGES",
    );
  }

  const files = await runGit(input.worktreePath, [
    "diff",
    "--find-renames=50%",
    "--name-status",
    `${input.baseCommit}...${headCommit}`,
  ]);
  const changedFiles = parseNameStatus(files.stdout);
  const stat = await runGit(input.worktreePath, [
    "diff",
    "--stat",
    `${input.baseCommit}...${headCommit}`,
  ]);

  return { headCommit, changedFiles, diffStat: stat.stdout.trim() };
}

export async function inspectTaskWorkspaceProgress(input: {
  repositoryPath: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string;
}): Promise<TaskWorkspaceProgress> {
  await fetchRemoteBranch(input.repositoryPath, input.baseBranch);
  const mainRef = `origin/${input.baseBranch}`;
  const [head, main, committed, uncommitted, mainChanges, mainCommitCount] = await Promise.all([
    runGit(input.worktreePath, ["rev-parse", "HEAD"]),
    runGit(input.worktreePath, ["rev-parse", mainRef]),
    runGit(input.worktreePath, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--find-renames=50%",
      "--name-status",
      `${input.baseCommit}...HEAD`,
    ]),
    runGit(input.worktreePath, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    runGit(input.worktreePath, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--find-renames=50%",
      "--name-status",
      `${input.baseCommit}..${mainRef}`,
    ]),
    runGit(input.worktreePath, ["rev-list", "--count", `${input.baseCommit}..${mainRef}`]),
  ]);
  const committedFiles = parseNameStatus(committed.stdout);
  const uncommittedFiles = parseWorktreeStatus(uncommitted.stdout);
  const mainChangedFiles = parseNameStatus(mainChanges.stdout);
  const actualChangedFiles = uniquePaths([...committedFiles, ...uncommittedFiles]);
  const mainChangedPaths = new Set(uniquePaths(mainChangedFiles));
  const overlappingFiles = actualChangedFiles.filter((filePath) => mainChangedPaths.has(filePath));
  const [taskImports, mainImports] = await Promise.all([
    collectWorktreeImportRelationships({
      worktreePath: input.worktreePath,
      importerFiles: [...committedFiles, ...uncommittedFiles],
      targetPaths: uniquePaths(mainChangedFiles),
    }),
    collectGitImportRelationships({
      repositoryPath: input.worktreePath,
      ref: mainRef,
      importerFiles: mainChangedFiles,
      targetPaths: actualChangedFiles,
    }),
  ]);
  const structuralConflicts = detectWorkspaceStructuralConflicts({
    taskFiles: [...committedFiles, ...uncommittedFiles],
    mainFiles: mainChangedFiles,
    taskImports,
    mainImports,
  });
  const mainCommit = main.stdout.trim();

  return {
    baseCommit: input.baseCommit,
    headCommit: head.stdout.trim(),
    mainCommit,
    committedFiles,
    uncommittedFiles,
    actualChangedFiles,
    mainChangedFiles,
    overlappingFiles,
    structuralConflicts,
    mainCommitsSinceBase: Number(mainCommitCount.stdout.trim() || 0),
    mainAdvanced: mainCommit !== input.baseCommit,
    workingTreeClean: uncommittedFiles.length === 0,
    checkedAt: new Date().toISOString(),
  };
}

export async function runVerificationCommands(
  commands: string[],
  worktreePath: string,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    try {
      const result = await execute("/bin/zsh", ["-lc", command], {
        cwd: worktreePath,
        timeout: 180_000,
      });
      results.push({
        command,
        exitCode: 0,
        output: `${result.stdout}${result.stderr}`.trim().slice(-20_000),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failed = error as GitCommandError;
      results.push({
        command,
        exitCode: failed.exitCode,
        output: `${failed.stdout}${failed.stderr}`.trim().slice(-20_000),
        durationMs: Date.now() - startedAt,
      });
      break;
    }
  }

  return results;
}

export async function prepareIntegrationWorktree(input: {
  repositoryPath: string;
  projectId: string;
  changeRequestId: string;
  taskBranch: string;
  defaultBranch: string;
}): Promise<{
  branchName: string;
  worktreePath: string;
  mergeCommit: string | null;
  conflicts: string[];
}> {
  await runGit(input.repositoryPath, ["fetch", "origin", "--prune"], true);
  const branchName = `integration/${input.changeRequestId.slice(0, 8)}`;
  const worktreePath = path.join(
    config.runtimeRoot,
    "projects",
    input.projectId,
    "integrations",
    input.changeRequestId,
  );
  await runGit(input.repositoryPath, ["worktree", "remove", "--force", worktreePath]).catch(
    () => undefined,
  );
  await rm(worktreePath, { recursive: true, force: true });
  await runGit(input.repositoryPath, ["branch", "-D", branchName]).catch(() => undefined);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(input.repositoryPath, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    `origin/${input.defaultBranch}`,
  ]);
  await runGit(worktreePath, ["config", "user.name", "CloudAgent Integration"]);
  await runGit(worktreePath, ["config", "user.email", "integration@cloudagent.local"]);

  try {
    await runGit(worktreePath, [
      "merge",
      "--no-ff",
      `origin/${input.taskBranch}`,
      "-m",
      `Integrate ${input.taskBranch}`,
    ]);
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
    const conflictOutput = await runGit(worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    const conflicts = conflictOutput.stdout.trim().split("\n").filter(Boolean);
    if (conflicts.length === 0) {
      throw error;
    }
    return {
      branchName,
      worktreePath,
      mergeCommit: null,
      conflicts,
    };
  }

  const mergeCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return { branchName, worktreePath, mergeCommit, conflicts: [] };
}

export async function finalizeIntegrationGit(input: {
  repositoryPath: string;
  integrationBranch: string;
  defaultBranch: string;
}): Promise<string> {
  await runGit(input.repositoryPath, ["fetch", "origin", "--prune"], true);
  await runGit(input.repositoryPath, ["checkout", input.defaultBranch]);
  await runGit(input.repositoryPath, ["reset", "--hard", `origin/${input.defaultBranch}`]);
  await runGit(input.repositoryPath, ["merge", "--ff-only", input.integrationBranch]);
  await runGit(input.repositoryPath, ["push", "origin", input.defaultBranch], true);
  return (await runGit(input.repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
}
