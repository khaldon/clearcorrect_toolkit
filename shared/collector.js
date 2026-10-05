// Drives the page steps from the popup. `exec(func, args, frameId?)` runs a step in the page and
// returns [{ frameId, result }] (empty on error). Everything is re-checked after every step, so a
// page reload / postback in the middle cannot break the flow.
import {
  stepClickLastSubmission, stepProbe, stepReadRx, stepNextVersion, stepIsIdle, stepReadPrefs
} from './page-collect.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function collectFromCase({ url, exec, log = () => {}, progress = () => {}, sleep = defaultSleep, maxVersions = 25 }) {
  const u = String(url || '').toLowerCase();
  const isSetup = u.includes('setup.aspx');
  const isCase = u.includes('case.aspx');
  log('page type -> setup:', isSetup, '| case:', isCase);
  if (!isSetup && !isCase) return { ok: false, reason: 'WRONG_PAGE' };

  // Finds the frame that holds the submission pop-up (polls; the pop-up may still be loading).
  async function findContainer(timeoutMs) {
    const end = Date.now() + timeoutMs;
    do {
      const res = await exec(stepProbe, []);
      const hit = res.find((r) => r.result?.hasContainer);
      if (hit) return { frameId: hit.frameId, probe: hit.result };
      await sleep(400);
    } while (Date.now() < end);
    return null;
  }

  async function clickLast() {
    const res = await exec(stepClickLastSubmission, []);
    res.forEach((r) => log('  click step, frame', r.frameId, JSON.stringify(r.result)));
    return res.some((r) => r.result?.clicked);
  }

  /* ---- 1. get the case submission pop-up ---- */
  let found = null;
  if (isSetup) {
    progress('Looking for the case submission form…', 1);
    found = await findContainer(2500);               // findOnlineForm first, no click
    if (!found) {
      log('setup page: pop-up not on the page, trying clickLastSubmissionLink');
      progress('Opening the submission…', 1);
      if (await clickLast()) { await sleep(1200); found = await findContainer(10000); }
    }
  } else {
    progress('Opening the last submission…', 1);
    if (!(await clickLast())) return { ok: false, reason: 'NO_SUBMISSION_LINK' };
    await sleep(1200);                               // let the pop-up postback start
    found = await findContainer(10000);
  }
  if (!found) return { ok: false, reason: 'NO_SUBMISSION_POPUP' };
  log('submission pop-up found in frame', found.frameId, JSON.stringify(found.probe));

  /* ---- 2. find the Online Form (Rx): try every version that is not a "Revision" header ---- */
  const versionsChecked = [];
  const visited = [];
  let rxText = '';
  let rxVersionLabel = null;
  let frameId = found.frameId;
  let noAnswer = 0;

  for (let i = 0; i < maxVersions; i++) {
    const cur = await findContainer(8000);
    if (!cur) return { ok: false, reason: 'NO_SUBMISSION_POPUP' };
    frameId = cur.frameId;
    const probe = cur.probe;
    if (!visited.includes(probe.versionIndex)) visited.push(probe.versionIndex);
    progress(`Looking for the Rx${probe.versionText ? ` (${probe.versionText})` : ''}…`, 2);
    log(`check ${i + 1}: version "${probe.versionText}" (index ${probe.versionIndex}/${probe.versionCount}) | Online Form tab visible:`, probe.formTabVisible);

    if (probe.formTabVisible) {
      const rxRes = (await exec(stepReadRx, [], frameId))[0]?.result;
      log('  Rx read:', JSON.stringify(rxRes));
      if (rxRes?.text) { rxText = rxRes.text; rxVersionLabel = probe.versionText || null; break; }
    }

    versionsChecked.push(probe.versionText || `#${probe.versionIndex}`);
    progress('No Rx in this version, trying another one…', 2);
    const next = (await exec(stepNextVersion, [{ visited }], frameId))[0]?.result;
    log('  next version step:', JSON.stringify(next));
    if (!next) {                                         // page probably reloaded; re-check it
      if (++noAnswer >= 3) { log('  no answer from the page 3 times in a row, stopping the version search'); break; }
      await sleep(1500);
      continue;
    }
    noAnswer = 0;
    if (!next.ok || next.reachedEnd) break;

    // wait until the page has finished the postback (Sys.WebForms request manager), like the console script
    await sleep(700);
    if (next.hasPrm === false) await sleep(1500);
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const idle = (await exec(stepIsIdle, [], frameId))[0]?.result
        || (await exec(stepIsIdle, []))[0]?.result;
      if (idle && idle.container && !idle.busy) break;
      await sleep(400);
    }
    await sleep(400);
  }

  /* ---- 3. Treatment Preferences tab ---- */
  progress('Reading the treatment preferences…', 3);
  const cur = await findContainer(8000);
  if (cur) frameId = cur.frameId;
  const prefs = (await exec(stepReadPrefs, [], frameId))[0]?.result || {};
  log('prefs:', JSON.stringify(prefs));

  return {
    ok: true,
    rxFound: !!rxText,
    rxText: rxText || null,
    rxVersionLabel,
    versionsChecked,
    prefsTabSwitched: !!prefs.switched,
    engagersDefaultRaw: prefs.engagersDefaultRaw ?? null,
    additionalPrefsRaw: prefs.additionalPrefsRaw ?? null
  };
}
