# SERVER.md — Flow Remote: gabay sa Codespace server + Orion extension

> **Basahin muna ito bago ka magsimula.** Isang hakbang lang kada beses. Kapag may hindi gumana, huminto ka muna — huwag ulit-ulitin.

## Ano ito (sa 4 na linya lang)

1. May **extension sa iPhone mo** (Orion browser) — doon ka magta-type ng prompt at magpapadala ng job.
2. May **server sa GitHub Codespace** — siya ang tatakbo sa totoong Chrome at siya ang magki-click sa Flow para sa'yo.
3. Ikaw ang magta-type sa phone; ang server ang gagawa ng generation sa Codespace.
4. **Hindi pa ito nasubukan sa totoong Flow o totoong iPhone.** Lahat ng test na nagawa ay mock lang — ibig sabihin, pekeng Flow at pekeng iPhone ang ginamit sa test. Kaya ang unang test mo ay libreng image lang, hindi video.

---

## Tapos na / built na — hindi mo na kailangang gawin

- ✅ Ang server (Python, walang pip install na kailangan) — nasa `server/` folder.
- ✅ Ang extension na "Flow Remote" v1.1.1 — nasa `remote-extension/` folder, at may ZIP na rin (`flow-remote-v1.1.1-orion.zip`). **v1.1.1: in-page panel na ang UI, hindi popup** — sa Orion ayaw lumabas ng popup, kaya ang panel na nasa mismong flow.google.com page ang gagamitin mo (floating ⚡ button, i-tap mo lang). Ang popup ay pang-desktop na lang.
- ✅ Ang Codespace setup (`.devcontainer/`) — nag-i-install ng totoong Chrome + `gflow` + desktop, at naka-set na ang `DISPLAY=:1`.
- ✅ Mock tests: server 13 passed / 0 failed; extension panel chain 26 passed / 0 failed; extension popup 14 passed / 0 failed; end-to-end mock 18 passed / 0 failed. **Mock lang lahat — hindi pa ito nasubukan sa totoong Flow.**

## Ikaw ang gagawa nito — ang mga hakbang sa ibaba

---

## Ano ang kailangan mo bago magsimula

- [ ] GitHub account mo (yung may access sa repo na **jerome-erc**).
- [ ] **Orion browser** sa iPhone mo (doon lang mai-install ang extension).
- [ ] Ang extension ZIP — **`flow-remote-v1.1.1-orion.zip`** — naka-attach sa chat message kung saan mo ito natanggap.
- [ ] Dalawang Google account: ang **main account** mo at ang **test account** (`unknowjason20@gmail.com`). **Test account muna ang gagamitin mo** — huwag ang main sa unang test.
- [ ] Phone mo, handa para sa 2FA / verification kung hingin ng Google.

---

## Hakbang 1: Gumawa ng Codespace mula sa repo

1. Buksan ang repo na **jerome-erc** sa GitHub (sa browser ng phone mo, o sa GitHub app).
2. Pindutin ang **Code** → **Codespaces** → **Create codespace on main**.
3. Piliin ang **2-core** machine (mas tipid sa libreng allowance).
4. **Maghintay ng ilang minuto** habang nagbi-build. Automatic na mai-install ang Chrome, `gflow`, at Playwright. Huwag mo itong galawin habang nagbi-build.

> Kapag tapos na ang build, makikita mo ang VS Code sa browser. Doon ka magtatrabaho sa mga susunod na hakbang.

---

## Hakbang 2: Buksan ang desktop at patakbuhin ang server

### Nasa repo na ang files (na-sync noong 2026-11-07)

Ang `server/` folder ay nasa **repo root** (katabi ng `.devcontainer/` at `JEROME.md`).

1. Buksan ang **desktop**: sa VS Code, pumunta sa **Ports** view → hanapin ang port **6080** → i-click ang **globe icon**. Bubukas ang noVNC desktop sa bagong tab.
2. I-click ang **Connect**, password: `vscode`.
3. Buksan ang **terminal** sa VS Code (yung nasa ibaba).
4. Pumunta sa server folder at patakbuhin ang server:

```bash
cd server
./start.sh
```

(Kung ayaw tumakbo ng `./start.sh`, subukan mo ang `bash start.sh`.)

5. Kapag tumakbo na ang server, may lalabas sa terminal na **pairing token** — mahabang random na code. **Kopyahin mo ito.** Huwag mo itong ipaste kahit kanino, at huwag mo itong i-save sa kahit anong file — sa terminal lang siya lumalabas, at magbabago siya kada restart ng server.

