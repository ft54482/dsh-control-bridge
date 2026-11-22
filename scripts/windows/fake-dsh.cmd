@echo off
setlocal EnableExtensions
REM Fake headless dsh. Reads the task from stdin and never calls a model.
REM DSH_FAKE_MODE selects a self-check behavior. The task text is not expanded.
set /p TASK_LINE=

if /I "%DSH_FAKE_MODE%"=="hang" goto hang
if /I "%DSH_FAKE_MODE%"=="tree" goto tree
if /I "%DSH_FAKE_MODE%"=="badexit" goto badexit
if /I "%DSH_FAKE_MODE%"=="nofinal" goto nofinal

echo {"type":"session","sessionId":"session-fake"}
echo {"type":"status","text":"fake"}
echo {"type":"final","sessionId":"session-fake","reason":{"kind":"completed"},"text":"fake-no-model"}
exit /b 0

:nofinal
echo {"type":"session","sessionId":"session-fake"}
exit /b 0

:badexit
echo {"type":"session","sessionId":"session-fake"}
echo {"type":"final","sessionId":"session-fake","reason":{"kind":"completed"},"text":"fake-no-model"}
exit /b 1

:hang
echo {"type":"session","sessionId":"session-fake"}
ping.exe -n 120 127.0.0.1 >nul
exit /b 1

:tree
echo {"type":"session","sessionId":"session-fake"}
start "" /b cmd.exe /c "ping.exe -n 120 127.0.0.1 >nul"
ping.exe -n 120 127.0.0.1 >nul
exit /b 1
