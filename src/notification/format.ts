/** 输入：文本；输出：PowerShell 单引号字符串里可安全使用的文本。 */
export function escapePowerShellSingleQuotedText(input: string): string {
  return input.replaceAll("'", "''")
}

/** 输入：文本；输出：AppleScript 双引号字符串里可安全使用的文本。 */
export function escapeAppleScriptText(input: string): string {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

/** 输入：文本；输出：XML 转义后的文本。 */
export function escapeXmlText(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/**
 * 输入：标题 + 正文。
 * 输出：一行 PowerShell 脚本，弹出 Windows toast。
 * 预期：只做 PowerShell 单引号转义；XML 实体由 `CreateTextNode` 负责，
 *       这里再转一次会变成字面量 `&amp;`（toast 里就能看到 `&amp;`）。
 */
export function buildWindowsToastScript(title: string, message: string): string {
  const psTitle = escapePowerShellSingleQuotedText(title)
  const psMessage = escapePowerShellSingleQuotedText(message)

  return `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$RawXml = [xml] $Template.GetXml()
($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq '1'}).AppendChild($RawXml.CreateTextNode('${psTitle}')) | Out-Null
($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq '2'}).AppendChild($RawXml.CreateTextNode('${psMessage}')) | Out-Null
$SerializedXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$SerializedXml.LoadXml($RawXml.OuterXml)
$Toast = [Windows.UI.Notifications.ToastNotification]::new($SerializedXml)
$Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenCode')
$Notifier.Show($Toast)
`.trim().replaceAll("\n", "; ")
}
