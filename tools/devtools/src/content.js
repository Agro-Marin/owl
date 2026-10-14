import globalHook from "./page_scripts/owl_devtools_global_hook";
import { IS_FIREFOX, browserInstance } from "./utils";

window.addEventListener(
  "message",
  function (event) {
    if (event.data.type && event.data.source === "owl-devtools") {
      try {
        browserInstance.runtime.sendMessage(
          event.data.data
            ? { type: event.data.type, data: event.data.data, origin: event.data.origin }
            : { type: event.data.type, origin: event.data.origin }
        );
      } catch (e) {
      }
    }
  },
  false
);

if (IS_FIREFOX) {
  const script = document.createElement("script");
  script.textContent = globalHook;
  document.documentElement.appendChild(script);
  script.parentNode.removeChild(script);
}
