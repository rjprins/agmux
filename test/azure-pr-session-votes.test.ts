import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { listMyActivePRs, type AzureRepoRef } from "../src/server/azure-pr.js";

const ref: AzureRepoRef = {
  orgUrl: "https://dev.azure.com/example",
  project: "Demo Project",
  repo: "demo-repo",
};

describe("listMyActivePRs", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("does not include a team vote rolled up from an individual reviewer", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
      callback(null, {
        stdout: JSON.stringify([{
          pullRequestId: 42,
          title: "Improve launch flow",
          sourceRefName: "refs/heads/feature/launch-flow",
          reviewers: [
            { displayName: "Flex Optimization Team", isContainer: true, vote: 10 },
            { uniqueName: "rutger@example.com", isContainer: false, vote: 10 },
          ],
        }]),
        stderr: "",
      });
    });

    const prs = await listMyActivePRs(ref, "rutger@example.com");

    expect(prs[0]?.votes).toEqual([{ by: "rutger@example.com", vote: "approved" }]);
  });
});
