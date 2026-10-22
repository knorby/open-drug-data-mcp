import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  type Config,
  readConfig,
  SOURCE_IDS,
  SOURCE_LABELS,
  type SourceId,
} from "../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";

/**
 * Connectivity and configuration check.
 *
 * Needs no credentials and no network, so it is the one tool that always
 * answers. It reports which sources this process will use and whether their
 * keys are configured — never the key values.
 */

/**
 * Sources that accept an API key, mapped to the config field holding it.
 * Sources absent from this map need no key, so they are always configured.
 */
const API_KEY_BY_SOURCE: Partial<
  Record<SourceId, "OPENFDA_API_KEY" | "DSLD_API_KEY">
> = {
  openfda: "OPENFDA_API_KEY",
  dsld: "DSLD_API_KEY",
};

const inputSchema = z.object({
  message: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional message to echo back in the text response. Omit for a plain 'pong'.",
    ),
});

const outputSchema = z.object({
  ok: z.boolean().describe("Always true — the server answered."),
  server: z
    .object({
      name: z.string().describe("Server name advertised to hosts."),
      version: z
        .string()
        .describe("Server version, derived from package.json."),
    })
    .describe("Server identity."),
  sources: z
    .array(
      z.object({
        id: z
          .enum(SOURCE_IDS)
          .describe("Adapter id, as accepted by DRUGDATA_DISABLED_SOURCES."),
        enabled: z
          .boolean()
          .describe(
            "Whether this source participates in searches — false when listed in DRUGDATA_DISABLED_SOURCES.",
          ),
        configured: z
          .boolean()
          .describe(
            "Whether this source's API key is present; always true for sources that take no key. Never reveals a key.",
          ),
      }),
    )
    .describe("Every source, in the server's fixed order."),
});

type PingInput = z.infer<typeof inputSchema>;
type PingOutput = z.infer<typeof outputSchema>;

/** Registers the `drugdata_ping` tool. */
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    "drugdata_ping",
    {
      title: "Ping the server",
      description:
        "Check that the server is running and see which data sources this process will use. Reports the server name and version, each source's adapter id and whether it is enabled, and whether its API key is configured (never the key itself). Needs no credentials and no network — use it to verify connectivity before searching.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message }: PingInput) => {
      const config = readConfig();
      if (!config.ok) {
        return {
          content: [{ type: "text", text: config.error }],
          isError: true,
        };
      }

      const disabled = new Set(config.config.DRUGDATA_DISABLED_SOURCES);
      const sources = SOURCE_IDS.map((id) => ({
        id,
        enabled: !disabled.has(id),
        configured: isConfigured(id, config.config),
      }));
      const output: PingOutput = {
        ok: true,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        sources,
      };

      const enabledCount = sources.filter((source) => source.enabled).length;
      const text = [
        message ? `pong: ${message}` : "pong",
        "",
        `${SERVER_NAME} ${SERVER_VERSION} — ${enabledCount} of ${SOURCE_IDS.length} sources enabled.`,
        ...sources.map(
          (source) =>
            `- ${SOURCE_LABELS[source.id]}: ${source.enabled ? "enabled" : "disabled"} (${keyLabel(source.id, source.configured)})`,
        ),
        "",
        "API keys: openFDA and DSLD keys are optional — they raise upstream rate limits. Key values are never shown.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: output,
      };
    },
  );
}

/** Whether the source's optional key is set (keyless sources report true). */
function isConfigured(id: SourceId, config: Config): boolean {
  const field = API_KEY_BY_SOURCE[id];
  return field === undefined ? true : config[field] !== undefined;
}

/** Describes the key situation for one source in the text response. */
function keyLabel(id: SourceId, configured: boolean): string {
  if (API_KEY_BY_SOURCE[id] === undefined) return "no key needed";
  return configured ? "API key configured" : "no API key";
}
