# Elevated network Pi

Use a network installation with a separate clone of this configuration repo.
Keep the clone on its local `intranet` branch.
Keep credentials outside Git.

## Before deployment

Check share permissions and restrict this folder's NTFS permissions before using this launcher.
Do not change permissions for the entire software share.
Allow your domain account and the required system and administrator accounts.
Other users must not have write access to the executable, scripts, or profile.

The launcher runs code from that folder with local administrator permissions.
Folder permissions do not protect credentials from administrators or malware on the client PC.

Commit the portable configuration changes before cloning the repo.
Update the network Pi installation to the same version as your working installation.
Copy the complete installation, not only `pi.exe`.
Do not update files while network Pi processes are running.

## Create the network clone

Run these commands from your own PC. Replace the target path.

```powershell
$target = '\\server\share\pi'
$source = Join-Path $HOME '.pi'
$profile = Join-Path $target 'profile'
$origin = git -C $source remote get-url origin
git clone --no-hardlinks $source $profile
git -C $profile remote set-url origin $origin
git -C $profile switch -c intranet
```

Edit `profile/agent/settings.json` on that branch:

- Set `defaultTools` to `["read", "powershell", "edit", "write"]`.
- Set `defaultProjectTrust` to `"ask"`.
- Add `"-extensions/background-processes"` to `extensions`. That extension requires Bash.

Keep the other settings unchanged. Commit these changes on `intranet`.
This branch can remain local. Do not push it unless you want to publish it.

Install extension dependencies from your PC:

```powershell
Push-Location (Join-Path $profile 'agent\extensions\ssh-session')
try { npm ci --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
Push-Location (Join-Path $profile 'agent\extensions\web-smart-fetch')
try { npm ci --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
Copy-Item (Join-Path $profile 'powershell\intranet\Start-Pi.cmd') (Join-Path $target 'Start-Pi.cmd')
```

The target layout is:

```text
pi/
  pi.exe
  Start-Pi.cmd
  ...other Pi installation files...
  profile/
    .git/
    powershell/intranet/Start-Pi.ps1
    agent/
      settings.json
      extensions/
      auth.json                 # ignored
      model-roles.local.json    # ignored
    web-smart-fetch.json        # ignored
```

## Sign in once

Open the protected folder in Explorer and run `Start-Pi.cmd`.
Choose your domain administrator account in the UAC prompt.
Your account must have administrator rights on that PC.

Run `/login openai-codex` in Pi.
Pi saves and refreshes credentials in `profile/agent/auth.json`.
Provider revocation or expired credentials can require another login.

Configure `/fast-model` once if you need the extensions that use that model role.
Add other provider credentials only when those features need them.
For Firecrawl, put `web-smart-fetch.json` beside `profile/agent`, not inside it.

## Daily use

Run `Start-Pi.cmd`. Pi and its commands run elevated.
The launcher shows the Windows identity before starting Pi.
It uses the network profile and keeps sessions in local application data.
It starts in the local system drive root, not the shared configuration repo.

If elevation loses network access, the launcher requests network credentials again.
Windows handles the password prompt. The launcher does not save the password.
The network connection remains available in that Windows logon session.
It does not become a persistent connection for future logons.

Git, Chrome, Everything, and other external programs still need local installation when a feature requires them.
The launcher does not install software or silently grant permissions.

## Update

Commit and push changes from your normal branch first.
Stop network Pi processes before updating their files.
Run these commands from your own PC:

```powershell
$target = '\\server\share\pi'
$profile = Join-Path $target 'profile'
git -C $profile fetch origin
git -C $profile merge origin/main
```

Resolve conflicts without discarding the `intranet` settings.
Do not use `git clean -x`; it can delete ignored credentials.
Install dependencies again when their lockfiles change.
Copy `Start-Pi.cmd` again when its source changes.
Update the complete Pi installation separately when needed.
