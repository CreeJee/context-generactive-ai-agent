#!/bin/sh
# git-status-brief: one-screen view of local git state: status, diff stats, recent commits.
# Usage: git-status-brief [commit-count]   (default: 10)
# Runs in the project root (run_skill's working directory), which holds .git.
set -u
n="${1:-10}"
case "$n" in *[!0-9]*|"") n=10 ;; esac
echo "== branch & status =="
git status --short --branch
echo "== unstaged diff stat =="
git diff --stat | tail -15
echo "== staged diff stat =="
git diff --cached --stat | tail -15
echo "== last $n commits =="
git log --oneline "-$n"
