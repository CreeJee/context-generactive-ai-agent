import { Option, Schema } from "effect";

/**
 * Tool argument fields treated as references to a file or URL. Both spellings of a path argument
 * are here because the app's own tools use `path`, while Claude Code and many MCP servers send
 * `file_path`; a transcript from either should produce the same `touches` edges.
 */
const RefArguments = Schema.parseJson(
  Schema.Struct({
    path: Schema.optional(Schema.String),
    file: Schema.optional(Schema.String),
    filePath: Schema.optional(Schema.String),
    file_path: Schema.optional(Schema.String),
    notebook_path: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    uri: Schema.optional(Schema.String),
  }),
);
const decodeRefArguments = Schema.decodeUnknownOption(RefArguments);

/** The files or URLs a tool call names, read from the JSON arguments it was called with. */
export function refsInArguments(argumentsJson: string): string[] {
  return Option.match(decodeRefArguments(argumentsJson), {
    onNone: () => [],
    onSome: (args) =>
      [
        args.path,
        args.file,
        args.filePath,
        args.file_path,
        args.notebook_path,
        args.url,
        args.uri,
      ].filter((ref): ref is string => ref !== undefined && ref.length > 0),
  });
}
