Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

; =====================================================================
; KNT Manager visual identity
; =====================================================================
; NSIS colors are 0x00BBGGRR
!define KNT_BG      0x10100E  ; #0E0E10 page background
!define KNT_PANEL   0x1B1610  ; #16161B brand panel
!define KNT_SURFACE 0x211A1A  ; #1A1A21 inputs / secondary
!define KNT_BORDER  0x332A2A  ; #2A2A33 borders
!define KNT_TEXT    0xF2EDED  ; #EDEDF2 primary text
!define KNT_DIM     0xA59A9A  ; #9A9AA5 secondary text
!define KNT_ACCENT  0xCF566E  ; #6E56CF violet accent
!define KNT_SUCCESS 0x7DC734  ; #34C77D success green
!define KNT_ERROR   0x4D48E5  ; #E5484D error red

; MUI theming (used by the instfiles progress page)
!define MUI_BGCOLOR "${KNT_BG}"
!define MUI_TEXTCOLOR "${KNT_TEXT}"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Instalação concluída"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "O KNT Manager foi instalado com sucesso."
!define MUI_INSTFILESPAGE_COLORS "EDEDF2 0E0E10"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; Custom hooks
!define MUI_CUSTOMFUNCTION_GUIINIT KntGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.KntGuiInit
!define MUI_CUSTOMFUNCTION_ABORT KntAbort
!define MUI_CUSTOMFUNCTION_UNABORT un.KntAbort

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

; KNT Manager UI variables
Var knt.dialog
Var knt.panel
Var knt.logo
Var knt.titleFont
Var knt.subFont
Var knt.checkFont
Var knt.btnFont
Var knt.bigCheckFont
Var knt.dirText
Var knt.dirBrowse
Var knt.deskChk
Var knt.menuChk
Var knt.deskBox
Var knt.menuBox
Var knt.installBtn
Var knt.cancelBtn
Var knt.createDesktop
Var knt.createStartMenu
Var knt.rr1Box
Var knt.rr2Box
Var knt.rr1Text
Var knt.rr2Text
Var knt.runBox
Var knt.dataBox
Var knt.installRequested
Var knt.reinstallMsg
Var knt.reinstallVer
Var knt.reinstallRadio1
Var knt.reinstallRadio2
Var knt.runChk
Var knt.runDone
Var knt.openBtn
Var knt.winW
Var knt.winH
Var knt.clientW
Var knt.clientH

Name "${PRODUCTNAME}"
Caption "KNT Manager · Instalador v${VERSION}"
BrandingText ""
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; =====================================================================
; Pages
; =====================================================================

; 1. Welcome / install options (custom dark page)
PageEx custom
  PageCallbacks KntWelcomeShow KntWelcomeLeave
PageExEnd

; 2. Reinstall / upgrade choice (custom dark page, only when a previous
;    installation is detected)
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall

; 3. Progress page (MUI instfiles, dark themed)
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KntInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

; 4. Finish (custom dark page)
PageEx custom
  PageCallbacks KntFinishShow KntFinishLeave
PageExEnd

; ---------------------------------------------------------------------
; Uninstaller pages
; ---------------------------------------------------------------------

; 1. Confirm uninstall (custom dark page)
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
PageEx un.custom
  PageCallbacks un.KntUnConfirmShow un.KntUnConfirmLeave
PageExEnd

; 2. Uninstalling progress page (MUI instfiles, dark themed)
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Desinstalação concluída"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "O KNT Manager foi removido deste computador."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KntUnInstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; =====================================================================
; GUI init / shared helpers
; =====================================================================

; Resize the window and style the outer chrome. Runs after MUI's own
; GUI initialization (both installer and uninstaller).
Function KntGuiInit
  Call KntStyleWindow
  CreateFont $knt.titleFont "$(^Font)" 15 600
  CreateFont $knt.subFont "$(^Font)" 9 400
  CreateFont $knt.btnFont "Segoe UI" 10 600
  CreateFont $knt.checkFont "Segoe UI Symbol" 13 400
  CreateFont $knt.bigCheckFont "Segoe UI Symbol" 30 400
FunctionEnd

Function un.KntGuiInit
  Call un.KntStyleWindow
  CreateFont $knt.titleFont "$(^Font)" 15 600
  CreateFont $knt.subFont "$(^Font)" 9 400
  CreateFont $knt.btnFont "Segoe UI" 10 600
  CreateFont $knt.checkFont "Segoe UI Symbol" 13 400
  CreateFont $knt.bigCheckFont "Segoe UI Symbol" 30 400
FunctionEnd

