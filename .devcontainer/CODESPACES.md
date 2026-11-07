# gflow-cli sa GitHub Codespaces (mula sa phone)

Hindi mo kailangan ng PC para subukan ito — ang Codespace mismo ang magiging "computer" mo: may totoong Chrome, may desktop na mabubuksan sa browser, at doon tatakbo ang gflow-cli.

## Ang totoo muna

Ang Codespace ay nasa Azure datacenter — ibang IP at bagong profile. Kahit trusted clicks pa yan, may tsansang tanggihan ng Flow ng "unusual activity". Kaya **image muna ang i-test (LIBRE yun)**. Kapag tinanggihan, hinto lang — walang credits na nasayang, at nalaman natin na blocked ang datacenter path. Ang PC mo pa rin ang pinaka-maaasahan.

## Mga kailangan

- GitHub account (libre)
- Codespaces free allowance: 120 core-hours/buwan — sa 2-core machine, mga 60 oras yun
- Yung Google account mo na may Flow access, at yung phone mo para sa 2FA kung hingin

## Steps (mula sa phone)

### 1. Fork

Sa GitHub app o sa github.com: buksan ang `ffroliva/gflow-cli` → **Fork** → piliin ang account mo.

### 2. Ilagay ang `.devcontainer` files sa fork mo

Sa fork mo sa github.com, i-upload ang dalawang file na ito sa loob ng folder na `.devcontainer/`:

- `devcontainer.json`
- `setup.sh`

(Ang file na ito, `CODESPACES.md`, ay gabay lang — hindi kailangang i-upload sa fork. Dalawang file lang ang kailangan para gumana ang Codespace.)

(Upload: **Add file → Upload files**. Kailangan munang gawin ang folder — puwedeng "Create new file" na ang pangalan ay `.devcontainer/devcontainer.json` at i-paste ang laman, tapos ganun din sa `setup.sh`.)

### 3. Gumawa ng Codespace

Sa fork mo: **Code → Codespaces → Create codespace on main**. Piliin ang **2-core** machine para tipid sa free allowance. Maghintay ng ilang minuto habang nagbi-build — automatic na mai-install ang Chrome, gflow-cli, at Playwright.

### 4. Buksan ang desktop

Sa VS Code (sa browser):

1. Buksan ang **Ports** view (o `Ctrl/Cmd + Shift + P` → "Ports: Focus on Ports View").
2. Hanapin ang port **6080**, i-click ang **globe icon** — bubukas ang noVNC desktop sa bagong tab.
3. I-click ang **Connect**, password: `vscode`.

### 5. Login sa Google (isang beses lang)

Sa VS Code terminal (yung nasa ibaba ng Codespace):

```
gflow auth login --browser chrome
```

Magbubukas ng totoong Chrome window sa desktop mo. Mag-sign in sa Google account mo. Kung humingi ng verification ("suspicious sign-in" mula sa bagong lugar), sundin lang — handa ang phone mo para sa 2FA.

> **Kung ayaw bumukas ng Chrome** ("Missing X server" o walang lumalabas na window): naka-set na dapat ang display sa `devcontainer.json` (`DISPLAY=:1`), pero kung sakaling wala, patakbuhin muna ito sa terminal bago ulitin ang login:
> ```
> export DISPLAY=:1
> gflow auth login --browser chrome
> ```
> O kaya, buksan ang terminal mula sa loob mismo ng noVNC desktop (right-click sa desktop → Terminal) at doon patakbuhin ang login.

Check:

```
gflow auth status
```

### 6. Unang test — image, LIBRE

```
gflow image t2i "a hot air balloon over Tokyo at sunrise"
```

Kapag gumana, saka mag-video:

```
gflow video t2v "Slow cinematic push-in on a sunlit forest clearing" --aspect 16:9
```

## Kung ayaw tanggapin ("unusual activity")

Hinto muna, wag ulit-ulitin. Fallback na subukan:

```
pip install --user "gflow-cli[patchright]"
GFLOW_CLI_BROWSER_ENGINE=patchright gflow image t2i "test prompt"
```

Kung ayaw pa rin, datacenter IP na ang problema — PC na lang talaga ang pag-asa.

## Mga tandaan

- **Idle timeout:** 30 minuto ang default — kapag walang galaw, papatayin ang Codespace. Itaas ito sa Codespace settings (hanggang 240 min) o galaw-galawin paminsan-minsan. Hindi mawawala ang files at session kapag nag-stop — babalik siya pag binuksan mo ulit.
- **Pag dinelete mo ang Codespace, mawawala ang login session** — kailangan ulit mag-`auth login` sa bagong Codespace.
- **Wag mag-batch ng marami agad.** Isang image muna, tingnan kung tinatanggap, saka dahan-dahan.
- Basahin ang `docs/ACCOUNT_SAFETY.md` sa repo bago mag-batch.