> Kung may error na `'gflow' not found on PATH`: hindi pa tapos mag-build ang Codespace, o hindi pa na-install ang `gflow`. Hintayin mo munang matapos ang build, o patakbuhin mula sa repo root ang `pip install --user -e .` tapos ulitin ang `./start.sh`.
>
> Kung may warning na `DISPLAY is unset`: dapat naka-set na ito ng devcontainer (`DISPLAY=:1`). Kung nag-fail ang generation, subukan mo munang patakbuhin sa terminal ang `export DISPLAY=:1` bago mo ulitin.

**Huwag mong isara ang terminal na ito habang gumagana ang server.** Dito rin lalabas ang pairing token at ang mga log.

---

## Hakbang 3: I-forward ang port 8766

Kailangan makita ng iPhone mo ang server. Gawin ito sa **Ports** view ng VS Code:

1. Sa Ports tab, pindutin ang **Add port** (o "Forward a Port").
2. I-type ang **`8766`** at Enter.
3. Lalabas ang forwarded URL na ganito ang itsura: `https://<pangalan>-8766.app.github.dev`. **Kopyahin mo ang URL na ito** — ito ang ilalagay mo sa extension mamaya.

### Private o Public? Pumili ka ng isa

| Pagpipilian | Ano ang ibig sabihin | Kailan ito gamitin |
|---|---|---|
| **Private** | Kailangan naka-sign in sa GitHub sa Orion para makapasok. Mas sarado, pero kailangan mong mag-sign in sa GitHub sa loob ng Orion. | Kung ayaw mong makita ng kahit sino ang server URL mo. |
| **Public** | Kahit sino na may URL ay makakaabot sa server — **pero hindi sila makakagawa ng job kung wala ang pairing token**. Ang token pa rin ang lock. | **Ito ang inirerekomenda** — mas simple, walang GitHub sign-in sa Orion. |

**Rekomendasyon: Public + malakas na random token.**

- Ang token ay random na ginagawa kada start ng server, kaya malakas na siya by default.
- **Paalala:** kada restart ng server, **nag-ro-rotate ang token** — magbabago siya. Kaya pagkatapos mong mag-restart, kailangan mong kopyahin ulit ang bagong token at ilagay ulit sa extension. Kung ayaw mong magbago ang token, puwede mong i-set ang `FLOW_SERVER_TOKEN` bago mo patakbuhin ang server — pero huwag mo itong gawin kung hindi mo kailangan; mas ligtas ang rotate kada restart.

---

## Hakbang 4: Ilagay ang URL at token sa extension

1. Buksan ang **flow.google.com** sa Orion (pagkatapos mo itong ma-install sa Hakbang 6 — kung hindi pa naka-install, gawin mo muna ang Hakbang 6, tapos bumalik dito). May lilitaw na floating button na **⚡ Flow Remote** sa page — i-tap mo ito para buksan ang panel. (Hindi na popup ang UI sa Orion — ayaw lumabas ng popup doon.)
2. Pumunta sa **Settings**.
3. I-paste ang **Server URL** — yung forwarded URL mula sa Hakbang 3 (hal. `https://<pangalan>-8766.app.github.dev`, **walang trailing slash** sa dulo).
4. I-paste ang **Pairing token** — yung kinopya mo sa terminal sa Hakbang 2.
5. Pindutin ang **Save**, tapos **Test connection**.
6. Kapag nagsabi ng OK ang test, ayos na — konektado na ang extension sa server mo. Kapag hindi, tingnan mo ang error table sa Hakbang 7.

---

## Hakbang 5: Mag-login ng bawat account (sa Codespace terminal)

**Ang server ay HINDI makakapag-login para sa'yo.** Ikaw mismo ang magla-login, isang beses kada account, sa terminal ng Codespace. Magbubukas ang totoong Chrome sa desktop (yung sa Hakbang 2) — doon ka magsa-sign in.

### Test account muna

```bash
gflow auth login --profile test --browser chrome
```

Mag-sign in ka gamit ang **test account** (`unknowjason20@gmail.com`). Kung humingi ng verification ("suspicious sign-in" mula sa bagong lugar), sundin mo lang — handa ang phone mo para sa 2FA.

### Tapos, ang main account

```bash
gflow auth login --profile main --browser chrome
```

Mag-sign in ka gamit ang **main account** mo.

