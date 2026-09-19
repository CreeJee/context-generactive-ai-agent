import { App } from "../entry";

export function meta() {
  return [{ title: "Agent" }, { name: "description", content: "Run!" }];
}

export default function Agent() {
  return <App />;
}
