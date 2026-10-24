---
name: "app-settings"
description: "Where this app (context-agent) keeps its own settings: external ACP agents, MCP servers, skills, the model and web search. Read before adding or changing any of them, or when the user asks where a setting lives."
---

# This app's settings

The storage root is named in the workspace instructions. The first file of each pair applies to
every project, the second to the current one:

- External ACP agents: `<storage root>/agents.json`, `<project>/.agents/agents.json`
- MCP servers: `<storage root>/mcp.json`, `<project>/.mcp.json`
- Skills (one folder with a SKILL.md each): `~/.agents/skills`, `<project>/.agents/skills`
- App settings such as the model and web search: `<storage root>/config.json`

Settings in the project can be changed with the file tools. The storage root also holds the
account login and the memory database, so neither the file tools nor shell skill scripts open it:
for a file there, show the user the exact change to make. Never print keys or tokens these files
hold.

An agent or MCP server that is added or changed does nothing until the user trusts it in the app's
settings.
