// PADIFY FORK — the toggleShortcuts action is deleted at the source level.
//
// The dist-patch era removed this registration from the compiled bundle so
// the vendor's own help dialog ("?" chord, help row, footer "?") could not
// fire; padify owns the one help surface (the app's shortcuts sheet — see
// the app's canvas.ts main-menu composition: the "Keyboard shortcuts" row
// dispatches padify:open-shortcuts). The whole help surface is deleted as
// REVIEWABLE source edits across this tree: the Help DefaultItem, the
// footer's HelpButton, the WelcomeScreen HelpHint/MenuItemHelp, the
// HelpDialog mount in LayerUI, and the "?" / CtrlOrCmd+P handlers in App.
//
// The file stays (not an empty deletion) so the import graph and the
// action registry keep compiling; upstream's version is in git history
// one commit below.