; The installer window is 500x660 logical px, DPI scaled. NSIS lays out the
; page dialog and the wizard buttons inside the window's client area, so we
; remember the (scaled) sizes here and reuse them when stretching the dialog
; and repositioning the buttons. Window-rect API calls are unreliable inside
; page callbacks, hence the stored constants.
Function KntStyleWindow
  StrCpy $0 "styleWindow"
  Call KntDbg2
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
  IntOp $1 500 * $0
  IntOp $1 $1 / 96
  IntOp $2 660 * $0
  IntOp $2 $2 / 96
  StrCpy $knt.winW $1
  StrCpy $knt.winH $2
  ; Client area ≈ window size minus frame (titlebar + borders)
  IntOp $knt.clientW $1 - 8
  IntOp $knt.clientH $2 - 39
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r1, i r2, i 0x0016)'

  ; Hide the default branding bar and separator lines (we draw our own footer)
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 0

  ; Paint the window background dark so nothing light shows around the pages
  System::Call 'user32::GetStockObject(i 4) i .r0'
  System::Call 'user32::SetClassLongPtrW(i $HWNDPARENT, i -10, i r0) i .r1'
  System::Call 'user32::InvalidateRect(i $HWNDPARENT, i 0, i 1)'
FunctionEnd

; Stretch the page dialog to fill the window client area. The dialog handle
; comes in $0: on custom pages it is the handle returned by nsDialogs::Create
; (GetDlgItem 1018 can return a stale duplicate). The wizard buttons live on
; the outer window and are hidden on custom pages (we draw our own footer).
Function KntStretchPageDialog
  ${If} $0 = 0
    GetDlgItem $0 $HWNDPARENT 1018
  ${EndIf}
  ${If} $0 <> 0
    System::Call "user32::SetWindowPos(i $0, i 0, i 0, i 0, i $knt.clientW, i $knt.clientH, i 0x0014)"
    StrCpy $knt.dialog $0
  ${EndIf}
FunctionEnd

; Short variant used on the MUI instfiles page: leaves a strip at the bottom
; where the standard Cancel button stays visible.
Function KntStretchPageDialogShort
  ${If} $0 = 0
    GetDlgItem $0 $HWNDPARENT 1018
  ${EndIf}
  ${If} $0 <> 0
    IntOp $7 $knt.clientH - 46
    System::Call "user32::SetWindowPos(i $0, i 0, i 0, i 0, i $knt.clientW, i r7, i 0x0014)"
    StrCpy $knt.dialog $0
  ${EndIf}
FunctionEnd

Function un.KntStyleWindow
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
  IntOp $1 500 * $0
  IntOp $1 $1 / 96
  IntOp $2 660 * $0
  IntOp $2 $2 / 96
  StrCpy $knt.winW $1
  StrCpy $knt.winH $2
  IntOp $knt.clientW $1 - 8
  IntOp $knt.clientH $2 - 39
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r1, i r2, i 0x0016)'
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 0
  System::Call 'user32::GetStockObject(i 4) i .r0'
  System::Call 'user32::SetClassLongPtrW(i $HWNDPARENT, i -10, i r0) i .r1'
  System::Call 'user32::InvalidateRect(i $HWNDPARENT, i 0, i 1)'
FunctionEnd

Function un.KntStretchPageDialog
  GetDlgItem $9 $HWNDPARENT 1018
  StrCpy $0 $9
  ${If} $0 = 0
    StrCpy $0 $knt.dialog
  ${EndIf}
  ${If} $0 <> 0
    System::Call "user32::SetWindowPos(i $0, i 0, i 0, i 0, i $knt.clientW, i $knt.clientH, i 0x0014)"
    StrCpy $knt.dialog $0
  ${EndIf}
FunctionEnd

Function un.KntStretchPageDialogShort
  GetDlgItem $9 $HWNDPARENT 1018
  StrCpy $0 $9
  ${If} $0 = 0
    StrCpy $0 $knt.dialog
  ${EndIf}
  ${If} $0 <> 0
    IntOp $7 $knt.clientH - 46
    System::Call "user32::SetWindowPos(i $0, i 0, i 0, i 0, i $knt.clientW, i r7, i 0x0014)"
    StrCpy $knt.dialog $0
  ${EndIf}
FunctionEnd

; Lay out the standard wizard buttons (1=Next, 2=Cancel, 3=Back) at the
; bottom-right of the resized window, restyled for the dark theme.
Function KntLayoutButtons
  IntOp $6 $knt.clientW - 94
  IntOp $7 $knt.clientH - 38
  GetDlgItem $3 $HWNDPARENT 2
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
  ShowWindow $3 1
  IntOp $6 $knt.clientW - 190
  GetDlgItem $3 $HWNDPARENT 1
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
  ShowWindow $3 1
  IntOp $6 $knt.clientW - 286
  GetDlgItem $3 $HWNDPARENT 3
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
  ShowWindow $3 1
