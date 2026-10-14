(function () {
  "use strict";

  const IS_FIREFOX = navigator.userAgent.indexOf("Firefox") !== -1;

  class OwlDevtoolsGlobalHook {
    constructor() {
      this.apps = window.__OWL_DEVTOOLS__.apps;
      this.Fiber = window.__OWL_DEVTOOLS__.Fiber;
      this.RootFiber = window.__OWL_DEVTOOLS__.RootFiber;
      this.toRaw = window.__OWL_DEVTOOLS__.toRaw ?? window.owl?.toRaw;
      this.reactive = window.__OWL_DEVTOOLS__.reactive ?? window.owl?.reactive;
      this.addedElements = [];
      this.eventId = 0;
      this.frame = "top";
      const iFrameObserver = new MutationObserver(function (mutationsList) {
        mutationsList.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (addedNode) {
            if (addedNode.tagName == "IFRAME") {
              if (addedNode.contentDocument) {
                window.top.postMessage({
                  source: "owl-devtools",
                  type: "NewIFrame",
                  data: addedNode.contentDocument.location.href,
                });
              }
            }
          });
        });
      });
      iFrameObserver.observe(document.body, { subtree: true, childList: true });
      this.patchAppsSetMethods();
      this.recordEvents = false;
      this.traceRenderings = false;
      this.traceSubscriptions = false;
      this.requestedFrame = false;
      this.enabledSelector = false;
      this.eventsBatch = [];
      this.rootNodes = new WeakMap();
      this.breakpointsClassMap = new Map();
      this.breakpointsHookMap = new Map();
      this.serializer = {
        serializeItem(value, asConstructorName = false) {
          if (typeof value === "object") {
            if (value == null) {
              return "null";
            }
            if (asConstructorName) {
              return value.constructor.name;
            }
            if (value instanceof Array) {
              return "Array(" + value.length + ")";
            }
            return "{...}";
          } else if (typeof value === "undefined") {
            return "undefined";
          } else if (typeof value === "string") {
            return JSON.stringify(value);
          } else if (typeof value === "function") {
            if (asConstructorName) {
              return value.constructor.name;
            }
            let functionString = value.toString();
            if (functionString.startsWith("class")) {
              return "class " + value.name;
            } else {
              const regex = /\{(?![^()]*\))(.*?)\}(?![^{}]*\})/s;
              return functionString.replace(regex, "{...}");
            }
          } else {
            let valueAsString = value.toString();
            if (asConstructorName && valueAsString.length > 10) {
              valueAsString = valueAsString.substring(0, 8) + "...";
            }
            return valueAsString;
          }
        },
        array(arr) {
          const result = [];
          let length = 0;
          for (const item of arr) {
            if (length > 25) {
              result.push("...");
              break;
            }
            const element = this.serializeItem(item);
            length += element.length;
            result.push(element);
          }
          return "[" + result.join(", ") + "]";
        },
        object(obj) {
          const result = [];
          let length = 0;
          if (obj instanceof String) {
            result[0] = `'${obj.toString()}'`;
          } else if (obj instanceof Array) {
            return `${obj.constructor.name} ${this.array([...obj])}`;
          } else if (obj instanceof Number) {
            result[0] = obj.toString();
          } else {
            for (const key of Reflect.ownKeys(obj)) {
              if (length > 25) {
                result.push("...");
                break;
              }
              let element;
              if (Object.getOwnPropertyDescriptor(obj, key).hasOwnProperty("get")) {
                element = key.toString() + ": (...)";
              } else {
                element = key.toString() + ": " + this.serializeItem(obj[key]);
              }
              length += element.length;
              result.push(element);
            }
            for (const key of Object.getOwnPropertySymbols(obj)) {
              if (length > 25) {
                result.push("...");
                break;
              }
              const element = key.toString() + ": " + this.serializeItem(obj[key]);
              length += element.length;
              result.push(element);
            }
          }
          if (obj.constructor && obj.constructor.name !== "Object") {
            return obj.constructor.name + " {" + result.join(", ") + "}";
          }
          return "{" + result.join(", ") + "}";
        },
        map(obj) {
          const result = [];
          let length = 0;
          for (const [key, value] of obj.entries()) {
            if (length > 25) {
              result.push("...");
              break;
            }
            const element =
              this.serializeItem(key, true) + " => " + this.serializeItem(value, true);
            length += element.length;
            result.push(element);
          }
          return "Map(" + obj.size + "){" + result.join(", ") + "}";
        },
        ["map entry"](obj) {
          return (
            "{" + this.serializeItem(obj[0], true) + " => " + this.serializeItem(obj[1], true) + "}"
          );
        },
        set(obj) {
          const result = [];
          let length = 0;
          for (const value of obj) {
            if (length > 25) {
              result.push("...");
              break;
            }
            const element = this.serializeItem(value, false);
            length += element.length;
            result.push(element);
          }
          return "Set(" + obj.size + "){" + result.join(", ") + "}";
        },
        serializeContent(item, type) {
          if (this[type]) {
            return this[type](item);
          }
          return this.serializeItem(item);
        },
      };
    }

    getAppVersion(app) {
      return app.__proto__.constructor?.version || "<2.0.8";
    }

    getRoots(app) {
      const version = this.getAppVersion(app);
      if (version.startsWith("3")) {
        const nodes = [];
        for (const root of app.roots) {
          if (root.node) {
            nodes.push(root.node);
            continue;
          }
          if (this.rootNodes.has(root)) {
            const node = this.rootNodes.get(root);
            if (node) {
              nodes.push(node);
            }
          } else {
            this.rootNodes.set(root, null);
            root.promise.then(
              (component) => {
                this.rootNodes.set(root, component.__owl__);
                window.top.postMessage({ source: "owl-devtools", type: "RefreshApps" });
              },
              () => {}
            );
          }
        }
        return nodes;
      }
      const roots = [];
      if (app.root) {
        roots.push(app.root);
      }
      if (app.subRoots) {
        for (const subRoot of app.subRoots) {
          roots.push(subRoot);
        }
      }
      return roots;
    }

    initDevtools(frame = "top") {
      if (!this.devtoolsInit) {
        document.addEventListener("mouseover", this.HTMLSelector, { capture: true });
        this.frame = frame;
        const self = this;
        const original_Complete = self.RootFiber.prototype.complete;
        self.RootFiber.prototype.complete = function () {
          original_Complete.call(this, ...arguments);
          const path = self.getComponentPath(this.node);
          window.top.postMessage({
            source: "owl-devtools",
            type: "Complete",
            data: path,
            origin: { frame: self.frame },
          });
          if (self.recordEvents) {
            window.top.postMessage({
              source: "owl-devtools",
              type: "Event",
              data: self.eventsBatch,
            });
            self.eventsBatch = [];
          }
        };
        this.devtoolsInit = true;
      }
    }
    patchAppsSetMethods() {
      const originalAdd = this.apps.add;
      const originalDelete = this.apps.delete;
      this.apps.add = function () {
        originalAdd.call(this, ...arguments);
        window.top.postMessage({
          source: "owl-devtools",
          type: "RefreshApps",
        });
      };
      this.apps.delete = function () {
        originalDelete.call(this, ...arguments);
        window.top.postMessage({
          source: "owl-devtools",
          type: "RefreshApps",
        });
      };
    }

    patchAppMethods() {
      let app;
      for (const appItem of this.apps) {
        if (this.getRoots(appItem).length > 0) {
          app = appItem;
          break;
        }
      }
      if (!app || this.getRoots(app).length === 0) {
        return;
      }
      const self = this;
      const originalFlush = app.scheduler.constructor.prototype.flush;
      let inFlush = false;
      const renderCalledKey = Symbol("owlDevtoolsRenderCalled");
      app.scheduler.constructor.prototype.flush = function () {
        const wasInFlush = inFlush;
        inFlush = true;
        originalFlush.call(this, ...arguments);
        inFlush = wasInFlush;
      };
      const originalRender = self.Fiber.prototype.render;
      self.Fiber.prototype.render = function () {
        const id = self.eventId++;
        this[renderCalledKey] = false;
        let flushed = false;
        if (this instanceof self.RootFiber && inFlush) {
          flushed = true;
        }

        const fiber = this;
        const node = this.node;
        const nodeRenderFn = node.renderFn;
        let time = 0;
        this.node.renderFn = function () {
          const before = performance.now();
          const result = nodeRenderFn.call(this);
          time = performance.now() - before;
          node.renderFn = nodeRenderFn;
          fiber[renderCalledKey] = true;
          return result;
        };

        originalRender.call(this, ...arguments);
        const nodeName = this.node.component?.constructor?.name ?? this.node.name ?? "";
        const didRender = this[renderCalledKey];
        if (didRender && self.traceRenderings && this instanceof self.RootFiber) {
          console.groupCollapsed(`Rendering <${nodeName}>`);
          console.trace();
          console.groupEnd();
        }
        if (self.recordEvents) {
          const path = self.getComponentPath(this.node);
          if (flushed) {
            self.eventsBatch.push({
              type: "render (flushed)",
              component: nodeName,
              key: this.node.parentKey ? this.node.parentKey : "",
              path: path,
              time: time,
              id: id,
            });
          } else if (didRender) {
            if (this instanceof self.RootFiber) {
              self.eventsBatch.push({
                type: this.deep ? "render (deep)" : "render",
                component: nodeName,
                key: this.node.parentKey ? this.node.parentKey : "",
                path: path,
                time: time,
                id: id,
              });
            } else if (this.node.status === 0) {
              self.eventsBatch.push({
                type: "create",
                component: nodeName,
                key: this.node.parentKey ? this.node.parentKey : "",
                path: path,
                time: time,
                id: id,
              });
            } else {
              self.eventsBatch.push({
                type: "update",
                component: nodeName,
                key: this.node.parentKey ? this.node.parentKey : "",
                path: path,
                time: time,
                id: id,
              });
            }
          } else {
            self.eventsBatch.push({
              type: "render (delayed)",
              component: nodeName,
              key: this.node.parentKey ? this.node.parentKey : "",
              path: path,
              time: time,
              id: id,
            });
          }
        }
      };
      const firstRoot = this.getRoots(app)[0];
      const originalDestroy = firstRoot.constructor.prototype._destroy;
      firstRoot.constructor.prototype._destroy = function () {
        if (self.recordEvents) {
          const path = self.getComponentPath(this);
          const event = {
            type: "destroy",
            component: this.component?.constructor?.name ?? this.name ?? "",
            key: this.parentKey ?? "",
            path: path,
            time: 0,
            id: self.eventId++,
          };
          self.eventsBatch.push(event);
          const before = performance.now();
          originalDestroy.call(this, ...arguments);
          event.time = performance.now() - before;
        } else {
          originalDestroy.call(this, ...arguments);
        }
      };
    }

    patchReactivity() {
      const WeakMapGet = WeakMap.prototype.get;
      const MapGet = Map.prototype.get;
      const SetAdd = Set.prototype.add;
      const self = this;

      let callbacksToTargets;
      let targetToKeysToCallbacks;

      const obj = self.reactive({}, () => {});
      let count = 0;
      WeakMap.prototype.get = function () {
        count++;
        if (count === 1) {
          targetToKeysToCallbacks = this;
        }
        if (count === 3) {
          callbacksToTargets = this;
          WeakMap.prototype.get = WeakMapGet;
        }
        return WeakMapGet.call(this, ...arguments);
      };
      obj.a;

      let key;
      function getKey(_key) {
        key = _key;
        return MapGet.call(this, _key);
      }

      targetToKeysToCallbacks.get = function (target) {
        const keyToCallbacks = WeakMapGet.call(this, target);
        if (keyToCallbacks) {
          keyToCallbacks.get = getKey;
        }
        return keyToCallbacks;
      };

      function addTarget(target) {
        if (self.traceSubscriptions && !this.has(target)) {
          console.groupCollapsed(`Observing:`, key, target);
          console.trace();
          console.groupEnd();
        }
        return SetAdd.call(this, target);
      }
      callbacksToTargets.get = function (callback) {
        const targets = WeakMapGet.call(this, callback);
        if (targets) {
          targets.add = addTarget;
        }
        return targets;
      };
    }

    toggleTracing(value) {
      if (value) {
        this.patchAppMethods();
        this.patchAppMethods = () => {};
      }
      this.traceRenderings = value;
      return this.traceRenderings;
    }

    supportsSubscriptionTracing() {
      const apps = [...this.apps];
      if (!apps.length) {
        return false;
      }
      return !this.getAppVersion(apps[0]).startsWith("3");
    }

    toggleSubscriptionTracing(value) {
      if (value) {
        this.patchReactivity();
        this.patchReactivity = () => {};
      }
      this.traceSubscriptions = value;
      return value;
    }
    toggleEventsRecording(value, index) {
      if (value) {
        this.patchAppMethods();
        this.patchAppMethods = () => {};
      }
      this.recordEvents = value;
      this.eventId = index;
      return this.recordEvents;
    }

    resetEvents() {
      this.eventId = 0;
    }

    getIFrameUrls() {
      let frames = [];
      for (const frame of document.querySelectorAll("iframe")) {
        frames.push(frame.contentDocument.location.href);
      }
      return frames;
    }

    highlightElements(elements, name) {
      this.removeHighlights();

      if (elements.length === 0) {
        return;
      }

      let minTop = Number.MAX_SAFE_INTEGER;
      let minLeft = Number.MAX_SAFE_INTEGER;
      let maxBottom = Number.MIN_SAFE_INTEGER;
      let maxRight = Number.MIN_SAFE_INTEGER;

      for (const element of elements) {
        let rect;
        if (element instanceof Text) {
          const range = document.createRange();
          range.selectNode(element);
          rect = range.getBoundingClientRect();
        } else {
          rect = element.getBoundingClientRect();
        }

        const top = rect.top;
        const left = rect.left;
        const bottom = top + rect.height;
        const right = left + rect.width;

        minTop = Math.min(minTop, top);
        minLeft = Math.min(minLeft, left);
        maxBottom = Math.max(maxBottom, bottom);
        maxRight = Math.max(maxRight, right);

        const width = right - left;
        const height = bottom - top;

        if (element instanceof HTMLElement) {
          const marginTop = parseInt(getComputedStyle(element).marginTop);
          const marginRight = parseInt(getComputedStyle(element).marginRight);
          const marginBottom = parseInt(getComputedStyle(element).marginBottom);
          const marginLeft = parseInt(getComputedStyle(element).marginLeft);

          const paddingTop = parseInt(getComputedStyle(element).paddingTop);
          const paddingRight = parseInt(getComputedStyle(element).paddingRight);
          const paddingBottom = parseInt(getComputedStyle(element).paddingBottom);
          const paddingLeft = parseInt(getComputedStyle(element).paddingLeft);

          const highlight = document.createElement("div");
          highlight.style.top = `${top}px`;
          highlight.style.left = `${left}px`;
          highlight.style.width = `${width}px`;
          highlight.style.height = `${height}px`;
          highlight.style.boxSizing = "border-box";
          highlight.style.position = "fixed";
          highlight.style.backgroundColor = "rgba(15, 139, 245, 0.4)";
          highlight.style.borderStyle = "solid";
          highlight.style.borderWidth = `${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px`;
          highlight.style.borderColor = "rgba(65, 196, 68, 0.4)";
          highlight.style.zIndex = "10000";
          highlight.style.pointerEvents = "none";
          document.body.appendChild(highlight);
          this.addedElements.push(highlight);

          const highlightMargins = document.createElement("div");
          highlightMargins.style.top = `${top - marginTop}px`;
          highlightMargins.style.left = `${left - marginLeft}px`;
          highlightMargins.style.width = `${width + marginLeft + marginRight}px`;
          highlightMargins.style.height = `${height + marginBottom + marginTop}px`;
          highlightMargins.style.position = "fixed";
          highlightMargins.style.borderStyle = "solid";
          highlightMargins.style.boxSizing = "border-box";
          highlightMargins.style.borderWidth = `${marginTop}px ${marginRight}px ${marginBottom}px ${marginLeft}px`;
          highlightMargins.style.borderColor = "rgba(241, 179, 121, 0.4)";
          highlightMargins.style.zIndex = "10000";
          highlightMargins.style.pointerEvents = "none";
          document.body.appendChild(highlightMargins);
          this.addedElements.push(highlightMargins);
        } else {
          const highlight = document.createElement("div");
          highlight.style.top = `${top}px`;
          highlight.style.left = `${left}px`;
          highlight.style.width = `${width}px`;
          highlight.style.height = `${height}px`;
          highlight.style.boxSizing = "border-box";
          highlight.style.position = "fixed";
          highlight.style.backgroundColor = "rgba(15, 139, 245, 0.4)";
          highlight.style.zIndex = "10000";
          highlight.style.pointerEvents = "none";
          document.body.appendChild(highlight);
          this.addedElements.push(highlight);
        }
      }

      const width = maxRight - minLeft;
      const height = maxBottom - minTop;

      const detailsBox = document.createElement("div");
      detailsBox.className = "owl-devtools-detailsBox";
      detailsBox.innerHTML = `
      <div style="color: #ffc107; display: inline;">${name} </div><div style="color: white; display: inline;">${width.toFixed(
        2
      )}px x ${height.toFixed(2)}px</div>
      `;
      detailsBox.style.position = "fixed";
      detailsBox.style.backgroundColor = "black";
      detailsBox.style.padding = "5px";
      detailsBox.style.zIndex = "10000";
      detailsBox.style.pointerEvents = "none";
      detailsBox.style.display = "inline";
      document.body.appendChild(detailsBox);
      this.addedElements.push(detailsBox);

      const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const viewportHeight = Math.max(
        document.documentElement.clientHeight,
        window.innerHeight || 0
      );
      const detailsBoxRect = detailsBox.getBoundingClientRect();
      let detailsBoxTop = minTop + height + 5;
      let detailsBoxLeft = minLeft;
      if (detailsBoxTop + detailsBoxRect.height > viewportHeight) {
        detailsBoxTop = minTop - detailsBoxRect.height - 5;
        if (detailsBoxTop < 0) {
          detailsBoxTop = minTop;
        }
      }
      if (detailsBoxLeft + detailsBoxRect.width > viewportWidth) {
        detailsBoxLeft = minLeft - detailsBoxRect.width - 5;
      }
      detailsBox.style.top = `${detailsBoxTop}px`;
      detailsBox.style.left = `${detailsBoxLeft + 5}px`;
    }

    removeHighlights = () => {
      for (const el of this.addedElements) {
        el.remove();
      }
      this.addedElements = [];
    };

    HTMLSelector = (ev) => {
      if (this.enabledSelector) {
        const target = ev.target;
        if (this.currentSelectedElement !== target) {
          this.currentSelectedElement = target;
          if (this._selectorRafId) {
            cancelAnimationFrame(this._selectorRafId);
          }
          this._selectorRafId = requestAnimationFrame(() => {
            this._selectorRafId = null;
            if (!this.enabledSelector) {
              return;
            }
            const path = this.getElementPath(this.currentSelectedElement);
            this.highlightComponent(path);
            window.top.postMessage({
              source: "owl-devtools",
              type: "SelectElement",
              data: path,
            });
          });
        }
      } else {
        this.removeHighlights();
      }
    };

    enableHTMLSelector() {
      this.enabledSelector = true;
      document.addEventListener("click", this.disableHTMLSelector, { capture: true });
      document.addEventListener("scroll", this.removeHighlights, { capture: true });
    }

    disableHTMLSelector = (ev = undefined) => {
      this.enabledSelector = false;
      if (this._selectorRafId) {
        cancelAnimationFrame(this._selectorRafId);
        this._selectorRafId = null;
      }
      if (ev && ev.isTrusted) {
        ev.stopPropagation();
        ev.preventDefault();
      }
      this.removeHighlights();
      document.removeEventListener("click", this.disableHTMLSelector, { capture: true });
      document.removeEventListener("scroll", this.removeHighlights, { capture: true });
      window.top.postMessage({
        source: "owl-devtools",
        type: "StopSelector",
      });
    };

    getObject(topParent, path) {
      let obj = topParent;
      if (path.length === 0) {
        return obj;
      }
      for (const key of path) {
        switch (key.type) {
          case "prototype":
            obj = Object.getPrototypeOf(obj);
            break;
          case "set entries":
          case "map entries":
            obj = [...obj];
            break;
          case "set value":
            obj = obj;
            break;
          case "map key":
            obj = obj[0];
            break;
          case "map value":
            obj = obj[1];
            break;
          case "getter":
            try {
              obj = Object.getOwnPropertyDescriptor(obj, key.value).get.call(obj);
            } catch (e) {
              obj = "Exception: " + e.toString();
            }
            break;
          case "signal":
          case "computed":
            obj = obj[key.value]();
            break;
          case "proxy":
            obj = obj[key.value];
            break;
          case "prototype getter":
          case "set entry":
          case "map entry":
          case "item":
            if (key.hasOwnProperty("symbolIndex") && key.symbolIndex >= 0) {
              const symbol = Object.getOwnPropertySymbols(obj)[key.symbolIndex];
              if (symbol) {
                obj = obj[symbol];
              }
            } else if (Object.getOwnPropertyDescriptor(obj, key.value)?.hasOwnProperty("get")) {
              try {
                obj = Object.getOwnPropertyDescriptor(obj, key.value).get;
              } catch (e) {
                obj = "Exception: " + e.toString();
              }
            } else {
              try {
                obj = obj[key.value];
              } catch (e) {
                obj = "Exception: " + e.toString();
              }
            }
        }
        if (obj) {
          obj = this.toRaw(obj);
        }
      }
      return obj;
    }

    getObjectProperty(path) {
      if (path.length === 1 && !isNaN(path[0])) {
        return [...this.apps][path[0]];
      }
      const index = path.findIndex((key) => typeof key !== "string");
      if (index === -1) {
        return this.getComponentNode(path);
      }
      const componentNode = this.getComponentNode(index === 1 ? [path[0]] : path.slice(0, index));
      if (componentNode) {
        return this.getObject(componentNode, path.slice(index));
      }
      return "Exception: component not found";
    }

    isSignal(obj) {
      if (typeof obj !== "function") return false;
      for (const sym of Object.getOwnPropertySymbols(obj)) {
        if (sym.toString() === "Symbol(Atom)" && obj[sym]?.type === "signal") return true;
      }
      return false;
    }

    isComputed(obj) {
      if (typeof obj !== "function") return false;
      for (const sym of Object.getOwnPropertySymbols(obj)) {
        if (sym.toString() === "Symbol(Atom)" && obj[sym] && obj[sym].type !== "signal")
          return true;
      }
      return false;
    }

    isReactiveProxy(obj) {
      if (typeof obj !== "object" || obj === null) return false;
      return this.toRaw(obj) !== obj;
    }

    serializeObjectChild(parentObj, key, depth, type, path, oldBranch, oldTree) {
      let obj;
      let child = {
        depth: depth,
        toggled: false,
        objectType: type,
        hasChildren: false,
      };
      if (oldBranch?.toggled) {
        child.toggled = true;
      }
      child.path = path.concat([key]);
      child.children = [];
      switch (key.type) {
        case "prototype":
          child.name = "[[Prototype]]";
          child.contentType = "object";
          child.content = this.serializer.serializeItem(Object.getPrototypeOf(parentObj), true);
          child.hasChildren = true;
          if (!oldTree && type === "env" && Object.getPrototypeOf(parentObj) !== Object.prototype) {
            child.toggled = true;
          }
          break;
        case "set entries":
        case "map entries":
          child.name = "[[Entries]]";
          child.content = "";
          child.contentType = "array";
          child.hasChildren = true;
          break;
        case "set value":
          child.name = "value";
          obj = parentObj;
          break;
        case "map key":
          child.name = "key";
          obj = parentObj[0];
          break;
        case "map value":
          child.name = "value";
          obj = parentObj[1];
          break;
        case "getter":
          child.name = key.value;
          obj = parentObj[key.value];
          break;
        case "prototype getter":
        case "set entry":
        case "map entry":
        case "item":
          if (Object.getOwnPropertyDescriptor(parentObj, key.value)?.hasOwnProperty("get")) {
            child.name = "get " + key.value;
            obj = Object.getOwnPropertyDescriptor(parentObj, key.value).get;
          } else {
            child.name = key.value;
            if (typeof key.value === "symbol") {
              child.name = key.value.toString();
              obj = parentObj[key.value];
              child.path[child.path.length - 1].symbolIndex = Object.getOwnPropertySymbols(
                parentObj
              ).findIndex((sym) => sym === key.value);
              child.path[child.path.length - 1].value = key.value.toString();
            } else if (key.hasOwnProperty("symbolIndex")) {
              obj = parentObj[Object.getOwnPropertySymbols(parentObj)[key.symbolIndex]];
            } else {
              obj = parentObj[key.value];
            }
          }
          if (key.type === "map entry") {
            child.contentType = "array";
            child.hasChildren = obj.length > 0;
            child.content = this.serializer.serializeContent(obj, key.type);
          }
          break;
      }
      if (!child.contentType) {
        if (obj === null) {
          child.content = "null";
          child.contentType = "object";
          child.hasChildren = false;
        } else if (obj === undefined) {
          child.content = "undefined";
          child.contentType = "undefined";
          child.hasChildren = false;
        } else {
          obj = this.toRaw(obj);
          switch (true) {
            case obj instanceof Map:
              child.contentType = "map";
              child.hasChildren = true;
              break;
            case obj instanceof Set:
              child.contentType = "set";
              child.hasChildren = true;
              break;
            case obj.constructor?.name === "Array":
              child.contentType = "array";
              child.hasChildren = obj.length > 0;
              break;
            case typeof obj === "function":
              child.contentType = "function";
              child.hasChildren = true;
              break;
            case typeof obj === "object":
              child.contentType = "object";
              child.hasChildren =
                Object.keys(obj).length > 0 ||
                Object.getOwnPropertySymbols(obj).length > 0 ||
                obj.constructor.name !== "Object";
              break;
            default:
              child.contentType = typeof obj;
              child.hasChildren = false;
          }
          if (key.type === "set entry") {
            child.content = this.serializer.serializeItem(obj, true);
          } else {
            child.content = this.serializer.serializeContent(obj, child.contentType);
          }
        }
      }
      if (child.toggled) {
        child.children = this.loadObjectChildren(
          child.path,
          child.depth,
          child.contentType,
          child.objectType,
          oldTree
        );
      }
      this.addHighlightedKeys(child);
      return child;
    }

    getObjectInOldTree(oldTree, completePath, objType) {
      const objPathIndex = completePath.findIndex((key) => typeof key !== "string");
      let path = completePath.slice(objPathIndex);
      let obj;
      if (objType === "subscription") {
        const subscriptionPath = completePath.slice(0, objPathIndex + 3);
        obj = oldTree.subscriptions.children.find(
          (child) => JSON.stringify(child.target.path) === JSON.stringify(subscriptionPath)
        ).target;
        path = path.slice(3);
      } else {
        if (objPathIndex > 1 && path[0]?.value === "component") {
          path.shift();
        }
        if (objType === "instance") {
          obj = oldTree.instance.children;
        } else if (objType === "reactiveValue") {
          obj = oldTree.reactiveValues.children;
        } else if (objType === "hook") {
          obj = oldTree.hooks.children;
          path.shift();
        } else if (objType === "props") {
          obj = oldTree.props.children;
          path.shift();
        } else {
          obj = oldTree[path[0].value].children;
          path.shift();
        }
        obj = obj[path[0].childIndex];
        path.shift();
      }
      for (const key of path) {
        obj = obj.children[key.childIndex];
      }
      return obj;
    }
    loadObjectChildren(path, depth, contentType, objType, oldTree) {
      const children = [];
      depth = depth + 1;
      let obj = this.getObjectProperty(path);
      let oldBranch = oldTree && this.getObjectInOldTree(oldTree, path, objType);
      if (!obj) {
        return [];
      }
      let index = 0;
      const lastKey = path.at(-1);
      let prototype;
      if (lastKey.type.includes("entry")) {
        if (lastKey.type === "map entry") {
          const mapKey = this.serializeObjectChild(
            obj,
            { type: "map key", childIndex: 0 },
            depth,
            objType,
            path,
            oldBranch?.children[0],
            oldTree
          );
          children.push(mapKey);
          const mapValue = this.serializeObjectChild(
            obj,
            { type: "map value", childIndex: 1 },
            depth,
            objType,
            path,
            oldBranch?.children[1],
            oldTree
          );
          children.push(mapValue);
        } else if (lastKey.type === "set entry") {
          const setValue = this.serializeObjectChild(
            obj,
            { type: "set value", childIndex: 0 },
            depth,
            objType,
            path,
            oldBranch?.children[0],
            oldTree
          );
          children.push(setValue);
        }
        return children;
      }
      switch (contentType) {
        case "array":
          if (lastKey.type.includes("entries")) {
            for (; index < obj.length; index++) {
              const child = this.serializeObjectChild(
                obj,
                {
                  type: lastKey.type.replace("entries", "entry"),
                  value: index,
                  childIndex: children.length,
                },
                depth,
                objType,
                path,
                oldBranch?.children[index],
                oldTree
              );
              if (child) {
                children.push(child);
              }
            }
          } else {
            for (; index < obj.length; index++) {
              const child = this.serializeObjectChild(
                obj,
                { type: "item", value: index, childIndex: children.length },
                depth,
                objType,
                path,
                oldBranch?.children[index],
                oldTree
              );
              if (child) {
                children.push(child);
              }
            }
          }
          break;
        case "set":
        case "map":
          const entries = this.serializeObjectChild(
            obj,
            { type: contentType + " entries", value: "[[Entries]]", childIndex: children.length },
            depth,
            objType,
            path,
            oldBranch?.children[index],
            oldTree
          );
          if (entries) {
            children.push(entries);
            index++;
          }
          Reflect.ownKeys(obj).forEach((key) => {
            const child = this.serializeObjectChild(
              obj,
              { type: "item", value: key, childIndex: children.length },
              depth,
              objType,
              path,
              oldBranch?.children[index],
              oldTree
            );
            if (child) {
              children.push(child);
            }
            index++;
          });
          break;
        case "object":
        case "function":
          Reflect.ownKeys(obj)
            .sort(compareKeys)
            .forEach((key) => {
              if (
                key !== "__proto__" &&
                Object.getOwnPropertyDescriptor(obj, key).hasOwnProperty("get")
              ) {
                let child = {
                  name: key,
                  depth: depth,
                  toggled: false,
                  objectType: objType,
                  path: [...path, { type: "getter", value: key, childIndex: children.length }],
                  contentType: "getter",
                  content: "(...)",
                  hasChildren: false,
                  children: [],
                };
                children.push(child);
              }
              const child = this.serializeObjectChild(
                obj,
                { type: "item", value: key, childIndex: children.length },
                depth,
                objType,
                path,
                oldBranch?.children[index],
                oldTree
              );
              if (child) {
                children.push(child);
              }
              index++;
            });
      }
      let proto = Object.getPrototypeOf(obj);
      while (proto) {
        Reflect.ownKeys(proto).forEach((key) => {
          if (
            key !== "__proto__" &&
            Object.getOwnPropertyDescriptor(proto, key).hasOwnProperty("get")
          ) {
            let child = {
              name: key,
              depth: depth,
              toggled: false,
              objectType: objType,
              path: [
                ...path,
                { type: "prototype getter", value: key, childIndex: children.length },
              ],
              contentType: "getter",
              content: "(...)",
              hasChildren: false,
              children: [],
            };
            children.push(child);
          }
        });
        proto = Object.getPrototypeOf(proto);
      }
      if (obj.__proto__) {
        prototype = this.serializeObjectChild(
          obj,
          { type: "prototype", childIndex: children.length },
          depth,
          objType,
          path,
          oldBranch?.children.at(-1),
          oldTree
        );
        children.push(prototype);
      }
      return children;
    }
    getComponentNode(path) {
      if (path.length === 1 && !isNaN(path[0])) {
        return [...this.apps][path[0]];
      }
      let node;
      if (!isNaN(path[0])) {
        const app = [...this.apps][path[0]];
        if (!app) return null;
        const roots = this.getRoots(app);
        node = roots[parseInt(path[1], 10)];
        if (!node) {
          return null;
        }
        for (let i = 2; i < path.length; i++) {
          if (typeof path[i] !== "string") {
            break;
          }
          if (node.children.hasOwnProperty(path[i])) {
            node = node.children[path[i]];
          } else {
            return null;
          }
        }
      } else {
        const simplifiedPathArray = path[0].split("/");
        const app = [...this.apps][simplifiedPathArray[0]];
        if (!app) return null;
        const roots = this.getRoots(app);
        const rootIndex = parseInt(simplifiedPathArray[1], 10);
        node = roots[rootIndex];
        if (!node || this.getNodeName(node) !== simplifiedPathArray[2]) {
          return null;
        }
        for (let i = 3; i < simplifiedPathArray.length; i += 2) {
          const key = Reflect.ownKeys(node.children)[simplifiedPathArray[i]];
          node = node.children[key];
          if (this.getNodeName(node) !== simplifiedPathArray[i + 1]) {
            return null;
          }
        }
      }
      return node;
    }
    refreshComponent(path) {
      const componentNode = this.getComponentNode(path);
      componentNode.render();
    }
    getComponentDetails(path = null, oldTree = null) {
      let component = {};
      if (!path) {
        path = this.getElementPath($0);
      }
      component.path = path;
      let node = this.getComponentNode(path);
      if (!node) {
        for (const app of this.apps) {
          const roots = this.getRoots(app);
          if (roots.length > 0) {
            node = roots[0];
            break;
          }
        }
      }
      if (!node) {
        return null;
      }
      const isApp = path.length === 1;
      if (isApp) {
        component.version = this.getAppVersion(node);
      }
      component.props = { toggled: oldTree ? oldTree.props.toggled : true, children: [] };
      component.name = isApp
        ? node?.name
          ? `App (${node.name})`
          : "App " + (Number(path[0]) + 1)
        : node.component.constructor.name;
      const appVersion = this.getAppVersion([...this.apps][path[0]]);
      const isOwl3 = appVersion.startsWith("3");
      if (isOwl3) {
        const rawProps = node.props || {};
        const defaults = node.defaultProps || {};
        const allPropKeys = [
          ...new Set([...Reflect.ownKeys(rawProps), ...Reflect.ownKeys(defaults)]),
        ].sort(compareKeys);
        allPropKeys.forEach((key) => {
          const inRaw = key in rawProps && rawProps[key] !== undefined;
          const parentObj = inRaw ? rawProps : defaults;
          const parentPathKey = inRaw ? "props" : "defaultProps";
          const keyPropsPath = [...path, { type: "item", value: parentPathKey }];
          let oldBranch = oldTree?.props.children[component.props.children.length];
          const property = this.serializeObjectChild(
            parentObj,
            { type: "item", value: key, childIndex: component.props.children.length },
            0,
            "props",
            keyPropsPath,
            oldBranch,
            oldTree
          );
          if (property) {
            component.props.children.push(property);
          }
        });
      } else {
        const props = isApp ? node.props : node.component.props;
        const propsPath = isApp
          ? [...path, { type: "item", value: "props" }]
          : [...path, { type: "item", value: "component" }, { type: "item", value: "props" }];
        Reflect.ownKeys(props || {})
          .sort(compareKeys)
          .forEach((key) => {
            let oldBranch = oldTree?.props.children[component.props.children.length];
            const property = this.serializeObjectChild(
              props,
              { type: "item", value: key, childIndex: component.props.children.length },
              0,
              "props",
              propsPath,
              oldBranch,
              oldTree
            );
            if (property) {
              component.props.children.push(property);
            }
          });
      }
      let obj;
      const env = isApp ? node.env : node.component.env;
      if (env) {
        component.env = { toggled: oldTree ? oldTree.env.toggled : false, children: [] };
        const envPath = isApp
          ? [...path, { type: "item", value: "env" }]
          : [...path, { type: "item", value: "component" }, { type: "item", value: "env" }];
        Reflect.ownKeys(env)
          .sort(compareKeys)
          .forEach((key) => {
            let oldBranch = oldTree?.env.children[component.env.children.length];
            const envElement = this.serializeObjectChild(
              env,
              { type: "item", value: key, childIndex: component.env.children.length },
              0,
              "env",
              envPath,
              oldBranch,
              oldTree
            );
            if (envElement) {
              component.env.children.push(envElement);
            }
          });
        let obj = Object.getPrototypeOf(env);
        Reflect.ownKeys(obj).forEach((key) => {
          if (
            key !== "__proto__" &&
            Object.getOwnPropertyDescriptor(obj, key).hasOwnProperty("get")
          ) {
            let child = {
              name: key,
              depth: 0,
              toggled: false,
              objectType: "env",
              path: [
                ...envPath,
                { type: "prototype getter", value: key, childIndex: component.env.children.length },
              ],
              contentType: "getter",
              content: "(...)",
              hasChildren: false,
              children: [],
            };
            component.env.children.push(child);
          }
        });
        const envPrototype = this.serializeObjectChild(
          env,
          { type: "prototype", childIndex: component.env.children.length },
          0,
          "env",
          envPath,
          oldTree?.env[component.env.children.length],
          oldTree
        );
        component.env.children.push(envPrototype);
      }
      const instance = isApp ? node : node.component;
      component.instance = { toggled: oldTree ? oldTree.instance.toggled : true, children: [] };
      const instancePath = isApp ? path : [...path, { type: "item", value: "component" }];
      Reflect.ownKeys(instance)
        .sort(compareKeys)
        .forEach((key) => {
          if (!["env", "props"].includes(key)) {
            let oldBranch = oldTree?.instance.children[component.instance.children.length];
            const instanceElement = this.serializeObjectChild(
              instance,
              { type: "item", value: key, childIndex: component.instance.children.length },
              0,
              "instance",
              instancePath,
              oldBranch,
              oldTree
            );
            if (instanceElement) {
              component.instance.children.push(instanceElement);
            }
          }
        });
      obj = Object.getPrototypeOf(instance);
      while (obj) {
        Reflect.ownKeys(obj).forEach((key) => {
          if (
            key !== "__proto__" &&
            Object.getOwnPropertyDescriptor(obj, key).hasOwnProperty("get")
          ) {
            let child = {
              name: key,
              depth: 0,
              toggled: false,
              objectType: "instance",
              path: [
                ...instancePath,
                {
                  type: "prototype getter",
                  value: key,
                  childIndex: component.instance.children.length,
                },
              ],
              contentType: "getter",
              content: "(...)",
              hasChildren: false,
              children: [],
            };
            component.instance.children.push(child);
          }
        });
        obj = Object.getPrototypeOf(obj);
      }
      const instancePrototype = this.serializeObjectChild(
        instance,
        { type: "prototype", childIndex: component.instance.children.length },
        0,
        "instance",
        instancePath,
        oldTree?.instance[component.instance.children.length],
        oldTree
      );
      component.instance.children.push(instancePrototype);

      component.reactiveValues = {
        toggled: oldTree ? (oldTree.reactiveValues?.toggled ?? true) : true,
        children: [],
      };
      if (isOwl3 && !isApp) {
        Reflect.ownKeys(instance)
          .sort(compareKeys)
          .forEach((key) => {
            if (["env", "props"].includes(key)) return;
            const val = instance[key];
            let pathType, reactiveValue;
            if (this.isSignal(val)) {
              pathType = "signal";
              reactiveValue = this.toRaw(val());
            } else if (this.isComputed(val)) {
              pathType = "computed";
              reactiveValue = this.toRaw(val());
            } else if (this.isReactiveProxy(val)) {
              pathType = "proxy";
              reactiveValue = this.toRaw(val);
            } else {
              return;
            }
            const childIndex = component.reactiveValues.children.length;
            const reactivePath = [...instancePath, { type: pathType, value: key, childIndex }];
            let contentType, hasChildren;
            if (reactiveValue === null || reactiveValue === undefined) {
              contentType = reactiveValue === null ? "object" : "undefined";
              hasChildren = false;
            } else if (reactiveValue instanceof Map) {
              contentType = "map";
              hasChildren = true;
            } else if (reactiveValue instanceof Set) {
              contentType = "set";
              hasChildren = true;
            } else if (Array.isArray(reactiveValue)) {
              contentType = "array";
              hasChildren = reactiveValue.length > 0;
            } else if (typeof reactiveValue === "function") {
              contentType = "function";
              hasChildren = true;
            } else if (typeof reactiveValue === "object") {
              contentType = "object";
              hasChildren =
                Object.keys(reactiveValue).length > 0 ||
                Object.getOwnPropertySymbols(reactiveValue).length > 0;
            } else {
              contentType = typeof reactiveValue;
              hasChildren = false;
            }
            const oldBranch = oldTree?.reactiveValues?.children[childIndex];
            const reactiveNode = {
              name: `${typeof key === "symbol" ? key.toString() : key} (${pathType[0].toUpperCase() + pathType.slice(1)})`,
              depth: 0,
              toggled: oldBranch?.toggled ?? false,
              objectType: "reactiveValue",
              contentType,
              content:
                reactiveValue == null
                  ? reactiveValue === null
                    ? "null"
                    : "undefined"
                  : this.serializer.serializeContent(reactiveValue, contentType),
              hasChildren,
              path: reactivePath,
              children: [],
            };
            if (reactiveNode.toggled) {
              reactiveNode.children = this.loadObjectChildren(
                reactivePath,
                0,
                contentType,
                "reactiveValue",
                oldTree
              );
            }
            component.reactiveValues.children.push(reactiveNode);
          });
      }
      if (isApp || isOwl3) {
        component.subscriptions = {
          toggled: oldTree ? oldTree.subscriptions?.toggled : true,
          children: [],
        };
      } else {
        const rawSubscriptions = this.topLevelSubscriptions(node);
        component.subscriptions = {
          toggled: oldTree ? oldTree.subscriptions.toggled : true,
          children: [],
        };
        rawSubscriptions.forEach((rawSubscription) => {
          let subscription = {
            target: {
              name: this.targetName(rawSubscription.target, node),
              contentType:
                typeof rawSubscription.target === "object"
                  ? Array.isArray(rawSubscription.target)
                    ? "array"
                    : "object"
                  : rawSubscription.target,
              depth: 0,
              path: [
                ...path,
                { type: "item", value: "subscriptions" },
                { type: "item", value: rawSubscription.index },
                { type: "item", value: "target" },
              ],
              toggled: false,
              objectType: "subscription",
            },
          };
          if (
            oldTree &&
            oldTree.subscriptions.children[rawSubscription.index] &&
            oldTree.subscriptions.children[rawSubscription.index].target.toggled
          ) {
            subscription.target.toggled = true;
          }
          if (rawSubscription.target == null) {
            if (subscription.target.contentType === "undefined") {
              subscription.target.content = "undefined";
            } else {
              subscription.target.content = "null";
            }
            subscription.target.hasChildren = false;
          } else {
            subscription.target.content = this.serializer.serializeContent(
              rawSubscription.target,
              subscription.target.contentType
            );
            subscription.target.hasChildren =
              subscription.target.contentType === "object"
                ? Object.keys(rawSubscription.target).length > 0
                : subscription.target.contentType === "array"
                  ? rawSubscription.target.length > 0
                  : false;
          }
          subscription.target.children = [];
          if (subscription.target.toggled) {
            subscription.target.children = this.loadObjectChildren(
              subscription.target.path,
              subscription.target.depth,
              subscription.target.contentType,
              subscription.target.objectType,
              oldTree
            );
          }
          this.addHighlightedKeys(subscription.target);
          component.subscriptions.children.push(subscription);
        });
      }
      if (!isApp) {
        component.hooks = { toggled: oldTree ? oldTree.hooks.toggled : true, children: [] };
        const hooksList = [
          "mounted",
          "patched",
          "willDestroy",
          "willPatch",
          "willStart",
          "willUnmount",
          "willUpdateProps",
        ];
        const hooksPath = [...instancePath, { type: "item", value: "__owl__" }];
        Reflect.ownKeys(instance.__owl__)
          .sort(compareKeys)
          .forEach((key) => {
            if (hooksList.includes(key)) {
              let oldBranch = oldTree?.hooks.children[component.hooks.children.length];
              const property = this.serializeObjectChild(
                instance.__owl__,
                { type: "item", value: key, childIndex: component.hooks.children.length },
                0,
                "hook",
                hooksPath,
                oldBranch,
                oldTree
              );
              if (property) {
                component.hooks.children.push(property);
              }
            }
          });
      }
      return component;
    }
    loadGetterContent(getter) {
      let obj = this.getObjectProperty(getter.path);
      if (obj == null) {
        if (typeof obj === "undefined") {
          getter.content = "undefined";
          getter.contentType = "undefined";
        } else {
          getter.content = "null";
          getter.contentType = "object";
        }
        getter.hasChildren = false;
      } else {
        obj = this.toRaw(obj);
        switch (true) {
          case obj instanceof Map:
            getter.contentType = "map";
            getter.hasChildren = obj.size > 0;
            break;
          case obj instanceof Set:
            getter.contentType = "set";
            getter.hasChildren = obj.size > 0;
            break;
          case obj instanceof Array:
            getter.contentType = "array";
            getter.hasChildren = obj.length > 0;
            break;
          case typeof obj === "function":
            getter.contentType = "function";
            getter.hasChildren = Reflect.ownKeys(obj).length > 0;
            break;
          case obj instanceof Object:
            getter.contentType = "object";
            getter.hasChildren = Reflect.ownKeys(obj).length > 0;
            break;
          default:
            getter.contentType = typeof obj;
            getter.hasChildren = false;
        }
        getter.content = this.serializer.serializeContent(obj, getter.contentType);
      }
      return getter;
    }
    getDOMElementsRecursive(node) {
      if (node.hasOwnProperty("bdom")) {
        return this.getDOMElementsRecursive(node.bdom);
      }
      if (node.hasOwnProperty("content")) {
        return this.getDOMElementsRecursive(node.content);
      }
      if (node.hasOwnProperty("el")) {
        if (node.el instanceof Element || node.el instanceof Text) {
          return [node.el];
        }
      }
      if (node.hasOwnProperty("child")) {
        return this.getDOMElementsRecursive(node.child);
      }
      if (node.hasOwnProperty("children") && node.children.length > 0) {
        let elements = [];
        for (const child of node.children) {
          if (child) {
            elements = elements.concat(this.getDOMElementsRecursive(child));
          }
        }
        return elements;
      }
      return [];
    }
    highlightComponent(path) {
      if (path.length === 1) {
        path.push("0");
      }
      let component = this.getComponentNode(path);
      if (!component) {
        return;
      }
      const elements = this.getDOMElementsRecursive(component);
      this.highlightElements(elements, component.component.constructor.name);
    }
    editObject(path, value, objectType) {
      if (value === "undefined") {
        value = undefined;
      } else {
        try {
          value = JSON.parse(value);
        } catch (e) {
          console.warn("Could not evaluate user property\n", e);
          return;
        }
      }
      const item = path.pop();
      const obj = this.getObjectProperty(path);
      const key = item.hasOwnProperty("symbolIndex")
        ? Object.getOwnPropertySymbols(obj)[item.symbolIndex]
        : item.value;
      if (!obj) {
        return;
      }
      if (objectType === "subscription") {
        this.reactive(obj)[key] = value;
      } else {
        obj[key] = value;
        if (objectType === "props" || objectType === "instance") {
          const component = this.getComponentNode(path);
          if (component.__proto__.hasOwnProperty("render")) {
            this.getComponentNode(path).render();
          } else {
            component.root.render();
          }
        } else if (objectType === "env") {
          const roots = this.getRoots([...this.apps][path[0]]);
          for (const rootNode of roots) {
            rootNode.render(true);
          }
        }
      }
    }
    searchElement(node, path, element) {
      if (!node?.bdom) {
        return null;
      }
      const results = this.getDOMElementsRecursive(node);
      let containsElement = false;
      for (const result of results) {
        if (result === element) {
          return path;
        }
        if (result.contains(element)) {
          containsElement = true;
        }
      }
      if (containsElement) {
        for (const [key, child] of Object.entries(node.children)) {
          const result = this.searchElement(child, path.concat([key]), element);
          if (result) {
            return result;
          }
        }
        return path;
      }
      return null;
    }
    getElementPath(element) {
      if (element) {
        const appsArray = [...this.apps];
        for (const [index, app] of appsArray.entries()) {
          const roots = this.getRoots(app);
          for (const [rootIdx, rootNode] of roots.entries()) {
            const inspectedPath = this.searchElement(rootNode, [rootIdx.toString()], element);
            if (inspectedPath) {
              inspectedPath.unshift(index.toString());
              return inspectedPath;
            }
          }
        }
      }
      const appsArray = [...this.apps];
      for (const [appIndex, app] of appsArray.entries()) {
        if (this.getRoots(app).length > 0) {
          return [appIndex.toString(), "0"];
        }
      }
      return ["0", "0"];
    }
    getComponentsTree(inspectedPath = null, oldTrees = null, oldDetails = null) {
      const appsArray = [...this.apps];
      if (inspectedPath && !this.getComponentNode(inspectedPath)) {
        inspectedPath = null;
      }
      const trees = appsArray.map((app, index) => {
        let oldTree;
        if (oldTrees) {
          oldTree = oldTrees[index];
        }
        let appNode = {};
        appNode = {
          name: app?.name ? `App (${app.name})` : "App " + (index + 1),
          path: [index.toString()],
          key: "",
          depth: 0,
          toggled: true,
          selected: false,
          highlighted: false,
          version: this.getAppVersion(app),
          children: [],
        };
        if (oldTree) {
          appNode.toggled = oldTree.toggled;
        }
        if (!inspectedPath) {
          inspectedPath = this.getElementPath($0);
        }
        if (inspectedPath.join("/") === index.toString()) {
          appNode.selected = true;
        }
        const roots = this.getRoots(app);
        roots.forEach((rootNode, rootIdx) => {
          const root = {
            name: rootNode.component.constructor.name,
            path: [index.toString(), rootIdx.toString()],
            key: rootIdx.toString(),
            depth: 1,
            toggled: true,
            selected: false,
            highlighted: false,
          };
          const oldChild = oldTree?.children?.[rootIdx];
          if (oldChild) {
            root.toggled = oldChild.toggled;
          }
          const rootPathString = index.toString() + "/" + rootIdx.toString();
          if (inspectedPath.join("/") === rootPathString) {
            root.selected = true;
          } else if (appNode.selected) {
            root.highlighted = true;
          }
          root.children = this.fillTree(rootNode, root, inspectedPath.join("/"), oldChild);
          appNode.children.push(root);
        });
        return appNode;
      });
      const component = this.getComponentDetails(inspectedPath, oldDetails);
      return trees ? [trees, component] : [];
    }
    fillTree(appNode, treeNode, inspectedPathString, oldBranch) {
      const children = [];
      for (const [key, appChild] of Object.entries(appNode.children)) {
        let child = {
          name: appChild.component.constructor.name,
          key: key,
          depth: treeNode.depth + 1,
          toggled: true,
          selected: false,
          highlighted: false,
        };
        child.path = treeNode.path.concat([child.key]);
        let oldChild = null;
        if (oldBranch) {
          const searchResult = oldBranch.children.find((o) => o.key === key);
          if (searchResult) {
            oldChild = searchResult;
            child.toggled = oldChild.toggled;
          }
        }
        const childPathString = child.path.join("/");
        if (childPathString === inspectedPathString) {
          child.selected = true;
        } else if (childPathString.includes(inspectedPathString)) {
          child.highlighted = true;
        }
        child.children = this.fillTree(appChild, child, inspectedPathString, oldChild);
        children.push(child);
      }
      return children;
    }
    getObservedVariables(current) {
      const res = [...current];
      for (let i = 0; i < current.length; i++) {
        const path = current[i].path;
        const parent = this.getObjectProperty(path.slice(0, path.length - 1));
        if (parent && !(typeof parent === "string" && parent.startsWith("Exception: "))) {
          const result = this.serializeObjectChild(
            parent,
            path.at(-1),
            0,
            "observed",
            path.slice(0, path.length - 1),
            {},
            {}
          );
          result.hasChildren = false;
          result.visible = true;
          const index = path.findIndex((key) => typeof key !== "string");
          const componentNode = this.getComponentNode(
            index <= 1 ? [path[0]] : path.slice(0, index)
          );
          if (result.name === "target" && parent?.keys !== undefined && componentNode) {
            result.name = this.targetName(parent.target, componentNode);
          }
          if (index > 1) {
            result.path = [this.getComponentSimplifiedPath(componentNode)].concat(
              path.slice(index)
            );
          }
          res[i] = result;
        } else {
          res[i].visible = false;
        }
      }
      return res;
    }
    getComponentPath(componentNode) {
      let path = [];
      if (componentNode.parentKey) {
        path = [componentNode.parentKey];
        while (componentNode.parent && componentNode.parent.parentKey) {
          componentNode = componentNode.parent;
          path.unshift(componentNode.parentKey);
        }
      }
      let rootNode = componentNode.parent || componentNode;
      const app = rootNode.app;
      const roots = this.getRoots(app);
      const rootIndex = roots.indexOf(rootNode);
      path.unshift(rootIndex.toString());
      const appsArray = [...this.apps];
      let index = appsArray.findIndex((a) => a === app);
      path.unshift(index.toString());
      return path;
    }
    getNodeName(node) {
      return node.component?.constructor?.name ?? node.name ?? "";
    }

    getComponentSimplifiedPath(componentNode) {
      let path = this.getNodeName(componentNode);
      if (componentNode.parentKey) {
        while (componentNode.parent) {
          const previousKey = componentNode.parentKey;
          componentNode = componentNode.parent;
          path = `${this.getNodeName(componentNode)}/${Reflect.ownKeys(
            componentNode.children
          ).indexOf(previousKey)}/${path}`;
        }
      }
      let rootNode = componentNode.parent || componentNode;
      const app = rootNode.app;
      const roots = this.getRoots(app);
      const rootIndex = roots.indexOf(rootNode);
      const appsArray = [...this.apps];
      let appIndex = appsArray.findIndex((a) => a === app);
      path = appIndex.toString() + "/" + rootIndex.toString() + (path.length ? `/${path}` : "");
      return path;
    }
    sendObjectToConsole(path) {
      const obj = this.getObjectProperty(path);
      let index = 1;
      while (window["temp" + index] !== undefined) {
        index++;
      }
      window["temp" + index] = obj;
      console.log("temp" + index + " = ", window["temp" + index]);
    }
    inspectComponentDOM(path) {
      const componentNode = this.getComponentNode(path);
      const elements = this.getDOMElementsRecursive(componentNode);
      if (!elements.length) {
        return;
      }
      if (IS_FIREFOX) {
        window.$temp = elements[0];
      } else {
        inspect(elements[0]);
      }
    }
    inspectComponentCompiledTemplate(path) {
      const componentNode = this.getComponentNode(path);
      const template = componentNode.component.constructor.template;
      if (IS_FIREFOX) {
        window.$temp = componentNode.app.templates[template];
      } else {
        inspect(componentNode.app.templates[template]);
      }
    }
    inspectComponentRawTemplate(path) {
      const componentNode = this.getComponentNode(path);
      const template = componentNode.component.constructor.template;
      const templateNode = componentNode.app.rawTemplates[template];
      console.log(templateNode);
    }
    inspectFunctionSource(path) {
      const obj = this.getObjectProperty(path);
      if (IS_FIREFOX) {
        window.$temp = obj;
      } else {
        inspect(obj);
      }
    }

    injectBreakpoint(hook, path, instanceOnly, condition) {
      const componentNode = this.getObjectProperty(path);
      const injectFunctionInHook = (comp, hook, fn) => {
        comp[hook] = [...comp[hook], fn];
      };
      const node = componentNode.component.__owl__;
      let hooks = this.breakpointsHookMap.get(node);
      if (!hooks) {
        this.breakpointsHookMap.set(node, (hooks = new Map()));
      }
      if (!hooks.has(hook)) {
        hooks.set(hook, node[hook]);
      }
      injectFunctionInHook(node, hook, () => {
        debugger;
      });
      if (!instanceOnly) {
        const componentClass = componentNode.component.constructor;
        const originalSetup = componentClass.prototype.setup;
        if (!this.breakpointsClassMap.get(componentClass)) {
          this.breakpointsClassMap.set(componentClass, originalSetup);
        }
        componentClass.prototype.setup = function () {
          const debuggerFunc = () => {
            if (eval(condition)) {
              this;
              debugger;
            }
          };
          injectFunctionInHook(this.__owl__, hook, debuggerFunc);
          originalSetup.call(this, ...arguments);
        };
      }
    }

    removeBreakpoints() {
      for (const [component, setup] of this.breakpointsClassMap) {
        component.prototype.setup = setup;
      }
      this.breakpointsClassMap.clear();
      for (const [node, hooks] of this.breakpointsHookMap) {
        for (const [hook, originalHook] of hooks) {
          node[hook] = originalHook;
        }
      }
      this.breakpointsHookMap.clear();
    }

    targetName(target, node) {
      const { component } = node;
      for (const [key, value] of Object.entries(component)) {
        if (target === this.toRaw(value)) {
          return key;
        }
      }
      for (const [key, value] of Object.entries(component.props)) {
        if (target === this.toRaw(value)) {
          return `props.${key}`;
        }
      }
      return "[unknown]";
    }

    topLevelSubscriptions(node) {
      const subscriptions = node.subscriptions.map((s, index) => ({ ...s, index }));
      const topLevelValues = new Set(Object.values(node.component).map((o) => this.toRaw(o)));
      const toOmit = new Set(
        subscriptions
          .flatMap(({ keys, target }) => keys.map((k) => this.toRaw(target[k])))
          .filter((obj) => !topLevelValues.has(obj))
      );
      return subscriptions.filter(({ target }) => !toOmit.has(target));
    }

    addHighlightedKeys(child) {
      const { path } = child;
      const subscriptionIndex = path.findIndex((item) => typeof item !== "string");
      if (path[subscriptionIndex]?.value === "subscriptions") {
        const node = this.getComponentNode(path.slice(0, subscriptionIndex));
        const targetToKeys = new Map(node.subscriptions.map(({ keys, target }) => [target, keys]));
        const target = this.getObjectProperty(child.path);
        child.keys = targetToKeys.get(target)?.map((k) => String(k));
      }
    }
  }

  function compareKeys(a, b) {
    const isSymbolA = typeof a === "symbol";
    const isSymbolB = typeof b === "symbol";

    if (isSymbolA && !isSymbolB) {
      return 1;
    } else if (!isSymbolA && isSymbolB) {
      return -1;
    } else {
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    }
  }

  function checkOwlStatus() {
    let owlStatus = 2;
    if (!window.__OWL__DEVTOOLS_GLOBAL_HOOK__) {
      if (window.__OWL_DEVTOOLS__ || window.owl?.App) {
        owlStatus = 1;
      } else {
        owlStatus = -1;
      }
    }
    window.postMessage({ source: "owl-devtools", type: "owlStatus", data: owlStatus });
  }

  if (!window.__OWL_DEVTOOLS__) {
    let val;
    const descriptor = Object.getOwnPropertyDescriptor(window, "__OWL_DEVTOOLS__") || {
      get() {
        return val;
      },
      set(value) {
        val = value;
      },
    };
    Object.defineProperty(window, "__OWL_DEVTOOLS__", {
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        descriptor.set.call(this, value);
        if (value?.Fiber !== undefined) {
          window.__OWL__DEVTOOLS_GLOBAL_HOOK__ = new OwlDevtoolsGlobalHook();
        }
        window.top.postMessage({ source: "owl-devtools", type: "FrameReady" });
        checkOwlStatus();
      },
    });
    window.postMessage({ source: "owl-devtools", type: "Reload" });
  } else if (
    window.__OWL_DEVTOOLS__?.Fiber !== undefined &&
    !window.__OWL__DEVTOOLS_GLOBAL_HOOK__
  ) {
    window.__OWL__DEVTOOLS_GLOBAL_HOOK__ = new OwlDevtoolsGlobalHook();
    window.postMessage({ source: "owl-devtools", type: "Reload" });
  }
  window.addEventListener(
    "message",
    function (event) {
      if (event.data.source === "owl-devtools-background" && event.data.type === "checkOwlStatus") {
        checkOwlStatus();
      }
    },
    false
  );
  checkOwlStatus();
  return window.__OWL__DEVTOOLS_GLOBAL_HOOK__ !== undefined;
})();
