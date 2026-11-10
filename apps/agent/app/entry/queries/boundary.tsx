import { isTruthy } from "../../truthy.ts";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";
import { Spinner } from "~/components/ui/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { LoadFailed } from "../shared/load-failed";

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
        <LoadFailed
          className="text-sm"
          onRetry={() => {
            this.props.onReset();
            this.setState({ error: null });
          }}
        >
          <Trans>설정을 불러오지 못했습니다.</Trans>
        </LoadFailed>
      );
    return this.props.children;
  }
}

/** Keep a failing or loading query inside its own settings page. */
export function QuerySection({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <SectionErrorBoundary onReset={reset}>
          <Suspense
            fallback={
              <Spinner
                aria-label={t({
                  message: "설정을 불러오는 중",
                  comment: "Accessible label of the spinner shown while a settings section loads",
                })}
              />
            }
          >
            {children}
          </Suspense>
        </SectionErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