FunctionEnd

Function un.KntLayoutButtons
  IntOp $6 $knt.clientW - 94
  IntOp $7 $knt.clientH - 38
  GetDlgItem $3 $HWNDPARENT 2
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
  IntOp $6 $knt.clientW - 190
  GetDlgItem $3 $HWNDPARENT 1
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
  IntOp $6 $knt.clientW - 286
  GetDlgItem $3 $HWNDPARENT 3
  SetCtlColors $3 ${KNT_TEXT} ${KNT_SURFACE}
  System::Call "user32::SetWindowPos(i $3, i 0, i r6, i r7, i 0, i 0, i 0x0001)"
FunctionEnd

; Hide the MUI header texts on custom pages (we draw our own typography).
Function KntHideCustomChrome
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 0
FunctionEnd

Function un.KntHideCustomChrome
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 0
FunctionEnd

; Hide the standard wizard buttons (1=Next, 2=Cancel, 3=Back) — custom pages
; draw their own footer actions inside the dialog.
Function KntHideWizardButtons
  Call KntHideCustomChrome
  StrCpy $0 $knt.dialog
  Call KntStretchPageDialog
  Call KntLayoutButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
FunctionEnd

Function un.KntHideWizardButtons
  Call un.KntHideCustomChrome
  StrCpy $0 $knt.dialog
  Call un.KntStretchPageDialog
  Call un.KntLayoutButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
FunctionEnd

; Trigger the wizard "Cancel" action from a custom button (button id 2).
Function KntOnCancelClick
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function KntAbort
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Deseja realmente cancelar a instalação do KNT Manager?" IDYES knt_abort_yes
    Abort
  ${EndIf}
  knt_abort_yes:
FunctionEnd

Function un.KntAbort
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Deseja realmente cancelar a desinstalação do KNT Manager?" IDYES knt_unabort_yes
    Abort
  ${EndIf}
  knt_unabort_yes:
FunctionEnd

; =====================================================================
; Shared UI primitives (brand panel, footer, flat buttons, toggles)
; =====================================================================

; Divider line
!macro KntDivider x y w
  ${NSD_CreateLabel} ${x} ${y} ${w} 1u ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BORDER}"
!macroend

; Flat primary action (accent fill). Handlers receive the control handle.
!macro KntPrimaryBtn hwndVar x y w h text handler
  ${NSD_CreateLabel} ${x} ${y} ${w} ${h} "${text}"
  Pop ${hwndVar}
  SetCtlColors ${hwndVar} ${KNT_TEXT} ${KNT_ACCENT}
  SendMessage ${hwndVar} ${WM_SETFONT} $knt.btnFont 0
  ${NSD_AddStyle} ${hwndVar} ${SS_CENTER}|${SS_NOTIFY}
  ${NSD_OnClick} ${hwndVar} ${handler}
!macroend

; Flat secondary action (surface fill)
!macro KntSecondaryBtn hwndVar x y w h text handler
  ${NSD_CreateLabel} ${x} ${y} ${w} ${h} "${text}"
  Pop ${hwndVar}
  SetCtlColors ${hwndVar} ${KNT_TEXT} ${KNT_SURFACE}
  SendMessage ${hwndVar} ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} ${hwndVar} ${SS_CENTER}|${SS_NOTIFY}
  ${NSD_OnClick} ${hwndVar} ${handler}
!macroend

; Ghost action (plain centered text)
!macro KntGhostBtn hwndVar x y w h text handler
  ${NSD_CreateLabel} ${x} ${y} ${w} ${h} "${text}"
  Pop ${hwndVar}
  SetCtlColors ${hwndVar} ${KNT_DIM} ${KNT_BG}
  SendMessage ${hwndVar} ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} ${hwndVar} ${SS_CENTER}|${SS_NOTIFY}
  ${NSD_OnClick} ${hwndVar} ${handler}
!macroend

; Footer secondary action (fixed position, bottom-right)
!macro KntCancelBtn hwndVar handler
  !insertmacro KntSecondaryBtn ${hwndVar} 266u 284u 46u 16u "Cancelar" ${handler}
!macroend

