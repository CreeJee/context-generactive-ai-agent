import { HashSet } from "effect";

/**
 * What a kanban card's agent and its verifiers can do. The card agent and verifier tool sets are
 * filtered by these names, and the planner reads the same abilities as text, so a Plan only holds
 * cards their agents can carry out and checks their verifiers can run. Both also get the
 * read-only tools of the project's MCP servers, and verifiers get record_card_verdict.
 */
export const cardAgentToolNames = HashSet.fromIterable([
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "list_outside_files",
  "read_outside_file",
  "search_outside_file",
  "write_outside_file",
  "delete_outside_file",
  "save_code_skill",
  "run_skill",
]);

/** A verifier reads the work and runs the project's saved code skills; it changes nothing. */
export const verifierToolNames = HashSet.fromIterable([
  "list_files",
  "search_files",
  "read_file",
  "run_skill",
]);

/** The abilities above as the planner reads them, with what they mean for the cards it writes. */
export const cardCapabilities = [
  "What card agents and verifiers can do; write only cards they can carry out and checks they can run:",
  "- A card agent works in a folder of its own. It reads, writes, edits and deletes files there and reads files elsewhere on the computer; writing outside its folder asks first.",
  "- It has no shell. Commands such as tests, builds, package installs or read-only git run only as the project's code skills: it runs a saved skill with run_skill and can save a new one with save_code_skill, which asks for approval as the permission mode says. A skill reaches the network only for the hosts it was saved with.",
  "- Of the project's MCP servers it calls only the read-only tools, the same ones you have. It cannot change an outside service (publish, deploy, post, open pull requests, write through MCP), change git state, or ask the user.",
  "- A verifier reads the card's files, runs code skills that are already saved, including one the card saved, and calls the same read-only MCP tools. It cannot write files or save a skill.",
  "- Keep work that needs anything else (a change to an outside service, credentials, a person's decision or action) out of the cards, and name it in the Plan's risks as left to the user.",
  "- Word each acceptance criterion so a verifier can check it by reading files or running a code skill. When a check needs a command no code skill of the project runs yet, say in that card that its agent saves one, so the verifier can run it.",
].join("\n");
