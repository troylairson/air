# Overhead flight display

An always-on screen that shows the aircraft flying over the house: airline, flight, route,
aircraft type, altitude, speed and distance. It runs as two Docker containers on the ZimaOS box:

| Container | What it does |
| --- | --- |
| `freeflight` | [FreeFlight](https://github.com/Ethos6/free-flight-api): merges adsb.lol, airplanes.live and adsb.fi and caches their responses. Not published on any port. |
| `nginx` | Serves the display page on the LAN (port 8090) and proxies FreeFlight and the [adsbdb](https://www.adsbdb.com/) route lookup, so the browser only talks to one origin. |

The page is a live map of the aircraft around the house, each with a trail of where it has been,
plus the planned route of the closest one, with its details in a card on top. The screen is a web
browser on any computer on the LAN, open full screen at `http://<box-ip>:8090`.
A dedicated screen (old tablet, Raspberry Pi) can come later.

**Everything runs on the box.** Log in with `ssh <user>@<box-ip>` and your ZimaOS password, and
run the commands below in that session. The project lives in `/DATA/AppData/overhead` as a git
clone of this repo, and `./start.sh` starts it.

## Repo layout

```
start.sh                  start or restart the display (run on the box)
docker-compose.yml        freeflight + nginx, pinned versions, restart: unless-stopped
docker-compose.debug.yml  testing only: FreeFlight on the box's 127.0.0.1:18000
nginx.conf                static page + /api/aircraft/ and /api/route/ proxies
web/                      the display: index.html, style.css, app.js, adapter.js, map.js
web/vendor/leaflet/       Leaflet 1.9.4 map library (BSD-2-Clause), kept here so there's no build step
config.example.json       copy to config.json (gitignored: holds your home location)
.env.example              copy to .env (gitignored): display port + FreeFlight settings
dev/server.mjs            local preview with fake aircraft (on a laptop, optional)
test/                     adapter unit tests
```

## Phase 0: log in and look around

Goal: you're logged in to the box and know it has what the display needs.

1. If SSH is off, turn it on in the ZimaOS web UI settings.
2. From any computer on your network, log in:

   ```sh
   ssh <user>@<box-ip>
   ```

   The box IP is the address you use for the ZimaOS web page, e.g. `192.168.1.50`. The first time,
   answer `yes` to "Are you sure you want to continue connecting?", then enter your ZimaOS
   password. Type `exit` when you're done.
3. Look around. These only read information:

   ```sh
   cat /etc/os-release | head -3
   docker ps
   docker compose version
   which git
   df -h /DATA
   ss -ltn | grep 8090
   ```

   What you want to see:
   - `docker ps` lists containers (or an empty table). If it says "permission denied", put
     `sudo` before every `docker` command in this README. `./start.sh` handles this by itself.
   - `docker compose version` prints v2.something.
   - `which git` prints a path. If it prints nothing, see "No git on the box" below.
   - `df` shows at least 1 GB free.
   - The last command prints nothing, meaning port 8090 is free. If it prints a line, pick another
     port for `DISPLAY_PORT` in `.env` later.

## First-time setup (on the box)

```sh
sudo mkdir -p /DATA/AppData/overhead
sudo chown $USER /DATA/AppData/overhead
git clone https://github.com/troylairson/air.git /DATA/AppData/overhead
cd /DATA/AppData/overhead
cp config.example.json config.json
cp .env.example .env
nano config.json        # set home.lat / home.lon (below); Ctrl+O, Enter, Ctrl+X saves and exits
```

If the repo is private, `git clone` asks for a login: your GitHub username, and a
[personal access token](https://github.com/settings/tokens) as the password.

Never commit `config.json` or `.env`; both are gitignored. `./start.sh` warns if `config.json`
still has the example location.

**No git on the box?** Copy the files from a computer that has the repo instead. Run this there,
inside the repo folder, after creating `config.json` and `.env`:

```sh
scp -r start.sh docker-compose.yml docker-compose.debug.yml .env nginx.conf config.json config.example.json web <user>@<box-ip>:/DATA/AppData/overhead/
```

### Find your latitude and longitude

Any of these gives you two decimal numbers, latitude first:

- **Google Maps (computer):** right-click your house on the map. The first line of the menu is the
  coordinates, e.g. `47.6205, -122.3493`. Click it to copy.
- **Google Maps (phone):** press and hold on your house until a red pin drops. The coordinates
  appear in the search box at the top.
- **Apple Maps (iPhone):** press and hold on your house to drop a pin, then swipe up on the pin's
  card. The coordinates are under Details.

Put them in `config.json`, rounded to 4 decimal places (about 10 m, plenty for this):

```json
"home": { "lat": 47.6205, "lon": -122.3493 },
```

Signs matter: latitude is negative south of the equator, and longitude is negative west of
Greenwich (all of the Americas). Keep the minus sign if the map shows one. If the numbers come as
degrees, minutes and seconds (`47°37'13.8"N`), switch the map to decimal or use a converter; the
display needs decimal degrees.

To check: open `https://www.google.com/maps?q=<lat>,<lon>` with your numbers. The pin should land
on your house.

## Phase 1: start FreeFlight

Goal: FreeFlight runs on the box and returns aircraft for your location.

```sh
cd /DATA/AppData/overhead
DEBUG=1 ./start.sh
```

The first run downloads the two images, which takes a minute or two. `DEBUG=1` also publishes
FreeFlight on the box's own `127.0.0.1:18000` so the checks below work. It is never reachable from
the rest of the network. If 18000 is taken too, set `DEBUG_PORT=` to another free port in `.env`
and use that port below.

If `./start.sh` says "Permission denied", run `chmod +x start.sh` once (or use `bash start.sh`).

**Checks** (replace `LAT` and `LON` with your numbers):

```sh
curl -s localhost:18000/v1/providers                 # adsb.lol, airplanes.live, adsb.fi healthy
docker exec overhead-freeflight-1 freeflight check  # skip if the command isn't found
curl -s "localhost:18000/v2/point/LAT/LON/10"        # an "ac" list with aircraft in it
curl -s localhost:18000/v1/route/CALLSIGN            # a callsign from the previous result: origin + destination
```

## Phase 2: the display

Goal: one page that answers "what is flying over the house right now?" from across the room.

It's already running. Open `http://<box-ip>:8090` in a browser on any computer on your network.

**Checks**

1. The page shows live aircraft, or "Clear skies overhead" with a count when nothing is within
   the radius.
2. Outage handling: the page keeps the last data and turns the status line red ("Stale · last
   update …"), then recovers on its own:

   ```sh
   docker stop overhead-freeflight-1     # wait ~10 s, look at the page
   docker start overhead-freeflight-1
   ```

3. A flight with no known route still shows cleanly ("Route unknown").
4. Turn off the test port by starting again without `DEBUG=1`:

   ```sh
   ./start.sh
   ss -ltn | grep 18000   # should print nothing
   ```

## Phase 3: always on

Goal: the display comes back by itself after a power cut, and changes take one command.

1. **Changes:** after editing `config.json` or `.env`, or after `git pull`, run `./start.sh`.
   The page checks for changes every minute and reloads itself, so you don't need to touch the
   screen.
2. **Reboots:** both containers restart by themselves. Confirm, then reboot the box once when it
   suits you:

   ```sh
   docker inspect -f "{{.Name}} {{.HostConfig.RestartPolicy.Name}}" overhead-freeflight-1 overhead-nginx-1
   sudo reboot
   ```

   Both lines of the first command should end in `unless-stopped`.
3. **The screen:** open the display in a web browser on any computer on the LAN.
   - Go to `http://<box-ip>:8090` and bookmark it.
   - **Full screen:** double-click the page or press `F` (`Esc` exits). The mouse pointer hides
     after 3 seconds without movement.
   - **Zoom and pan:** scroll, pinch or use the +/− buttons to zoom, and drag to move the map. All
     traffic in view is shown, out to a view reaching 250 nm from its centre (the most FreeFlight
     can answer for in one go); the map won't zoom out further. It returns to the home view a
     minute after you stop (`map.recenterSeconds`).
   - **Pick a plane:** click any plane on the map to show it in the card, with its planned route.
     Click the map (or the same plane) to go back to the closest one; it also goes back by itself
     after `map.recenterSeconds`. This works in the map-only view too.
   - **Map only:** the "Map only" button (bottom left, shown while the mouse moves) or the `C` key
     hides the card and list; press again to bring them back. Each browser remembers its choice.
   - **Keep it awake:** browsers only let a page keep the screen on over HTTPS, so set the
     computer's own display sleep to "never" while it's showing the page.
   - **Open straight into full screen** (optional), as an app window with no browser bars:

     ```sh
     # Chrome or Edge; on macOS use "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
     google-chrome --kiosk http://<box-ip>:8090      # Alt+F4 (Cmd+Q on macOS) closes it
     ```

   Later, a dedicated screen works the same way: an old tablet with a kiosk browser app set to
   start on boot, or a Raspberry Pi with Chromium in `--kiosk` mode and screen blanking off.
4. Give the box a DHCP reservation on your router, so its IP and the display's URL never change.

**Check:** after a reboot of the box, the open browser tab shows live aircraft again within
2 minutes with no one touching it. While the box is down the page shows "Stale"; it never needs
a manual refresh.

## Phase 4 (optional): your own receiver

Goal: read aircraft from an antenna at the house, with FreeFlight as the fallback. Do this only
after Phases 1 to 3 have run well for a while.

Hardware: an RTL-SDR USB dongle for 1090 MHz ADS-B, plus a 1090 MHz antenna placed as high as
possible.

1. Plug the dongle into the box and check it is seen: `lsusb`.
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
6. `./start.sh`

**Check:** the display keeps working with FreeFlight stopped, and with the dongle unplugged.

## Configuration (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `home.lat`, `home.lon` | required | Your location in decimal degrees ([how to find it](#find-your-latitude-and-longitude)) |
| `radiusNm` | `3` | "Overhead" radius. The closest aircraft inside it gets the big card. 2 to 5 nm works well. |
| `fetchRadiusMultiplier` | `2` | Aircraft are fetched and listed out to `radiusNm` × this, so you see them coming |
| `altitudeFt.min`, `.max` | `0`, `45000` | Altitude band. Raise `min` to hide approach traffic near an airport. |
| `units.altitude` | `ft` | `ft` or `m` |
| `units.speed` | `kt` | `kt`, `mph` or `kmh` |
| `units.distance` | `nm` | `nm`, `mi` or `km` |
| `refreshSeconds` | `5` | How often to fetch aircraft |
| `listCount` | `5` | Most rows under the main card (fewer if the screen is short) |
| `sources` | FreeFlight | Data URLs tried in order. `{lat}`, `{lon}` and `{radius}` are filled in. |
| `standingDataUrl` | GitHub via nginx | Community route data, tried first. `""` to use adsbdb only. |
| `routeUrl` | adsbdb via nginx | Fallback route lookup URL. `{callsign}` is filled in. |
| `airlineUrl` | adsbdb via nginx | Airline-name lookup URL. `{code}` (the callsign's ICAO prefix) is filled in. |
| `clock24h` | `true` | 24-hour clock |
| `night.enabled`, `.start`, `.end`, `.brightness` | off, `23:00`, `06:30`, `0.25` | Dim the screen overnight |
| `map.enabled` | `true` | Live map behind the cards. `false` gives the plain card-and-list page. |
| `map.trailMinutes` | `15` | How much of each aircraft's trail to keep |
| `map.tileUrl`, `map.attribution` | OpenStreetMap | Map background tiles and their credit line; any Leaflet tile URL works |
| `map.darkTiles` | `true` | Invert light tiles into a dark map. Set `false` for tiles that are already dark. |
| `map.tileBrightness` | `0.9` | How light the darkened map is (try 0.7 to 1.2) |
| `map.viewRadiusNm` | `4` | How far from home the map shows when nobody is touching it |
| `map.recenterSeconds` | `60` | After you drag or zoom, the map returns to the home view this many seconds later (`0` = never) |

To change the location or radius: `nano config.json`, then `./start.sh`. The screen reloads
within a minute.

## How it works

- `web/adapter.js` turns ADSBExchange-v2-style records (FreeFlight's `/v2/point`, adsb.lol,
  airplanes.live, or a readsb `aircraft.json`) into one shape, and works out distance and bearing
  from home itself. Swapping the data source is a config change.
- Routes are looked up once per callsign: first in the community
  [standing-data](https://github.com/vradarserver/standing-data) route list (updated daily, and it
  keeps multi-leg flights such as JFK → CVG → JFK), then from adsbdb (cached by nginx for 24
  hours) for callsigns that list doesn't have. nginx fetches the standing-data CSV files from
  GitHub as needed (one per airline, plus small airport files) and keeps each for a day.
- Route databases go stale, especially for regional airlines that reuse flight numbers, so every
  route is checked against where the plane actually is. A leg counts only if the plane is within
  100 nm (or 20% of the leg) of the straight line between its airports, between them, and heading
  towards the destination (not required within 40 nm of either airport). The card shows the leg
  that fits; if none does it says "Route unconfirmed" and no route line is drawn. A flight with no
  route still shows; the display never guesses one.
- When adsbdb has no route (or no airline) for a flight, the airline is looked up from the
  callsign's three-letter ICAO prefix (DAL1605 → Delta) through adsbdb's airline lookup, cached for
  7 days.
- If a fetch fails, the page keeps the last data and marks it stale. It never goes blank.
- Planes move smoothly between the 5-second updates: the page moves each one forward from its last
  known position at its reported speed and heading, using the time the feed says the position was
  taken, and eases into the real position when the next update arrives. If updates stop, planes
  stop moving after 20 seconds.
- Plane symbols come from the ADS-B emitter category each aircraft broadcasts: helicopters (A7)
  get a helicopter with a spinning rotor, light aircraft (A1, gliders, ultralights) a small
  straight-winged plane, small airliners (A2) a slightly smaller jet, heavies (A5) a bigger one.
  Aircraft without a category fall back to their type code (R44, EC35, B407 and similar are
  helicopters; C172, PA-28, SR22 and similar are light).
- At the home view the page makes one request, for the home area. Once the map is zoomed or
  panned past it, it also requests the circle around what's on screen (up to 250 nm). FreeFlight
  rounds every request to a grid point and a fixed radius and caches it, so this adds about one
  upstream request every 5 seconds, not more. Route and airline lookups stay limited to the card,
  the list and a picked plane.
- Planes near home (and a picked one) are full map markers with labels and trails. Everything else
  is drawn on a single canvas, which stays smooth with well over 1,000 planes; those get labels
  once you zoom in far enough and no trails. Click any plane to pick it.
- The map is drawn by `web/map.js` with Leaflet. None of the data sources keep flight history, so
  each trail is built in the browser from the positions it receives every few seconds: it starts
  when an aircraft first comes within the fetch radius, and a page reload clears it. The dashed
  line is the closest aircraft's planned route, a great circle between its departure and
  destination airports from adsbdb.
- The map background is OpenStreetMap's standard tiles (free, no API key), darkened in the browser
  to match the page. The browser loads them straight from the internet, not through the box, and
  caches them; one screen is well within OpenStreetMap's
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). If they can't load,
  the aircraft still show on a plain dark background. To use another provider, set `map.tileUrl`
  and `map.attribution` (and `map.darkTiles: false` if its tiles are already dark).

## Updating

```sh
cd /DATA/AppData/overhead
git pull
./start.sh
```

Your `config.json` and `.env` aren't in git, so `git pull` never touches them.

## Upkeep

- Every few months, check for new [FreeFlight](https://github.com/Ethos6/free-flight-api/releases)
  and [nginx](https://hub.docker.com/_/nginx) releases (and ultrafeeder if used), bump the pinned
  tags in `docker-compose.yml`, and run `./start.sh`. Leaflet rarely needs updating; if it does,
  replace the files in `web/vendor/leaflet/` with the new release's `dist/leaflet.js` and
  `dist/leaflet.css`.
- Don't add auto-updaters such as Watchtower; an untested update could quietly break the screen.
- Logs: `docker compose logs --tail 50` (in `/DATA/AppData/overhead`)

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| "Waiting for data" or a stale marker that stays | `docker logs --tail 50 overhead-freeflight-1`, then the Phase 1 checks with `DEBUG=1 ./start.sh` |
| Every flight says "Route unknown" | `docker exec overhead-nginx-1 wget -qO- http://127.0.0.1/api/route/BAW1`. If it fails, the box can't reach api.adsbdb.com. |
| Routes show "Route unconfirmed" | The route databases list a route the plane isn't flying (stale data), so it's hidden rather than shown wrong. |
| "Config error" on screen | `config.json` is missing or invalid; `./start.sh` checks it when `python3` is on the box |
| Page doesn't load | `docker ps` should list both containers; `ss -ltn \| grep 8090` should show the port |
| `docker` says "permission denied" | Put `sudo` in front, e.g. `sudo docker ps` |

## Preview on a laptop (optional)

Needs Node 18 or newer. No Docker, no network, no box.

```sh
npm test          # adapter unit tests
npm run dev       # http://localhost:8090 with fake aircraft
curl localhost:8090/__dev/down    # toggle a simulated outage: the page shows "Stale"
curl localhost:8090/__dev/empty   # toggle an empty sky: "Clear skies overhead"
```
