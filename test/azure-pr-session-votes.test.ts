import { beforeEach, describe, expect, it, vi } from "vitest";

const runAzureCliMock = vi.hoisted(() => vi.fn());

vi.mock("../src/server/azure-cli.js", () => ({ runAzureCli: runAzureCliMock }));

import { listActivePRsWithVotes, prAuthoredBy, type AzureRepoRef } from "../src/server/azure-pr.js";

const ref: AzureRepoRef = {
  orgUrl: "https://dev.azure.com/example",
  project: "Demo Project",
  repo: "demo-repo",
};

describe("listActivePRsWithVotes", () => {
  beforeEach(() => {
    runAzureCliMock.mockReset();
  });

  it("does not include a team vote rolled up from an individual reviewer", async () => {
    runAzureCliMock.mockResolvedValue({
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

    const prs = await listActivePRsWithVotes(ref);

    expect(prs[0]?.votes).toEqual([{ by: "rutger@example.com", vote: "approved" }]);
  });

  it("marks a PR created by someone else as not mine", async () => {
    runAzureCliMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          pullRequestId: 43,
          title: "Colleague work",
          sourceRefName: "refs/heads/feature/colleague",
          createdBy: { uniqueName: "colleague@example.com", displayName: "A Colleague" },
        },
        {
          pullRequestId: 44,
          title: "My work",
          sourceRefName: "refs/heads/feature/mine",
          createdBy: { uniqueName: "Rutger@Example.com", displayName: "Rutger" },
        },
      ]),
      stderr: "",
    });

    const prs = await listActivePRsWithVotes(ref);

    expect(prs.map((pr) => prAuthoredBy(pr, "rutger@example.com"))).toEqual([false, true]);
    expect(prs[0]?.author).toBe("A Colleague");
  });

  it("does not claim an unattributed PR when the az user is unknown", async () => {
    runAzureCliMock.mockResolvedValue({
      stdout: JSON.stringify([{ pullRequestId: 45, title: "Orphan", sourceRefName: "refs/heads/orphan" }]),
      stderr: "",
    });

    const prs = await listActivePRsWithVotes(ref);

    expect(prAuthoredBy(prs[0]!, "")).toBe(false);
    expect(prs[0]?.author).toBe("Unknown");
  });
});
