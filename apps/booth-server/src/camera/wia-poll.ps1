# WIA fallback for Canon EOS cameras that EDSDK cannot open.
# Polls the camera's memory card over USB and copies NEW files into $OutDir.
# Protocol: one compact JSON object per stdout line.
#   {"type":"status","connected":true,"model":"Canon EOS 2000D","battery":80}
#   {"type":"file","path":"C:\\PhotoBooth\\Incoming\\wia-...-IMG_0001.JPG","name":"IMG_0001.JPG"}
#   {"type":"error","message":"..."}
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$IntervalMs = 1500
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$CameraDeviceType = 2         # WiaDeviceType.CameraDeviceType
$FolderItemFlag = 4           # WiaItemFlag.FolderItemFlag
$ImageOrFileFlags = 1 -bor 2  # ImageItemFlag | FileItemFlag

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

function Get-Prop($props, [string]$name) {
  foreach ($p in $props) { if ($p.Name -eq $name) { return $p.Value } }
  return $null
}

function Get-Files($items, $acc) {
  foreach ($it in $items) {
    $flags = [int](Get-Prop $it.Properties 'Item Flags')
    if ($flags -band $FolderItemFlag) { Get-Files $it.Items $acc }
    elseif ($flags -band $ImageOrFileFlags) { [void]$acc.Add($it) }
  }
}

function Connect-Camera {
  $dm = New-Object -ComObject WIA.DeviceManager
  foreach ($info in $dm.DeviceInfos) {
    if ($info.Type -eq $CameraDeviceType) {
      $name = Get-Prop $info.Properties 'Name'
      if ($name -match 'Canon|EOS') { return $info.Connect() }
    }
  }
  return $null
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$baselined = $false
$device = $null
$lastStatus = ''

while ($true) {
  try {
    if ($null -eq $device) { $device = Connect-Camera }
    if ($null -eq $device) {
      if ($lastStatus -ne 'off') { Emit @{ type = 'status'; connected = $false }; $lastStatus = 'off' }
    } else {
      $model = Get-Prop $device.Properties 'Name'
      $battery = Get-Prop $device.Properties 'Battery Status'
      $status = "on|$battery"
      if ($status -ne $lastStatus) { Emit @{ type = 'status'; connected = $true; model = $model; battery = $battery }; $lastStatus = $status }

      $files = New-Object System.Collections.ArrayList
      Get-Files $device.Items $files
      foreach ($it in $files) {
        $id = $it.ItemID
        if ($seen.Contains($id)) { continue }
        [void]$seen.Add($id)
        # First pass only learns what is already on the card; those shots belong to nobody.
        if (-not $baselined) { continue }
        $base = Get-Prop $it.Properties 'Item Name'
        $ext = Get-Prop $it.Properties 'Filename extension'
        $name = "$base.$ext"
        $dest = Join-Path $OutDir ("wia-{0}-{1}" -f [DateTime]::UtcNow.Ticks, $name)
        $img = $it.Transfer()   # native format: JPG stays JPG, CR2 stays CR2
        $img.SaveFile($dest)
        Emit @{ type = 'file'; path = $dest; name = $name }
      }
      $baselined = $true
    }
  } catch {
    # Unplugged or camera asleep: drop the handle and reconnect on the next tick.
    $device = $null
    if ($lastStatus -ne 'off') { Emit @{ type = 'status'; connected = $false }; $lastStatus = 'off' }
    Emit @{ type = 'error'; message = $_.Exception.Message }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
