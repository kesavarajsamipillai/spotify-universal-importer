$url = "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"
$resp = Invoke-WebRequest -Uri $url -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$content = $resp.Content

# Find all script tags
$matches = [regex]::Matches($content, '<script[^>]*id="([^"]+)"[^>]*>([\s\S]*?)</script>')
foreach ($m in $matches) {
    Write-Output ("ID: " + $m.Groups[1].Value)
    Write-Output ("Sample: " + $m.Groups[2].Value.Substring(0, [Math]::Min(200, $m.Groups[2].Value.Length)))
    Write-Output "---"
}
