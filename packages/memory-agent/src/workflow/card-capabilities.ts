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
  "run_command",
  "save_project_commands",
  "read_skill",
  "read_evidence",
  "read_tool_result",
]);

/** A verifier reads the work and runs the project's saved code skills; it changes nothing. */
export const verifierToolNames = HashSet.fromIterable([
  "list_files",
  "search_files",
  "read_file",
  "run_skill",
  "read_skill",
  "read_evidence",
  "read_tool_result",
]);

/** The abilities above as the planner reads them, with what they mean for the cards it writes. */
export const cardCapabilities = [
  "What card agents and verifiers can do; write only cards they can carry out and checks they can run:",
  "- A card agent works in a folder of its own. It reads, writes, edits and deletes files there and reads files elsewhere on the computer; writing outside its folder asks first.",
  '- It runs host commands in a sandbox. A command that only looks, such as read-only git, runs at once with run_command and access "read", which can change nothing. Commands that change files or need the network, such as tests, builds or package installs, ask for approval as the permission mode says: each call of run_command with access "write", or once for a code skill it saves with save_code_skill and then runs with run_skill. A script reaches the network only for the hosts it was approved with.',
  "- It starts with the project's command list (how the project runs its tests, build and checks) when the project has one, and adds to it with save_project_commands. A verifier reads the same list.",
  "- It reads the project's skill catalog with read_skill, so a card can follow a skill the project already keeps; the catalog is read from the folder the card works in.",
  "- Of the project's MCP servers it calls only the read-only tools. It cannot change an outside service (publish, deploy, post, open pull requests, write through MCP), change git state, or ask the user.",
  "- A verifier reads the card's files, reads the same skill catalog with read_skill, runs code skills that are already saved, including one the card saved, and calls the same read-only MCP tools. It cannot write files or save a skill.",
  "- Both read a saved memory record of this project by its node id with read_evidence, and page through a long tool result of this conversation with read_tool_result, so a card may point them at a conversation message or tool result as its source. Neither searches memory.",
  "- Keep work that needs anything else (a change to an outside service or git state, credentials, a person's decision or action) out of the cards. Do it yourself when your tools and the permission mode allow it; otherwise name it in the Plan's risks as left to the user.",
  "- Word each acceptance criterion so a verifier can check it by reading files or running a code skill. When a check needs a command no code skill of the project runs yet, say in that card that its agent saves one, so the verifier can run it.",
].join("\n");