> **Paalala:** ang pangalan ng profile (`test`, `main`) ay halimbawa lang — puwede kang gumamit ng ibang pangalan, basta pareho ang gagamitin mo sa extension pag pumili ka ng account. Ang mahalaga: **isang profile kada Google account**, at ang **test account ang una**.

Para i-check kung naka-login na:

```bash
gflow auth status
```

---

## Hakbang 6: I-install ang extension ZIP sa Orion

1. Kunin ang ZIP na **`flow-remote-v1.1.1-orion.zip`** at i-save ito sa **On My iPhone** (local storage — **hindi** iCloud Drive).
2. Buksan ang **Orion** sa iPhone mo.
3. Pumunta sa **`⋯` → Extensions → `+` → Install from File**, at piliin ang ZIP.
4. Kapag na-install na, buksan ang **flow.google.com** sa Orion — may lilitaw na floating button na **⚡ Flow Remote**. I-tap mo ito para buksan ang panel.

**Kung ayaw gumana ng Install from File:**

1. I-unzip ang ZIP (lalabas ang folder na may `manifest.json` sa loob).
2. Ilipat ang buong folder sa **On My iPhone → Orion → Extensions**.
3. Sa Orion, pumunta sa **`⋯` → Extensions → `+`**, at piliin ang folder na iyon.

> Siguraduhin mong ang `manifest.json` ay nasa **root** ng ZIP / folder — hindi nakabaon sa loob ng isa pang folder. Kapag mali ang pagkaka-zip, hindi ito mai-install.

Kapag naka-install na, bumalik ka sa **Hakbang 4** para ilagay ang URL at token.

---

## Hakbang 7: Unang test — libreng image, test account

**Huwag video ang unang test. Image lang — libre ito.**

1. Sa panel, piliin ang **test account** sa account picker. Kung may nakasulat na "session missing", bumalik ka sa Hakbang 5 at mag-login ka muna.
2. I-type ang prompt mo (hal. `a lighthouse at dusk`).
3. Siguraduhin ang settings:
   - **Kind:** image
   - **Model:** `nano2` (ito ang pinakamura / libre)
   - **Aspect:** `9:16`
   - **Count:** `1`
4. Pindutin ang **Send job**.

### Paano malalaman kung gumana

- Sa **Jobs** list ng panel, makikita mo ang job mo. Magre-refresh ito kada 5 segundo habang bukas ang panel.
- Kapag naging **`done`** ang status at may **media link** (o **Open / Copy URL**) na lumabas, **gumana ito**. I-tap ang link para makita ang image.
- Habang `queued` o `running` pa, maghintay ka lang — umaabot ito ng ilang minuto.

### Kung may problema — error table

| Nakita mo | Ibig sabihin | Gagawin mo |
|---|---|---|
| **401 — Wrong or expired pairing token** | Mali o luma na ang token sa extension. | Kopyahin ulit ang token mula sa terminal ng server at i-paste ulit sa Settings. (Nag-rotate ba ang token dahil nag-restart ka ng server? Kopyahin mo ang bago.) |
| **503 — Server stopped / unusual-activity stop** | Itinigil ng server ang sarili niya. | **Huminto ka. Huwag ka nang mag-send ng job.** I-restart ang server sa Codespace terminal (Hakbang 2), kopyahin ang bagong token, at ilagay ulit sa extension. |
| **Job status: `blocked`** | Tinanggihan ng Flow ang job — "unusual activity". | **Huwag mo itong i-resend.** Huminto ka, i-restart ang server, at mag-cooldown muna. Kapag inulit-ulit mo, mas lalong ma-flag ang account. |
| **Job status: `failed` + `auth_expired`** | Expired na ang login ng account na iyon. | Mag-login ulit sa Codespace terminal: `gflow auth login --profile <pangalan> --browser chrome`. |
| **Job status: `failed` + `profile_busy`** | May tumatakbo pang job sa profile na iyon. | Maghintay ka munang matapos ang unang job. Isang job lang kada profile. |
| **Cannot reach the server** | Hindi makita ng extension ang server. | Tingnan mo kung buhay pa ang Codespace (baka natulog na — tingnan ang "Mga paalala" sa ibaba), at kung tama ang Server URL sa Settings. |
| **Session missing** | Hindi pa naka-login ang account na pinili mo. | Bumalik sa Hakbang 5 at mag-`gflow auth login` para sa account na iyon. |
| **Job status: `failed` + `timeout`** | Masyadong matagal ang generation (image: 10 min, video: 30 min). | Subukan ulit ng isang beses. Kapag inulit pa rin, baka may problema sa Flow mismo — huminto ka muna. |

