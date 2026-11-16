import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const workflowFiles = readdirSync(workflowsDirectory).filter((file) =>
  /\.ya?ml$/.test(file),
);

describe("GitHub Actions supply-chain policy", () => {
  it("pins every remote action in every workflow to a full commit SHA", () => {
    const unpinned: string[] = [];

    for (const file of workflowFiles) {
      const workflow = readFileSync(new URL(file, workflowsDirectory), "utf8");
      for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        const action = match[1] ?? "";
        if (action.startsWith("./")) continue;
        const ref = action.split("@")[1] ?? "";
        if (!/^[0-9a-f]{40}$/.test(ref)) {
          unpinned.push(`${file}: ${action}`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });
});
