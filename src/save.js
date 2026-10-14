// Saving attempts. A failed save used to vanish: the result showed, but the attempt never reached History or the daily plan.
// Now each attempt waits in this browser until the server confirms it, and anything unconfirmed is sent again on the next load.
const KEY = "bandsy-unsaved";
const same = (x, a) => x.test === a.test && x.module === a.module && x.started_at === a.started_at;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const write = list => { try { list.length ? localStorage.setItem(KEY, JSON.stringify(list)) : localStorage.removeItem(KEY); } catch {} };
const forget = a => write(read().filter(x => !same(x, a)));

async function post(a) {
  const r = await fetch("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server replied ${r.status}`);
  forget(a);
}

/** Saves one finished attempt; on failure says so (with the server's reason) and keeps it for the next load. */
export async function saveAttempt(a) {
  write([...read().filter(x => !same(x, a)), a]);
  try { await post(a); }
  catch (e) { alert(`This attempt wasn't saved: ${e.message}\n\nIt's kept in this browser and will be sent again the next time you open Bandsy.`); }
}

/** Sends attempts left from a failed save. One the server already has (the save landed but its reply was lost) is just dropped. */
export async function sendUnsaved() {
  const list = read();
  if (!list.length) return;
  try {
    const have = await fetch("/api/attempts").then(r => r.ok ? r.json() : Promise.reject());
    for (const a of list) have.some(x => same(x, a)) ? forget(a) : await post(a);
  } catch {}   // still unreachable: try again on the next load
}
