// Small single-purpose steps injected into the ClearCorrect page (world MAIN).
// Each one is SELF-CONTAINED (Chrome serialises it) and mirrors a snippet from engagers.txt.
// They are deliberately short so a page reload between steps (ASP.NET postback) cannot lose work:
// shared/collector.js drives them one at a time and re-checks the page after every step.

const IDS = {
  container: 'ctl00_MainPH_frmCaseSubmission_tcRecord',
  onlineFormTab: 'ctl00_MainPH_frmCaseSubmission_tcRecord_tpForm_tab',
  filesTab: 'ctl00_MainPH_frmCaseSubmission_tcRecord_tpFiles_tab',
  versionDropdown: 'ctl00_MainPH_frmCaseSubmission_tcRecord_tpFiles_ddlCaseSubmissionID',
  rxLabel: 'ctl00_MainPH_frmCaseSubmission_tcRecord_tpForm_lblRevInstructions'
};

/* engagers.txt -> clickLastSubmissionLink() (case page) */
export function stepClickLastSubmission() {
  const allRows = Array.from(document.querySelectorAll('tr'));
  const rowsWithLink = allRows.filter((row) => row.querySelector('.btnlgray.bdlgray.hand img'));
  if (!rowsWithLink.length) {
    console.error('[ClearComm] No rows found with the submission link.');
    return { clicked: false, rows: 0, frame: location.href.slice(0, 80) };
  }
  const lastRow = rowsWithLink[rowsWithLink.length - 1];
  const targetImage = lastRow.querySelector('.btnlgray.bdlgray.hand img');
  if (!targetImage) return { clicked: false, rows: rowsWithLink.length, frame: location.href.slice(0, 80) };
  targetImage.click();
  console.log('[ClearComm] Successfully clicked the submission link in the last row.');
  return { clicked: true, rows: rowsWithLink.length, frame: location.href.slice(0, 80) };
}

/* Is the case submission pop-up in this frame, and which version / tab is showing? */
export function stepProbe() {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const container = document.getElementById(C);
  if (!container) return { hasContainer: false };
  // engagers.txt -> findOnlineForm(): tab present AND visible (offsetHeight > 0)
  const tab = document.getElementById(`${C}_tpForm_tab`);
  const formTabVisible = !!tab && (tab.offsetParent !== null || tab.offsetHeight > 0);   // automationLoop success check
  const dd = document.getElementById(`${C}_tpFiles_ddlCaseSubmissionID`);
  return {
    hasContainer: true,
    formTabVisible,
    hasFilesTab: !!document.getElementById(`${C}_tpFiles_tab`),
    versionIndex: dd ? dd.selectedIndex : -1,
    versionCount: dd ? dd.options.length : 0,
    versionText: dd ? (dd.options[dd.selectedIndex]?.text || '').trim() : ''
  };
}

/* automationLoop success branch + extractData(): click the Online Form tab, let it load, read the Rx */
export async function stepReadRx() {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = document.getElementById(`${C}_tpForm_tab`);
  if (tab) {
    const innerTab = tab.querySelector('.ajax__tab_inner') || tab.querySelector('.ajax__tab_outer') || tab;
    innerTab.click();
    console.log('[ClearComm] SUCCESS: Online Form Tab Found! Clicked it.');
  }
  await sleep(1000);                       // let the tab content load before reading
  let label = null;
  for (let i = 0; i < 15 && !label; i++) {
    label = document.querySelector(`#${C}_tpForm_lblRevInstructions`);
    if (!label) await sleep(200);
  }
  const text = label ? (label.innerText || label.textContent || '').trim() : '';
  console.log('[ClearComm] Rx / instructions:', text);
  return { labelFound: !!label, text };
}

/* automationLoop(): next dropdown entry that is not a "Revision" header (cycling like the script).
   `visited` = option indexes already checked. The change is fired AFTER this returns, so the
   result reaches the popup even if the page reloads. */
