#!/bin/sh
set -eu

tracked_ignored=$(git ls-files --cached --ignored --exclude-from=.gitignore)
if [ -n "$tracked_ignored" ]; then
    echo "The Git index contains ignored files. Inspect the staged paths locally before publishing." >&2
    exit 1
fi
