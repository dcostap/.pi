# Elevated network Pi

Use a network installation with a separate clone of this configuration repo.
Keep the clone on its local `intranet` branch.
Keep credentials outside Git.
Put the public launcher in `pi-launcher`, beside the private `pi` directory.

## Before deployment

Check share permissions and restrict this folder's NTFS permissions before using this launcher.
Do not change permissions for the entire software share.
Allow your domain account and the required system and administrator accounts.
Other users must not have write access to the executable, scripts, or profile.

Create the separate `pi-launcher` folder before copying the launcher files.
Disable permission inheritance on that folder.
Give Everyone Read and Execute access only.
Preserve system, administrator, and your maintenance account's write access.
Do not put credentials, the executable, or the profile in that public folder.

Explorer normally uses the logged-in user's domain credentials for network access.
Denying access to the private folder does not request another identity.
The public launcher requests elevation before accessing private files.

The launcher runs code from that folder with local administrator permissions.
Folder permissions do not protect credentials from administrators or malware on the client PC.

Commit the portable configuration changes before cloning the repo.
Use a network Pi version that supports your current extensions.
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
$gitTrust = "safe.directory=$($profile.Replace('\', '/'))"
git -c $gitTrust -C $profile remote set-url origin $origin
git -c $gitTrust -C $profile switch -c intranet
```

The command-scoped trust allows Git to use a share whose owner is the server's administrator group.
It does not change global Git settings or trust other folders.

Edit `profile/agent/settings.json` on that branch:

- Set `defaultTools` to `["read", "powershell", "edit", "write"]`.
- Set `defaultProjectTrust` to `"ask"`.
- Add `"-extensions/background-processes/index.ts"` to `extensions`. That extension requires Bash.

Keep the other settings unchanged. Commit these changes on `intranet`.
This branch can remain local. Do not push it unless you want to publish it.

Install extension dependencies from your PC:

```powershell
$stage = Join-Path $env:TEMP ("pi-deps-" + [guid]::NewGuid())
try {
    foreach ($extension in 'ssh-session', 'web-smart-fetch') {
        $destination = Join-Path $profile "agent\extensions\$extension"
        $local = Join-Path $stage $extension
        New-Item -ItemType Directory -Path $local -Force | Out-Null
        Copy-Item (Join-Path $destination 'package*.json') $local
        if (Test-Path (Join-Path $destination '.npmrc')) {
            Copy-Item (Join-Path $destination '.npmrc') $local
        }
        npm --prefix $local ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $extension" }
        robocopy "$local\node_modules" "$destination\node_modules" /MIR /COPY:DAT /R:2 /W:1
        if ($LASTEXITCODE -ge 8) { throw "Dependency copy failed: $extension" }
    }
} finally {
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
$public = Join-Path (Split-Path $target -Parent) 'pi-launcher'
foreach ($file in 'Start-Pi.cmd', 'Start-Pi.ps1') {
    Copy-Item (Join-Path $profile "powershell\intranet\$file") $public
}
```

Install locally because npm can fail on UNC paths.
Only mirror the generated `node_modules` folders. Do not mirror the entire profile.

The target layout is:

```text
pi-launcher/                    # public read-only entry point
  Start-Pi.cmd
  Start-Pi.ps1
pi/                             # private installation and profile
  pi.exe
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

Open `pi-launcher` in Explorer and run `Start-Pi.cmd`.
Windows requests administrator approval or credentials before Pi accesses the private folder.
Choose your domain administrator account when Windows requests credentials.
Your account must have administrator rights on that PC.
If Windows requests approval only, it keeps the current Windows identity.
Use `runas /user:"DOMAIN\YourUser" cmd.exe` first when you need a different identity in that case.
Run the public launcher from that command window.

Run `/login openai-codex` in Pi.
Pi saves and refreshes credentials in `profile/agent/auth.json`.
Provider revocation or expired credentials can require another login.
Use `/model` to select your Codex model after signing in.
Codex model discovery may require this first sign-in.

Configure `/fast-model` once if you need the extensions that use that model role.
Add other provider credentials only when those features need them.
For Firecrawl, put `web-smart-fetch.json` beside `profile/agent`, not inside it.

## Daily use

Run `Start-Pi.cmd`. Pi and its commands run elevated.
Use the copy in the public `pi-launcher` folder, not the private installation.
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
$gitTrust = "safe.directory=$($profile.Replace('\', '/'))"
git -c $gitTrust -C $profile fetch origin
git -c $gitTrust -C $profile merge origin/main
```

Resolve conflicts without discarding the `intranet` settings.
Do not use `git clean -x`; it can delete ignored credentials.
Install dependencies again when their lockfiles change.
Copy both launcher files to `pi-launcher` again when their source changes.
Update the complete Pi installation separately when needed.
