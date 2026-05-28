; Strata Mixer v1.0 Windows Installer
#define MyAppName "Strata Mixer"
#define MyAppVersion "1.1"
#define MyAppPublisher "Strata Mixer"
#define MyAppExeName "StrataMixer_1_0.exe"
#define MySourceDir "release\StrataMixer_1_0-win32-x64"

[Setup]
AppId={{C6D86E6E-1E04-45A5-A63D-5A11A0C0011C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Strata Mixer
DefaultGroupName=Strata Mixer
DisableProgramGroupPage=yes
OutputDir=installer-output
OutputBaseFilename=StrataMixer_Setup_1_1
SetupIconFile=assets\strata_mixer_v1_2_4.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: unchecked

[InstallDelete]
Type: files; Name: "{app}\StrataMixer_1_3_1_beta.exe"
Type: files; Name: "{app}\StrataMixer_1_3_beta.exe"
Type: files; Name: "{app}\StrataMixer_1_2_beta.exe"
Type: files; Name: "{app}\StrataMixer_1_1_1_beta.exe"
Type: files; Name: "{app}\StrataMixer_1_1_beta.exe"

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Strata Mixer"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Strata Mixer"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить Strata Mixer"; Flags: nowait postinstall skipifsilent
