; Yamlet — Inno Setup installer script
; Compiled by scripts/build-windows.ps1 via:
;   ISCC.exe /DAppVersion=<ver> /DSourceDir=<abs-path> /DRepoRoot=<abs-path> yamlet.iss

#ifndef AppVersion
  #define AppVersion "0.0.0.0"
#endif

; Absolute path to the staged publish directory (artifacts/pkg/yamlet-windows/Yamlet)
#ifndef SourceDir
  #define SourceDir "..\..\artifacts\pkg\yamlet-windows\Yamlet"
#endif

; Absolute path to the repository root
#ifndef RepoRoot
  #define RepoRoot "..\.."
#endif

[Setup]
; Unique AppId — do not change once the installer is publicly distributed
AppId={{C9F4A2D7-8B1E-4A36-9E5C-2F7D3A6B8C10}
AppName=Yamlet
AppVersion={#AppVersion}
AppPublisher=Piyush Doorwar
AppPublisherURL=https://github.com/piyushdoorwar/yamlet
AppSupportURL=https://github.com/piyushdoorwar/yamlet/issues
AppUpdatesURL=https://github.com/piyushdoorwar/yamlet/releases
DefaultDirName={autopf}\Yamlet
DefaultGroupName=Yamlet
AllowNoIcons=yes
LicenseFile={#RepoRoot}\LICENSE
OutputDir={#RepoRoot}\artifacts\packages
OutputBaseFilename=yamlet_{#AppVersion}_win-x64_setup
SetupIconFile={#RepoRoot}\packaging\windows\yamlet.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; x64 only
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 minimum (.NET 10 requirement)
MinVersion=10.0.17763
UninstallDisplayIcon={app}\Yamlet.App.exe
UninstallDisplayName=Yamlet
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Copy the entire self-contained publish output (Yamlet.App.exe + runtime + DLLs)
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Yamlet"; Filename: "{app}\Yamlet.App.exe"
Name: "{autodesktop}\Yamlet"; Filename: "{app}\Yamlet.App.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Yamlet.App.exe"; Description: "{cm:LaunchProgram,Yamlet}"; Flags: nowait postinstall skipifsilent
