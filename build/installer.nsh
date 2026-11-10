; 装法：payload 随包带成 resources/payload.7z，装时用随包 7za 直解到 resources/app/payload。
; NSIS 默认装法先把 7z 解到临时目录再用 CopyFiles 逐个复制，两万多个文件要 5 分钟，直解一分多。
; 卸载：安装目录 NSIS 自己删；程序自己的 node-low 和 LocalLow 一起删；用户的数据问一句，默认留。
; 注意：one-click 卸载器在用户确认后会 SetSilent silent，${Silent} 永远为真，
; 所以改看命令行里有没有真的 /S（/S = 静默卸载，不问都留；没有 = 用户点的，问一句）。

; 自定义运行检查会替代默认分支，因此补上默认分支原本负责加载的进程助手和全局 pid。
!include "getProcessInfo.nsh"
Var pid

; electron-builder 的 messages.yml 没有这三条 zh_CN；自定义 include 先于 MUI_LANGUAGE，故用简体中文 LCID 2052。
; 覆盖内置英文兜底会触发 6030，只在这段关掉“重复定义”警告（electron-builder 把警告当错误）。
!pragma warning disable 6030
LangString uninstallFailed 2052 "有文件没能删干净。请再运行一次安装包；还不行就重启电脑后再试。"
LangString decompressionFailed 2052 "安装文件解压失败。请再运行一次安装包。"
LangString appClosing 2052 "正在关闭 ${PRODUCT_NAME}……"
!pragma warning enable 6030

; customCheckAppRunning 包裹原检查：安装段在 uninstallOldVersion 之前调用它，此时 $INSTDIR 已是旧目录。
; 早期版本的卸载器会逐文件搬到 %TEMP%；确认桌伴已关后再删会重装的 payload，避免长路径和取消后留下残缺。
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    RMDir /r "$INSTDIR\resources\app\payload"
  !endif
!macroend

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\7za.exe" x -y "-o$INSTDIR\resources\app\payload" "$INSTDIR\resources\payload.7z"'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "payload 解压失败（退出码 $R0），安装中止"
    MessageBox MB_OK|MB_ICONSTOP "装到一半没成：payload 解压失败（退出码 $R0）。请关掉别的程序再装一次；还不行就把这个码发给桌伴。" /SD IDOK
    Abort
  ${EndIf}
  Delete "$INSTDIR\resources\payload.7z"
  Delete "$INSTDIR\resources\7za.exe"
  Delete "$INSTDIR\resources\7za-LICENSE.txt"
  Delete "$INSTDIR\resources\7za-COPYING.txt"
!macroend

; 新版卸载器不走 atomicRMDir：不要逐文件改名到 $PLUGINSDIR\old-install（它位于 %TEMP%）。
; 沿用卸载器 un.onInit 的先关闭检查；移出当前目录后直接删，避免路径变长。
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInstall
  RMDir /r "$APPDATA\sidemate\node-low"
  RMDir /r "$PROFILE\AppData\LocalLow\桌伴"
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "卸载桌伴。$\n$\n要不要把你的数据也删掉？$\n$PROFILE\桌伴（任务、产出、钥匙）$\n$APPDATA\sidemate（最近记录、日志）$\n默认留着。" IDYES del_data IDNO keep_data
    del_data:
      RMDir /r "$PROFILE\桌伴"
      RMDir /r "$APPDATA\sidemate"
    keep_data:
  ${EndIf}
!macroend
