import { Schema } from "effect";

export class NativeRegistrationError extends Schema.TaggedError<NativeRegistrationError>()(
  "NativeRegistrationError",
  {
    reason: Schema.optional(
      Schema.Literals([
        "historical_goal",
        "conflicting_generation",
        /** A manifest names a file outside its build directory. */
        "escaped_build_directory",
        /** Built bytes differ from the SHA256 their manifest records. */
        "artifact_hash_mismatch",
      ]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
