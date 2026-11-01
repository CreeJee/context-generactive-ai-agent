---
name: fetch-page-text
description: "Fetches a web page with curl and prints its readable text (scripts/styles removed, tags stripped, capped), plus same-site links. Use to research an external product, docs page or GitHub README whose host is allowed in this skill's network list (delta.dev, tryboxi.xyz, github.com, raw.githubusercontent.com)."
---

args: <url> [maxChars=12000]. Prints HTTP status and final URL, the page's links (to find docs/pricing/github pages), then stripped text. Only hosts in the network list are reachable.

Run with the `run_skill` tool (name `fetch-page-text`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
