# FormatPad shell integration for zsh.
# Uses preexec/precmd hooks to expose command boundaries to the renderer.

autoload -Uz add-zsh-hook

__formatpad_preexec() {
  printf '\033]633;A\a'
  printf '\033]633;B\a'
  printf '\033]633;C\a'
}

__formatpad_precmd() {
  local status=$?
  printf '\033]633;D;%s\a' "$status"
  printf '\033]633;P;Cwd=%s\a' "$PWD"
}

add-zsh-hook preexec __formatpad_preexec
add-zsh-hook precmd __formatpad_precmd