; Toggle: accent square + caption. stateVar holds 1/0; the box is
; painted accent when on, surface when off.
!macro KntToggleCreate boxVar textVar x y w caption stateVar handler
  ${NSD_CreateLabel} ${x} ${y} 13u 13u ""
  Pop ${boxVar}
  SendMessage ${boxVar} ${WM_SETFONT} $knt.checkFont 0
  ${NSD_AddStyle} ${boxVar} ${SS_CENTER}|${SS_NOTIFY}
  ${NSD_OnClick} ${boxVar} ${handler}
  ${If} ${stateVar} = 1
    SetCtlColors ${boxVar} ${KNT_TEXT} ${KNT_ACCENT}
    ${NSD_SetText} ${boxVar} "✓"
  ${Else}
    SetCtlColors ${boxVar} ${KNT_DIM} ${KNT_SURFACE}
  ${EndIf}

  ${NSD_CreateLabel} ${x} ${y} ${w} 13u "${caption}"
  Pop ${textVar}
  SetCtlColors ${textVar} ${KNT_TEXT} ${KNT_BG}
  SendMessage ${textVar} ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} ${textVar} ${SS_NOTIFY}
  ${NSD_OnClick} ${textVar} ${handler}
!macroend

; Brand panel (shared by all pages): dark side panel with wordmark and
; version, typography only (no bitmap assets required).
Function KntCreatePanel
  ${NSD_CreateLabel} 0 0 100u 100% ""
  Pop $knt.panel
  SetCtlColors $knt.panel "" "${KNT_PANEL}"

  ${NSD_CreateLabel} 0 34u 100u 22u "KNT"
  Pop $0
  SetCtlColors $0 ${KNT_ACCENT} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.titleFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 0 56u 100u 10u "M A N A G E R"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 0 258u 100u 10u "v${VERSION}"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}
FunctionEnd

Function un.KntCreatePanel
  ${NSD_CreateLabel} 0 0 100u 100% ""
  Pop $knt.panel
  SetCtlColors $knt.panel "" "${KNT_PANEL}"

  ${NSD_CreateLabel} 0 34u 100u 22u "KNT"
  Pop $0
  SetCtlColors $0 ${KNT_ACCENT} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.titleFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 0 56u 100u 10u "M A N A G E R"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 0 258u 100u 10u "v${VERSION}"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_PANEL}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}
FunctionEnd

; Footer bar shared by custom pages: divider line + copyright.
Function KntCreateFooter
  ${NSD_CreateLabel} 0 280u 328u 1u ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BORDER}"

  ${NSD_CreateLabel} 116u 288u 150u 8u "${COPYRIGHT}"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
FunctionEnd

Function un.KntCreateFooter
  ${NSD_CreateLabel} 0 280u 328u 1u ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BORDER}"

  ${NSD_CreateLabel} 116u 288u 150u 8u "${COPYRIGHT}"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
FunctionEnd

; =====================================================================
; Welcome page
; =====================================================================

Function KntWelcomeShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  ; The wizard shrinks the window to the page dialog template size on every
  ; transition, so restyle it back to our size on each page.
  Call KntStyleWindow

  nsDialogs::Create 1018
  Pop $knt.dialog
  ${If} $knt.dialog == error
    Abort
  ${EndIf}

  SetCtlColors $knt.dialog "" "${KNT_BG}"
  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BG}"

  Call KntCreatePanel

  ${NSD_CreateLabel} 116u 24u 196u 20u "Instalar KNT Manager"
  Pop $0
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.titleFont 0

  ${NSD_CreateLabel} 116u 44u 196u 10u "Gerencie suas contas Roblox em um único lugar."
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  !insertmacro KntDivider 116u 58u 196u

  ${NSD_CreateLabel} 116u 66u 196u 8u "LOCAL DE INSTALAÇÃO"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  ${NSD_CreateText} 116u 74u 150u 13u "$INSTDIR"
  Pop $knt.dirText
  ${NSD_AddStyle} $knt.dirText ${ES_READONLY}
  SetCtlColors $knt.dirText ${KNT_TEXT} ${KNT_SURFACE}

  !insertmacro KntSecondaryBtn $knt.dirBrowse 272u 74u 40u 13u "Alterar" KntOnBrowseClick

  IntOp $R8 ${ESTIMATEDSIZE} / 1024
  IntOp $R8 $R8 + 1
  ${NSD_CreateLabel} 116u 90u 196u 8u "Espaço necessário: aproximadamente $R8 MB"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  !insertmacro KntDivider 116u 100u 196u

  ${NSD_CreateLabel} 116u 108u 196u 8u "ATALHOS"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  StrCpy $knt.createDesktop 1
  !insertmacro KntToggleCreate $knt.deskBox $knt.deskChk 116u 118u 196u "Criar atalho na área de trabalho" $knt.createDesktop KntToggleDesktop

  StrCpy $knt.createStartMenu 1
  !insertmacro KntToggleCreate $knt.menuBox $knt.menuChk 116u 132u 196u "Criar atalho no Menu Iniciar" $knt.createStartMenu KntToggleMenu

  ${NSD_CreateLabel} 116u 152u 196u 30u "O KNT Manager será instalado apenas para a sua conta de usuário, sem precisar de permissões de administrador. Seus dados ficam salvos apenas neste computador."
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  !insertmacro KntPrimaryBtn $knt.installBtn 116u 176u 196u 18u "Instalar KNT Manager" KntOnInstallClick

  ${NSD_CreateLabel} 116u 202u 196u 8u "A instalação leva menos de um minuto."
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  Call KntCreateFooter
  !insertmacro KntCancelBtn $knt.cancelBtn KntOnCancelClick

  Call KntHideWizardButtons

  nsDialogs::Show
