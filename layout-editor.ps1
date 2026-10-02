param([string]$GameRoot = 'D:\SteamLibrary\steamapps\common\Deep Rock Galactic')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$specs = @(
  @('Width','面板宽度 %',72,45,95), @('Height','面板高度 %',66,40,90),
  @('X','横向位置 %',14,0,55), @('Y','纵向位置 %',17,0,60),
  @('FontSize','聊天字号',13,10,22), @('ButtonFontSize','按钮字号',12,10,20),
  @('MetaWidth','玩家栏宽度',108,70,200), @('ActionWidth','操作栏宽度',76,60,130),
  @('RowPadding','聊天行内边距',1,0,8), @('Gap','控件间距',2,0,8),
  @('SourceWeight','原文宽度比例',1,.5,3), @('TranslationWeight','译文宽度比例',1,.5,3),
  @('PageSize','每页聊天条数',16,8,32)
)
$form = [System.Windows.Forms.Form]::new()
$form.Text = '聊天翻译 0.2.3 · 界面调整（示意预览）'
$form.ClientSize = [System.Drawing.Size]::new(960,650)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI',10)
$pathLabel = [System.Windows.Forms.Label]::new()
$pathLabel.Text = '游戏目录'; $pathLabel.SetBounds(18,20,90,25); $form.Controls.Add($pathLabel)
$rootBox = [System.Windows.Forms.TextBox]::new()
$rootBox.Text = $GameRoot; $rootBox.SetBounds(110,16,830,28); $form.Controls.Add($rootBox)
$preview = [System.Windows.Forms.Panel]::new()
$preview.SetBounds(295,70,645,470); $preview.BackColor = [System.Drawing.Color]::FromArgb(28,29,29)
$form.Controls.Add($preview)
$controls = @{}
function Layout-Path { Join-Path $rootBox.Text.Trim() 'FSD\Saved\SaveGames\Mods\DRGChatTranslator\ui-layout.json' }
function Values {
  $values = [ordered]@{}
  foreach ($spec in $specs) { $values[$spec[0]] = [double]$controls[$spec[0]].Value }
  $values.X = [Math]::Min($values.X,100-$values.Width)
  $values.Y = [Math]::Min($values.Y,100-$values.Height)
  return $values
}
for ($index=0; $index -lt $specs.Count; $index++) {
  $spec=$specs[$index]; $top=70+35*$index
  $label=[System.Windows.Forms.Label]::new(); $label.Text=$spec[1]; $label.SetBounds(18,$top+3,164,26); $form.Controls.Add($label)
  $number=[System.Windows.Forms.NumericUpDown]::new(); $number.Minimum=[decimal]$spec[3]; $number.Maximum=[decimal]$spec[4]
  if ($spec[0] -match 'Weight|^X$|^Y$') { $number.DecimalPlaces=1; $number.Increment=[decimal]0.1 }
  $number.Value=[decimal]$spec[2]; $number.SetBounds(184,$top,90,28)
  $number.Add_ValueChanged({ $preview.Invalidate() }); $form.Controls.Add($number); $controls[$spec[0]]=$number
}
$preview.Add_Paint({
  param($sender,$event)
  $g=$event.Graphics; $v=Values
  $x=[single]($sender.Width*$v.X/100); $y=[single]($sender.Height*$v.Y/100)
  $w=[single]($sender.Width*$v.Width/100); $h=[single]($sender.Height*$v.Height/100)
  $brush=[System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(16,22,29))
  $button=[System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38,53,70))
  $font=[System.Drawing.Font]::new('Microsoft YaHei UI',[single]($v.FontSize*.67))
  $small=[System.Drawing.Font]::new('Microsoft YaHei UI',[single]($v.ButtonFontSize*.67))
  try {
    $g.FillRectangle($brush,$x,$y,$w,$h)
    $g.FillRectangle($button,$x+4,$y+4,$w-8,23)
    $g.DrawString('按住拖动       导出聊天  清空  关闭',$small,[System.Drawing.Brushes]::White,$x+8,$y+8)
    $g.DrawString('翻译：开启    自动英→中：开启',$small,[System.Drawing.Brushes]::LightSteelBlue,$x+8,$y+31)
    $meta=[single]([Math]::Min($w*.3,$v.MetaWidth*.65)); $action=[single]($v.ActionWidth*.65)
    $source=[single](($w-$meta-$action-20)*$v.SourceWeight/($v.SourceWeight+$v.TranslationWeight))
    $rowHeight=[single]($v.FontSize*.9+2*$v.RowPadding+2*$v.Gap+5)
    for ($row=0; $row -lt 12; $row++) {
      $at=[single]($y+62+$row*$rowHeight)
      if ($at+$rowHeight -gt $y+$h-78) { break }
      if ($row%2 -eq 1) { $g.FillRectangle($button,$x+4,$at,$w-8,$rowHeight) }
      $g.DrawString('12:30 玩家',$small,[System.Drawing.Brushes]::LightSteelBlue,$x+8,$at+2)
      $g.DrawString('Ready to go?',$font,[System.Drawing.Brushes]::White,$x+$meta,$at+2)
      $g.DrawString('准备出发了吗？',$font,[System.Drawing.Brushes]::White,$x+$meta+$source,$at+2)
      $g.DrawString('翻译',$small,[System.Drawing.Brushes]::White,$x+$w-$action,$at+2)
    }
    $g.DrawString('较早聊天    跟随：开    最新聊天',$small,[System.Drawing.Brushes]::LightSteelBlue,$x+8,$y+$h-68)
    $g.FillRectangle($button,$x+4,$y+$h-42,$w-8,32)
    $g.DrawString('输入聊天…       翻译成英文    发送',$small,[System.Drawing.Brushes]::White,$x+8,$y+$h-36)
  } finally { $brush.Dispose(); $button.Dispose(); $font.Dispose(); $small.Dispose() }
})
$hint=[System.Windows.Forms.Label]::new()
$hint.Text="预览为缩小示意，实际字体和换行以游戏为准。`r`n保存后在游戏按 F6，再打开 F9。拖动位置也保存在这份设置。`r`n此工具只调整界面，不读取密钥或聊天记录。"
$hint.SetBounds(295,552,645,77); $form.Controls.Add($hint)
$message=[System.Windows.Forms.Label]::new(); $message.SetBounds(18,611,270,25); $form.Controls.Add($message)
function Load-Layout {
  try {
    $path=Layout-Path
    if (Test-Path -LiteralPath $path) {
      $saved=Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($spec in $specs) {
        $value=$saved.($spec[0]); $number=$controls[$spec[0]]
        if ($null -ne $value) { $number.Value=[Math]::Min($number.Maximum,[Math]::Max($number.Minimum,[decimal]$value)) }
      }
    }
  } catch { $message.Text='设置无法读取，可恢复默认再保存。' }
}
$load=[System.Windows.Forms.Button]::new(); $load.Text='读取'; $load.SetBounds(18,547,75,36); $load.Add_Click({ Load-Layout }); $form.Controls.Add($load)
$reset=[System.Windows.Forms.Button]::new(); $reset.Text='默认'; $reset.SetBounds(99,547,75,36)
$reset.Add_Click({ foreach ($spec in $specs) { $controls[$spec[0]].Value=[decimal]$spec[2] } }); $form.Controls.Add($reset)
$save=[System.Windows.Forms.Button]::new(); $save.Text='保存'; $save.SetBounds(180,547,94,36)
$save.Add_Click({
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $rootBox.Text.Trim() 'FSD') -PathType Container)) { throw '请选择有效游戏根目录。' }
    $path=Layout-Path; New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    [System.IO.File]::WriteAllText($path,((Values) | ConvertTo-Json),[System.Text.UTF8Encoding]::new($false))
    $message.Text='已保存；游戏按 F6 后生效。'; $message.ForeColor=[System.Drawing.Color]::DarkGreen
  } catch { $message.Text='保存失败，请检查游戏目录。'; $message.ForeColor=[System.Drawing.Color]::DarkRed }
})
$form.Controls.Add($save)
Load-Layout
[void]$form.ShowDialog()
$form.Dispose()
