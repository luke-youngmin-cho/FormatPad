# OrPAD shell integration for bash.
# Emits VS Code-style OSC 633 markers without persisting command output.

__orpad_prompt() {
  local status=$?
  printf '\033]633;D;%s\a' "$status"
  printf '\033]633;P;Cwd=%s\a' "$PWD"
}

__orpad_preexec() {
  case "$BASH_COMMAND" in
    __orpad_*|*'633;'*) return ;;
  esac
  printf '\033]633;A\a'
  printf '\033]633;B\a'
  printf '\033]633;C\a'
}

trap '__orpad_preexec' DEBUG
PROMPT_COMMAND="__orpad_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
