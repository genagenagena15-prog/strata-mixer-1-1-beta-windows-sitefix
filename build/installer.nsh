; Custom NSIS hooks for Strata Mixer.
; After install/uninstall, broadcast SHCNE_ASSOCCHANGED so the Windows shell
; re-reads file-type associations AND their icons immediately — otherwise the
; .smproj icon can keep showing a CACHED old icon until the icon cache rebuilds
; on its own (or a reboot). 0x08000000 = SHCNE_ASSOCCHANGED, flags 0 = SHCNF_IDLIST.

; Before anything installs, make sure no OLD copy of Strata Mixer is still running.
; A running app keeps app.asar / the .exe locked, so an in-place update can't overwrite
; them — the user then runs a MIX of new + old files, which is exactly the "old bugs stayed
; after the update" symptom. Killing the old process first guarantees every file is replaced
; cleanly. Runs silently too (so it's safe during a background auto-update). The installer
; itself is "StrataMixer-<ver>.exe", NOT "Strata Mixer.exe", so this never kills the installer.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Strata Mixer.exe" /T'
  Sleep 500
!macroend

!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
