# Flow Local (v1.0.0)

Fill-only helper para sa Google Flow sa Orion iOS. Walang server, walang token, walang terminal — lahat dito lang sa page nangyayari.

## Ano ito

- Isang lumulutang na button na **⚡ Flow Local** sa flow.google.com. I-tap mo, bubukas ang panel.
- Sa panel: magsulat ka ng prompt, pumili ng model / aspect / count / duration, tapos pindutin ang **Fill sa Flow**.
- Ilalagay ng extension ang prompt at settings mo sa mismong composer ng Flow. Pagkatapos, **ikaw mismo ang pipindot ng Send** sa Flow.

## Ano ito HINDI

- **Hindi ito pipindot ng Send.** Hindi kaya ng kahit anong script o extension sa iPhone ang totoong pindot sa Flow (trusted-gesture / reCAPTCHA gate). Ikaw ang pipindot — iyan ang buong punto ng fill-only.
- **Walang photo attach sa v1.0.0.** I-attach mo muna ang photo sa picker mismo ng Flow, tapos Fill. Ang DataTransfer attach ay hindi pa napatunayan sa totoong Flow, kaya hindi ito isinama.
- **Walang server, walang token, walang kinokontak.** Hindi ito tumatawag kahit saan. Ang natatandaan lang nito (sa browser mo) ay ang huli mong prompt at settings, para hindi mo na ulit-ulitin.

## Install (Orion sa iOS)

1. I-save ang ZIP (`flow-local-v1.0.0-orion.zip`) sa **On My iPhone** (local storage, hindi iCloud Drive).
2. Sa Orion: `⋯ → Extensions → + → Install from File`, piliin ang ZIP.
3. Kung may lumang Flow Remote na naka-install, puwede mo itong iwan — magkaiba sila ng pangalan. Pero huwag silang sabay na bukas sa iisang page kung nalilito ka kung alin ang alin.

## Gamitin

1. Buksan ang isang **project** sa flow.google.com (kailangan ng project page — walang composer sa home page).
2. I-tap ang lumulutang na **⚡ Flow Local** button (puwede mo itong i-drag kung nakaharang).
3. Piliin ang **Image** o **Video**, magsulat ng prompt, pumili ng model / aspect / count / duration.
4. Pindutin ang **Fill sa Flow**. Babasahin ng panel kung ano ang nangyari sa bawat step (prompt, model, aspect, count, duration) at kung ano ang setting ng Flow ngayon.
5. Tingnan ang composer: dapat nandoon ang prompt mo at tama ang settings. **Ikaw na ang pipindot ng Send (arrow) sa Flow.**

## Mga model at setting

- Image: Nano Banana 2.1, Nano Banana 2 Lite, Nano Banana Pro, Imagen 4. Aspect 9:16 / 16:9 / 1:1 / 4:3 / 3:4. Count x1–x4.
- Video: Veo 3.1 - Lite, Veo 3.1 - Fast, Omni 1.2 Flash. Aspect 9:16 / 16:9. Duration 8s; 10s ay Omni Flash lang.
- Kung may setting na hindi mahanap ng extension sa page (hal. nagbago ang Flow), iiwan niya ito kung ano ang dati at sasabihin niya sa iyo — hindi siya titigil nang tahimik.

## Kung may problema

- **Walang lumalabas na button:** i-reload ang flow.google.com. Siguraduhing naka-ON ang Flow Local sa Extensions list.
- **"Walang composer sa page na ito":** nasa home page ka pa — buksan mo muna ang isang project.
- **Prompt pumasok pero Send naka-disable pa rin:** normal na minsan — tingnan mo ang box; kung may text na, i-tap mo ang Send mismo. Kung wala pa ring text, subukan mo ulit ang Fill.
- **Hindi nagbago ang model/aspect:** basahin ang mensahe sa panel — sasabihin niya kung alin ang hindi niya nahanap. Maaaring nagbago ang Flow UI; i-report mo ang mensahe.

## Estado ng test

Mock-tested lang ito (node, 26+ na check) — hindi pa ito nasusubukan sa totoong Orion at totoong Flow. Ikaw ang unang live test. I-report mo kung ano ang nakita mo: lumabas ba ang button, pumasok ba ang prompt, nagbago ba ang settings.
