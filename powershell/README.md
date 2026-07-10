# `pii` PowerShell project picker

`pii` is a fast fuzzy picker for working directories found in local [pi](https://github.com/badlogic/pi-mono) coding-agent sessions.

## Install

Clone this repository as `~/.pi`, then add this to every PowerShell profile that should provide `pii`:

```powershell
$sharedPii = Join-Path $HOME ".pi\powershell\pii.ps1"
if (Test-Path -LiteralPath $sharedPii) {
    . $sharedPii
}
```

Find the active profile with `$PROFILE`. On Windows, PowerShell 7 and Windows PowerShell 5.1 use different profile files, but both can load this same script.

Reload the current profile after editing it:

```powershell
. $PROFILE
```

## Usage

```powershell
pii
```

- Type to fuzzy-filter paths.
- Use Up/Down, Page Up/Page Down, Home, or End to move.
- Press Enter to change to the selected directory.
- Press Escape or Ctrl+C to close.
- Backspace deletes one character.
- Ctrl+Backspace or Ctrl+W deletes a query segment.
- Delete or Ctrl+U clears the query.

Use `pii -List` to print the indexed projects without opening the picker. Use `pii -RebuildCache` if its local cache ever needs rebuilding.

## Privacy

The script contains no credentials or machine-specific paths and is safe to publish. It reads only the first metadata line of local pi session files and never uploads anything. Its generated cache is written outside the repository to `%LOCALAPPDATA%\pii\project-cwds-v2.json`; that cache can contain local project paths and should remain private.
