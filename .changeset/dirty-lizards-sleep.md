---
"@shellular/protocol": patch
"shellular": patch
---

feat: show shellular version in app, and update

- Add `showSelfUpdateLogs` function to display self-update logs with live streaming of the latest log file.
- Introduce `runSelfUpdate` function to handle self-update execution, ensuring proper detachment from the parent process.
- Update `pm2` and remove unused dependencies
- Add startup and unstartup sub-commands to manage Shellular CLI daemon startup (wrapper over PM2)
- Add `--no-qr` option to the CLI to not show QR code
- Extend protocol with new message types for host updates and results, including schemas for validation.
- Modify session information to include CLI version and update availability status.
