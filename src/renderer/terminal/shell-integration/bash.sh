# FormatPad shell integration for bash.
# Emits VS Code-style OSC 633 markers without persisting command output.

__formatpad_prompt() {
  local status=$?
  printf '\033]633;D;%s\a' "$status"
  printf '\033]633;P;Cwd=%s\a' "$PWD"
}

__formatpad_preexec() {
  case "$BASH_COMMAND" in
    __formatpad_*|*'633;'*) return ;;
  esac
  printf '\033]633;A\a'
  printf '\033]633;B\a'
  printf '\033]633;C\a'
}

trap '__formatpad_preexec' DEBUG
PROMPT_COMMAND="__formatpad_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
