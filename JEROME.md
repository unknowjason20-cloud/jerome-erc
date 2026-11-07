# jerome-erc

Workspace ni jerome para sa Google Flow capture at automation.

## Ano ang laman nito
- Buong `gflow-cli` (ffroliva/gflow-cli) — ang tool na nagda-drive ng Flow gamit ang totoong Chrome.
- `.devcontainer/` — Codespace setup: real Google Chrome + gflow-cli + Playwright + desktop (noVNC, port 6080, password `vscode`). May `DISPLAY=:1` fix na.
- `.devcontainer/CODESPACES.md` — Tagalog guide, step by step.

## Para saan
1. Gumawa ng Codespace mula sa repo na ito.
2. Buksan ang desktop (Ports -> 6080 -> globe icon, password `vscode`).
3. Mag-login sa Flow gamit ang test account: `gflow auth login --browser chrome`.
4. I-test muna ang FREE image (`gflow image t2i "..."`), hindi video.
5. Para sa capture: buksan ang DevTools (F12) sa Chrome ng Codespace, Network tab, i-type `test123`, i-click ang Generate, hanapin ang POST request (batchexecute).

## Mga paalala
- Ang capture ay ebidensya lang — hindi pwedeng i-replay ang request (gesture-bound token, `extension_hijack_detected`).
- Ang raw HAR ay may auth tokens — itago lang sa local, huwag ipaste kahit kanino.
- Kapag tumanggi ang Flow ("unusual activity"): huminto, mag-cooldown, huwag ulitin nang paulit-ulit.
