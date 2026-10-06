export const IS_FIREFOX = navigator.userAgent.indexOf("Firefox") !== -1;

export const browserInstance = IS_FIREFOX ? browser : chrome;

export async function getOwlStatus() {
  const response = await browserInstance.runtime.sendMessage({ type: "getOwlStatus" });
  return response.result;
}

export async function getActiveTabURL() {
  const window = await browserInstance.windows.getLastFocused({ populate: true });
  const activeTab = window.tabs.find((tab) => tab.active);
  return activeTab.id;
}

// inspired from https://www.tutorialspoint.com/fuzzy-search-algorithm-in-javascript
// Check if the query matches with the base in a fuzzy search way
export function fuzzySearch(baseString, queryString) {
  const base = baseString.toLowerCase();
  const query = queryString.toLowerCase();
  let queryIndex = 0;
  let baseIndex = -1;
  let character;
  // Loop through each character in the query string
  while ((character = query[queryIndex++])) {
    // Find the index of the character in the base string, starting from the previous index plus 1
    baseIndex = base.indexOf(character, baseIndex + 1);
    // If the character is not found, return false
    if (baseIndex === -1) {
      return false;
    }
  }
  // All characters in the query string were found in the base string, so return true
  return true;
}

// Check if the given element is vertically centered in the user view (between 25 and 75% of the height)
export function isElementInCenterViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.bottom >= 0.25 * (window.innerHeight || document.documentElement.clientHeight) &&
    rect.bottom <= 0.75 * (window.innerHeight || document.documentElement.clientHeight)
  );
}

// Formatting for displaying the key of the component: a key is segments, each
// \u0002, a tag and a payload, the \u0002 of a payload doubled (see keyOf in
// owl-runtime's template_helpers). Shown: its loop keys and t-keys.
export function minimizeKey(key) {
  const shown = [];
  let i = key.indexOf("\u0002");
  while (i !== -1 && i < key.length - 1) {
    const tag = key[i + 1];
    let end = i + 2;
    let payload = "";
    while (end < key.length) {
      if (key[end] === "\u0002") {
        if (key[end + 1] !== "\u0002") {
          break;
        }
        end++;
      }
      payload += key[end++];
    }
    if (tag === ":" || tag === "k") {
      shown.push(payload.startsWith("'") ? payload.slice(1) : payload);
    }
    i = end < key.length ? end : -1;
  }
  return shown.join(", ");
}
