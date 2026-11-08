# SMART Disk Analyzer

A local, browser-based dashboard that reads **every SMART parameter of every disk in the
machine**, scores the health of each drive and **forecasts its remaining useful life**.

The UI is a vanilla-JavaScript single page app built from web components. A tiny
zero-dependency Node server bridges the browser to `smartctl` (from `smartmontools`),
which is the only reliable way for a web page to reach raw device data.

![dashboard](docs/screenshot-overview.png)

## Highlights

- **All parameters, not a summary** – every ATA attribute, every NVMe health-log field and
  every SCSI counter is normalised into one sortable, searchable, filterable table with a
  plain-English explanation per row, severity rating and CSV export.
- **Remaining-life forecast** – five independent projections (measured wear trend,
  write-endurance budget, media-defect growth, health-score decay, health-weighted design
  life) are combined into one estimate with an explicit confidence level and a breakdown of
  which model produced the answer.
- **History and trends** – snapshots are stored on disk, charted with a canvas trend chart
  and used to replace lifetime averages with *measured* wear and write rates.
- **Works without root** – disks are still listed, each one explains why it cannot be read,
  and you can drop a `smartctl -a -j` JSON file from any machine onto the page to analyse
  it. Demo mode ships five fixture drives so the whole UI can be explored immediately.
- **Zero runtime dependencies** – no npm packages, no build step, no telemetry. Everything
  runs on your machine.

## Quick start

```bash
# 1. smartmontools must be installed
sudo apt install smartmontools        # Debian / Ubuntu
# sudo dnf install smartmontools      # Fedora

# 2. Explore the UI with bundled demo drives (no root needed)
npm run demo
# → http://127.0.0.1:7373

# 3. Read the real disks (SMART needs raw device access)
sudo npm start
# or, nicer: elevate only smartctl, not the whole server
sudo ./bin/setup-sudoers.sh     # once
npm run elevated
```

Requires Node.js ≥ 18.13 (tested on Node 22).

## How it works

```
┌──────────────────────────────┐        ┌───────────────────────────────┐
│ Browser (public/)            │  HTTP  │ Node server (server/)         │
│  web components, canvas      │ <────> │  scan devices, run smartctl   │
│  charts, attribute tables    │  JSON  │  persist snapshot history     │
└──────────────┬───────────────┘        └──────────────┬────────────────┘
               │ imports                                │ imports
               └──────────────► shared/ ◄───────────────┘
                 normalisation, attribute knowledge base, health + RUL model
```

`shared/` is pure ES modules with no Node or DOM APIs, so the *same* analysis code runs in
both places. That is why imported JSON files get identical scores to locally scanned disks.

| Path | Purpose |
| --- | --- |
| `shared/attributes.js` | ATA/NVMe/SCSI attribute dictionary + severity rules |
| `shared/normalize.js` | `smartctl -a -j` JSON → one unified device model |
| `shared/forecast.js` | Health scoring, trend regression, RUL projections |
| `shared/format.js` | Byte / duration / percent formatting helpers |
| `server/smartctl.js` | Device discovery and `smartctl` execution |
| `server/store.js` | Atomic JSON snapshot history |
| `server/demo.js` | Fixture loader + synthetic history generator |
| `server/index.js` | HTTP API + static hosting |
| `public/js/components/` | `<sa-gauge>`, `<sa-disk-list>`, `<sa-attribute-table>`, `<sa-trend-chart>`, `<sa-forecast-panel>`, `<sa-risk-list>`, `<sa-kpi-strip>`, `<sa-import-dialog>`, `<sa-toasts>` |

## Remaining-life model

For each disk the engine computes several independent projections and takes the most
pessimistic one, then applies safety caps:

1. **Endurance consumption** – remaining endurance (`100 − percentage_used`, or the
   countdown normalised ATA gauges 202/231/233/177) divided by the wear rate. The rate is
   the slope of a least-squares fit over the stored snapshots when at least one day of
   history exists, otherwise the lifetime average (`wear ÷ power-on days`).
2. **Write endurance budget** – the implied rated TBW is derived from the drive itself
   (`bytes written ÷ wear fraction`), then remaining bytes are divided by the measured or
   average write rate. A 970 EVO Plus at 38 % used with 114 TB written correctly implies a
   300 TB rating.
3. **Media defect growth** – linear extrapolation of reallocated / pending sector counts to
   the practical red line (100 reallocated or 10 pending sectors).
4. **Health score decay** – extrapolation of the health score to the replacement threshold
   of 40.
5. **Design life** – remaining powered-on hours against a nominal 43 800 h budget, scaled
   by health (0.6×–1.4×) and converted with the measured duty cycle. A drive past its
   budget gets a health-proportional grace period instead of a hard zero.

Safety caps stop the model from being optimistic: a failing SMART status caps the estimate
at 30 days, pending sectors at 60 days, any critical risk factor at 180 days, and the health
score itself imposes a ceiling (score < 45 → 180 d, < 60 → 365 d, < 70 → 730 d, < 85 → 1095 d).

