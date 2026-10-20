/** TanStack AI takes an AbortController; follow the interruption signal Effect passes in. */
export const abortControllerFor = (signal: AbortSignal) => {
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
};
