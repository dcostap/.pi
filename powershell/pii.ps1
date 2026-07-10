function pii {
    [CmdletBinding()]
    param(
        [switch]$List,
        [switch]$RebuildCache
    )

    $sessionRoot = Join-Path $HOME ".pi\agent\sessions"
    if (-not [IO.Directory]::Exists($sessionRoot)) {
        Write-Warning "No pi sessions directory found at $sessionRoot"
        return
    }

    # Cache only the stable project-directory -> cwd mapping. Session files are
    # still enumerated on every run, but their large JSONL contents are not read.
    $cacheBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [IO.Path]::GetTempPath() }
    $cacheDirectory = Join-Path $cacheBase "pii"
    $cachePath = Join-Path $cacheDirectory "project-cwds-v2.json"
    $directoryCache = @{}
    $cacheDirty = [bool]$RebuildCache

    if (-not $RebuildCache -and [IO.File]::Exists($cachePath)) {
        try {
            $cachedItems = @(Get-Content -LiteralPath $cachePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
            foreach ($item in $cachedItems) {
                if ($item.Directory -and $item.Cwd) {
                    $directoryCache[[string]$item.Directory] = [string]$item.Cwd
                }
            }
        } catch {
            $directoryCache = @{}
            $cacheDirty = $true
        }
    }

    $activeDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $cacheRows = [Collections.Generic.List[object]]::new()
    $projectGroups = @{}

    try {
        foreach ($directory in [IO.Directory]::EnumerateDirectories($sessionRoot)) {
            $conversationCount = 0
            $latestPath = $null
            $latestName = ""

            foreach ($path in [IO.Directory]::EnumerateFiles($directory, "*.jsonl", [IO.SearchOption]::TopDirectoryOnly)) {
                $conversationCount++
                $name = [IO.Path]::GetFileName($path)
                if (-not $latestPath -or [string]::Compare($name, $latestName, [StringComparison]::OrdinalIgnoreCase) -gt 0) {
                    $latestPath = $path
                    $latestName = $name
                }
            }

            if (-not $latestPath) { continue }
            [void]$activeDirectories.Add($directory)

            $cwd = $directoryCache[$directory]
            if ([string]::IsNullOrWhiteSpace($cwd)) {
                try {
                    $reader = [IO.File]::OpenText($latestPath)
                    try {
                        $firstLine = $reader.ReadLine()
                    } finally {
                        $reader.Dispose()
                    }
                    $session = $firstLine | ConvertFrom-Json -ErrorAction Stop
                    $cwd = [string]$session.cwd
                    if ([string]::IsNullOrWhiteSpace($cwd)) { continue }
                    $cacheDirty = $true
                } catch {
                    continue
                }
            }

            $cacheRows.Add([pscustomobject]@{
                Directory = $directory
                Cwd = $cwd
            })

            $lastSessionTime = [IO.File]::GetLastWriteTime($latestPath)
            if ($projectGroups.ContainsKey($cwd)) {
                $group = $projectGroups[$cwd]
                $group.ConversationCount += $conversationCount
                if ($lastSessionTime -gt $group.LastSessionTime) {
                    $group.LastSessionTime = $lastSessionTime
                }
            } else {
                $projectGroups[$cwd] = [pscustomobject]@{
                    Cwd = $cwd
                    ConversationCount = $conversationCount
                    LastSessionTime = $lastSessionTime
                }
            }
        }
    } catch {
        Write-Error "Could not scan pi sessions: $($_.Exception.Message)"
        return
    }

    if ($directoryCache.Count -ne $activeDirectories.Count) {
        $cacheDirty = $true
    } else {
        foreach ($oldDirectory in $directoryCache.Keys) {
            if (-not $activeDirectories.Contains([string]$oldDirectory)) {
                $cacheDirty = $true
                break
            }
        }
    }

    if ($cacheDirty) {
        try {
            [IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
            $temporaryPath = "$cachePath.$([guid]::NewGuid().ToString('N')).tmp"
            $json = @($cacheRows) | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporaryPath -Destination $cachePath -Force
        } catch {
            if ($temporaryPath -and [IO.File]::Exists($temporaryPath)) {
                Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
            }
            # A cache failure should never prevent the picker from opening.
        }
    }

    $projects = @($projectGroups.Values | Sort-Object LastSessionTime -Descending)

    if ($List) {
        $projects | Select-Object Cwd, ConversationCount, LastSessionTime
        return
    }

    if ($projects.Count -eq 0) {
        Write-Warning "No pi projects found in $sessionRoot"
        return
    }

    function Test-PiiFuzzyMatch([string]$Text, [string]$Pattern) {
        if ([string]::IsNullOrEmpty($Pattern)) { return $true }
        $textIndex = 0
        for ($patternIndex = 0; $patternIndex -lt $Pattern.Length; $patternIndex++) {
            $needle = [string]$Pattern[$patternIndex]
            $foundAt = $Text.IndexOf($needle, $textIndex, [StringComparison]::OrdinalIgnoreCase)
            if ($foundAt -lt 0) { return $false }
            $textIndex = $foundAt + 1
        }
        return $true
    }

    function Format-PiiAge([datetime]$Time, [datetime]$Now) {
        $span = $Now - $Time
        if ($span.TotalSeconds -lt 0 -or $span.TotalMinutes -lt 1) { return "just now" }
        if ($span.TotalHours -lt 1) {
            $n = [Math]::Floor($span.TotalMinutes)
            return "${n}m ago"
        }
        if ($span.TotalDays -lt 1) {
            $n = [Math]::Floor($span.TotalHours)
            return "${n}h ago"
        }
        if ($span.TotalDays -lt 30) {
            $n = [Math]::Floor($span.TotalDays)
            return "${n}d ago"
        }
        if ($span.TotalDays -lt 365) {
            $n = [Math]::Floor($span.TotalDays / 30)
            return "${n}mo ago"
        }
        $n = [Math]::Floor($span.TotalDays / 365)
        return "${n}y ago"
    }

    function Limit-PiiText([string]$Text, [int]$Width) {
        if ($Width -le 0) { return "" }
        if ($Text.Length -le $Width) { return $Text }
        if ($Width -le 3) { return $Text.Substring(0, $Width) }
        return $Text.Substring(0, $Width - 3) + "..."
    }

    $query = ""
    $selected = 0
    $offset = 0
    $destination = $null
    $done = $false

    $esc = [char]27
    $cyan = "$esc[36m"
    $yellow = "$esc[33m"
    $white = "$esc[37m"
    $darkGray = "$esc[90m"
    $reset = "$esc[0m"

    $alternateBufferActive = $false
    try {
        # An alternate screen makes the picker feel like a popup and restores the
        # previous terminal contents exactly when it closes.
        [Console]::Write("$esc[?1049h$esc[H$esc[?25l")
        $alternateBufferActive = $true

        while (-not $done) {
            if ([string]::IsNullOrEmpty($query)) {
                $matches = $projects
            } else {
                $filtered = [Collections.Generic.List[object]]::new()
                foreach ($project in $projects) {
                    if (Test-PiiFuzzyMatch $project.Cwd $query) {
                        $filtered.Add($project)
                    }
                }
                $matches = @($filtered)
            }

            if ($matches.Count -eq 0) {
                $selected = 0
                $offset = 0
            } else {
                $selected = [Math]::Max(0, [Math]::Min($selected, $matches.Count - 1))
            }

            $windowWidth = [Math]::Max(20, [Console]::WindowWidth)
            $windowHeight = [Math]::Max(6, [Console]::WindowHeight)
            $contentWidth = [Math]::Max(10, $windowWidth - 1)
            $visibleRows = [Math]::Max(1, $windowHeight - 4)

            if ($selected -lt $offset) { $offset = $selected }
            if ($selected -ge ($offset + $visibleRows)) { $offset = $selected - $visibleRows + 1 }
            $maxOffset = [Math]::Max(0, $matches.Count - $visibleRows)
            $offset = [Math]::Max(0, [Math]::Min($offset, $maxOffset))

            $out = [Text.StringBuilder]::new()
            $header = Limit-PiiText "pii  $($projects.Count) projects   Up/Down move  Enter open  Esc close" $contentWidth
            [void]$out.AppendLine("$cyan$header$reset$esc[K")

            $queryPrefix = "Search: "
            $queryWidth = [Math]::Max(1, $contentWidth - $queryPrefix.Length - 1)
            if ($query.Length -gt $queryWidth) {
                $queryDisplay = "<" + $query.Substring($query.Length - $queryWidth + 1)
            } else {
                $queryDisplay = $query
            }
            [void]$out.AppendLine("$queryPrefix$yellow$queryDisplay`_$reset$esc[K")
            [void]$out.AppendLine("$esc[K")

            if ($matches.Count -eq 0) {
                [void]$out.AppendLine("$darkGray  No matching projects$reset$esc[K")
            } else {
                $now = Get-Date
                $lastVisible = [Math]::Min($matches.Count, $offset + $visibleRows)
                for ($i = $offset; $i -lt $lastVisible; $i++) {
                    $project = $matches[$i]
                    $prefix = if ($i -eq $selected) { "> " } else { "  " }
                    $lineColor = if ($i -eq $selected) { $yellow } else { $white }
                    $unit = if ($project.ConversationCount -eq 1) { "convo" } else { "convos" }
                    $age = Format-PiiAge $project.LastSessionTime $now
                    $meta = "$($project.ConversationCount) $unit  $age"
                    $left = "$prefix$($project.Cwd)"

                    if (($left.Length + 2 + $meta.Length) -le $contentWidth) {
                        $padding = " " * ($contentWidth - $left.Length - $meta.Length)
                        [void]$out.AppendLine("$lineColor$left$reset$padding$darkGray$meta$reset$esc[K")
                    } elseif ($contentWidth - $meta.Length - 2 -ge 10) {
                        $leftWidth = $contentWidth - $meta.Length - 2
                        $left = Limit-PiiText $left $leftWidth
                        [void]$out.AppendLine("$lineColor$left$reset  $darkGray$meta$reset$esc[K")
                    } else {
                        $left = Limit-PiiText $left $contentWidth
                        [void]$out.AppendLine("$lineColor$left$reset$esc[K")
                    }
                }
            }

            [void]$out.Append("$esc[J")
            [Console]::Write("$esc[H$($out.ToString())")

            $key = [Console]::ReadKey($true)
            $control = ($key.Modifiers -band [ConsoleModifiers]::Control) -ne 0
            $alt = ($key.Modifiers -band [ConsoleModifiers]::Alt) -ne 0

            if ($control -and $key.Key -eq [ConsoleKey]::C) {
                $done = $true
                continue
            }

            switch ($key.Key) {
                ([ConsoleKey]::Escape) {
                    $done = $true
                }
                ([ConsoleKey]::Enter) {
                    if ($matches.Count -gt 0) {
                        $destination = $matches[$selected].Cwd
                        $done = $true
                    }
                }
                ([ConsoleKey]::UpArrow) {
                    if ($matches.Count -gt 0) { $selected = [Math]::Max(0, $selected - 1) }
                }
                ([ConsoleKey]::DownArrow) {
                    if ($matches.Count -gt 0) { $selected = [Math]::Min($matches.Count - 1, $selected + 1) }
                }
                ([ConsoleKey]::PageUp) {
                    if ($matches.Count -gt 0) { $selected = [Math]::Max(0, $selected - $visibleRows) }
                }
                ([ConsoleKey]::PageDown) {
                    if ($matches.Count -gt 0) { $selected = [Math]::Min($matches.Count - 1, $selected + $visibleRows) }
                }
                ([ConsoleKey]::Home) {
                    if ($matches.Count -gt 0) { $selected = 0 }
                }
                ([ConsoleKey]::End) {
                    if ($matches.Count -gt 0) { $selected = $matches.Count - 1 }
                }
                ([ConsoleKey]::Backspace) {
                    if ($query.Length -gt 0) {
                        if ($control) {
                            $query = $query -replace '[^\\/\s]+[\\/\s]*$', ''
                        } else {
                            $query = $query.Substring(0, $query.Length - 1)
                        }
                        $selected = 0
                        $offset = 0
                    }
                }
                ([ConsoleKey]::Delete) {
                    $query = ""
                    $selected = 0
                    $offset = 0
                }
                default {
                    if ($control -and ($key.Key -eq [ConsoleKey]::U)) {
                        $query = ""
                        $selected = 0
                        $offset = 0
                    } elseif ($control -and ($key.Key -eq [ConsoleKey]::W)) {
                        $query = $query -replace '[^\\/\s]+[\\/\s]*$', ''
                        $selected = 0
                        $offset = 0
                    } elseif (-not $control -and -not $alt -and -not [char]::IsControl($key.KeyChar)) {
                        $query += $key.KeyChar
                        $selected = 0
                        $offset = 0
                    }
                }
            }
        }
    } finally {
        if ($alternateBufferActive) {
            [Console]::Write("$esc[?25h$esc[?1049l")
        } else {
            [Console]::CursorVisible = $true
        }
    }

    if ($destination) {
        if ([IO.Directory]::Exists($destination)) {
            Set-Location -LiteralPath $destination
        } else {
            Write-Warning "Project directory no longer exists: $destination"
        }
    }
}
