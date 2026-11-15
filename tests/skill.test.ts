import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestClient, type TestHarness } from "./helpers.js";

/**
 * The agent skill is documentation, so the only way it can go wrong silently
 * is drift: a renamed tool, a dropped disclaimer, or a frontmatter field a
 * host cannot load. These tests parse the real file and compare it with the
 * server's live `tools/list` catalog.
 *
 * The frontmatter parser is deliberately tiny: the skill keeps a flat YAML
 * header with one `key: value` per line, so a full YAML dependency would add
 * weight without covering anything this file uses.
 */

const SKILL_URL = new URL("../skills/open-drug-data/SKILL.md", import.meta.url);
const README_URL = new URL("../README.md", import.meta.url);

interface SkillDocument {
  frontmatter: ReadonlyMap<string, string>;
  body: string;
  text: string;
}

/** Reads `SKILL.md` and splits its flat frontmatter from the body. */
function readSkill(): SkillDocument {
  const text = readFileSync(SKILL_URL, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new Error(
      "SKILL.md must start with a --- delimited frontmatter block",
    );
  }

  const yaml = match[1];
  const body = match[2];
  if (yaml === undefined || body === undefined) {
    throw new Error("SKILL.md frontmatter block is empty or malformed");
  }

  const frontmatter = new Map<string, string>();
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(`Unsupported frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    frontmatter.set(key, value);
  }

  return { frontmatter, body, text };
}

/** Every `drugdata_*` name the skill mentions, in first-seen order. */
function mentionedTools(text: string): string[] {
  return [...new Set(text.match(/drugdata_[a-z0-9_]+/g) ?? [])];
}

describe("agent skill", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("declares a host-loadable skill with useful trigger phrases", () => {
    const { frontmatter } = readSkill();

    expect(frontmatter.get("name")).toBe("open-drug-data");

    const description = frontmatter.get("description");
    expect(description).toBeTypeOf("string");
    expect(description?.trim().length).toBeGreaterThan(0);
    expect(description?.length).toBeLessThanOrEqual(1024);

    // The description is what a host searches to decide whether to load the
    // skill, so the domains and identifier families must be discoverable there.
    const lower = description?.toLowerCase() ?? "";
    for (const trigger of [
      "drug",
      "ingredient",
      "supplement",
      "cosmetic",
      "ndc",
      "unii",
      "rxcui",
      "cas",
      "inci",
    ]) {
      expect(lower).toContain(trigger);
    }
  });

  it("mentions only tools the server actually registers", async () => {
    const { text } = readSkill();
    harness = await createTestClient();
    const { tools } = await harness.client.listTools();
    const registered = new Set(tools.map((tool) => tool.name));

    const mentioned = mentionedTools(text);
    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);

    // A skill that omitted a tool would send a model looking for a capability
    // it never learns about, so the catalog must be complete as well.
    expect(new Set(mentioned)).toEqual(registered);
  });

  it("teaches the loop, confidence, costs, and known pitfalls", () => {
    const { text } = readSkill();
    const lower = text.toLowerCase();

    for (const required of [
      "search → resolve → get",
      "nextsteps",
      "links",
      "candidates",
      "direct",
      "derived",
      "include_label_sections",
      "resolve_ingredients",
      "include_clinical",
      "ndc",
      "drugcentral",
      "substring",
      "zero matches",
      "only the brand",
      "only the ingredient",
      "page",
      "hasmore",
      "cite",
      "deep link",
    ]) {
      expect(lower).toContain(required);
    }
  });

  it("carries the not-medical-advice disclaimer and no client names", () => {
    const { text } = readSkill();

    expect(text.toLowerCase()).toContain("not medical advice");
    expect(text).not.toMatch(/@knorby/i);
    expect(text).not.toMatch(/-client\b/i);
  });

  it("is linked from the README", () => {
    const readme = readFileSync(README_URL, "utf8");

    expect(readme).toContain("skills/open-drug-data/SKILL.md");
  });
});
