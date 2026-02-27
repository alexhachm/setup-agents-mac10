#!/usr/bin/env bash
# Pre-tool hook: blocks access to files that likely contain secrets.
# Reads the tool input from stdin (JSON with tool_name and tool_input).

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

# Extract file path depending on tool
FILE_PATH=""
case "$TOOL_NAME" in
  Read|Write|Edit)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    # Check if command references sensitive files
    for pattern in '.env' 'secrets' 'credentials' '.pem' '.key' 'id_rsa' '.secret' 'private_key' 'token'; do
      if echo "$COMMAND" | grep -qi "$pattern"; then
        echo "BLOCKED: Command references potentially sensitive file pattern: $pattern" >&2
        exit 2
      fi
    done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac

[ -z "$FILE_PATH" ] && exit 0

# Check file path against sensitive patterns
BASENAME=$(basename "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
for pattern in '.env' 'secrets' 'credentials' '.pem' '.key' 'id_rsa' '.secret' 'private_key'; do
  case "$BASENAME" in
    *"$pattern"*)
      echo "BLOCKED: Access to sensitive file: $FILE_PATH (matched pattern: $pattern)" >&2
      exit 2
      ;;
  esac
done

exit 0
