import { afterEach, describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import { createTestClient, type TestHarness } from "./helpers.js";

/** Server assembly: the primitives a host discovers before any tool call. */
describe("server", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("advertises only the drugdata tools", async () => {
    harness = await createTestClient();

    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["drugdata_ping"]);
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("lists tools in the same order on every call", async () => {
    harness = await createTestClient();

    const first = await harness.client.listTools();
    const second = await harness.client.listTools();

    expect(first.tools.map((tool) => tool.name)).toEqual(
      second.tools.map((tool) => tool.name),
    );
  });

  it("registers no prompts from the template", async () => {
    harness = await createTestClient();

    const { prompts } = await harness.client.listPrompts();

    expect(prompts).toEqual([]);
  });

  it("serves server://info", async () => {
    harness = await createTestClient();

    const result = await harness.client.readResource({ uri: "server://info" });
    const contents = result.contents as { text?: string }[];
    const info = JSON.parse(contents[0]?.text ?? "{}") as {
      name: string;
      version: string;
      transport: string;
    };

    expect(info).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "stdio",
    });
  });
});
