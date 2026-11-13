#!/bin/bash
set -euo pipefail
base="${1:?base revision required}"
head="${2:-HEAD}"
git diff --name-status "$base...$head"
