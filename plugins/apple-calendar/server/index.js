import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function runJXA(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-l", "JavaScript"]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => (stdout += d));
    proc.stderr.on("data", d => (stderr += d));
    proc.on("close", code => {
      if (code !== 0) reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
      else resolve(stdout.trim());
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

// Expand bare date strings (YYYY-MM-DD) to include a time component.
function expandDate(s, endOfDay = false) {
  return s.length === 10 ? `${s}T${endOfDay ? "23:59:59" : "00:00:00"}` : s;
}

const server = new McpServer({ name: "apple-calendar", version: "0.1.0" });

server.tool(
  "calendar_list_calendars",
  "List all Apple Calendar calendars on this Mac with their name and ID.",
  {},
  async () => {
    const raw = await runJXA(`
      const app = Application("Calendar");
      const result = app.calendars().map(c => ({
        name: c.name(),
        description: (() => { try { return c.description() || null; } catch { return null; } })(),
        writable: (() => { try { return c.writable(); } catch { return null; } })()
      }));
      JSON.stringify(result);
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

server.tool(
  "calendar_get_events",
  "Get events from Apple Calendar within a date range, optionally filtered to one calendar.",
  {
    start_date: z.string().describe("Range start in ISO 8601, e.g. '2026-05-17' or '2026-05-17T09:00:00'"),
    end_date: z.string().describe("Range end in ISO 8601, e.g. '2026-05-17' or '2026-05-17T23:59:59'"),
    calendar_name: z.string().optional().describe("Filter to this calendar by name. Omit for all calendars."),
  },
  async ({ start_date, end_date, calendar_name }) => {
    const start = expandDate(start_date, false);
    const end = expandDate(end_date, true);
    const raw = await runJXA(`
      const app = Application("Calendar");
      const startTs = new Date(${JSON.stringify(start)}).getTime();
      const endTs   = new Date(${JSON.stringify(end)}).getTime();
      const filterCal = ${JSON.stringify(calendar_name ?? null)};
      const result = [];
      for (const cal of app.calendars()) {
        if (filterCal && cal.name() !== filterCal) continue;
        let events = [];
        try { events = cal.events(); } catch {}
        for (const e of events) {
          try {
            const s = e.startDate();
            const ts = s.getTime();
            if (ts < startTs || ts > endTs) continue;
            result.push({
              uid:      e.uid(),
              title:    e.summary() || "(no title)",
              start:    s.toISOString(),
              end:      e.endDate().toISOString(),
              allDay:   e.alldayEvent(),
              location: (() => { try { return e.location() || null; } catch { return null; } })(),
              notes:    (() => { try { return e.description() || null; } catch { return null; } })(),
              url:      (() => { try { return e.url() || null; } catch { return null; } })(),
              calendar: cal.name()
            });
          } catch {}
        }
      }
      result.sort((a, b) => a.start.localeCompare(b.start));
      JSON.stringify(result);
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

server.tool(
  "calendar_create_event",
  "Create a new event in Apple Calendar.",
  {
    title: z.string().describe("Event title"),
    start: z.string().describe("Start date/time in ISO 8601, e.g. '2026-05-17T10:00:00'"),
    end:   z.string().describe("End date/time in ISO 8601, e.g. '2026-05-17T11:00:00'"),
    calendar_name: z.string().optional().describe("Target calendar name. Falls back to first available calendar."),
    location: z.string().optional().describe("Event location"),
    notes:    z.string().optional().describe("Event notes/description"),
    url:      z.string().optional().describe("Event URL"),
    all_day:  z.boolean().optional().describe("Set true for an all-day event"),
  },
  async ({ title, start, end, calendar_name, location, notes, url, all_day }) => {
    const raw = await runJXA(`
      const app = Application("Calendar");
      const calName = ${JSON.stringify(calendar_name ?? null)};
      let cal;
      if (calName) {
        const matches = app.calendars().filter(c => c.name() === calName);
        if (!matches.length) throw new Error("Calendar not found: " + calName);
        cal = matches[0];
      } else {
        cal = app.calendars()[0];
      }
      const props = {
        summary:     ${JSON.stringify(title)},
        startDate:   new Date(${JSON.stringify(expandDate(start))}),
        endDate:     new Date(${JSON.stringify(expandDate(end))}),
        alldayEvent: ${JSON.stringify(all_day ?? false)}
      };
      ${location != null ? `props.location    = ${JSON.stringify(location)};` : ""}
      ${notes    != null ? `props.description = ${JSON.stringify(notes)};`    : ""}
      ${url      != null ? `props.url         = ${JSON.stringify(url)};`      : ""}
      const event = app.Event(props);
      cal.events.push(event);
      JSON.stringify({
        created:  true,
        uid:      event.uid(),
        title:    event.summary(),
        start:    event.startDate().toISOString(),
        end:      event.endDate().toISOString(),
        calendar: cal.name()
      });
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

server.tool(
  "calendar_update_event",
  "Update an existing Apple Calendar event by its UID (from calendar_get_events or calendar_search_events).",
  {
    uid:      z.string().describe("Event UID"),
    title:    z.string().optional().describe("New title"),
    start:    z.string().optional().describe("New start date/time in ISO 8601"),
    end:      z.string().optional().describe("New end date/time in ISO 8601"),
    location: z.string().optional().describe("New location (empty string to clear)"),
    notes:    z.string().optional().describe("New notes (empty string to clear)"),
    url:      z.string().optional().describe("New URL (empty string to clear)"),
  },
  async ({ uid, title, start, end, location, notes, url }) => {
    const raw = await runJXA(`
      const app = Application("Calendar");
      let found = null;
      for (const cal of app.calendars()) {
        const match = cal.events().find(e => { try { return e.uid() === ${JSON.stringify(uid)}; } catch { return false; } });
        if (match) { found = match; break; }
      }
      if (!found) throw new Error("Event not found: " + ${JSON.stringify(uid)});
      ${title    != null ? `found.summary     = ${JSON.stringify(title)};`              : ""}
      ${start    != null ? `found.startDate   = new Date(${JSON.stringify(expandDate(start))});` : ""}
      ${end      != null ? `found.endDate     = new Date(${JSON.stringify(expandDate(end))});`   : ""}
      ${location != null ? `found.location    = ${JSON.stringify(location)};`           : ""}
      ${notes    != null ? `found.description = ${JSON.stringify(notes)};`              : ""}
      ${url      != null ? `found.url         = ${JSON.stringify(url)};`                : ""}
      JSON.stringify({
        updated: true,
        uid:     found.uid(),
        title:   found.summary(),
        start:   found.startDate().toISOString(),
        end:     found.endDate().toISOString()
      });
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

server.tool(
  "calendar_delete_event",
  "Delete an Apple Calendar event by its UID.",
  {
    uid: z.string().describe("Event UID (from calendar_get_events or calendar_search_events)"),
  },
  async ({ uid }) => {
    const raw = await runJXA(`
      const app = Application("Calendar");
      let result = { deleted: false, error: "Event not found: " + ${JSON.stringify(uid)} };
      for (const cal of app.calendars()) {
        const idx = cal.events().findIndex(e => { try { return e.uid() === ${JSON.stringify(uid)}; } catch { return false; } });
        if (idx !== -1) {
          const title = (() => { try { return cal.events()[idx].summary(); } catch { return null; } })();
          cal.events()[idx].delete();
          result = { deleted: true, uid: ${JSON.stringify(uid)}, title };
          break;
        }
      }
      JSON.stringify(result);
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

server.tool(
  "calendar_search_events",
  "Search Apple Calendar events by keyword matched against title and notes.",
  {
    query: z.string().describe("Keyword to search for in event title and notes"),
    calendar_name: z.string().optional().describe("Limit search to this calendar"),
    limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)"),
  },
  async ({ query, calendar_name, limit = 25 }) => {
    const raw = await runJXA(`
      const app = Application("Calendar");
      const q          = ${JSON.stringify(query.toLowerCase())};
      const filterCal  = ${JSON.stringify(calendar_name ?? null)};
      const maxResults = ${limit};
      const result = [];
      outer: for (const cal of app.calendars()) {
        if (filterCal && cal.name() !== filterCal) continue;
        let events = [];
        try { events = cal.events(); } catch {}
        for (const e of events) {
          if (result.length >= maxResults) break outer;
          try {
            const titleLC = (e.summary()     || "").toLowerCase();
            const notesLC = (e.description() || "").toLowerCase();
            if (!titleLC.includes(q) && !notesLC.includes(q)) continue;
            result.push({
              uid:      e.uid(),
              title:    e.summary() || "(no title)",
              start:    e.startDate().toISOString(),
              end:      e.endDate().toISOString(),
              allDay:   e.alldayEvent(),
              location: (() => { try { return e.location() || null;     } catch { return null; } })(),
              notes:    (() => { try { return e.description() || null;   } catch { return null; } })(),
              calendar: cal.name()
            });
          } catch {}
        }
      }
      result.sort((a, b) => a.start.localeCompare(b.start));
      JSON.stringify(result);
    `);
    return { content: [{ type: "text", text: raw }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
