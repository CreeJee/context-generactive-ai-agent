import { HashSet } from "effect";

/**
 * What a kanban card's agent and its verifiers can do. The card agent and the verifiers get the
 * same tools, filtered by these names, and the planner reads the same abilities as text, so a Plan
 * only holds cards their agents can carry out and checks their verifiers can run. Both also get the
 * read-only tools of the project's MCP servers, and a verifier gets record_card_verdict on top.
 */
export const cardToolNames = HashSet.fromIterable([
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
  "find_skill",
  "read_skill",
  "read_evidence",
  "read_tool_result",
]);

/** The abilities above as the planner reads them, with what they mean for the cards it writes. */
export const cardCapabilities = [
  "What card agents and verifiers can do; write only cards they can carry out and checks they can run:",
  "- A card agent works in a folder of its own. It reads, writes, edits and deletes files there and reads files elsewhere on the computer; writing outside its folder asks first.",
  '- It runs host commands in a sandbox. A command that only looks, such as read-only git, runs at once with run_command and access "read", which can change nothing. Commands that change files or need the network, such as tests, builds or package installs, ask for approval as the permission mode says: each call of run_command with access "write", or, for a program of several steps that one command line cannot hold, once for a code skill it saves with save_code_skill and then runs with run_skill. A script reaches the network only for the hosts it was approved with.',
  "- It starts with the project's command list (how the project runs its tests, build and checks) when the project has one, and adds to it with save_project_commands. A verifier gets the same tools, reads the same list and runs its lines the same way.",
  "- It and a verifier start with the project's term list (what words mean in this project) when the project has one. Neither can change it: write a card's text with the listed terms, and save a term the cards need with save_project_terms before the Plan.",
  "- It finds the project's skills with find_skill and reads them with read_skill, so a card can follow a skill the project already keeps; the catalog is read from the folder the card works in.",
  "- Of the project's MCP servers it calls only the read-only tools. It cannot change an outside service (publish, deploy, post, open pull requests, write through MCP), change git state, or ask the user.",
  "- A verifier has the card agent's tools, runs checks from the project's command list, finds and reads the same skills, and calls the same read-only MCP tools. It does not fix the work it judges: when it changes the work's files, its verdict does not pass.",
  "- Both read a saved memory record of this project by its node id with read_evidence, and page through a long tool result of this conversation with read_tool_result, so a card may point them at a conversation message or tool result as its source. Neither searches memory.",
  "- Keep work that needs anything else (a change to an outside service or git state, credentials, a person's decision or action) out of the cards. Do it yourself when your tools and the permission mode allow it; otherwise name it in the Plan's risks as left to the user.",
  "- Word each acceptance criterion so a verifier can check it by reading files or running a command of the project's command list. When a check needs a command the list lacks, say in that card that its agent adds it to the list.",
].join("\n");
