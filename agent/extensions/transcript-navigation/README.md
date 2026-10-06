# Transcript navigation

Press **F2** in Pi's fullscreen prompt to open a read-only transcript view.
The view selects the latest user or assistant text block in the current viewport.
It marks the leftmost cell of each block line, like a column of cursors.
It keeps the text intact and does not highlight the whole block.
Ctrl+C still copies the whole block.
Right-click also copies the block or the selected caret text.

## Block selection

| Key | Action |
| --- | --- |
| Up/Down | Select the previous/next text block |
| Ctrl+C | Copy the whole selected block |
| F2 | Switch to caret navigation at the block start |
| Escape | Close the view and keep its scroll position in the normal transcript |

Block navigation skips reasoning, tool calls, tool results, and empty blocks.
It stops at the first and last blocks. It does not wrap.
If no text block is visible, it selects the block closest to the viewport end.
If no text blocks exist, F2 still opens caret navigation.

The view centers the selected block vertically, within the transcript limits.
It adjusts the space above and below when you select a block or resize the terminal.
For blocks taller than the viewport, it puts the beginning at the top.
Copy includes the whole block, even when part of it is outside the viewport.

The mouse wheel scrolls by line in both modes, without changing the selected text.
It uses Pi's wheel speed, acceleration, and Alt+wheel setting.
The view does not move back to the caret after wheel scrolling.
Keyboard navigation brings the selected block or caret back into view.

Pi joins user text content for display. The view treats that displayed user message as one block.
Each assistant text content block remains separate.

## Caret navigation

The caret can move anywhere in the transcript, including tools and reasoning.
It uses the terminal cursor when Pi enables it. Otherwise, it draws a caret.

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
| F2 or Escape | Return to block selection |

When you return to block selection, the view selects the block containing the caret.
If the caret is outside a text block, it selects the closest block.
Press Escape again to return to the prompt.

## Display and state

The view copies Pi's rendered transcript buffer when you press F2.
It includes visible tool results and folded sections as Pi renders them.
It keeps colors, text styles, and links. It replaces inline images with `[image]`.
Cursor movement and copying use plain text.
It does not expand folded sections.

The copy stays fixed while the agent continues. Open it again to see new output.
The prompt text, cursor, and selection remain unchanged.
The normal transcript keeps the viewed text at the same screen position, within its scroll limits.
New output does not pull the view to the end. Use normal scrolling to return to the end.
Typing, deletion, paste, and Enter have no effect in this view.

Native mouse text selection remains available and takes priority when you right-click.
It follows Pi's `fullscreenCopyOnSelect` setting.
With automatic copy off, right-click copies the native selection.
With automatic copy on, Pi copies it on mouse release; right-click does not copy it again.
Right-click without a native selection copies the F2 selection in either setting.
It never pastes into the read-only view.

Pi 1.0 exposes no public transcript-buffer or text-block getter.
`snapshot.ts` contains all private API access: `currentLayout` and cached component child heights.
It reads block positions from rendered user and assistant components, not text matching.
The extension uses Pi's public overlay API. It does not patch input or rendering methods.
