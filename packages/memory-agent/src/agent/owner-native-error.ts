import { Schema } from "effect";

export class NativeRegistrationError extends Schema.TaggedError<NativeRegistrationError>()(
  "NativeRegistrationError",
  { cause: Schema.Defect() },
) {}
