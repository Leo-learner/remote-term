# remote-term shell integration. zsh reads its startup files from $ZDOTDIR, which points here
# only while the shell starts: each file loads the owner's own file first, and .zshrc hands
# ZDOTDIR back, so history, completions and child shells behave exactly as in any terminal.
RT_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="${RT_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
RT_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$RT_ZDOTDIR"
