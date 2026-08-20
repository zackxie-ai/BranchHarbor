import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Git worktree lifecycle", () => {
  it("creates an isolated task worktree and calculates committed Git facts", { timeout: 15_000 }, async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "branchharbor-git-test-"));
    const runtimeRoot = path.join(fixtureRoot, "runtime");
    cleanupPaths.push(fixtureRoot);
    process.env.BRANCHHARBOR_RUNTIME_ROOT = runtimeRoot;

    const remote = path.join(fixtureRoot, "remote.git");
    const seed = path.join(fixtureRoot, "seed");
    const manager = path.join(fixtureRoot, "manager");
    await mkdir(seed, { recursive: true });
    await git(fixtureRoot, "init", "--bare", remote);
    await git(fixtureRoot, "clone", remote, seed);
    await git(seed, "config", "user.name", "Test User");
    await git(seed, "config", "user.email", "test@branchharbor.local");
    await writeFile(path.join(seed, "README.md"), "# Fixture\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "Initial commit");
    await git(seed, "branch", "-M", "main");
    await git(seed, "push", "-u", "origin", "main");

    const {
      cloneRepository,
      createTaskWorktree,
      inspectCommittedChanges,
      inspectTaskWorkspaceProgress,
      restoreTaskWorkspaceBackup,
      syncTaskWorkspaceBackup,
    } = await import("../git");
    await cloneRepository(remote, manager);
    const workspace = await createTaskWorktree({
      repositoryPath: manager,
      projectId: "test-project",
      taskId: "11111111-1111-4111-8111-111111111111",
      title: "Add product note",
      baseBranch: "main",
    });
    await writeFile(path.join(workspace.worktreePath, "PRODUCT.md"), "BranchHarbor test\n");
    await git(workspace.worktreePath, "add", "PRODUCT.md");
    await git(workspace.worktreePath, "commit", "-m", "Add product note");

    const facts = await inspectCommittedChanges({
      worktreePath: workspace.worktreePath,
      baseCommit: workspace.baseCommit,
    });
    expect(workspace.branchName).toMatch(/^task\/11111111-add-product-note$/);
    expect(facts.headCommit).not.toBe(workspace.baseCommit);
    expect(facts.changedFiles).toEqual([{ status: "A", path: "PRODUCT.md" }]);
    expect(facts.diffStat).toContain("PRODUCT.md");

    await writeFile(path.join(workspace.worktreePath, "DRAFT.md"), "Uncommitted\n");
    await writeFile(path.join(seed, "PRODUCT.md"), "Main changed the same file\n");
    await git(seed, "add", "PRODUCT.md");
    await git(seed, "commit", "-m", "Advance main");
    await git(seed, "push", "origin", "main");
    const progress = await inspectTaskWorkspaceProgress({
      repositoryPath: manager,
      worktreePath: workspace.worktreePath,
      baseBranch: "main",
      baseCommit: workspace.baseCommit,
    });
    expect(progress.committedFiles).toEqual([{ status: "A", path: "PRODUCT.md" }]);
    expect(progress.uncommittedFiles).toEqual([{ status: "??", path: "DRAFT.md" }]);
    expect(progress.mainCommitsSinceBase).toBe(1);
    expect(progress.mainAdvanced).toBe(true);
    expect(progress.overlappingFiles).toEqual(["PRODUCT.md"]);
    expect(progress.workingTreeClean).toBe(false);

    const backup = await syncTaskWorkspaceBackup({
      worktreePath: workspace.worktreePath,
      taskId: "11111111-1111-4111-8111-111111111111",
      branchName: workspace.branchName,
    });
    expect(backup.remoteHeadCommit).toBe(facts.headCommit);
    expect(backup.checkpointCommit).toBeTruthy();
    expect(backup.changedFiles).toEqual([{ status: "??", path: "DRAFT.md" }]);
    const unchangedBackup = await syncTaskWorkspaceBackup({
      worktreePath: workspace.worktreePath,
      taskId: "11111111-1111-4111-8111-111111111111",
      branchName: workspace.branchName,
    });
    expect(unchangedBackup.checkpointCommit).toBe(backup.checkpointCommit);
    expect(
      (
        await git(
          fixtureRoot,
          "--git-dir",
          remote,
          "rev-parse",
          `refs/heads/${workspace.branchName}`,
        )
      ).stdout.trim(),
    ).toBe(facts.headCommit);
    expect(
      (
        await git(
          fixtureRoot,
          "--git-dir",
          remote,
          "rev-parse",
          "refs/branchharbor/checkpoints/11111111-1111-4111-8111-111111111111^",
        )
      ).stdout.trim(),
    ).toBe(facts.headCommit);

    await rm(workspace.worktreePath, { recursive: true, force: true });
    await rm(manager, { recursive: true, force: true });
    const restored = await restoreTaskWorkspaceBackup({
      repositoryPath: manager,
      repositoryUrl: remote,
      worktreePath: workspace.worktreePath,
      taskId: "11111111-1111-4111-8111-111111111111",
      branchName: workspace.branchName,
    });
    expect(restored.repositoryCloned).toBe(true);
    expect(restored.checkpointRestored).toBe(true);
    expect(await readFile(path.join(workspace.worktreePath, "PRODUCT.md"), "utf8")).toBe(
      "BranchHarbor test\n",
    );
    expect(await readFile(path.join(workspace.worktreePath, "DRAFT.md"), "utf8")).toBe(
      "Uncommitted\n",
    );
    expect((await git(workspace.worktreePath, "status", "--porcelain")).stdout.trim()).toBe(
      "?? DRAFT.md",
    );

    await rm(path.join(workspace.worktreePath, "DRAFT.md"));
    const cleanBackup = await syncTaskWorkspaceBackup({
      worktreePath: workspace.worktreePath,
      taskId: "11111111-1111-4111-8111-111111111111",
      branchName: workspace.branchName,
    });
    expect(cleanBackup.workingTreeClean).toBe(true);
    await expect(
      git(
        fixtureRoot,
        "--git-dir",
        remote,
        "show-ref",
        "--verify",
        "refs/branchharbor/checkpoints/11111111-1111-4111-8111-111111111111",
      ),
    ).rejects.toBeTruthy();
  });
});
