@echo off
rem ---------------------------------------------------------------
rem  Build "birdreport-rare-birds" into a single portable .exe.
rem  Keep this file ASCII-only: cmd.exe reads batch files using the
rem  OEM code page, and non-ASCII text here corrupts the parsing.
rem
rem  Output: dist\*.exe   (double-click to run, opens the browser)
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo   Building single-file exe ...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] "node" not found. Install Node.js and add it to PATH first.
  exit /b 1
)

if not exist "node_modules\postject" (
  echo   Installing build dependencies ^(esbuild, postject^) ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [ERROR] npm install failed. Run "npm install" manually.
    exit /b 1
  )
)

echo   [1/4] collect web assets, write build\sea-config.json
node build-exe.mjs config
if errorlevel 1 goto fail

echo   [2/4] bundle server code with esbuild
if exist "node_modules\@esbuild\win32-x64\esbuild.exe" (
  "node_modules\@esbuild\win32-x64\esbuild.exe" server\index.mjs --bundle --platform=node --format=cjs --target=node22 --legal-comments=none --log-level=warning --outfile=build\app.cjs
) else (
  call npx --no-install esbuild server\index.mjs --bundle --platform=node --format=cjs --target=node22 --legal-comments=none --log-level=warning --outfile=build\app.cjs
)
if errorlevel 1 goto fail

echo   [3/4] generate SEA preparation blob
node --experimental-sea-config build\sea-config.json
if errorlevel 1 goto fail

echo   [4/4] copy node.exe and inject the blob
node build-exe.mjs inject
if errorlevel 1 goto fail

echo.
echo   Done. The exe is in the "dist" folder.
echo   Double-click it: the browser opens automatically, and closing
echo   the console window stops the server.
echo.
exit /b 0

:fail
echo.
echo   [ERROR] Build failed. See the output above.
exit /b 1
