@echo off
REM One-click Croatian-sellers scrape (run this on your own PC, not a server).
REM First run also installs Playwright + Chromium.
cd /d "%~dp0"
where python >nul 2>nul || (echo Python not found - install it from python.org & pause & exit /b 1)
python -m pip show playwright >nul 2>nul || python -m pip install playwright
python -m playwright install chromium
python scrape_cardmarket.py --croatia-only --min-eur 1 --headed %*
echo.
echo To publish the results to the live site run:
echo   git add data/listings.json ^&^& git commit -m "Update listings" ^&^& git push
pause
