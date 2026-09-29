// Drives the page steps from the popup. `exec(func, args, frameId?)` runs a step in the page and
// returns [{ frameId, result }] (empty on error). Everything is re-checked after every step, so a
// page reload / postback in the middle cannot break the flow.
import {
  stepClickLastSubmission, stepProbe, stepReadRx, stepPrevVersion, stepReadPrefs
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

  /* ---- 2. find the Online Form (Rx), stepping back through versions ---- */
  const versionsChecked = [];
  let rxText = '';
  let rxVersionLabel = null;
  let frameId = found.frameId;
  let noAnswer = 0;

  for (let i = 0; i < maxVersions; i++) {
    let cur = await findContainer(8000);
    if (!cur) return { ok: false, reason: 'NO_SUBMISSION_POPUP' };
    frameId = cur.frameId;
    const probe = cur.probe;
    progress(`Looking for the Rx${probe.versionText ? ` (version ${probe.versionText})` : ''}…`, 2);
    log(`check ${i + 1}: version "${probe.versionText}" (${probe.versionIndex + 1}/${probe.versionCount}) | Online Form tab visible:`, probe.formTabVisible);

    if (probe.formTabVisible) {
      const rxRes = (await exec(stepReadRx, [], frameId))[0]?.result;
      log('  Rx read:', JSON.stringify(rxRes));
      if (rxRes?.text) { rxText = rxRes.text; rxVersionLabel = probe.versionText || null; break; }
    }

    versionsChecked.push(probe.versionText || `#${probe.versionIndex}`);
    progress('No Rx in this version, trying an older one…', 2);
    const prev = (await exec(stepPrevVersion, [], frameId))[0]?.result;
    log('  previous version step:', JSON.stringify(prev));
    if (!prev) {                                        // page probably reloaded; re-check it
      if (++noAnswer >= 3) { log('  no answer from the page 3 times in a row, stopping the version search'); break; }
      await sleep(1500);
      continue;
    }
    noAnswer = 0;
    if (!prev.ok || prev.reachedEnd) break;

    // wait for the postback to finish: the dropdown must show the older version
    await sleep(800);
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const c = await findContainer(1500);
      if (c && c.probe.versionIndex === prev.targetIndex) break;
      await sleep(400);
    }
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
