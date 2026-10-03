# Transcript navigation

Press **F2** in Pi's fullscreen prompt to open a read-only transcript view.
Press **F2** or **Escape** to return to the prompt.

| Key | Action |
| --- | --- |
| Arrow keys | Move the cursor |
| Ctrl/Alt+Left/Right | Move by word |
| Home/End | Move to the line start/end |
| Ctrl+Home/End | Move to the transcript start/end |
| PageUp/PageDown | Move by page |
| Shift with a movement key | Select text |
| Ctrl+A | Select all text |
| Ctrl+C | Copy selected text |

The view copies Pi's rendered transcript buffer when you press F2.
It includes visible tool results and folded sections as Pi renders them.
It keeps colors, text styles, and links. It replaces inline images with `[image]`.
Cursor movement and copying use plain text.
It does not expand folded sections.

The copy stays fixed while the agent continues. Open it again to see new output.
The prompt text, cursor, and selection remain unchanged.
Typing, deletion, paste, and Enter have no effect in this view.

Pi 1.0 exposes no public transcript-buffer getter.
`snapshot.ts` contains the only private API access: `currentLayout`.
The extension uses Pi's public overlay API. It does not patch input or rendering methods.
