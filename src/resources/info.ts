import type { McpServer } from "@modelcontextprotocol/server";
import { readConfig, SOURCE_IDS, SOURCE_LABELS } from "../config.js";
import {
  DISCLAIMER,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_CHOICE_GUIDE,
} from "../constants.js";

/**
 * Static resource: what this server is, which sources it will use, and the
 * disclaimer.
 *
 * A host can read it by URI with no arguments, which makes it the right place
 * for facts an operator or model wants without calling a tool. Configuration is
 * read lazily on every read, and a broken environment is reported rather than
 * hidden: whoever opens this resource is exactly who needs to see the error.
 */

/** Registers the `server://info` resource. */
export function registerInfoResource(server: McpServer): void {
  server.registerResource(
    "server-info",
    "server://info",
    {
      title: "Server information",
      description:
        "Server name, version, transport, the enabled upstream databases, and the research-use disclaimer.",
      mimeType: "application/json",
    },
    async (uri) => {
      const config = readConfig();
      const sources = config.ok
        ? SOURCE_IDS.map((id) => ({
            id,
            database: SOURCE_LABELS[id],
            enabled: !config.config.DRUGDATA_DISABLED_SOURCES.includes(id),
          }))
        : [];

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                name: SERVER_NAME,
                version: SERVER_VERSION,
                transport: "stdio",
                searchTimeoutMs: config.ok
                  ? config.config.DRUGDATA_SEARCH_TIMEOUT_MS
                  : null,
                toolChoiceGuide: TOOL_CHOICE_GUIDE,
                sources,
                disclaimer: DISCLAIMER,
                configError: config.ok ? null : config.error,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
