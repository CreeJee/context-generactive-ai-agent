import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

class SectionErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error)
      return (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span>설정을 불러오지 못했어요.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.props.onReset();
              this.setState({ error: null });
            }}
          >
            다시 시도
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
          <Suspense fallback={<Spinner aria-label="설정을 불러오는 중" />}>{children}</Suspense>
        </SectionErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
