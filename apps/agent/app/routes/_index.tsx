import type { Route } from "./+types/_index";
import { App } from "../entry";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Agent" }, { name: "description", content: "Run!" }];
}

export default function Agent() {
  return <App />;
}