FunctionEnd

Function KntToggleDesktop
  ${If} $knt.createDesktop = 1
    StrCpy $knt.createDesktop 0
    ${NSD_SetText} $knt.deskBox ""
    SetCtlColors $knt.deskBox ${KNT_DIM} ${KNT_SURFACE}
  ${Else}
    StrCpy $knt.createDesktop 1
    ${NSD_SetText} $knt.deskBox "✓"
    SetCtlColors $knt.deskBox ${KNT_TEXT} ${KNT_ACCENT}
  ${EndIf}
  System::Call 'user32::InvalidateRect(i $knt.deskBox, i 0, i 1)'
FunctionEnd

Function KntToggleMenu
  ${If} $knt.createStartMenu = 1
    StrCpy $knt.createStartMenu 0
    ${NSD_SetText} $knt.menuBox ""
    SetCtlColors $knt.menuBox ${KNT_DIM} ${KNT_SURFACE}
  ${Else}
    StrCpy $knt.createStartMenu 1
    ${NSD_SetText} $knt.menuBox "✓"
    SetCtlColors $knt.menuBox ${KNT_TEXT} ${KNT_ACCENT}
  ${EndIf}
  System::Call 'user32::InvalidateRect(i $knt.menuBox, i 0, i 1)'
FunctionEnd

Function KntOnBrowseClick
  Pop $0
  nsDialogs::SelectFolderDialog "Selecione a pasta de instalação" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
    ${AndIf} $0 != ""
    StrCpy $INSTDIR $0
    ${NSD_SetText} $knt.dirText $0
  ${EndIf}
FunctionEnd

Function KntDbg2
  FileOpen $9 "$TEMP\knt-click.txt" a
  FileWrite $9 "$0$\r$\n"
  FileClose $9
FunctionEnd

Function KntOnInstallClick
  StrCpy $0 "onInstallClick"
  Call KntDbg2
  StrCpy $knt.installRequested 1
  Call KntClickNext
FunctionEnd

Function KntClickNext
  StrCpy $0 "clickNext"
  Call KntDbg2
  GetDlgItem $0 $HWNDPARENT 1
  StrCpy $1 $0
  StrCpy $0 "nextBtn=$1 parent=$HWNDPARENT"
  Call KntDbg2
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 $1
FunctionEnd

Function KntWelcomeLeave
  StrCpy $0 "welcomeLeave"
  Call KntDbg2
  ${If} $knt.installRequested <> 1
    StrCpy $0 "leave-abort"
    Call KntDbg2
    Abort
  ${EndIf}
  ${NSD_GetText} $knt.dirText $0
  ${If} $0 == ""
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
FunctionEnd

