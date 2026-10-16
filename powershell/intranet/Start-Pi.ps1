[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PiDirectory,

    [string]$WorkingDirectory = "$env:SystemDrive\"
)

$ErrorActionPreference = "Stop"
$administrator = $false

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $administrator) {
        # Read the script before elevation. The elevated logon may not have the
        # network connection that Explorer used to open the launcher.
        $script = [IO.File]::ReadAllText($PSCommandPath)
        $quotedPiDirectory = $PiDirectory.Replace("'", "''")
        $quotedWorkingDirectory = $WorkingDirectory.Replace("'", "''")
        $command = "& {`n$script`n} -PiDirectory '$quotedPiDirectory' -WorkingDirectory '$quotedWorkingDirectory'"
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $powershell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $process = Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru `
            -WorkingDirectory $env:SystemRoot `
            -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand)
        exit $process.ExitCode
    }

    $PiDirectory = [IO.Path]::GetFullPath($PiDirectory)
    $agentDirectory = Join-Path $PiDirectory "profile\agent"
    $runtimeDirectory = Join-Path $PiDirectory "runtime"
    $node = Join-Path $runtimeDirectory "node.exe"
    $pi = Join-Path $runtimeDirectory "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"

    Write-Host "Running elevated as $($identity.Name)"

    if (-not [IO.Directory]::Exists($agentDirectory) -and $PiDirectory -match '^(\\\\[^\\]+\\[^\\]+)') {
        $share = $Matches[1]
        Write-Host "The elevated account cannot read $agentDirectory."
        $networkUser = Read-Host "Domain user for $share (Enter to cancel)"
        if ([string]::IsNullOrWhiteSpace($networkUser)) {
            throw "Network authentication cancelled."
        }

        # net.exe prompts for the password without exposing it in arguments.
        # Do not save the connection for later Windows logons.
        & "$env:SystemRoot\System32\net.exe" use $share "*" "/user:$networkUser" "/persistent:no"
        if ($LASTEXITCODE -ne 0) {
            throw "Network authentication failed. Existing connections may use a different account."
        }
    }

    if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($pi)) {
        throw "Cannot read the portable Node.js runtime or Pi CLI in $runtimeDirectory. Check the installation and permissions."
    }
    if (-not [IO.File]::Exists((Join-Path $agentDirectory "settings.json"))) {
        throw "Cannot read settings.json in $agentDirectory. Complete the profile setup first."
    }

    $env:PI_CODING_AGENT_DIR = $agentDirectory
    $env:PATH = "$runtimeDirectory;$env:PATH"
    $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $env:PI_CODING_AGENT_SESSION_DIR = Join-Path $localData "Pi-Intranet\sessions"
    [IO.Directory]::CreateDirectory($env:PI_CODING_AGENT_SESSION_DIR) | Out-Null

    Set-Location -LiteralPath $WorkingDirectory
    Write-Host "Runtime: portable Node.js"
    Write-Host "Profile: $agentDirectory"
    Write-Host "Sessions: $env:PI_CODING_AGENT_SESSION_DIR"
    & $node $pi
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Read-Host "Pi exited with code $exitCode. Press Enter to close" | Out-Null
    }
    exit $exitCode
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host "Press Enter to close" | Out-Null
    exit 1
}
