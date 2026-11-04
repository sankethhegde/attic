; Attic Hub's additions to the installer (electron-builder includes build/installer.nsh by itself).
; Phase 3, 3-3: uninstalling removes File Explorer's "Send to Attic Hub" entry (agent/explorer.js),
; which the tool adds for the person using it, under HKEY_CURRENT_USER.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\AtticHub"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AtticHub"
!macroend
