import { serveApi } from "~/.server/api";
import type { Route } from "./+types/$";

/**
 * Every `/api/...` request no route file answers goes to the chat API and the app API
 * (`~/.server/api`, docs/httpapi-migration.md). Route files still answer the groups not moved yet.
 */
export function loader({ request }: Route.LoaderArgs) {
  return serveApi(request);
}

export function action({ request }: Route.ActionArgs) {
  return serveApi(request);
}
