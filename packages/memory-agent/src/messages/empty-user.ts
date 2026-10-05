const textMessageFields = new Set(["id", "role", "content", "createdAt", "metadata"]);

/** Only the confirmed empty text shape is disposable; preserve media and unknown payloads. */
export function isEmptyUserText(message: {
  readonly role: string;
  readonly content?: unknown;
}): boolean {
  return (
    message.role === "user" &&
    message.content === "" &&
    Object.keys(message).every((key) => textMessageFields.has(key))
  );
}