; =====================================================================
; Reinstall / upgrade choice page
; =====================================================================

Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installer version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "versão desconhecida"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${If} $R0 != ""
    StrCpy $R4 "v$R0"
  ${EndIf}
  StrCpy $knt.reinstallVer "$R4"

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "O KNT Manager ${VERSION} já está instalado neste computador. O que você gostaria de fazer?"
    StrCpy $R2 "Reinstalar (manter meus dados)"
    StrCpy $R3 "Desinstalar o aplicativo"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "Uma versão anterior do KNT Manager está instalada. Como você gostaria de instalar a v${VERSION}?"
    StrCpy $R2 "Desinstalar antes de instalar"
    StrCpy $R3 "Instalar sem desinstalar"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "Uma versão mais recente do KNT Manager está instalada. Como você gostaria de continuar?"
    StrCpy $R2 "Desinstalar antes de instalar"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "Instalar sem desinstalar"
    !else
      StrCpy $R3 "Instalar sem desinstalar (não recomendado nesta versão)"
    !endif
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    Call KntStyleWindow
    nsDialogs::Create 1018
    Pop $knt.dialog
    ${If} $knt.dialog == error
      Abort
    ${EndIf}

    SetCtlColors $knt.dialog "" "${KNT_BG}"
    ${NSD_CreateLabel} 0 0 100% 100% ""
    Pop $0
    SetCtlColors $0 "" "${KNT_BG}"

    Call KntCreatePanel

    ${NSD_CreateLabel} 116u 24u 196u 20u "Instalação detectada"
    Pop $0
    SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
    SendMessage $0 ${WM_SETFONT} $knt.titleFont 0

    ${NSD_CreateLabel} 116u 46u 196u 26u "$R1"
    Pop $knt.reinstallMsg
    SetCtlColors $knt.reinstallMsg ${KNT_TEXT} ${KNT_BG}
    SendMessage $knt.reinstallMsg ${WM_SETFONT} $knt.subFont 0

    ${NSD_CreateLabel} 116u 78u 196u 8u "Versão instalada: $knt.reinstallVer"
    Pop $0
    SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
    SendMessage $0 ${WM_SETFONT} $knt.subFont 0

    ; Choice rows (custom radio)
    ${If} $ReinstallPageCheck <> 2
      StrCpy $ReinstallPageCheck 1
    ${EndIf}
    StrCpy $R9 $ReinstallPageCheck
    StrCpy $ReinstallPageCheck 1
    !insertmacro KntToggleCreate $knt.rr1Box $knt.rr1Text 116u 94u 196u "$R2" $ReinstallPageCheck KntReinstallRow1Click
    StrCpy $ReinstallPageCheck 2
    !insertmacro KntToggleCreate $knt.rr2Box $knt.rr2Text 116u 112u 196u "$R3" $ReinstallPageCheck KntReinstallRow2Click
    StrCpy $ReinstallPageCheck $R9
    ; Disable second row if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${If} $R0 = -1
        EnableWindow $knt.rr2Box 0
        EnableWindow $knt.rr2Text 0
      ${EndIf}
    !endif
    Call KntPaintReinstallRows

    !insertmacro KntPrimaryBtn $knt.installBtn 116u 160u 196u 18u "Continuar" KntOnContinueClick

    Call KntCreateFooter
    !insertmacro KntCancelBtn $knt.cancelBtn KntOnCancelClick

    Call KntHideWizardButtons

    nsDialogs::Show
  ${EndIf}
FunctionEnd

Function KntOnContinueClick
  Call KntClickNext
FunctionEnd

Function KntPaintReinstallRows
  ${If} $ReinstallPageCheck = 2
    ${NSD_SetText} $knt.rr2Box "✓"
    SetCtlColors $knt.rr2Box ${KNT_TEXT} ${KNT_ACCENT}
    SetCtlColors $knt.rr2Text ${KNT_TEXT} ${KNT_BG}
    ${NSD_SetText} $knt.rr1Box ""
    SetCtlColors $knt.rr1Box ${KNT_DIM} ${KNT_SURFACE}
    SetCtlColors $knt.rr1Text ${KNT_DIM} ${KNT_BG}
  ${Else}
    ${NSD_SetText} $knt.rr1Box "✓"
    SetCtlColors $knt.rr1Box ${KNT_TEXT} ${KNT_ACCENT}
    SetCtlColors $knt.rr1Text ${KNT_TEXT} ${KNT_BG}
    ${NSD_SetText} $knt.rr2Box ""
    SetCtlColors $knt.rr2Box ${KNT_DIM} ${KNT_SURFACE}
    SetCtlColors $knt.rr2Text ${KNT_DIM} ${KNT_BG}
  ${EndIf}
  System::Call 'user32::InvalidateRect(i $knt.rr1Box, i 0, i 1)'
  System::Call 'user32::InvalidateRect(i $knt.rr1Text, i 0, i 1)'
  System::Call 'user32::InvalidateRect(i $knt.rr2Box, i 0, i 1)'
  System::Call 'user32::InvalidateRect(i $knt.rr2Text, i 0, i 1)'
FunctionEnd

Function KntReinstallRow1Click
  StrCpy $ReinstallPageCheck 1
  Call KntPaintReinstallRows
FunctionEnd

Function KntReinstallRow2Click
  StrCpy $ReinstallPageCheck 2
  Call KntPaintReinstallRows
FunctionEnd

