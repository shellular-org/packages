import { execFile } from "node:child_process";
import os from "node:os";

import { logger } from "./logger";

type NotifyArgs = {
	title: string;
	body: string;
};

function escapeAppleScript(s: string) {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePowerShell(s: string) {
	return s.replace(/'/g, "''");
}

function run(cmd: string, args: string[]) {
	execFile(cmd, args, { timeout: 5000 }, (error, _stdout, stderr) => {
		if (error) {
			logger.debug(`${cmd} failed`, error);
			return;
		}

		if (stderr?.trim()) {
			logger.debug(`${cmd} stderr: ${stderr.trim()}`);
		}
	});
}

export function notify({ title, body }: NotifyArgs): boolean {
	try {
		switch (os.platform()) {
			case "darwin":
				run("osascript", [
					"-e",
					`display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`,
				]);
				return true;

			case "linux":
				run("notify-send", [title, body]);
				return true;

			case "win32":
				run("powershell", [
					"-NoProfile",
					"-Command",
					`
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null

$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${escapePowerShell(title)}</text>
      <text>${escapePowerShell(body)}</text>
    </binding>
  </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("MyCLI")
$notifier.Show($toast)
          `.trim(),
				]);
				return true;

			default:
				logger.debug(`Unsupported platform: ${os.platform()}`);
				return false;
		}
	} catch (err) {
		logger.debug("Unexpected notification error", err);
		return false;
	}
}
