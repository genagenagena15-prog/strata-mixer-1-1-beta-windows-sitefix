; Custom NSIS hooks for Strata Mixer.
; After install/uninstall, broadcast SHCNE_ASSOCCHANGED so the Windows shell
; re-reads file-type associations AND their icons immediately — otherwise the
; .smproj icon can keep showing a CACHED old icon until the icon cache rebuilds
; on its own (or a reboot). 0x08000000 = SHCNE_ASSOCCHANGED, flags 0 = SHCNF_IDLIST.

!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
