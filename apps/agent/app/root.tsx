import { isTruthy } from "./truthy.ts";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/react-router/v8";
import { useState } from "react";
import { OverlayProvider } from "overlay-kit";
import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";

import { useBackendRestartRequired } from "./entry/shared/use-backend-restart";
import { themeScript } from "./entry/shared/theme-script";
import { i18n } from "./i18n";
import { TooltipProvider } from "~/components/ui/tooltip";
import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  );
  const backendRestartRequired = useBackendRestartRequired();

  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <NuqsAdapter>
          {backendRestartRequired && (
            <div
              className="fixed inset-x-0 top-0 z-100 border-b border-warning/40 bg-background px-4 py-2 text-center text-sm text-foreground shadow-sm"
              role="alert"
            >
              <Trans>
                서버 연결이 바뀌었습니다. 페이지를 새로고침한 뒤 작업을 이어가 주십시오.
              </Trans>
            </div>
          )}
          <OverlayProvider>
            <Outlet />
          </OverlayProvider>
        </NuqsAdapter>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function ErrorView({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  // The thrown error's own text and stack help while developing; a user gets what to do next.
  const thrown = import.meta.env.DEV && isTruthy(error) && error instanceof Error ? error : null;

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>
        {notFound ? (
          <Trans>페이지를 찾을 수 없습니다</Trans>
        ) : (
          <Trans>예상하지 못한 오류가 났습니다</Trans>
        )}
      </h1>
      <p>
        {notFound ? (
          <Trans>주소를 확인해 주십시오.</Trans>
        ) : (
          <Trans>페이지를 새로고침한 뒤 다시 시도해 주십시오.</Trans>
        )}
      </p>
      {thrown && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{thrown.stack ?? thrown.message}</code>
        </pre>
      )}
    </main>
  );
}

// The boundary renders in place of `App`, outside its providers.
export function ErrorBoundary(props: Route.ErrorBoundaryProps) {
  return (
    <I18nProvider i18n={i18n}>
      <ErrorView {...props} />
    </I18nProvider>
  );
}
