import { Cause, Option, Schema } from "effect";

const decodeTagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));
const decodeReasonTag = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Schema.Struct({ _tag: Schema.String }) }),
);

/**
 * A cause as its failures' tags, for text a person or model reads and for logs. A tagged reason,
 * such as a platform error's `PermissionDenied`, is named too; messages never are, since they can
 * hold paths, command output or provider text.
 */
export const failureTags = (cause: Cause.Cause<unknown>) => {
  const tags = cause.reasons.map((reason) => {
    switch (reason._tag) {
      case "Fail":
        return Option.match(decodeTagged(reason.error), {
          onNone: () => "Failure",
          onSome: ({ _tag }) =>
            Option.match(decodeReasonTag(reason.error), {
              onNone: () => _tag,
              onSome: (failure) => `${_tag}:${failure.reason._tag}`,
            }),
        });
      case "Die":
        return "Defect";
      case "Interrupt":
        return "Interrupted";
    }
  });
  return [...new Set(tags)].join(",");
};
