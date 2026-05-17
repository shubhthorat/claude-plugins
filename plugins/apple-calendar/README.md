# apple-calendar

Read and manage Apple Calendar events from Claude Code using JXA (JavaScript for Automation via `osascript`).

## Tools

- `calendar_list_calendars` — list all calendars (name, ID)
- `calendar_get_events` — get events in a date range, optionally filtered by calendar
- `calendar_create_event` — create a new event with title, time, location, notes, URL
- `calendar_update_event` — update an existing event by UID
- `calendar_delete_event` — delete an event by UID
- `calendar_search_events` — search events by keyword (matched against title and notes)

## Setup

```
/plugin install apple-calendar@shubhthorat
```

### macOS permissions

On first use, macOS will prompt for Calendar access. Grant it to your terminal app (Terminal, iTerm2, etc.) via **System Settings → Privacy & Security → Calendars**.

## Usage examples

```
What's on my calendar this week?
Schedule a dentist appointment next Tuesday at 2pm for 1 hour.
Find all events mentioning "standup" and show me this week's ones.
Move my 3pm meeting to 4pm.
```

## Build from source

```bash
cd server && npm install && npm run build
```
