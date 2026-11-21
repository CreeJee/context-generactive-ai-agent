import type { Match } from "../memory/search.ts";

/** A lead's source as the model reads it: the day, the project and the kind of the node. */
export const leadSource = (match: Match): string =>
  `${match.createdAt.slice(0, 10)} · ${match.projectName} · ${match.kind}`;

/** A lead's snippet on one line. */
export const leadSnippet = (match: Match): string => match.snippet.replace(/\s+/g, " ");
