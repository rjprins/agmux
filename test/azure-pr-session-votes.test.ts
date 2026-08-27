import { beforeEach, describe, expect, it, vi } from "vitest";

const runAzureCliMock = vi.hoisted(() => vi.fn());

vi.mock("../src/server/azure-cli.js", () => ({ runAzureCli: runAzureCliMock }));

import { listMyActivePRs, type AzureRepoRef } from "../src/server/azure-pr.js";

const ref: AzureRepoRef = {
  orgUrl: "https://dev.azure.com/example",
  project: "Demo Project",
  repo: "demo-repo",
};

describe("listMyActivePRs", () => {
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

    const prs = await listMyActivePRs(ref, "rutger@example.com");

    expect(prs[0]?.votes).toEqual([{ by: "rutger@example.com", vote: "approved" }]);
  });
});
