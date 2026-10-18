import { Schema } from "effect";

export class NativeRegistrationError extends Schema.TaggedError<NativeRegistrationError>()(
  "NativeRegistrationError",
  {
    reason: Schema.optional(Schema.Literals(["historical_goal", "conflicting_generation"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
