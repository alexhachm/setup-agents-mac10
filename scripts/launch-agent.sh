#!/usr/bin/env bash
# Launch a Claude agent in the specified project directory.
# Usage: launch-agent.sh <project-dir> <model> <slash-command>
# Avoids semicolons so Windows Terminal doesn't split the command.
set -eu

DIR="$1"
MODEL="$2"
CMD="$3"

cd "$DIR" || exit 1
claude --model "$MODEL" "$CMD"
exec bash
