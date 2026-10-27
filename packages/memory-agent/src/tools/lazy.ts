import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";

/**
 * A tool the model seldom needs: the request lists it by name only, and its description and schema
 * follow once the model asks for them through TanStack's discovery tool.
 */
export const lazily = <T extends { readonly lazy?: boolean | undefined }>(tool: T): T => ({
  ...tool,
  lazy: true,
});

/** The discovery call is how the model asks for a lazy tool; it is not part of the work. */
export const isDiscoveryCall = (name: string) => name === DISCOVERY_TOOL_NAME;
