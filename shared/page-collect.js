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
  const formTabVisible = !!tab && (tab.offsetHeight > 0 || tab.offsetWidth > 0);
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

/* engagers.txt -> onlineFormTab.click() then the rx (instruction) line */
export async function stepReadRx() {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = document.getElementById(`${C}_tpForm_tab`);
  if (tab) { tab.click(); console.log('[ClearComm] Online Form found! Switching to tab...'); }
  let label = null;
  for (let i = 0; i < 25 && !label; i++) {
    label = document.querySelector(`#${C}_tpForm_lblRevInstructions`);
    if (!label) await sleep(200);
  }
  const text = label ? (label.innerText || label.textContent || '').trim() : '';
  console.log('[ClearComm] Rx / instructions:', text);
  return { labelFound: !!label, text };
}

/* engagers.txt -> findOnlineForm(): Files tab -> next (older) version in the dropdown.
   The actual change is fired AFTER this function returns, so the result reaches the popup
   even if the page reloads because of the postback. */
export async function stepPrevVersion() {
  const C = 'ctl00_MainPH_frmCaseSubmission_tcRecord';
  const DD = `${C}_tpFiles_ddlCaseSubmissionID`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('[ClearComm] Online Form not found in this version. Navigating to Files to change version...');
  const filesTab = document.getElementById(`${C}_tpFiles_tab`);
  if (!filesTab) { console.error('[ClearComm] Could not find Files tab.'); return { ok: false, reason: 'NO_FILES_TAB' }; }
  filesTab.click();
  let dropdown = null;
  for (let i = 0; i < 15 && !dropdown; i++) {
    await sleep(200);
    dropdown = document.getElementById(DD);
  }
  if (!dropdown) { console.error('[ClearComm] Version dropdown not found in Files tab.'); return { ok: false, reason: 'NO_DROPDOWN' }; }

  const currentIndex = dropdown.selectedIndex;
  const from = (dropdown.options[currentIndex]?.text || '').trim();
  if (currentIndex >= dropdown.options.length - 1) {
    console.log('[ClearComm] Reached the end of the version history. Online Form not found.');
    return { ok: true, reachedEnd: true, from };
  }
  const target = currentIndex + 1;
  const to = (dropdown.options[target]?.text || '').trim();
  console.log(`[ClearComm] Switching from version ${from} to older version ${to}...`);
  setTimeout(() => {
    dropdown.selectedIndex = target;
    dropdown.dispatchEvent(new Event('change'));
    if (typeof window.__doPostBack !== 'undefined') window.__doPostBack(DD, '');
  }, 80);
  return { ok: true, reachedEnd: false, from, to, targetIndex: target };
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

  // engagers.txt: getEngagersRemovalValue() and Additional Treatment Preferences Notes (Option 1)
  const getEngagersRemovalValue = () => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const targetRow = rows.find((tr) => {
      const cells = tr.querySelectorAll('td');
      return cells.length >= 2 && /^engagers removal for revisions/i.test(cells[0].innerText.trim());
    });
    return targetRow ? targetRow.cells[1].innerText.trim() : null;
  };
  // Additional Treatment Preferences Notes: label cell -> next cell, non-breaking spaces cleaned.
  const getNotes = () => {
    const label = 'Additional Treatment Preferences Notes:';
    const tds = Array.from(document.querySelectorAll('td'));
    const labelTd = tds.find((td) => td.innerText.trim() === label);
    const rawValue = labelTd?.nextElementSibling?.innerText || '';
    return rawValue.replace(/\u00a0/g, ' ').trim();   // "" when effectively empty
  };
  for (let i = 0; i < 25 && getEngagersRemovalValue() === null; i++) await sleep(200);
  const engagersDefaultRaw = getEngagersRemovalValue();
  const additionalPrefsRaw = getNotes();
  console.log('[ClearComm] Engagers removal for revisions:', engagersDefaultRaw);
  console.log('[ClearComm] Additional Treatment Preferences Notes:', JSON.stringify(additionalPrefsRaw));
  return { switched, how, engagersDefaultRaw, additionalPrefsRaw };
}
