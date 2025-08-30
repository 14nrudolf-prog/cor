(function (root) {
  root.diffSnapshots = (prev, curr, opts = {}) => {
    const rows = [];
    const prevComments     = opts.prevComments     || {};
    const inactiveStatus   = opts.inactiveStatus   || {};
    const knownLogKeysById = opts.knownLogKeysById || {}; // <-- union of ALL prior log items per WO ID

     const isCancelled = s =>
      typeof s === 'string' && /cancel/i.test(s); // handles "Cancelled: Duplicate Work Order", "Canceled", etc
    
    const norm = v => (v && typeof v === 'object' ? JSON.stringify(v) : v);

    // Make a stable signature for each log row
    const makeLogKey = it => [
      it?.ActionDateTime || '',
      it?.ActionBy       || '',
      it?.ActionTitle    || '',
      it?.Comment        || ''
    ].join('||');

    // Does current activity log contain a *new* item (not seen in ANY older snapshot)?
    function activityLogHasNew(id, prevRow, currRow) {
      const currArr = currRow && currRow['Activity log'];
      if (!Array.isArray(currArr) || currArr.length === 0) return false;

      // Start with the set from all older snapshots (passed in from SW)
      const seen = new Set(knownLogKeysById[String(id).trim()] || []);

      // Also include items from the immediate previous snapshot
      const prevArr = prevRow && prevRow['Activity log'];
      if (Array.isArray(prevArr)) {
        for (const it of prevArr) seen.add(makeLogKey(it));
      }

      // If ANY current item isn't in 'seen', it's truly new
      for (const it of currArr) {
        const key = makeLogKey(it);
        if (!seen.has(key)) return true;
      }
      return false;
    }

    // Compare fields, with special handling for Activity log
    function changedFields(id, a, b) {
      const fields = [];
      for (const k of Object.keys(b)) {
        if (
          k === 'Updated' ||
          k === 'Comment / last update (previous)' ||
          k === 'Comment / last update (new)'
        ) continue;

        if (k === 'Activity log') {
          if (activityLogHasNew(id, a, b)) fields.push('Activity log');
        } else {
          if (norm(a?.[k]) !== norm(b?.[k])) fields.push(k);
        }
      }
      return fields;
    }

    const latestLogText = row => {
      const arr = row && row['Activity log'];
      if (Array.isArray(arr) && arr.length) {
        const i = arr[0]; // most recent
        const parts = [
          i.ActionDateTime || '',
          i.ActionBy       || '',
          i.ActionTitle    || '',
          i.Comment        || ''
        ].filter(Boolean);
        return parts.join(' — ');
      }
      return '';
    };

    // present now (active)
    Object.entries(curr).forEach(([id, row]) => {
      const key = String(id).trim();
      if (!prev[id]) {
        rows.push({
          ...row,
          Updated: 'New',
          'Comment / last update (previous)': prevComments[key] || '',
          'Comment / last update (new)': ''
        });
      } else {
        const changed = changedFields(key, prev[id], row);
        rows.push({
          ...row,
          Updated: changed.length ? changed.join(',') : '',
          'Comment / last update (previous)': prevComments[key] || latestLogText(prev[id]),
          'Comment / last update (new)': ''
        });
      }
    });

    // present before, missing now (completed/cancelled)
    Object.entries(prev).forEach(([id, row]) => {
      if (!curr[id]) {
        const key = String(id).trim();
        const nowStatus  = inactiveStatus[key];     // status read from details page this run (if we got it)
        const prevStatus = row.Status;              // fallback to last known status in the old snapshot
        const label = isCancelled(nowStatus) || isCancelled(prevStatus) ? 'Cancelled' : 'Completed';

        rows.push({
          ...row,
          Updated: label,
          'Comment / last update (previous)': (opts.prevComments?.[key]) || latestLogText(row),
          'Comment / last update (new)': ''
        });
      }
    });

    return rows;
  };
})(typeof window === 'undefined' ? globalThis : window);
