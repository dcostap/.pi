---
name: windows-notify-user
description: Send a Windows 11 desktop toast notification to the user via PowerShell BurntToast. Use when the user asks to be notified, alerted, pinged, or when a long-running task finishes and the user wants a desktop notification.
compatibility: Windows 11 with PowerShell and the BurntToast module installed for the current user.
---

# Windows Notify User

Use this skill to notify the user with a Windows desktop toast notification.

## Command

Run this through the `bash` tool, replacing the title and message:

```bash
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '[Environment]::SetEnvironmentVariable("PSModulePath", "$env:USERPROFILE\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$env:WINDIR\system32\WindowsPowerShell\v1.0\Modules", "Process"); Import-Module BurntToast; New-BurntToastNotification -Text "Title", "Message"'
```

## Usage guidance

- Use a short, clear title.
- Use a concise message explaining what completed or needs attention.
- Do not use this repeatedly or spam notifications.
- If notification delivery fails because `BurntToast` is missing, install it with:

```bash
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '[Environment]::SetEnvironmentVariable("PSModulePath", "$env:USERPROFILE\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$env:WINDIR\system32\WindowsPowerShell\v1.0\Modules", "Process"); Import-Module PowerShellGet -Force; Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force; Install-Module BurntToast -Scope CurrentUser -Force -AllowClobber'
```
