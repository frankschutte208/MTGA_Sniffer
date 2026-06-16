@echo off
setlocal EnableDelayedExpansion

echo ================================================
echo            MTGA_Sniffer Backup Tool
echo ================================================
echo.

set "TARGET_REMOTE_URL=https://github.com/frankschutte208/MTGA_Sniffer.git"

REM Check if we're in a git repository
if not exist ".git" (
    echo No git repository found in this folder.
    set /p INIT_REPO="Initialize a new git repository here now? (y/n): "
    if /i not "!INIT_REPO!"=="y" (
        echo Backup cancelled.
        exit /b 0
    )
    git init -b main >nul 2>&1
    if errorlevel 1 (
        git init >nul 2>&1
    )
    if errorlevel 1 (
        echo Error: Failed to initialize git repository.
        exit /b 1
    )
    echo Git repository initialized.
)

REM Validate Git is available
git --version >nul 2>&1
if errorlevel 1 (
    echo Error: Git is not installed or not in PATH.
    exit /b 1
)

REM Detect current branch
for /f "tokens=*" %%a in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set CURRENT_BRANCH=%%a
if "!CURRENT_BRANCH!"=="" set "CURRENT_BRANCH=main"
if /i "!CURRENT_BRANCH!"=="HEAD" set "CURRENT_BRANCH=main"

REM Ensure origin points to this project's repository
set "ORIGIN_URL="
for /f "tokens=*" %%a in ('git remote get-url origin 2^>nul') do set ORIGIN_URL=%%a
if "!ORIGIN_URL!"=="" (
    echo No origin remote found. Adding origin:
    echo   !TARGET_REMOTE_URL!
    git remote add origin !TARGET_REMOTE_URL!
    if errorlevel 1 (
        echo Error: Failed to add origin remote.
        exit /b 1
    )
) else (
    if /i not "!ORIGIN_URL!"=="!TARGET_REMOTE_URL!" (
        echo Existing origin remote:
        echo   !ORIGIN_URL!
        echo Expected for this project:
        echo   !TARGET_REMOTE_URL!
        set /p UPDATE_REMOTE="Update origin to this repository? (y/n): "
        if /i "!UPDATE_REMOTE!"=="y" (
            git remote set-url origin !TARGET_REMOTE_URL!
            if errorlevel 1 (
                echo Error: Failed to update origin remote.
                exit /b 1
            )
        ) else (
            echo Backup cancelled. Origin remote was not updated.
            exit /b 0
        )
    )
)

REM Get last commit date and message
for /f "tokens=*" %%a in ('git log -1 --format^="%%cd" --date^=format:"%%Y-%%m-%%d %%H:%%M:%%S" 2^>nul') do set LAST_BACKUP=%%a
for /f "tokens=*" %%a in ('git log -1 --format^="%%s" 2^>nul') do set LAST_MESSAGE=%%a
if "!LAST_BACKUP!"=="" set "LAST_BACKUP=No commits yet"
if "!LAST_MESSAGE!"=="" set "LAST_MESSAGE=No commits yet"

REM Get current version
for /f "tokens=*" %%a in ('git describe --abbrev^=0 --tags 2^>nul') do set CURRENT_VERSION=%%a
if "!CURRENT_VERSION!"=="" (
    set CURRENT_VERSION=No version tags yet
)

echo Last Backup Information:
echo -----------------------
echo Date: !LAST_BACKUP!
echo Message: !LAST_MESSAGE!
echo Current Version: !CURRENT_VERSION!
echo Current Branch: !CURRENT_BRANCH!
echo.
echo Build outputs are NOT backed up ^(.gitignore^): apps/tray-ui/dist/, apps/tray-ui/dist-new/, scan-work/, node_modules/
echo.

REM Show changed files
echo Changed Files:
echo -------------
git status -s
echo.

REM Detect uncommitted/untracked working tree changes
set "HAS_CHANGES="
for /f "tokens=*" %%a in ('git status --porcelain') do (
    set "HAS_CHANGES=1"
)

REM Detect unpushed commits (backup can fail at push while commit exists locally)
set "UNPUSHED_COUNT=0"
for /f %%a in ('git rev-list --count @{u}..HEAD 2^>nul') do set "UNPUSHED_COUNT=%%a"
if not defined UNPUSHED_COUNT set "UNPUSHED_COUNT=0"
if "!UNPUSHED_COUNT!"=="0" (
    git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
    if errorlevel 1 (
        for /f %%a in ('git rev-list --count origin/!CURRENT_BRANCH!..HEAD 2^>nul') do set "UNPUSHED_COUNT=%%a"
        if not defined UNPUSHED_COUNT set "UNPUSHED_COUNT=0"
    )
)

