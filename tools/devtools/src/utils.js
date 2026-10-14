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

export function fuzzySearch(baseString, queryString) {
  const base = baseString.toLowerCase();
  const query = queryString.toLowerCase();
  let queryIndex = 0;
  let baseIndex = -1;
  let character;
  while ((character = query[queryIndex++])) {
    baseIndex = base.indexOf(character, baseIndex + 1);
    if (baseIndex === -1) {
      return false;
    }
  }
  return true;
}

export function isElementInCenterViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.bottom >= 0.25 * (window.innerHeight || document.documentElement.clientHeight) &&
    rect.bottom <= 0.75 * (window.innerHeight || document.documentElement.clientHeight)
  );
}

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
