#!/usr/bin/env bash
# gflow-cli Codespace setup: real Google Chrome + gflow-cli + Playwright.
# Tumakbo ito nang automatic pagka-create ng Codespace (postCreateCommand).
set -e

echo "== Installing Google Chrome (system Chrome, kailangan ng gflow-cli) =="
sudo apt-get update -qq
sudo apt-get install -y -qq wget >/dev/null
cd /tmp
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
google-chrome --version

echo "== Installing gflow-cli (itong repo) =="
pip install --user -e .
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"

echo "== Installing Playwright browsers =="
python -m playwright install chromium
sudo python -m playwright install-deps chromium || echo "(playwright deps: tuloy pa rin — nadala na ng Chrome yung shared libs)"

echo "== Tapos na. Susunod (tingnan din .devcontainer/CODESPACES.md) =="
gflow --version
echo "1) Buksan ang desktop: Ports view -> 6080 -> globe icon (password: vscode)"
echo "2) Sa VS Code terminal: gflow auth login --browser chrome"
echo "3) gflow auth status"
echo "4) gflow image t2i \"test prompt\"   (LIBRE ang image — ito muna ang i-test)"
