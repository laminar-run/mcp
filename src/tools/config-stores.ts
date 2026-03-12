import { z } from "zod";
import { safe } from "../helpers.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

  server.tool(
    "list_config_stores",
    "List all configuration stores in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().listConfigStores(workspaceId)),
  );

  server.tool(
    "get_config_store",
    "Get a configuration store by its external ID",
    {
      externalId: z.string().describe("Configuration store external ID"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, workspaceId }) =>
      safe(() => deps.client().getConfigStore(externalId, workspaceId)),
  );

  server.tool(
    "get_config_properties",
    "Get all properties (key-value pairs) from a configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, workspaceId }) =>
      safe(() => deps.client().getConfigProperties(externalId, workspaceId)),
  );

  server.tool(
    "get_config_property",
    "Get a specific property value from a configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      key: z.string().describe("Property key"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, key, workspaceId }) =>
      safe(() =>
        deps.client().getConfigProperty(externalId, key, workspaceId),
      ),
  );

  server.tool(
    "update_config_property",
    "Create or update a property in a configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      workspaceId: z.number().describe("Workspace ID"),
      key: z.string().describe("Property key"),
      value: z.string().describe("Property value"),
    },
    async ({ externalId, workspaceId, key, value }) =>
      safe(() =>
        deps
          .client()
          .updateConfigProperty(externalId, workspaceId, { key, value }),
      ),
  );

  server.tool(
    "remove_config_property",
    "Remove a property from a configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      key: z.string().describe("Property key"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, key, workspaceId }) =>
      safe(() =>
        deps.client().removeConfigProperty(externalId, key, workspaceId),
      ),
  );

  server.tool(
    "create_config_store",
    "Create a new configuration store",
    {
      workspaceId: z.number().describe("Workspace ID"),
      name: z.string().describe("Config store name"),
      externalId: z
        .string()
        .describe("Unique external ID (used in {{config.xxx}} references)"),
      properties: z
        .array(
          z.object({
            key: z.string().describe("Property key"),
            value: z.string().describe("Property value"),
          }),
        )
        .describe("Initial properties"),
    },
    async (args) => safe(() => deps.client().createConfigStore(args)),
  );

  server.tool(
    "delete_config_store",
    "Delete (archive) a configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, workspaceId }) =>
      safe(() => deps.client().deleteConfigStore(externalId, workspaceId)),
  );

  server.tool(
    "restore_config_store",
    "Restore a previously archived configuration store",
    {
      externalId: z.string().describe("Configuration store external ID"),
      workspaceId: z.number().describe("Workspace ID"),
    },
    async ({ externalId, workspaceId }) =>
      safe(() => deps.client().restoreConfigStore(externalId, workspaceId)),
  );
}