Function PageLeaveReinstall
  ${If} $ReinstallPageCheck = 1
    StrCpy $R1 1
  ${Else}
    StrCpy $R1 0
  ${EndIf}

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "Não foi possível desinstalar a versão anterior. Tente novamente ou desinstale manualmente pelo Painel de Controle."
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; =====================================================================
; Install progress page (MUI instfiles, dark themed)
; =====================================================================
; The header title is set in the show callback to keep it in Portuguese
; (MUI's own page strings are English)
Function KntInstFilesShow
  StrCpy $0 "instFilesShow"
  Call KntDbg2
  Call KntStyleWindow
  FindWindow $mui.InstFilesPage "#32770" "" $HWNDPARENT
  StrCpy $knt.dialog $mui.InstFilesPage
  StrCpy $0 $mui.InstFilesPage
  Call KntStretchPageDialogShort
  Call KntLayoutButtons

  ; Page background
  SetCtlColors $mui.InstFilesPage "" "${KNT_BG}"

  ; Progress bar: violet fill on surface bg, repositioned for the tall window
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBARCOLOR} 0 ${KNT_ACCENT}
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBKCOLOR} 0 ${KNT_SURFACE}
  IntOp $6 $knt.clientW - 198
  System::Call "user32::SetWindowPos(i $mui.InstFilesPage.ProgressBar, i 0, i 174, i 150, i r6, i 8, i 0x0014)"
  ; Current file label above the bar
  GetDlgItem $0 $mui.InstFilesPage 1002
  System::Call "user32::SetWindowPos(i $0, i 0, i 174, i 128, i r6, i 14, i 0x0014)"
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}

  ; Hide the details log + log controls for a clean look
  ShowWindow $mui.InstFilesPage.ShowLogButton 0
  ShowWindow $mui.InstFilesPage.Log 0
  ShowWindow $mui.InstFilesPage.Text 0

  ; Header texts (Portuguese)
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Instalando KNT Manager"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Por favor, aguarde enquanto os arquivos são copiados."

  ; Hide the Back button, keep Cancel
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
FunctionEnd

; =====================================================================
; Finish page
; =====================================================================

Function KntFinishShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  StrCpy $0 "finishShow"
  Call KntDbg2
  Call KntStyleWindow

  nsDialogs::Create 1018
  Pop $knt.dialog
  ${If} $knt.dialog == error
    Abort
  ${EndIf}

  SetCtlColors $knt.dialog "" "${KNT_BG}"
  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BG}"

  Call KntCreatePanel

  ; Success checkmark
  ${NSD_CreateLabel} 116u 28u 196u 34u "✓"
  Pop $0
  SetCtlColors $0 ${KNT_SUCCESS} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.bigCheckFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 116u 68u 196u 20u "KNT Manager está pronto."
  Pop $0
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.titleFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ${NSD_CreateLabel} 116u 90u 196u 10u "A instalação foi concluída com sucesso."
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  ; Run toggle (default checked)
  StrCpy $knt.runDone 1
  !insertmacro KntToggleCreate $knt.runBox $knt.runChk 116u 116u 196u "Executar o KNT Manager agora" $knt.runDone KntToggleRun

  ${NSD_CreateLabel} 116u 138u 196u 16u "$INSTDIR"
  Pop $0
  SetCtlColors $0 ${KNT_DIM} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0
  ${NSD_AddStyle} $0 ${SS_CENTER}

  !insertmacro KntPrimaryBtn $knt.openBtn 116u 168u 196u 18u "Abrir KNT Manager" KntOnOpenClick
  !insertmacro KntGhostBtn $knt.cancelBtn 116u 192u 196u 14u "Concluir" KntFinishLeaveOnly

  Call KntCreateFooter

  Call KntHideWizardButtons

  nsDialogs::Show
FunctionEnd

Function KntToggleRun
  ${If} $knt.runDone = 1
    StrCpy $knt.runDone 0
    ${NSD_SetText} $knt.runBox ""
    SetCtlColors $knt.runBox ${KNT_DIM} ${KNT_SURFACE}
  ${Else}
    StrCpy $knt.runDone 1
    ${NSD_SetText} $knt.runBox "✓"
    SetCtlColors $knt.runBox ${KNT_TEXT} ${KNT_ACCENT}
  ${EndIf}
  System::Call 'user32::InvalidateRect(i $knt.runBox, i 0, i 1)'
FunctionEnd

Function KntFinishLeaveOnly
  Call KntClickNext
FunctionEnd

Function KntOnOpenClick
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  StrCpy $knt.runDone 1
  Call KntClickNext
FunctionEnd

Function KntFinishLeave
  ${If} $knt.runDone <> 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    StrCpy $knt.runDone 1
  ${EndIf}
FunctionEnd

; =====================================================================
; Uninstaller pages
; =====================================================================

