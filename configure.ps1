param([string]$GameRoot = 'D:\SteamLibrary\steamapps\common\Deep Rock Galactic')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = '深岩银河 · 聊天翻译配置'
$form.ClientSize = [System.Drawing.Size]::new(590, 438)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)
function Add-Label($caption, $x, $y, $width, $height) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $caption
  $label.Location = [System.Drawing.Point]::new($x,$y)
  $label.Size = [System.Drawing.Size]::new($width,$height)
  $form.Controls.Add($label)
  return $label
}
function Add-Button($caption, $x, $y, $width) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $caption
  $button.Location = [System.Drawing.Point]::new($x,$y)
  $button.Size = [System.Drawing.Size]::new($width,36)
  $form.Controls.Add($button)
  return $button
}
$null = Add-Label '直接翻译聊天文字，译文在原版聊天框里显示。' 24 20 540 28
$null = Add-Label '游戏目录' 24 64 110 25
$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Location = [System.Drawing.Point]::new(132,62)
$pathBox.Size = [System.Drawing.Size]::new(432,28)
$pathBox.Text = $GameRoot
$form.Controls.Add($pathBox)
$null = Add-Label '免费模型' 24 104 110 25
$null = Add-Label '智谱 GLM-4-Flash-250414' 132 104 432 25
$register = Add-Button '注册 / 登录智谱' 24 145 180
$keyPage = Add-Button '创建 API 密钥' 218 145 180
$register.Add_Click({ Start-Process 'https://open.bigmodel.cn/console' })
$keyPage.Add_Click({ Start-Process 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys' })
$null = Add-Label 'API 密钥' 24 204 110 25
$keyBox = New-Object System.Windows.Forms.TextBox
$keyBox.Location = [System.Drawing.Point]::new(132,200)
$keyBox.Size = [System.Drawing.Size]::new(432,28)
$keyBox.UseSystemPasswordChar = $true
$form.Controls.Add($keyBox)
$enabled = New-Object System.Windows.Forms.CheckBox
$enabled.Text = '开启翻译'
$enabled.Checked = $true
$enabled.Location = [System.Drawing.Point]::new(24,249)
$enabled.Size = [System.Drawing.Size]::new(140,26)
$form.Controls.Add($enabled)
$incoming = New-Object System.Windows.Forms.CheckBox
$incoming.Text = '自动英→中（新英文聊天）'
$incoming.Checked = $true
$incoming.Location = [System.Drawing.Point]::new(184,249)
$incoming.Size = [System.Drawing.Size]::new(360,26)
$form.Controls.Add($incoming)
$null = Add-Label "保存后，在游戏里按 F6 加载、F7 测试。`r`n输入中文后按 F8，等待英文出现再按回车；F9 查看聊天记录。`r`n密钥保存在本机；聊天文字会提交给智谱进行翻译。" 24 283 540 66
$status = Add-Label '' 24 393 540 26
$status.ForeColor = [System.Drawing.Color]::DarkGreen
$save = Add-Button '保存配置' 382 352 182
$viewStatus = Add-Button '查看运行状态' 24 352 182
function Config-Path([string]$root) { return Join-Path $root 'FSD\Saved\SaveGames\Mods\DRGChatTranslator\config.json' }
$viewStatus.Add_Click({
  $viewer = New-Object System.Windows.Forms.Form
  $viewer.Text = '聊天翻译 · 运行状态（自动刷新）'
  $viewer.ClientSize = [System.Drawing.Size]::new(650,420)
  $viewer.StartPosition = 'CenterParent'
  $viewer.Font = $form.Font
  $details = New-Object System.Windows.Forms.TextBox
  $details.Multiline = $true
  $details.ReadOnly = $true
  $details.ScrollBars = 'Vertical'
  $details.Dock = 'Fill'
  $viewer.Controls.Add($details)
  $statusPath = Join-Path (Split-Path -Parent (Config-Path $pathBox.Text.Trim())) 'status.json'
  $refresh = {
    try {
      if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
        $content = '暂无运行记录。请重启游戏加载 0.2.2，再按 F7、F8 或 F9。'
      } else {
        $report = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lines = @("模组版本：$($report.version)", '')
        foreach ($item in $report.history) {
          $at = ([datetime]$item.time).ToLocalTime().ToString('HH:mm:ss')
          $lines += '[' + $at + '] ' + $item.message
        }
        if ($report.diagnostics) {
          $lines += ''; $lines += '输入框检查（仅名称和字数，不记录聊天原文）：'
          foreach ($item in $report.diagnostics) {
            $lines += $item.name + ' | 字数=' + $item.length + ' | 焦点=' + $item.focused + ' | 已打开=' + $item.open + ' | 可见=' + $item.visible
          }
        }
        $content = $lines -join "`r`n"
      }
      if ($details.Text -ne $content) { $details.Text = $content; $details.SelectionStart = $details.TextLength; $details.ScrollToCaret() }
    } catch { $details.Text = '正在等待完整记录，请稍后。' }
  }.GetNewClosure()
  $refreshTimer = New-Object System.Windows.Forms.Timer
  $refreshTimer.Interval = 1500
  $refreshTimer.Add_Tick($refresh)
  & $refresh
  $refreshTimer.Start()
  try { $null = $viewer.ShowDialog($form) } finally { $refreshTimer.Stop(); $refreshTimer.Dispose(); $viewer.Dispose() }
})
try {
  $existingPath = Config-Path $GameRoot
  if (Test-Path -LiteralPath $existingPath -PathType Leaf) {
    $existing = Get-Content -LiteralPath $existingPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $keyBox.Text = [string]$existing.ApiKey
    if ($null -ne $existing.Enabled) { $enabled.Checked = [bool]$existing.Enabled }
    if ($null -ne $existing.IncomingEnabled) { $incoming.Checked = [bool]$existing.IncomingEnabled }
  }
} catch { $status.Text = '旧配置无法读取，可以重新填写并保存。' }
$save.Add_Click({
  try {
    $chosenRoot = [System.IO.Path]::GetFullPath($pathBox.Text.Trim())
    if (-not (Test-Path -LiteralPath (Join-Path $chosenRoot 'FSD.exe') -PathType Leaf)) {
      throw '请选择包含 FSD.exe 的深岩银河游戏根目录。'
    }
    $apiValue = $keyBox.Text.Trim()
    if ($enabled.Checked -and -not $apiValue) { throw '请先创建 API 密钥，然后粘贴到密钥框。' }
    $chosenConfig = Config-Path $chosenRoot
    $configDirectory = Split-Path -Parent $chosenConfig
    [System.IO.Directory]::CreateDirectory($configDirectory) | Out-Null
    $payload = [ordered]@{
      Enabled = $enabled.Checked
      IncomingEnabled = $incoming.Checked
      ApiKey = $apiValue
      Endpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
      Model = 'glm-4-flash-250414'
      TimeoutMs = 12000
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($chosenConfig,$payload,[System.Text.UTF8Encoding]::new($false))
    $status.ForeColor = [System.Drawing.Color]::DarkGreen
    $status.Text = '已保存。回到游戏按 F6，然后按 F7 测试。'
  } catch {
    $status.ForeColor = [System.Drawing.Color]::Firebrick
    $status.Text = $_.Exception.Message
  }
})
$null = $form.ShowDialog()
$form.Dispose()
