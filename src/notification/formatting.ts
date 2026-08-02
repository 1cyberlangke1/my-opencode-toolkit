export function escapePowerShellSingleQuotedText(input: string): string {
  return input.replace(/'/g, "''");
}

export function escapeAppleScriptText(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape XML-reserved characters before inserting into a toast XML template. */
export function escapeXmlText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildWindowsToastScript(title: string, message: string): string {
  // XML-escape first (for the toast XML), then PowerShell single-quote escape (for the -Command string).
  const psTitle = escapePowerShellSingleQuotedText(escapeXmlText(title));
  const psMessage = escapePowerShellSingleQuotedText(escapeXmlText(message));

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
`.trim().replace(/\n/g, "; ");
}