Function un.KntUnConfirmShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  Call un.KntStyleWindow

  nsDialogs::Create 1018
  Pop $knt.dialog
  ${If} $knt.dialog == error
    Abort
  ${EndIf}

  SetCtlColors $knt.dialog "" "${KNT_BG}"
  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $0
  SetCtlColors $0 "" "${KNT_BG}"

  Call un.KntCreatePanel

  ${NSD_CreateLabel} 116u 24u 196u 20u "Desinstalar KNT Manager"
  Pop $0
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.titleFont 0

  ${NSD_CreateLabel} 116u 46u 196u 30u "Tem certeza de que deseja remover o KNT Manager deste computador? Os arquivos instalados serão excluídos."
  Pop $0
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
  SendMessage $0 ${WM_SETFONT} $knt.subFont 0

  StrCpy $DeleteAppDataCheckboxState 0
  !insertmacro KntToggleCreate $knt.dataBox $DeleteAppDataCheckbox 116u 90u 196u "Excluir também os dados do aplicativo (contas, configurações e arquivos salvos)" $DeleteAppDataCheckboxState un.KntToggleData

  ; Primary action: destructive, painted in the error color
  ${NSD_CreateLabel} 116u 160u 196u 18u "Desinstalar"
  Pop $knt.installBtn
  SetCtlColors $knt.installBtn ${KNT_TEXT} ${KNT_ERROR}
  SendMessage $knt.installBtn ${WM_SETFONT} $knt.btnFont 0
  ${NSD_AddStyle} $knt.installBtn ${SS_CENTER}|${SS_NOTIFY}
  ${NSD_OnClick} $knt.installBtn un.KntOnContinueClick

  Call un.KntCreateFooter
  !insertmacro KntCancelBtn $knt.cancelBtn un.KntOnCancelClick

  Call un.KntHideWizardButtons

  nsDialogs::Show
FunctionEnd

Function un.KntToggleData
  ${If} $DeleteAppDataCheckboxState = 1
    StrCpy $DeleteAppDataCheckboxState 0
    ${NSD_SetText} $knt.dataBox ""
    SetCtlColors $knt.dataBox ${KNT_DIM} ${KNT_SURFACE}
  ${Else}
    StrCpy $DeleteAppDataCheckboxState 1
    ${NSD_SetText} $knt.dataBox "✓"
    SetCtlColors $knt.dataBox ${KNT_TEXT} ${KNT_ACCENT}
  ${EndIf}
  System::Call 'user32::InvalidateRect(i $knt.dataBox, i 0, i 1)'
FunctionEnd

Function un.KntOnCancelClick
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function un.KntClickNext
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 $0
FunctionEnd

Function un.KntOnContinueClick
  Call un.KntClickNext
FunctionEnd

Function un.KntUnConfirmLeave
FunctionEnd

Function un.KntUnInstFilesShow
  Call un.KntStyleWindow
  FindWindow $mui.InstFilesPage "#32770" "" $HWNDPARENT
  StrCpy $knt.dialog $mui.InstFilesPage
  StrCpy $0 $mui.InstFilesPage
  Call un.KntStretchPageDialogShort
  Call un.KntLayoutButtons

  SetCtlColors $mui.InstFilesPage "" "${KNT_BG}"
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBARCOLOR} 0 ${KNT_ACCENT}
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBKCOLOR} 0 ${KNT_SURFACE}
  IntOp $6 $knt.clientW - 198
  System::Call "user32::SetWindowPos(i $mui.InstFilesPage.ProgressBar, i 0, i 174, i 150, i r6, i 8, i 0x0014)"
  GetDlgItem $0 $mui.InstFilesPage 1002
  System::Call "user32::SetWindowPos(i $0, i 0, i 174, i 128, i r6, i 14, i 0x0014)"
  SetCtlColors $0 ${KNT_TEXT} ${KNT_BG}
  ShowWindow $mui.InstFilesPage.ShowLogButton 0
  ShowWindow $mui.InstFilesPage.Log 0
  ShowWindow $mui.InstFilesPage.Text 0

  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Desinstalando KNT Manager"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Por favor, aguarde enquanto os arquivos são removidos."

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
FunctionEnd

; =====================================================================
; Installer logic (unchanged from tauri)
; =====================================================================

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd

Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "Esta versão não permite instalar uma versão mais antiga. Abortando..."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "Baixando o WebView2 Runtime..."
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "WebView2 baixado com sucesso."
        ${Else}
          DetailPrint "Falha ao baixar o WebView2 Runtime."
          Abort "Não foi possível instalar o WebView2 Runtime, necessário para o KNT Manager. Tente novamente mais tarde."
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "Instalando o WebView2 Runtime..."
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "Instalando o WebView2 Runtime..."
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "Instalando o WebView2 Runtime..."
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "WebView2 instalado com sucesso."
        ${Else}
          DetailPrint "Falha ao instalar o WebView2 Runtime."
          Abort "Não foi possível instalar o WebView2 Runtime, necessário para o KNT Manager. Tente novamente mais tarde."
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "Instalando o WebView2 Runtime..."
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "WebView2 instalado com sucesso."
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "Falha ao atualizar o WebView2 Runtime." IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create shortcuts (installer + silent/passive always create them)
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateStartMenuShortcut
    Call CreateOrUpdateDesktopShortcut
  ${Else}
    ${If} $knt.createStartMenu = ${BST_CHECKED}
      Call CreateOrUpdateStartMenuShortcut
    ${EndIf}
    ${If} $knt.createDesktop = ${BST_CHECKED}
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\${PRODUCTNAME}"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
