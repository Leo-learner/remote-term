# Marks the remote-term agent reads from the output stream (terminals ignore unknown ones):
#   OSC 133;C            a command starts        OSC 133;D;<status>   it finished
#   OSC 133;A            a prompt is drawn       OSC 7;file://host/cwd
#   OSC 6973;cmd;<text>  the command line, percent-encoded and cut to 200 characters
# zsh restores $? and $pipestatus before each precmd hook, so the prompt (starship) is unaffected.

__rt_encode() {
  emulate -L zsh
  local LC_ALL=C input="$1" output="" char
  local -i i
  for (( i = 1; i <= ${#input}; i++ )); do
    char="${input[i]}"
    case "$char" in
      [A-Za-z0-9/._~-]) output+="$char" ;;
      *) output+="$(printf '%%%02X' "'$char")" ;;
    esac
  done
  print -rn -- "$output"
}

__rt_precmd() {
  local rt_status=$?
  if [[ -n "$__rt_command_running" ]]; then
    printf '\e]133;D;%s\a' "$rt_status"
    unset __rt_command_running
  fi
  printf '\e]7;file://%s%s\a' "${HOST}" "$(__rt_encode "$PWD")"
  printf '\e]133;A\a'
}

__rt_preexec() {
  __rt_command_running=1
  printf '\e]6973;cmd;%s\a' "$(__rt_encode "${1[1,200]}")"
  printf '\e]133;C\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __rt_precmd
add-zsh-hook preexec __rt_preexec