### Kapag gumana ang unang image

Saka ka lang mag-test ng video — at **isang video lang muna**, 8 segundo, `veo-lite`, 9:16, test account pa rin. Tandaan: ang video ay **may bayad sa credits**, hindi libre tulad ng image.

---

## Mga paalala / risks — basahin ito, maikli lang

- **May unusual-activity risk pa rin.** Ang Chrome ng Codespace ay nasa GitHub datacenter — ibang IP, bagong profile. Kahit totoong Chrome at totoong click pa yan, puwedeng tanggihan ng Flow. Kapag nangyari, huminto ka lang — hindi ito kasalanan mo, at hindi ito maaayos sa pamamagitan ng pag-ulit.
- **Natutulog ang Codespace pag idle.** Ang default idle timeout ay 30 minuto — kapag walang galaw, papatayin ito. Hindi mawawala ang files at session mo, pero kailangan mong buksan ulit ang Codespace at i-restart ang server (at kopyahin ulit ang bagong token). Puwede mong itaas ang timeout sa Codespace settings (hanggang 240 min).
- **~120 core-hours/month lang ang libre.** Sa 2-core machine, mga 60 oras lang yun kada buwan. Hindi ito 24/7 server — buksan mo lang kapag gagamitin mo, at i-stop mo kapag tapos ka na.
- **Hindi pa live-tested ang extension sa totoong iPhone.** Gumagana siya sa mock test, pero hindi pa siya nasubukan sa totoong Orion sa totoong iPhone. Kapag may kakaiba kang nakita, i-report mo — yun ang susunod na hakbang.
- **Humihinto mag-isa ang server pag na-block.** Kapag may job na `blocked`, titigil ang server sa pagtanggap ng bagong jobs (lahat ng bagong job ay 503). Kailangan mong i-restart ito sa terminal. Hindi ito bug — sadya ito para hindi ka ma-flag nang paulit-ulit.
- **Isang job lang kada beses.** FIFO ang pila — isa-isang pinoproseso ang mga job. Huwag kang magpadala ng sunod-sunod na jobs agad; isa muna, tingnan kung gumana, saka ang susunod.
- **50 free credits kada araw** ang image — kaya libre ang unang test. Ang video ay kumakain ng credits, kaya dahan-dahan lang.
- **Huwag mong ipaste ang Google password mo sa extension.** Hindi ito hihingin ng extension kailanman. Ang login ay sa Codespace Chrome lang ginagawa (Hakbang 5).
- **Pag dinelete mo ang Codespace, mawawala ang login session** — kailangan mong mag-`auth login` ulit sa bagong Codespace.

---

## Checklist — lahat ng hakbang

- [ ] Nakuha ko ang extension ZIP (`flow-remote-v1.1.1-orion.zip`) mula sa chat (naka-attach).
- [ ] Gumawa ako ng Codespace mula sa repo na **jerome-erc** (Code → Codespaces → Create codespace on main, 2-core).
- [ ] Hinintay kong matapos mag-build ang Codespace.
- [ ] Na-sync na sa repo ang `server/` at `remote-extension/` files.
- [ ] Binuksan ko ang desktop (Ports → 6080 → globe icon, password `vscode`).
- [ ] Pinatakbo ko ang server (`cd server` → `./start.sh`) at kinopya ko ang pairing token.
- [ ] Ni-forward ko ang port **8766** at kinopya ko ang forwarded URL.
- [ ] Pinili ko ang visibility: Public (inirerekomenda) o Private.
- [ ] Nag-login ako ng **test account** (`gflow auth login --profile test --browser chrome`).
- [ ] Nag-login ako ng **main account** (`gflow auth login --profile main --browser chrome`).
- [ ] Na-install ko ang extension ZIP sa Orion (⋯ → Extensions → + → Install from File).
- [ ] Nilagay ko ang Server URL at pairing token sa extension Settings at nag-**Test connection** ako.
- [ ] Nag-send ako ng unang test: **libreng image** (nano2, 9:16, 1 pc, test account).
- [ ] Nakita ko ang job status na **`done`** at ang media link sa panel.

---

*Huling paalala, erp: mock-tested lang lahat ng ito. Ang unang totoong test mo — yung libreng image — ang magsasabi kung gumagana ba talaga ito sa totoong Flow. Kapag hindi gumana, hindi ikaw ang may kasalanan. Huminto ka lang, at i-report mo kung ano ang nangyari.*
