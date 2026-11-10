import { isTruthy } from "../../truthy.ts";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Trans, useLingui } from "@lingui/react/macro";

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
          <span>
            <Trans>설정을 불러오지 못했습니다.</Trans>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.props.onReset();
              this.setState({ error: null });
            }}
          >
            <Trans comment="Button that loads a settings section again after it failed to load">
              다시 시도
            </Trans>
          </Button>
        </div>
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
