# Overhead flight display

An always-on screen that shows the aircraft flying over the house: airline, flight, route,
aircraft type, altitude, speed and distance. It runs as two Docker containers on the ZimaOS box:

| Container | What it does |
| --- | --- |
| `freeflight` | [FreeFlight](https://github.com/Ethos6/free-flight-api): merges adsb.lol, airplanes.live and adsb.fi and caches their responses. Not published on any port. |
| `nginx` | Serves the display page on the LAN (port 8090) and proxies FreeFlight and the [adsbdb](https://www.adsbdb.com/) route lookup, so the browser only talks to one origin. |

The screen is a web browser on any computer on the LAN, open full screen at `http://<box>:8090`.
A dedicated screen (old tablet, Raspberry Pi) can come later.

**You run every SSH command.** Nothing in this repo connects to the box by itself. Each step
below lists the commands to run from your own machine; `deploy.sh` is a convenience that runs
the copy and `docker compose up` for you, also over your SSH login.

## Repo layout

```
docker-compose.yml        freeflight + nginx, pinned versions, restart: unless-stopped
docker-compose.debug.yml  testing only: FreeFlight on the box's 127.0.0.1:8000
nginx.conf                static page + /api/aircraft/ and /api/route/ proxies
web/                      the display: index.html, style.css, app.js, adapter.js
config.example.json       copy to config.json (gitignored: holds your home location)
.env.example              copy to .env (gitignored): display port + FreeFlight settings
deploy.sh                 copy files to the box and (re)start the containers
dev/server.mjs            local preview with fake aircraft
test/                     adapter unit tests
```

## Try it locally first

Needs Node 18 or newer. No Docker, no network, no box.

```sh
npm test          # adapter unit tests
npm run dev       # http://localhost:8090 with fake aircraft
curl localhost:8090/__dev/down    # toggle a simulated outage: the page shows "Stale"
curl localhost:8090/__dev/empty   # toggle an empty sky: "Clear skies overhead"
```

## First-time setup (local)

```sh
cp config.example.json config.json   # set home.lat / home.lon (4 decimals is plenty)
cp .env.example .env                 # change DISPLAY_PORT if 8090 is taken
```

Never commit `config.json` or `.env`; both are gitignored.

## Phase 0: connect and inspect the box

Goal: passwordless SSH as `ssh zima`, and you know what is already running.

1. Enable SSH in the ZimaOS web UI if it is off.
2. Create a key if you have none, and copy it to the box:

   ```sh
   ssh-keygen -t ed25519
   ssh-copy-id <user>@<box-ip-or-hostname>
   ```

3. Add an alias to `~/.ssh/config`:

   ```
   Host zima
       HostName <box-ip-or-hostname>
       User <user>
   ```

   Test it: `ssh zima 'echo ok'`
4. Inspect the box (read-only):

   ```sh
   ssh zima 'uname -a; cat /etc/os-release'
   ssh zima 'docker version; docker compose version'
   ssh zima 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"'
   ssh zima 'df -h /DATA; ls /DATA/AppData'
   ssh zima 'ss -ltn'
   ```

   Look for: `docker compose` (v2) works, there is free disk space, and nothing is listening on
   `:8090`. If 8090 is taken, set another `DISPLAY_PORT` in `.env`.

**Check:** `ssh zima 'docker ps'` runs without a password prompt.

## Phase 1: deploy FreeFlight

Goal: FreeFlight runs on the box and returns aircraft for your location.

```sh
DEBUG=1 ./deploy.sh
```

`DEBUG=1` adds `docker-compose.debug.yml`, which publishes FreeFlight on the box's loopback
(`127.0.0.1:8000`) so the checks below work. It is never reachable from the LAN. This also starts
nginx; that's fine, Phase 2 checks it.

<details>
<summary>Same thing without deploy.sh</summary>

```sh
ssh zima 'mkdir -p /DATA/AppData/overhead'
scp -r docker-compose.yml docker-compose.debug.yml .env nginx.conf config.json web zima:/DATA/AppData/overhead/
ssh zima 'cd /DATA/AppData/overhead && docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d freeflight'
```

</details>

**Checks** (replace `<lat>`/`<lon>` with your home location):

```sh
ssh zima 'curl -s localhost:8000/v1/providers'                 # adsb.lol, airplanes.live, adsb.fi healthy
ssh zima 'docker exec overhead-freeflight-1 freeflight check'  # skip if the CLI is not in the image
ssh zima 'curl -s "localhost:8000/v2/point/<lat>/<lon>/10"'    # an "ac" array with aircraft in it
ssh zima 'curl -s localhost:8000/v1/route/<a callsign from the previous result>'   # origin + destination
```

## Phase 2: the display

Goal: one page that answers "what is flying over the house right now?" from across the room.

The containers from Phase 1 already serve it. Open `http://<box>:8090` on a laptop on the same
network.

**Checks**

1. The page shows live aircraft, or "Clear skies overhead" with a count when nothing is within
   the radius.
2. Outage handling: the page keeps the last data and turns the status line red ("Stale · last
   update …"), then recovers on its own:

   ```sh
   ssh zima 'docker stop overhead-freeflight-1'    # wait ~10 s, look at the screen
   ssh zima 'docker start overhead-freeflight-1'
   ```

3. A flight with no known route still shows cleanly ("Route unknown").
4. Remove the debug port by redeploying without `DEBUG=1`:

   ```sh
   ./deploy.sh
   ssh zima 'ss -ltn | grep 8000'    # should print nothing
   ```

## Phase 3: always on

Goal: one command redeploys everything, and the screen comes back by itself after a power cut.

1. `./deploy.sh` is safe to re-run. Use it for every change, including `config.json` edits. The
   page checks for changes every minute and reloads itself, so you don't need to touch the screen.
2. Both containers use `restart: unless-stopped`. Confirm, then reboot the box once when it suits you:

   ```sh
   ssh zima 'docker inspect -f "{{.Name}} {{.HostConfig.RestartPolicy.Name}}" overhead-freeflight-1 overhead-nginx-1'
   ssh zima 'sudo reboot'
   ```

3. Open the display in a web browser on any computer on the LAN:
   - Go to `http://<box>:8090` and bookmark it.
   - **Full screen:** double-click the page or press `F` (`Esc` exits). The mouse pointer hides
     after 3 seconds without movement.
   - **Keep it awake:** browsers only allow the page to keep the screen on over HTTPS, so set the
     computer's own display sleep to "never" while it's showing the page.
   - **Open straight into full screen** (optional), as an app window with no browser bars:

     ```sh
     # Chrome or Edge; on macOS use "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
     google-chrome --kiosk http://<box>:8090      # Alt+F4 (Cmd+Q on macOS) closes it
     ```

   Later, a dedicated screen works the same way: an old tablet with a kiosk browser app set to
   start on boot, or a Raspberry Pi with Chromium in `--kiosk` mode and screen blanking off.
4. Give the box a DHCP reservation on your router, or use its `.local` name, so the URL never
   changes.

**Check:** after a reboot of the box, the open browser tab shows live aircraft again within
2 minutes with no one touching it. While the box is down the page shows "Stale"; it never needs
a manual refresh.

## Phase 4 (optional): your own receiver

Goal: read aircraft from an antenna at the house, with FreeFlight as the fallback. Do this only
after Phases 1 to 3 have run well for a while.

Hardware: an RTL-SDR USB dongle for 1090 MHz ADS-B, plus a 1090 MHz antenna placed as high as
possible.

1. Plug the dongle into the box and check it is seen: `ssh zima 'lsusb'`.
2. The Linux TV-tuner driver (`dvb_usb_rtl28xxu`) usually grabs the dongle and has to be
   blacklisted. ZimaOS may not allow changes in `/etc/modprobe.d`, or may undo them on update. Find
   out what ZimaOS supports before changing anything. If it can't be done cleanly, run the receiver
   on a Raspberry Pi instead.
3. Add [`sdr-enthusiasts/docker-adsb-ultrafeeder`](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder)
   (pinned version) to `docker-compose.yml` as a service named `ultrafeeder`. Pass the USB device
   through, set your location and altitude, and follow its README for the rest.
4. Optionally feed adsb.lol, adsb.fi or airplanes.live from ultrafeeder.
5. Uncomment the `/api/receiver/aircraft.json` location in `nginx.conf`, and make the receiver the
   first source in `config.json`:

   ```json
   "sources": ["/api/receiver/aircraft.json", "/api/aircraft/{lat}/{lon}/{radius}"]
   ```

   The display tries the sources in order. The adapter already reads readsb's `aircraft.json`.
6. `./deploy.sh`

**Check:** the display keeps working with FreeFlight stopped, and with the dongle unplugged.

## Configuration (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `home.lat`, `home.lon` | required | Your location in decimal degrees |
| `radiusNm` | `3` | "Overhead" radius. The closest aircraft inside it gets the big card. 2 to 5 nm works well. |
| `fetchRadiusMultiplier` | `2` | Aircraft are fetched and listed out to `radiusNm` × this, so you see them coming |
| `altitudeFt.min`, `.max` | `0`, `45000` | Altitude band. Raise `min` to hide approach traffic near an airport. |
| `units.altitude` | `ft` | `ft` or `m` |
| `units.speed` | `kt` | `kt`, `mph` or `kmh` |
| `units.distance` | `nm` | `nm`, `mi` or `km` |
| `refreshSeconds` | `5` | How often to fetch aircraft |
| `listCount` | `5` | Most rows under the main card (fewer if the screen is short) |
| `sources` | FreeFlight | Data URLs tried in order. `{lat}`, `{lon}` and `{radius}` are filled in. |
| `routeUrl` | adsbdb via nginx | Route lookup URL. `{callsign}` is filled in. |
| `clock24h` | `true` | 24-hour clock |
| `night.enabled`, `.start`, `.end`, `.brightness` | off, `23:00`, `06:30`, `0.25` | Dim the screen overnight |

To change the location or radius: edit `config.json`, run `./deploy.sh`, and the screen reloads
within a minute.

## How it works

- `web/adapter.js` turns ADSBExchange-v2-style records (FreeFlight's `/v2/point`, adsb.lol,
  airplanes.live, or a readsb `aircraft.json`) into one shape, and works out distance and bearing
  from home itself. Swapping the data source is a config change.
- Routes come from adsbdb, looked up once per callsign and cached by nginx for 24 hours, including
  "unknown" answers. A flight with no route still shows; the display never guesses one.
- If a fetch fails, the page keeps the last data and marks it stale. It never goes blank.

## Upkeep

- Every few months, check for new [FreeFlight](https://github.com/Ethos6/free-flight-api/releases)
  and [nginx](https://hub.docker.com/_/nginx) releases (and ultrafeeder if used), bump the pinned
  tags in `docker-compose.yml`, and run `./deploy.sh`.
- Don't add auto-updaters such as Watchtower; an untested update could quietly break the screen.
- Logs: `ssh zima 'cd /DATA/AppData/overhead && docker compose logs --tail 50'`

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| "Waiting for data" or a stale marker that stays | `ssh zima 'docker logs --tail 50 overhead-freeflight-1'`, then the Phase 1 checks with `DEBUG=1 ./deploy.sh` |
| Every flight says "Route unknown" | `ssh zima 'docker exec overhead-nginx-1 wget -qO- http://127.0.0.1/api/route/BAW1'`. If it fails, the box can't reach api.adsbdb.com. |
| "Config error" on screen | `config.json` is missing or invalid; `deploy.sh` checks it before copying |
| Page doesn't load | `ssh zima 'docker ps'` and `ss -ltn` for the display port |