if "!HAS_CHANGES!"=="" if "!UNPUSHED_COUNT!"=="0" (
    echo No changes to backup.
    exit /b 0
)

if "!HAS_CHANGES!"=="" if not "!UNPUSHED_COUNT!"=="0" (
    echo Unpushed commits: !UNPUSHED_COUNT! on branch !CURRENT_BRANCH!
    echo Working tree is clean; only a push is needed.
    echo.
    set /p PUSH_ONLY="Push existing commit(s) to origin now? (y/n): "
    if /i not "!PUSH_ONLY!"=="y" (
        echo Backup cancelled.
        exit /b 0
    )
    echo.
    echo Pushing branch !CURRENT_BRANCH! to origin...
    git push -u origin !CURRENT_BRANCH!
    if errorlevel 1 (
        echo Branch push failed. Backup stopped.
        exit /b 1
    )
    echo.
    echo ================================================
    echo Push completed successfully!
    echo - Branch: !CURRENT_BRANCH!
    echo - Remote: !TARGET_REMOTE_URL!
    echo ================================================
    echo.
    pause
    exit /b 0
)

REM Ask if user wants to proceed with backup
set /p PROCEED="Do you want to backup these changes? (y/n): "
if /i not "!PROCEED!"=="y" (
    echo Backup cancelled.
    exit /b 0
)

REM Ask for version number with suggestion
set "SUGGESTED_VERSION=1.0.0"
if not "!CURRENT_VERSION!"=="No version tags yet" (
    for /f "tokens=1,2,3 delims=." %%a in ("!CURRENT_VERSION:v=!") do (
        set /a PATCH=%%c+1
        set "SUGGESTED_VERSION=%%a.%%b.!PATCH!"
    )
)
echo.
echo Suggested version: !SUGGESTED_VERSION!
set /p VERSION="Enter new version number [!SUGGESTED_VERSION!]: "
if "!VERSION!"=="" set "VERSION=!SUGGESTED_VERSION!"

REM Prevent duplicate tags
git rev-parse -q --verify "refs/tags/v!VERSION!" >nul 2>&1
if not errorlevel 1 (
    echo Error: Tag v!VERSION! already exists. Please choose a different version.
    exit /b 1
)

REM Ask for description
echo.
echo Enter a brief description of your changes
echo Example: "Improve overlay rescan reliability"
set /p DESC="Description: "
if "!DESC!"=="" (
    echo Error: Description is required
    exit /b 1
)

echo.
echo Summary of Backup:
echo -----------------
echo Version: v!VERSION!
echo Description: !DESC!
echo Branch: !CURRENT_BRANCH!
echo Remote: !TARGET_REMOTE_URL!
echo.
set /p CONFIRM="Proceed with backup? (y/n): "
if /i not "!CONFIRM!"=="y" (
    echo Backup cancelled.
    exit /b 0
)

echo.
echo Processing backup...
echo.

REM Add and commit changes
git add .
git commit -m "v!VERSION! - !DESC!"
if errorlevel 1 (
    echo Commit failed. Backup stopped.
    exit /b 1
)
git tag -a v!VERSION! -m "Version !VERSION! - !DESC!"
if errorlevel 1 (
    echo Tag creation failed. Backup stopped.
    exit /b 1
)

REM Push branch, then only this backup's tag (not all local tags — older tags may reference large build files)
echo.
echo Pushing branch !CURRENT_BRANCH! to origin...
git push -u origin !CURRENT_BRANCH!
if errorlevel 1 (
    echo Branch push failed. Backup stopped.
    exit /b 1
)
echo.
echo Pushing tag v!VERSION! only...
git push origin "v!VERSION!"
if errorlevel 1 (
    echo.
    echo WARNING: Tag push failed. Your commit is on GitHub; tag v!VERSION! was not uploaded.
    echo Local tags v1.1 / v1.1.2 reference old Electron builds over GitHub's size limit and must not be pushed with --tags.
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo Backup completed successfully!
echo - New version: v!VERSION!
echo - Description: !DESC!
echo - Branch: !CURRENT_BRANCH!
echo - Remote: !TARGET_REMOTE_URL!
echo - Tag: v!VERSION! pushed
echo ================================================
echo.
pause