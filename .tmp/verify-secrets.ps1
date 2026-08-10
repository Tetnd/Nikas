$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$blobFile = Join-Path $PSScriptRoot 'secret-blobs.json'
$blobs = Get-Content $blobFile -Raw | ConvertFrom-Json

function Get-PlainHash([string]$storageJson) {
    if (-not $storageJson) { return 'MISSING' }
    $obj = $storageJson | ConvertFrom-Json
    if ($obj.type -eq 'Buffer') {
        $bytes = [byte[]]$obj.data
    } else {
        $bytes = [Convert]::FromBase64String($obj.data)
    }
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $text = [System.Text.Encoding]::UTF8.GetString($plain)
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($text)))
    return $hash.Substring(0, 16) + ' (len=' + $text.Length + ', starts with sk-: ' + $text.StartsWith('sk-') + ')'
}

Write-Host 'nikas.deepseek ->' (Get-PlainHash $blobs.'nikas.deepseek')
Write-Host 'nika.deepseek  ->' (Get-PlainHash $blobs.'nika.deepseek')
Write-Host 'nikas.gemini  ->' (Get-PlainHash $blobs.'nikas.gemini')
Write-Host 'nika.gemini   ->' (Get-PlainHash $blobs.'nika.gemini')
