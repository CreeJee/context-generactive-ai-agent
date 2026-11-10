import { isTruthy } from "../../truthy.ts";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { queriesCopy } from "./copy";

class SectionErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (isTruthy(this.state.error))
      return (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span>{queriesCopy.section.loadFailed}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.props.onReset();
              this.setState({ error: null });
            }}
          >
            {queriesCopy.section.retry}
          </Button>
        </div>
      );
    return this.props.children;
  }
}

/** Keep a failing or loading query inside its own settings page. */
export function QuerySection({ children }: { children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <SectionErrorBoundary onReset={reset}>
          <Suspense fallback={<Spinner aria-label={queriesCopy.section.loading} />}>
            {children}
          </Suspense>
        </SectionErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
