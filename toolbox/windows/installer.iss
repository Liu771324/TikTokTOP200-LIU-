#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppDir
  #error AppDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef BootstrapperPath
  #error BootstrapperPath is required
#endif

[Setup]
AppId=ScriptAllToolbox
AppName=电商工具箱
AppVersion={#AppVersion}
AppPublisher=Script All
DefaultDirName={localappdata}\Programs\ScriptAllToolbox
DefaultGroupName=电商工具箱
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
AppMutex=Local\ScriptAllToolbox.InstallGuard
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=ScriptAllToolbox-{#AppVersion}-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\ScriptAllToolbox.exe

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BootstrapperPath}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Icons]
Name: "{group}\电商工具箱"; Filename: "{app}\ScriptAllToolbox.exe"
Name: "{userdesktop}\电商工具箱"; Filename: "{app}\ScriptAllToolbox.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ScriptAllToolbox.exe"; Description: "打开电商工具箱"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebViewKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  EdgeDownload = 'https://www.microsoft.com/edge/download';

// Inno 6.7.3 script API uses Integer for registry root keys (is-6_7_3).
function HasRuntimeIn(Hive: Integer): Boolean;
var Version: String;
begin
  Result := RegQueryStringValue(Hive, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebView2: Boolean;
begin
  Result := HasRuntimeIn(HKCU32) or HasRuntimeIn(HKCU64) or
    HasRuntimeIn(HKLM32) or HasRuntimeIn(HKLM64);
end;

function HasEdge: Boolean;
var EdgePath: String;
begin
  Result := (RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', EdgePath) and FileExists(EdgePath)) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', EdgePath) and FileExists(EdgePath)) or
    FileExists(ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe')) or
    FileExists(ExpandConstant('{pf64}\Microsoft\Edge\Application\msedge.exe')) or
    FileExists(ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe'));
end;

function InitializeSetup: Boolean;
var ErrorCode: Integer;
begin
  Result := True;
  if not HasEdge then
    if MsgBox('采集功能需要 Microsoft Edge。可先安装工具箱；使用采集前请从微软官方页面安装 Edge。是否现在打开下载页？', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', EdgeDownload, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

function DataDirectoryConflict: Boolean;
var DataRoot, AppRoot, CheckRoot, ParentRoot: String;
begin
  DataRoot := Lowercase(AddBackslash(ExpandConstant('{localappdata}\ScriptAllToolbox')));
  AppRoot := Lowercase(AddBackslash(ExpandFileName(WizardDirValue)));
  Result := Pos(DataRoot, AppRoot) = 1;
  // Also protect moved data roots without depending on a versioned JSON parser.
  CheckRoot := ExcludeTrailingBackslash(AppRoot);
  while not Result do begin
    if FileExists(AddBackslash(CheckRoot) + 'toolbox.sqlite3') and
       DirExists(AddBackslash(CheckRoot) + 'tasks') and
       DirExists(AddBackslash(CheckRoot) + 'media') then begin
      Result := True;
      exit;
    end;
    ParentRoot := ExtractFileDir(CheckRoot);
    if (ParentRoot = '') or (ParentRoot = CheckRoot) then exit;
    CheckRoot := ParentRoot;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and DataDirectoryConflict then begin
    MsgBox('程序目录需与工具箱用户数据目录分开，请使用默认程序目录或其他文件夹。', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var ExitCode: Integer;
begin
  Result := '';
  // Silent /DIR overrides do not trigger NextButtonClick.
  if DataDirectoryConflict then begin
    Result := '程序目录不能位于工具箱用户数据目录内。';
    exit;
  end;
  if HasWebView2 then exit;
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
    Result := '无法启动 Microsoft WebView2 安装程序，请检查网络后重试。';
    exit;
  end;
  if not HasWebView2 then
    Result := 'Microsoft WebView2 运行时尚未安装完成（退出码 ' + IntToStr(ExitCode) + '）。请联网完成安装；如提示重启，请重启后重试。';
end;

// No [UninstallDelete] or data-directory cleanup: LOCALAPPDATA\ScriptAllToolbox remains.
