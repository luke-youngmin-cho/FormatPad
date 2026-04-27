# OrPAD shell integration for Windows PowerShell.
# The renderer starts command blocks on Enter and closes them when prompt runs.

$global:OrPADOriginalPrompt = $function:prompt

function global:prompt {
  $exitCode = if ($?) { 0 } else { 1 }
  [Console]::Out.Write("$([char]27)]633;D;$exitCode$([char]7)")
  [Console]::Out.Write("$([char]27)]633;P;Cwd=$($PWD.Path)$([char]7)")
  if ($global:OrPADOriginalPrompt) {
    & $global:OrPADOriginalPrompt
  } else {
    "PS $($executionContext.SessionState.Path.CurrentLocation)> "
  }
}

[Console]::Out.Write("$([char]27)]633;P;Cwd=$($PWD.Path)$([char]7)")