**Confidence** starts at 20 % and grows with firmware-reported wear data (+30 %), history
depth (+25 % for ≥ 3 snapshots over ≥ 7 days, +12 % for ≥ 30 days), agreement between
independent models (+8 %), and shrinks for missing gauges and open critical risks. Every
number is labelled `low` / `medium` / `high`, and the UI shows the individual projections so
the estimate is never a black box.

The health score starts at 100 and subtracts weighted penalties for reallocated sectors,
pending/uncorrectable sectors, media errors, self-test failures, endurance consumed,
critical warnings, spare-block exhaustion, temperature, interface CRC errors, age and
unfavourable trends. The full penalty list is returned by the API.


## Using the dashboard

| Area | What you get |
| --- | --- |
| KPI strip | disk count, total capacity, mean health, drives needing attention, earliest end of life |
| Disk rail | every drive with a compact health ring, capacity, wear and remaining life; sorted worst first |
| Hero | health gauge with grade, remaining life, projected failure date, confidence and a concrete recommendation |
| Overview tab | risk factors with severity and the SMART attribute that triggered them, endurance/usage stats, and the model breakdown |
| Parameters tab | all parameters: search, category chips, severity filters, sortable columns, expandable explanation per row, CSV export |
| Trends tab | canvas trend chart (endurance, health, temperature, reallocated, pending, bytes written, power-on hours) with hover readout and the recent snapshot table |
| Raw JSON tab | the untouched `smartctl` JSON with copy and download |

Keyboard: `R` rescan · `C` capture snapshot · `I` import JSON · `?` shortcut help.

**Capture** stores a snapshot of every readable disk. Snapshots older than six hours are
also captured automatically on every scan, so trends build up by themselves if the analyzer
is left running (or launched from a timer). A few days of history is enough for the model to
switch from lifetime averages to measured rates.

## CLI options

```
node server/index.js [options]

  -p, --port <n>              HTTP port (default 7373, env PORT)
      --host <addr>           bind address (default 127.0.0.1, env HOST)
      --demo                  use the bundled fixtures + synthetic history
      --live                  force live smartctl reads (default)
      --sudo                  run smartctl through "sudo -n"
      --smartctl <path>       smartctl binary (default "smartctl")
      --refresh <seconds>     device scan cache TTL (default 30)
      --capture-interval <h>  minimum hours between automatic snapshots (default 6)
      --design-life <hours>   design life used by the age model (default 43800)
      --no-auto-capture       never write snapshots automatically
      --verbose               log every request
```

Environment equivalents: `PORT`, `HOST`, `SMART_MODE=demo`, `SMARTCTL_BIN`,
`SMARTCTL_SUDO=1`, `REFRESH_SECONDS`, `CAPTURE_INTERVAL_HOURS`, `DESIGN_LIFE_HOURS`,
`AUTO_CAPTURE=0`, `HISTORY_FILE`.

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/disks` | all disks with attributes, health and forecast (`?refresh=1` bypasses the scan cache) |
| GET | `/api/disks/:key` | one disk |
| GET | `/api/status` | smartctl version, privileges, host info, history summary |
| POST | `/api/capture` | store a snapshot for every readable disk |
| GET | `/api/history/:key` | snapshot history of one disk |
| DELETE | `/api/history/:key` | forget the history of one disk |
| POST | `/api/import` | analyse `smartctl` JSON posted in the request body |
| GET | `/api/download/:key` | download the raw `smartctl` JSON |

Example:

```bash
curl -s localhost:7373/api/disks | jq '.disks[] | {model, score: .health.score, rulDays: .forecast.rul.days}'
```

## Reading other machines' disks

```bash
sudo smartctl -a -j /dev/sda > disk.json     # on the remote machine
```

Drop `disk.json` onto the dashboard (or use **Import**). Parsing, scoring and forecasting
run in the browser with the same shared modules - the server is not involved.

## Development

```bash
npm start        # live mode
npm run dev      # live mode with --watch
npm run demo     # fixtures + synthetic history
npm test         # normalisation, attribute rules, forecast model, API and store tests
```

Everything is plain ES modules; there is no bundler. Edit a file and reload the page.

## Notes and limitations

- The forecast is a statistical estimate, not a guarantee: SMART indicators precede most but
  not all failures (and a drive can die without any warning). Keep backups.
- `smartctl` needs root (or CAP_SYS_RAWIO) for raw device access; that is a kernel
  permission, not something a browser can work around.
- ATA attributes are vendor specific. Known IDs are documented in `shared/attributes.js`;
  unknown ones get a generic trend explanation instead of a guessed verdict.
- Some USB bridges and RAID controllers hide SMART data entirely. Pass the right `-d` device
  type; the server forwards any non-standard type reported by the scan, while ATA, SCSI and
  NVMe are auto-detected.
- Remaining-life figures assume the recent workload continues. A drive that suddenly gets
  much more write traffic will age faster than the projection.

## License

MIT
