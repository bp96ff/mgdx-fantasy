// Makes the weekly scripts ride out brief hiccups from ESPN or Google Sheets: a request that can't connect,
// or that gets a server error or rate limit, is tried again after a short wait. Other errors fail right away.
// Required first by each tools/run-*.js script; the site itself doesn't use it.
const WAITS = [5000, 15000]; // before the second and third tries

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

globalThis.fetch = async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    let problem;
    try {
      const response = await realFetch(url, options);
      if (response.status < 500 && response.status !== 429) return response;
      if (attempt >= WAITS.length) return response;
      problem = `responded ${response.status}`;
    } catch (err) {
      if (attempt >= WAITS.length) throw err;
      problem = err.message;
    }
    console.log(`Request to ${new URL(url).host} failed (${problem}). Trying again in ${WAITS[attempt] / 1000}s.`);
    await sleep(WAITS[attempt]);
  }
};
