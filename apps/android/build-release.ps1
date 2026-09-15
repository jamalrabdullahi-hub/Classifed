# Builds and signs the FLT Android app in one step.
#
#   powershell -ExecutionPolicy Bypass -File C:\FLTCrypto\apps\android\build-release.ps1
#
# Asks for the keystore password once, hidden as you type. The password is
# checked against the keystore before building, handed to keytool and
# Bubblewrap only through environment variables of this one process, never
# written to disk or printed, and cleared at the end.

$ErrorActionPreference = 'Stop'

$Jdk      = 'C:\FLT-tools\jdk-17'
$Sdk      = 'C:\FLT-tools\android-sdk'
$Keystore = 'C:\FLT-signing\flt-upload.keystore'
$Alias    = 'flt-upload'
$Keytool  = Join-Path $Jdk 'bin\keytool.exe'
$Project  = $PSScriptRoot

foreach ($path in @($Keytool, $Sdk, $Keystore)) {
  if (-not (Test-Path $path)) { throw "Missing: $path" }
}

# Bubblewrap runs gradlew.bat by bare name; this Windows setting blocks that.
Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk

Write-Host 'Pointing Bubblewrap at the JDK and Android SDK...'
& npx.cmd --yes @bubblewrap/cli updateConfig --jdkPath $Jdk --androidSdkPath $Sdk | Out-Null

$secure = Read-Host 'Keystore password (hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$ErrorActionPreference = 'Continue'
$buildExit = 1
try {
  # Check the password first, so a typo fails in a second rather than after the build.
  $env:FLT_KS_CHECK = $plain
  $listing = & $Keytool -list -keystore $Keystore -alias $Alias -storepass:env FLT_KS_CHECK 2>&1 | Out-String
  $listExit = $LASTEXITCODE
  Remove-Item Env:FLT_KS_CHECK -ErrorAction SilentlyContinue

  if ($listExit -ne 0 -or $listing -notmatch 'PrivateKeyEntry') {
    Write-Host ''
    Write-Host 'That password does not open the keystore. Nothing was built.' -ForegroundColor Red
    exit 1
  }
  Write-Host 'Password OK.' -ForegroundColor Green

  $env:BUBBLEWRAP_KEYSTORE_PASSWORD = $plain
  $env:BUBBLEWRAP_KEY_PASSWORD = $plain
  Push-Location $Project
  Write-Host 'Building and signing (a few minutes the first time)...'
  # Output is filtered so a failing signing command, which carries the password, never prints it.
  & npx.cmd --yes @bubblewrap/cli build 2>&1 |
    ForEach-Object { "$_" -replace 'pass:"[^"]*"', 'pass:"***"' -replace 'pass:\S+', 'pass:***' }
  $buildExit = $LASTEXITCODE
  Pop-Location
} finally {
  Remove-Item Env:FLT_KS_CHECK -ErrorAction SilentlyContinue
  Remove-Item Env:BUBBLEWRAP_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:BUBBLEWRAP_KEY_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
}

$apk = Join-Path $Project 'app-release-signed.apk'
$aab = Join-Path $Project 'app-release-bundle.aab'
if ($buildExit -ne 0 -or -not (Test-Path $apk)) {
  Write-Host 'The build did not produce a signed APK. Send the error lines above; they do not show the password.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "APK: $apk"
if (Test-Path $aab) { Write-Host "AAB: $aab" }
Write-Host ('APK SHA-256: ' + (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower())
