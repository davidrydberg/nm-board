# Records assets/demo.gif, the demo at the top of the README.
# From the repository root: npm run build && vhs assets/demo.tape
#
# vhs records a plain terminal, not herdr, so Enter shows the run full screen.
# Inside herdr the same view opens in a popup over the board.
# The fleet is nm-watch's built-in synthetic one, so nothing here is real.

Output assets/demo.gif
Require node

Set Shell "bash"
Set FontSize 13
Set Width 1600
Set Height 600
Set Padding 20
Set TypingSpeed 75ms

# Leaving herdr's variables set would open the popup in the recording
# machine's own herdr session.
Hide
Type "unset HERDR_ENV HERDR_SOCKET_PATH; PS1='$ '; alias nm-watch='node dist/cli.js'; clear"
Enter
Show

Sleep 500ms
Type "nm-watch --demo"
Sleep 600ms
Enter
Sleep 3s

# Move to the run waiting on a decision and open it.
Right
Sleep 900ms
Down
Sleep 900ms
Up
Sleep 900ms
Enter
Sleep 3.5s
Down
Sleep 1.5s

# Esc closes the run's view and returns to the board; the run keeps going.
Escape
Sleep 3s
