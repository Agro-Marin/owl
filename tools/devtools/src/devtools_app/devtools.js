import { IS_FIREFOX, browserInstance } from "../utils";

let created = false;

const checkInterval = setInterval(createPanelsIfOwl, 1000);

createPanelsIfOwl();

function createPanelsIfOwl() {
  if (created) {
    clearInterval(checkInterval);
    return;
  }
  browserInstance.devtools.inspectedWindow.eval(
    "window.__OWL_DEVTOOLS__?.Fiber !== undefined;",
    async (hasOwl) => {
      if (!hasOwl || created) {
        return;
      }
      clearInterval(checkInterval);
      created = true;
      browserInstance.devtools.panels.create(
        "Owl",
        "../../assets/icon128.png",
        IS_FIREFOX ? "devtools_panel.html" : "devtools_app/devtools_panel.html"
      );
    }
  );
}