export async function stepNextVersion({ visited = [] } = {}) {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const SELECT_ID = `${C}_tpFiles_ddlCaseSubmissionID`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let select = document.getElementById(SELECT_ID);
  if (!select) {                           // dropdown lives in the Files tab: open it and look again
    const filesTab = document.getElementById(`${C}_tpFiles_tab`);
    if (filesTab) filesTab.click();
    for (let i = 0; i < 15 && !select; i++) { await sleep(200); select = document.getElementById(SELECT_ID); }
  }
  if (!select) { console.error('[ClearComm] Version dropdown not found.'); return { ok: false, reason: 'NO_DROPDOWN' }; }

  const options = select.options;
  const current = select.selectedIndex;
  let next = -1;
  for (let i = 1; i <= options.length; i++) {
    const idx = (current + i) % options.length;
    if (!/revision/i.test(options[idx].text) && !visited.includes(idx)) { next = idx; break; }
  }
  if (next === -1 || next === current) {
    console.log('[ClearComm] No more versions to try.');
    return { ok: true, reachedEnd: true };
  }
  const to = options[next].text.trim();
  console.log(`[ClearComm] Trying: "${to}"`);
  setTimeout(() => {
    select.selectedIndex = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, 80);
  return { ok: true, reachedEnd: false, to, targetIndex: next, hasPrm: !!(window.Sys && window.Sys.WebForms) };
}

/* Is the pop-up there and the page finished with its (async) postback? */
export function stepIsIdle() {
  const container = !!document.getElementById('ctl00_MainPH_frmCaseSubmission_tcRecord');
  let busy = false;
  let hasPrm = false;
  try {
    const prm = window.Sys && window.Sys.WebForms ? window.Sys.WebForms.PageRequestManager.getInstance() : null;
    if (prm) { hasPrm = true; busy = !!prm.get_isInAsyncPostBack(); }
  } catch (e) { /* ignore */ }
  return { container, busy, hasPrm };
}

/* engagers.txt -> $find(...).set_activeTabIndex(2), then the two rows */
export async function stepReadPrefs() {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let switched = false;
  let how = '';
  try {
    const tabContainer = typeof window.$find === 'function' ? window.$find(C) : null;
    if (tabContainer) { tabContainer.set_activeTabIndex(2); switched = true; how = '$find'; }
  } catch (e) { how = `$find failed: ${e}`; }
  if (!switched) {
    const container = document.getElementById(C);
    const heads = container ? Array.from(container.querySelectorAll('a, span, div')) : [];
    const guess = heads.find((h) => {
      const t = (h.innerText || h.textContent || '').trim();
      return /treatment preferences/i.test(t) && t.length < 40;
    });
    if (guess) { guess.click(); switched = true; how = 'header click'; }
  }
  console.log('[ClearComm] Treatment Preferences tab switched:', switched, how);
  await sleep(1000);                       // wait for the tab switch like extractData()

  // engagers.txt: getEngagersRemovalValue() and Additional Treatment Preferences Notes (Option 1)
  const getEngagersRemovalValue = () => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const targetRow = rows.find((tr) => {
      const cells = tr.querySelectorAll('td');
      return cells.length >= 2 && /^engagers removal for revisions/i.test(cells[0].innerText.trim());
    });
    return targetRow ? targetRow.cells[1].innerText.trim() : null;
  };
  // Additional Treatment Preferences Notes: exact label cell first, then any row whose first cell contains the label.
  const getNotes = () => {
    const clean = (v) => String(v || '').replace(/\u00a0/g, ' ').trim();
    const label = 'Additional Treatment Preferences Notes:';
    const labelTd = Array.from(document.querySelectorAll('td')).find((td) => td.innerText.trim() === label);
    if (labelTd) return clean(labelTd.nextElementSibling?.innerText);
    const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.cells[0]?.innerText.includes('Additional Treatment Preferences Notes'));
    return row && row.cells[1] ? clean(row.cells[1].innerText) : '';
  };
  for (let i = 0; i < 25 && getEngagersRemovalValue() === null; i++) await sleep(200);
  const engagersDefaultRaw = getEngagersRemovalValue();
  const additionalPrefsRaw = getNotes();
  console.log('[ClearComm] Engagers removal for revisions:', engagersDefaultRaw);
  console.log('[ClearComm] Additional Treatment Preferences Notes:', JSON.stringify(additionalPrefsRaw));
  return { switched, how, engagersDefaultRaw, additionalPrefsRaw };
}
