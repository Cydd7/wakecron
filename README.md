# wakecron

Wake your Mac from sleep and run your scripts on a schedule.

Put scripts in `scripts/`, then tell wakecron when to run them:

```bash
./wakecron add backup.sh 07:30
```

At 07:29 the Mac wakes up. At 07:30 `backup.sh` runs, and the Mac stays awake until the
script finishes, then goes back to sleep on its usual timer. If the Mac slept through the time
anyway, the script runs as soon as the Mac wakes.

**Included:** a morning routine that backs up your Apple Shortcuts every day. See [Morning routine](#morning-routine).

## Requirements

- macOS
- Node.js 20 or newer. Check with `node --version`; install it with `brew install node` or from
  [nodejs.org](https://nodejs.org).

## Install

1. Unzip the folder to `~/wakecron`. Don't put it in Desktop, Documents, Downloads or iCloud
   Drive: macOS privacy rules stop background jobs from reading those folders.
2. Run the one-time setup. It asks for your password once:

   ```bash
   cd ~/wakecron
   ./wakecron setup
   ```

   Setup lets wakecron schedule wake-ups without asking for your password each time. It also adds
   a small login item that re-arms wake-ups whenever you log in.

   Run wakecron as yourself, never with `sudo`: it asks for your password itself when it needs it.

macOS may then show a **Background Items Added** notification for `node`. That's wakecron; leave
it allowed in System Settings → General → Login Items & Extensions.

## Three-minute self-test

```bash
./wakecron add hello.sh +3m     # run the example script once, three minutes from now
pmset -g sched                  # should list a wake-up "by 'wakecron'"
pmset sleepnow                  # or Apple menu → Sleep
```

About two minutes later the Mac wakes up, and `hello.sh` runs a minute after that. You'll see
a "hello.sh ran" notification. Then check:

```bash
./wakecron list                 # one-time jobs remove themselves after running
cat logs/hello-*.log            # the script's output, with start and end lines
```

## Commands

| Command | What it does |
|---|---|
| `./wakecron setup` | One-time setup. Safe to run again. |
| `./wakecron add [script] [time] [--days D]` | Schedule a script from `scripts/`. Run it without arguments to be asked step by step. |
| `./wakecron list` | Jobs, next runs, last results, pending wake-ups and setup status. Also what plain `./wakecron` shows. |
| `./wakecron run <id>` | Run a job now and see its output. Doesn't change its schedule. |
| `./wakecron remove <id>` | Delete a job (alias `rm`). Its log is kept. |
| `./wakecron sync` | Repair everything, for example after moving this folder or changing Node. |
| `./wakecron uninstall` | Remove the background jobs, wake-ups and sudo rule. Leaves this folder alone. |

Job ids look like `backup-0730`: the script name plus the time.

### Times

| You type | Meaning |
|---|---|
| `07:30`, `7:30pm`, `7pm`, `12am` | Every day at that time, or on the days you choose with `--days` |
| `2026-11-06 18:00` or `2026-11-06 6pm` | Once, at that date and time |
| `+10m`, `+2h` | Once, that long from now |

### Days (`--days` or `-d`)

`daily` (the default), `weekdays`, `weekends`, or a list of day names and ranges such as
`mon,wed,fri`, `mon-fri` or `fri-mon`.

```bash
./wakecron add report.js 18:00 --days mon-fri
./wakecron add cleanup.sh 2026-12-24 09:00
./wakecron add                  # asks which script, when, and which days
```

## Writing scripts

- Any language works. Start the file with a `#!` line, such as `#!/bin/bash`,
  `#!/usr/bin/env python3` or `#!/usr/bin/env node`. A script without one runs with
  `/bin/bash`. wakecron makes `#!` scripts executable for you.
- Scripts run from inside `scripts/`, so relative paths start there.
- Scripts get the PATH your terminal had the last time you ran `add` or `sync`, plus the
  Homebrew folders, so `git`, `brew` and friends work as usual. `WAKECRON_JOB_ID` holds the job id.
- A non-zero exit code shows a macOS notification and is marked ✗ in `./wakecron list`.
- Output is captured until every process that holds it exits. If a script starts something that
  keeps running, detach it: `long-task >/dev/null 2>&1 &`.

## Morning routine

`scripts/morning.sh` runs a list of steps every morning at 7:00, once you schedule it. Right now it
has one step: it backs up all your Apple Shortcuts, keeping daily, weekly and monthly copies.

### Set it up (once, on your Mac, after `./wakecron setup`)

1. **Let node read your Shortcuts.** macOS keeps the Shortcuts library private, so the `node` that
   runs wakecron needs Full Disk Access.
   1. In Terminal, run this and copy the path it prints:

      ```bash
      node -p "require('fs').realpathSync(process.execPath)"
      ```

   2. Open System Settings → Privacy & Security → Full Disk Access.
   3. Click **+**, press ⌘⇧G, paste the path, press Return, then click **Open**.
   4. Check that the switch next to `node` is on.
2. **Schedule it** for 7:00 every day:

   ```bash
   ./wakecron add morning.sh 07:00
   ```

3. **Try it now** instead of waiting until tomorrow. This runs the routine once, two minutes from
   now, the same way the 7:00 run will:

   ```bash
   ./wakecron add morning.sh +2m
   ```

   Two minutes later, this lists today's backup:

   ```bash
   ls ~/Documents/Backups/Shortcuts/daily
   ```

   and this shows how the run went:

   ```bash
   cat logs/morning-*.log
   ```

### What you get

Each morning adds a backup to `~/Documents/Backups/Shortcuts`:

```
~/Documents/Backups/Shortcuts/
├── daily/
│   └── 2026-11-06/
│       ├── Shortcuts.sqlite.gz    your whole Shortcuts library, compressed
│       └── shortcut-names.txt     the names of the shortcuts in it
├── weekly/
│   └── 2026-11-02/                the same two files
└── monthly/
    └── 2026-11-01/                the same two files
```

- **Daily:** the newest 7 are kept. Running the routine again on the same day replaces that day's
  backup.
- **Weekly and monthly:** the first backup of each week (Monday to Sunday) is also kept in
  `weekly/`, newest 4, and the first backup of each month in `monthly/`, newest 12.
- **Counted, not aged:** if the Mac is off for a while, your most recent backups stay. The routine
  only ever deletes the dated folders it made itself.

The routine's output is in `logs/morning-0700.log`.

To use another folder or keep more backups, edit the `step` line in `scripts/morning.sh`. For
example:

```bash
step "Back up Shortcuts" node morning/backup-shortcuts.js --to "$HOME/Documents/Backups/Shortcuts" --daily 14 --weekly 8 --monthly 24
```

### Add a step

1. Put your script in `scripts/morning/`, for example `scripts/morning/weather.sh`.
2. Add a line for it in `scripts/morning.sh`, above `exit "$failed"`:

   ```bash
   step "Check the weather" bash morning/weather.sh
   ```

Use `node morning/your-script.js` or `python3 morning/your-script.py` the same way. Steps run in
order. A step that fails doesn't stop the others, but you get a "morning.sh failed" notification.

### Restore a backup

**This hasn't been tested yet; read it all before you start.**

- Make sure Time Machine has a recent backup of your Mac first.
- If your shortcuts sync through iCloud, changes made after the backup, deletions included, may
  sync back afterwards.
- Terminal needs Full Disk Access for these commands. Give it the same way as in setup step 1, but
  add the Terminal app (Applications → Utilities → Terminal) instead of the node path.

1. Pick a backup, and open its `shortcut-names.txt` to check it has what you need.
2. Quit the Shortcuts app.
3. Change the first line below to the backup you picked, then paste all three lines into Terminal.
   The last line stops before it touches your library if that backup isn't there:

   ```bash
   BACKUP=~/Documents/Backups/Shortcuts/daily/2026-11-05
   SAVED=~/Documents/Backups/Shortcuts/before-restore-$(date +%Y%m%d-%H%M%S)
   [ -f "$BACKUP/Shortcuts.sqlite.gz" ] && mkdir -p "$SAVED" && mv ~/Library/Shortcuts/Shortcuts.sqlite* "$SAVED"/ && gunzip -c "$BACKUP/Shortcuts.sqlite.gz" > ~/Library/Shortcuts/Shortcuts.sqlite && echo "Restored. Now restart your Mac."
   ```

   You should see `Restored. Now restart your Mac.` If you don't, check the folder in the first
   line. If `~/Library/Shortcuts` no longer has a `Shortcuts.sqlite`, follow the undo note below.
4. Restart the Mac, then open Shortcuts.

Your library from before the restore is kept in the `before-restore-…` folder, and the routine
never deletes those. To undo the restore, quit Shortcuts, move the files in that folder back into
`~/Library/Shortcuts/`, and restart.

### When something goes wrong

- **A "morning.sh failed" notification:** see what happened with `tail -n 20 logs/morning-0700.log`.
- **The log says "macOS blocked access":** do setup step 1 again. With Homebrew's Node you need to
  after every `brew upgrade node`, because macOS ties the permission to that exact `node` file.
  Node from the [nodejs.org](https://nodejs.org) installer keeps the permission.
- **The log says "no Shortcuts library":** open the Shortcuts app once, then try setup step 3 again.

## Logs

- `logs/<id>.log` — each run's output, between `=== … start …` and `=== … exit N …` lines. When it
  passes 1 MB it moves to `<id>.log.1`.
- `logs/launchd.log` — problems with wakecron itself (rarely written).

## How it works

- Each job is a macOS LaunchAgent (`~/Library/LaunchAgents/local.wakecron.<id>.plist`) that
  launchd starts at the job's time. If the Mac slept through that time, launchd starts it on wake.
- One minute before each run, a `pmset` wake-up wakes the Mac. Each run schedules the next
  wake-up before running the script, so a failing script can't break the schedule.
- While the script runs, `caffeinate` keeps the Mac from sleeping.
- `setup` installs `/etc/sudoers.d/wakecron_<you>`. It allows exactly two commands without a
  password, `pmset schedule wake <date> wakecron` and `pmset schedule cancel wake <date> wakecron`,
  and nothing else.
- The login item runs `./wakecron sync --wakes-only` at each login. That re-arms wake-ups missed
  while the Mac was shut down.

## Limits and troubleshooting

- **Jobs run only while you're logged in.** A locked screen is fine. The FileVault login screen
  after a restart is not; log in once and the next runs happen as normal.
- **A shut-down Mac isn't turned on.** wakecron wakes a sleeping Mac. Runs missed while it was
  off are skipped. A one-time job that is more than 24 hours late is skipped and removed, and you
  get a notification.
- **MacBooks with the lid closed** and no external display may go straight back to sleep. Keep the
  lid open, or use an external display and power.
- **"Operation not permitted"** in a log means macOS privacy rules blocked the script. Give Full
  Disk Access to the program named in the error, often `node` or `bash`, in System Settings →
  Privacy & Security.
- **Moved this folder, or switched Node versions with nvm?** Run `./wakecron sync`.
  `./wakecron list` tells you when it's needed. Homebrew upgrades need nothing: jobs use
  `/opt/homebrew/bin/node`, which survives them.
- **Nothing happened?** Check `./wakecron list` for ✗ and `!` lines, then `logs/`, then
  `pmset -g sched`, which should list wake-ups `by 'wakecron'`.

## Uninstall

```bash
./wakecron uninstall
```

Then delete this folder.

## Development

```bash
npm test
```

The tests run on macOS and Linux and never touch your real launchd, pmset or sudo.
`WAKECRON_BIN_DIR` points wakecron at the stand-in tools in `tests/fakes/`; it is for tests only.
One test checks the sudoers rule against real `sudo`; it runs only as root on Linux, for example
in a CI container, and is skipped everywhere else. The Shortcuts backup tests use a real sqlite3
when one is installed (macOS has it) and skip those checks otherwise.

The design and the implementation plan are in `docs/superpowers/`.
