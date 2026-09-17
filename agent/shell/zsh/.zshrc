ZDOTDIR="$RT_USER_ZDOTDIR"
# /etc/zshrc picked HISTFILE while ZDOTDIR still pointed at this directory.
[[ "$HISTFILE" == "$RT_ZDOTDIR"/* ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
[[ -f "$RT_ZDOTDIR/remote-term.zsh" ]] && source "$RT_ZDOTDIR/remote-term.zsh"
# Hand ZDOTDIR back (zsh reads .zlogin from wherever it points now) and leave no trace in the
# environment that child shells inherit.
if [[ "$RT_USER_ZDOTDIR" == "$HOME" ]]; then
  unset ZDOTDIR
else
  export ZDOTDIR="$RT_USER_ZDOTDIR"
fi
unset RT_ZDOTDIR RT_USER_ZDOTDIR
